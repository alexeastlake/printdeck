"""Multi-user login for the dashboard, with admin-defined roles.

Auth turns on as soon as there's at least one user in users.yaml (see
app/users_store.py). With none configured, the dashboard stays open (handy
for local dev) and we log a loud warning — same default as before.

A role is just a name plus a set of permissions (see models.Permission) —
nothing about "Admin" or any other role name is hardcoded past what
users_store.load_or_bootstrap seeds the very first account with. Viewing
printer status/camera/files/the live feed is the implicit baseline for any
logged-in account; every *mutating* endpoint requires a specific permission
(declared per-endpoint in routes.py) via require_permission below.

Session cookies are signed with a secret that's persisted in users.yaml
(generated once), so — unlike the old single-credential system — logins now
survive a server restart.
"""

from __future__ import annotations

import logging
import time

from fastapi import APIRouter, HTTPException, Request, WebSocket
from pydantic import BaseModel

from .models import Permission, Role, UserOut
from .security import dummy_verify

log = logging.getLogger("printdeck.auth")

router = APIRouter()

PERMISSION_CATALOG = [
    {"id": "manage_printers", "label": "Manage printers",
     "description": "Add, remove, and edit printer settings (name, IP/hostname, camera URL, group)."},
    {"id": "control_printers", "label": "Control printers",
     "description": "Set nozzle/bed temperature, fan speed, and move/home the toolhead."},
    {"id": "manage_files", "label": "Manage files",
     "description": "See the Files section, and upload, rename, or delete files."},
    {"id": "manage_users", "label": "Manage users",
     "description": "Create, edit, and delete accounts, and assign them roles."},
    {"id": "manage_roles", "label": "Manage roles",
     "description": "Create, edit, and delete roles and the permissions they grant."},
]


class Credentials(BaseModel):
    username: str
    password: str


class NewUser(BaseModel):
    username: str
    password: str
    role: str


class UserUpdate(BaseModel):
    password: str | None = None
    role: str | None = None


class NewRole(BaseModel):
    name: str
    permissions: list[Permission] = []


class RoleUpdate(BaseModel):
    name: str | None = None
    permissions: list[Permission] | None = None


def _users(request: Request):
    return request.app.state.users


def auth_enabled(request: Request) -> bool:
    return bool(_users(request).list())


# --- brute-force backoff ----------------------------------------------------
# In-memory per-client lockout after repeated failed logins. Resets on server
# restart, which is fine here — the threat model is a LAN device guessing
# passwords over many requests, not a distributed attack.
MAX_ATTEMPTS = 5
BASE_LOCKOUT = 5.0  # seconds
MAX_LOCKOUT = 300.0  # cap the exponential backoff at 5 minutes
_failed_logins: dict[str, tuple[int, float]] = {}  # key -> (fail count, locked_until)


def _client_key(request: Request) -> str:
    return request.client.host if request.client else "unknown"


@router.post("/auth/login")
def login(request: Request, creds: Credentials) -> dict:
    users = _users(request)
    if not users.list():
        return {"ok": True, "user": None, "role": None, "permissions": []}

    key = _client_key(request)
    now = time.monotonic()
    fails, locked_until = _failed_logins.get(key, (0, 0.0))
    if now < locked_until:
        raise HTTPException(
            status_code=429,
            detail=f"Too many attempts. Try again in {int(locked_until - now) + 1}s.",
        )

    user = users.verify(creds.username, creds.password)
    if user is None:
        if users.get(creds.username) is None:
            dummy_verify()  # don't let response timing reveal a valid username
        fails += 1
        lockout = 0.0
        if fails >= MAX_ATTEMPTS:
            lockout = min(BASE_LOCKOUT * 2 ** (fails - MAX_ATTEMPTS), MAX_LOCKOUT)
        _failed_logins[key] = (fails, now + lockout)
        raise HTTPException(status_code=401, detail="Wrong username or password.")

    _failed_logins.pop(key, None)
    # Role isn't stored here — it's always re-checked against the live store
    # (see _live_user), never trusted from the cookie, so a role
    # change/deletion (or a permission change on the role itself) takes
    # effect immediately rather than only once the old cookie expires.
    # session_version is stored so a later password change invalidates this
    # session too (see _live_user and UserStore.update).
    request.session["user"] = user.username
    request.session["session_version"] = user.session_version
    return {
        "ok": True,
        "user": user.username,
        "role": user.role,
        "permissions": users.permissions_for(user),
    }


@router.post("/auth/logout")
def logout(request: Request) -> dict:
    request.session.clear()
    return {"ok": True}


def _live_user(request: Request):
    """The session's user, re-checked against the current in-memory store —
    not just whatever was baked into the signed cookie at login time.
    Session cookies are stateless, so without this, deleting a user,
    reassigning their role, or editing that role's permissions wouldn't
    take effect until their cookie expired or they logged out — this is a
    plain dict lookup (app.state.users is already loaded in memory), not a
    disk read, so it costs nothing to do on every request.

    Also rejects a session whose session_version doesn't match the user's
    current one — that's what makes a password change invalidate every
    session issued with the old password, not just future logins."""
    username = request.session.get("user")
    if not username:
        return None
    user = _users(request).get(username)
    if user is None or user.session_version != request.session.get("session_version"):
        request.session.clear()  # gone, or logged in under a since-changed password
        return None
    return user


