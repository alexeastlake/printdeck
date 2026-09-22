"""Login, sessions, permission checks, and the users/roles API.

Auth is on iff users.yaml has at least one user. With none, everything is
open and every request is treated as holding every permission.

Roles are admin-defined: a name plus a subset of models.Permission. Reads
need a login; writes need a specific permission, declared per endpoint.
"""

from __future__ import annotations

import logging
import re
import threading
import time
from contextlib import contextmanager
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException, Request, WebSocket
from pydantic import BaseModel, Field

from .models import ALL_PERMISSIONS, PERMISSION_CATALOG, Permission, Role, UserOut
from .security import dummy_verify

log = logging.getLogger("printdeck.auth")

router = APIRouter()

# Usernames end up in URL paths; a "/" would make an account impossible to edit or delete.
USERNAME_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$"
USERNAME_HELP = (
    "Usernames are 1-32 characters: letters, digits, dots, hyphens, underscores, "
    "starting with a letter or digit."
)
PASSWORD_MIN = 8
PASSWORD_MAX = 256
ROLE_NAME_MAX = 64


class Credentials(BaseModel):
    username: str = Field(max_length=256)
    password: str = Field(max_length=PASSWORD_MAX)


class NewUser(BaseModel):
    username: str = Field(max_length=256)
    password: str = Field(max_length=PASSWORD_MAX)
    role: str = Field(max_length=256)


class UserUpdate(BaseModel):
    password: str | None = Field(default=None, max_length=PASSWORD_MAX)
    role: str | None = Field(default=None, max_length=256)


class NewRole(BaseModel):
    name: str = Field(max_length=ROLE_NAME_MAX)
    permissions: list[Permission] = Field(default_factory=list)


class RoleUpdate(BaseModel):
    name: str | None = Field(default=None, max_length=ROLE_NAME_MAX)
    permissions: list[Permission] | None = None


def _users(request: Request):
    return request.app.state.users


def auth_enabled(request: Request) -> bool:
    return bool(_users(request).list())


# --- brute-force backoff ----------------------------------------------------
# Keyed per IP *and* per username. Behind a reverse proxy every client shares
# the proxy's IP, so IP alone would let one person lock everyone out and do
# nothing against a spray from many addresses. In-memory; resets on restart.
MAX_ATTEMPTS = 5
BASE_LOCKOUT = 5.0
MAX_LOCKOUT = 300.0
FAILURE_TTL = 900.0  # forget a key this long after its last failure


class _LoginBackoff:
    def __init__(self) -> None:
        self._entries: dict[str, tuple[int, float, float]] = {}  # key -> (fails, locked_until, last_seen)
        self._lock = threading.Lock()  # login() is sync → runs on worker threads

    def _evict(self, now: float) -> None:
        stale = [k for k, (_, locked_until, last) in self._entries.items()
                 if now > locked_until and now - last > FAILURE_TTL]
        for k in stale:
            del self._entries[k]

    def locked_for(self, keys: list[str]) -> float:
        now = time.monotonic()
        with self._lock:
            self._evict(now)
            return max((self._entries[k][1] - now for k in keys if k in self._entries), default=0.0)

    def record_failure(self, keys: list[str]) -> None:
        now = time.monotonic()
        with self._lock:
            for key in keys:
                fails, _, _ = self._entries.get(key, (0, 0.0, now))
                fails += 1
                lockout = 0.0
                if fails >= MAX_ATTEMPTS:
                    lockout = min(BASE_LOCKOUT * 2 ** (fails - MAX_ATTEMPTS), MAX_LOCKOUT)
                self._entries[key] = (fails, now + lockout, now)

    def clear(self, keys: list[str]) -> None:
        with self._lock:
            for key in keys:
                self._entries.pop(key, None)


_backoff = _LoginBackoff()


def _client_key(request: Request) -> str:
    # Only meaningful behind a proxy if FORWARDED_ALLOW_IPS is set (see README).
    return request.client.host if request.client else "unknown"


@router.post("/auth/login")
def login(request: Request, creds: Credentials) -> dict:
    users = _users(request)
    if not users.list():
        return {"ok": True, "user": None, "role": None, "permissions": list(ALL_PERMISSIONS)}

    keys = [f"ip:{_client_key(request)}", f"user:{creds.username}"]
    remaining = _backoff.locked_for(keys)
    if remaining > 0:
        raise HTTPException(
            status_code=429,
            detail=f"Too many attempts. Try again in {int(remaining) + 1}s.",
        )

    user = users.verify(creds.username, creds.password)
    if user is None:
        if users.get(creds.username) is None:
            dummy_verify()  # keep timing the same for unknown usernames
        _backoff.record_failure(keys)
        raise HTTPException(status_code=401, detail="Wrong username or password.")

    _backoff.clear(keys)
    # Role is never stored in the cookie. It's always re-read from the store (see _live_user).
    # session_version lets a password change invalidate existing sessions.
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
    """Session user re-checked against the store on every request, so a
    deleted user / changed role / changed password takes effect immediately
    rather than when the cookie expires. It's a dict lookup, so it's cheap."""
    username = request.session.get("user")
    if not username:
        return None
    user = _users(request).get(username)
    if user is None or user.session_version != request.session.get("session_version"):
        request.session.clear()
        return None
    return user


@router.get("/api/session")
def session_info(request: Request) -> dict:
    """Public. The UI hides/shows controls from `permissions`, so with auth
    off this must report everything, because that's what the API allows."""
    users = _users(request)
    if not auth_enabled(request):
        return {
            "enabled": False,
            "user": None,
            "role": None,
            "role_name": None,
            "permissions": list(ALL_PERMISSIONS),
        }
    user = _live_user(request)
    role = users.get_role(user.role) if user else None
    return {
        "enabled": True,
        "user": user.username if user else None,
        "role": user.role if user else None,
        "role_name": role.name if role else None,
        "permissions": users.permissions_for(user) if user else [],
    }


def current_permissions(request: Request) -> list[str] | None:
    """None if not logged in. Used by main.py's page redirects."""
    user = _live_user(request)
    if user is None:
        return None
    return _users(request).permissions_for(user)


def require_user(request: Request) -> str:
    if not auth_enabled(request):
        return "anonymous"
    user = _live_user(request)
    if user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return user.username


def require_permission(permission: str):
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


def _same_origin(websocket: WebSocket) -> bool:
    # SameSite=Lax already keeps the cookie off cross-site handshakes; this is
    # belt and braces. No Origin header = non-browser client, let it through.
    origin = websocket.headers.get("origin")
    if not origin:
        return True
    host = websocket.headers.get("host", "")
    return urlsplit(origin).netloc.lower() == host.lower()


def ws_authorized(websocket: WebSocket) -> bool:
    if not _same_origin(websocket):
        return False
    users = websocket.app.state.users
    if not users.list():
        return True
    username = websocket.session.get("user")
    user = users.get(username) if username else None
    return user is not None and user.session_version == websocket.session.get("session_version")


# --- users + roles API ------------------------------------------------------
# This router is mounted public, so each endpoint declares its own gate.

logged_in = [Depends(require_user)]
manage_roles = [Depends(require_permission("manage_roles"))]
manage_users = [Depends(require_permission("manage_users"))]


@contextmanager
def _store_errors(entity: str):
    """Translate UserStore exceptions for an endpoint about `entity`
    ("user" or "role"): a missing record is 404, except a bad role reference
    on a user endpoint, which is the caller's input → 400. Rule violations → 409."""
    try:
        yield
    except KeyError as exc:
        missing = exc.args[0] if exc.args else entity
        if missing == "role" and entity == "user":
            raise HTTPException(status_code=400, detail="No such role.")
        raise HTTPException(status_code=404, detail=f"No such {missing}.")
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))


def _validate_username(username: str) -> str:
    username = username.strip()
    if not re.match(USERNAME_PATTERN, username):
        raise HTTPException(status_code=400, detail=USERNAME_HELP)
    return username


def _validate_password(password: str) -> None:
    if len(password) < PASSWORD_MIN:
        raise HTTPException(status_code=400, detail=f"Password needs to be at least {PASSWORD_MIN} characters.")


def _validate_role_name(name: str) -> str:
    name = name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Name can't be empty.")
    return name


def _user_out(user) -> UserOut:
    return UserOut(username=user.username, role=user.role)


@router.get("/api/permissions", dependencies=logged_in)
def list_permissions() -> list[dict]:
    return PERMISSION_CATALOG


@router.get("/api/roles", dependencies=logged_in)
def list_roles(request: Request) -> list[Role]:
    return _users(request).list_roles()


@router.post("/api/roles", dependencies=manage_roles)
def create_role(request: Request, body: NewRole) -> Role:
    name = _validate_role_name(body.name)
    with _store_errors("role"):
        return _users(request).create_role(name, body.permissions)


@router.patch("/api/roles/{role_id}", dependencies=manage_roles)
def update_role(request: Request, role_id: str, body: RoleUpdate) -> Role:
    if body.name is not None:
        _validate_role_name(body.name)
    # Otherwise a manage_roles-only account just grants itself everything.
    me = _live_user(request)
    if body.permissions is not None and me is not None and me.role == role_id:
        raise HTTPException(
            status_code=403,
            detail=(
                "You can't change the permissions of your own role. "
                "Sign in as an account with a different role to edit this one."
            ),
        )
    with _store_errors("role"):
        return _users(request).update_role(role_id, name=body.name, permissions=body.permissions)


@router.delete("/api/roles/{role_id}", dependencies=manage_roles)
def delete_role(request: Request, role_id: str) -> dict:
    with _store_errors("role"):
        _users(request).delete_role(role_id)
    return {"ok": True}


@router.get("/api/users", dependencies=manage_users)
def list_users(request: Request) -> list[UserOut]:
    return [_user_out(u) for u in _users(request).list()]


@router.post("/api/users", dependencies=manage_users)
def create_user(request: Request, body: NewUser) -> UserOut:
    username = _validate_username(body.username)
    _validate_password(body.password)
    with _store_errors("user"):
        return _user_out(_users(request).create(username, body.password, body.role))


@router.patch("/api/users/{username}", dependencies=manage_users)
def update_user(request: Request, username: str, body: UserUpdate) -> UserOut:
    if body.password is not None:
        _validate_password(body.password)
    with _store_errors("user"):
        return _user_out(_users(request).update(username, password=body.password, role=body.role))


@router.delete("/api/users/{username}", dependencies=manage_users)
def delete_user(request: Request, username: str) -> dict:
    with _store_errors("user"):
        _users(request).delete(username)
    if request.session.get("user") == username:
        request.session.clear()
    return {"ok": True}