@router.get("/api/session")
def session_info(request: Request) -> dict:
    """Public: lets the frontend show account info (and drive which
    controls are visible) without needing its own login check."""
    users = _users(request)
    user = _live_user(request)
    role = users.get_role(user.role) if user else None
    return {
        "enabled": auth_enabled(request),
        "user": user.username if user else None,
        "role": user.role if user else None,
        "role_name": role.name if role else None,
        "permissions": users.permissions_for(user) if user else [],
    }


def current_permissions(request: Request) -> list[str] | None:
    """The logged-in session's live permissions, or None if not logged in
    (or the session's since been invalidated). Safe to call outside the
    require_user/require_permission dependency flow — main.py's page
    routing uses this to decide redirects."""
    user = _live_user(request)
    if user is None:
        return None
    return _users(request).permissions_for(user)


def require_user(request: Request) -> str:
    """FastAPI dependency: 401 unless logged in (or auth is disabled)."""
    if not auth_enabled(request):
        return "anonymous"
    user = _live_user(request)
    if user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return user.username


def require_permission(permission: str):
    """FastAPI dependency factory: 401 unless logged in, 403 unless the
    live user's role grants `permission` (right now — not whatever it was
    when they logged in)."""
    def check(request: Request) -> str:
        if not auth_enabled(request):
            return "anonymous"
        user = _live_user(request)
        if user is None:
            raise HTTPException(status_code=401, detail="Not authenticated")
        if permission not in _users(request).permissions_for(user):
            raise HTTPException(status_code=403, detail=f"Missing permission: {permission}")
        return user.username
    return check


def ws_authorized(websocket: WebSocket) -> bool:
    users = websocket.app.state.users
    if not users.list():
        return True
    username = websocket.session.get("user")
    return bool(username and users.get(username))


# --- roles: read is open to any logged-in account, writes need manage_roles -

@router.get("/api/permissions")
def list_permissions(request: Request) -> list[dict]:
    require_user(request)
    return PERMISSION_CATALOG


@router.get("/api/roles")
def list_roles(request: Request) -> list[Role]:
    require_user(request)
    return _users(request).list_roles()


@router.post("/api/roles")
def create_role(request: Request, body: NewRole) -> Role:
    require_permission("manage_roles")(request)
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Name can't be empty.")
    return _users(request).create_role(name, body.permissions)


@router.patch("/api/roles/{role_id}")
def update_role(request: Request, role_id: str, body: RoleUpdate) -> Role:
    require_permission("manage_roles")(request)
    if body.name is not None and not body.name.strip():
        raise HTTPException(status_code=400, detail="Name can't be empty.")
    try:
        return _users(request).update_role(role_id, name=body.name, permissions=body.permissions)
    except KeyError:
        raise HTTPException(status_code=404, detail="No such role.")
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))


@router.delete("/api/roles/{role_id}")
def delete_role(request: Request, role_id: str) -> dict:
    require_permission("manage_roles")(request)
    try:
        _users(request).delete_role(role_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="No such role.")
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    return {"ok": True}


# --- user management (needs manage_users) -----------------------------------
# auth.router is mounted *publicly* in main.py (unlike routes.api_router),
# so every endpoint below declares its own permission dependency explicitly.

@router.get("/api/users")
def list_users(request: Request) -> list[UserOut]:
    require_permission("manage_users")(request)
    return [UserOut(username=u.username, role=u.role) for u in _users(request).list()]


@router.post("/api/users")
def create_user(request: Request, body: NewUser) -> UserOut:
    require_permission("manage_users")(request)
    username = body.username.strip()
    if not username:
        raise HTTPException(status_code=400, detail="Username can't be empty.")
    if len(body.password) < 8:
        raise HTTPException(status_code=400, detail="Password needs to be at least 8 characters.")
    try:
        user = _users(request).create(username, body.password, body.role)
    except KeyError:
        raise HTTPException(status_code=400, detail="No such role.")
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    return UserOut(username=user.username, role=user.role)


@router.patch("/api/users/{username}")
def update_user(request: Request, username: str, body: UserUpdate) -> UserOut:
    require_permission("manage_users")(request)
    if body.password is not None and len(body.password) < 8:
        raise HTTPException(status_code=400, detail="Password needs to be at least 8 characters.")
    try:
        user = _users(request).update(username, password=body.password, role=body.role)
    except KeyError as exc:
        if exc.args[0] == "role":
            raise HTTPException(status_code=400, detail="No such role.")
        raise HTTPException(status_code=404, detail="No such user.")
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    return UserOut(username=user.username, role=user.role)


@router.delete("/api/users/{username}")
def delete_user(request: Request, username: str) -> dict:
    require_permission("manage_users")(request)
    try:
        _users(request).delete(username)
    except KeyError:
        raise HTTPException(status_code=404, detail="No such user.")
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    if request.session.get("user") == username:
        request.session.clear()  # they just deleted their own account
    return {"ok": True}
