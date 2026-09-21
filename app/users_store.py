"""Load/persist the user + role registry from users.yaml — same pattern as
app/config.py's printers.yaml, but this file also carries the session-cookie
signing secret (see load_or_bootstrap) so Docker only needs one extra bind
mount, not two.

Set PRINTDECK_USERS to store it somewhere else, exactly like
PRINTDECK_PRINTERS. Unset, it's just users.yaml at the repo root.

Unlike printers.yaml, there's no bundled example file to fall back to —
shipping even a fake password hash in the repo is bad practice. A fresh
install with no users.yaml and no PRINTDECK_ADMIN_USERNAME/PASSWORD simply
runs with auth disabled (same dev-friendly default as before), until either
an admin is bootstrapped or a users.yaml is created by hand.
"""

from __future__ import annotations

import os
import secrets
from pathlib import Path

import yaml

from .models import Role, User
from .security import hash_password, verify_password
from .utils import slugify

ROOT = Path(__file__).resolve().parent.parent
USERS_FILE = Path(os.environ.get("PRINTDECK_USERS") or ROOT / "users.yaml")

# The two role ids a pre-roles-feature users.yaml could reference (its
# role field used to be a fixed "admin"/"viewer" literal, not an id lookup)
# — used only for the one-time migration in load_or_bootstrap.
ALL_PERMISSIONS = ["manage_printers", "control_printers", "manage_files", "manage_users", "manage_roles"]
_LEGACY_ROLE_PERMISSIONS = {"admin": ALL_PERMISSIONS, "viewer": []}


def _read() -> dict:
    if not USERS_FILE.exists():
        return {}
    return yaml.safe_load(USERS_FILE.read_text(encoding="utf-8")) or {}


def _write(session_secret: str, users: list[User], roles: list[Role]) -> None:
    data = {
        "session_secret": session_secret,
        "roles": [r.model_dump() for r in roles],
        "users": [u.model_dump() for u in users],
    }
    USERS_FILE.write_text(
        yaml.safe_dump(data, sort_keys=False, allow_unicode=True), encoding="utf-8"
    )


def load_or_bootstrap() -> tuple[str, list[User], list[Role]]:
    """Read users.yaml, creating/migrating it if missing/empty/old-shaped.

    A fresh file always gets its own random session_secret (generated once,
    reused across restarts — unlike the old single-credential system, which
    deliberately regenerated its signing key every start).

    If PRINTDECK_ADMIN_USERNAME/PASSWORD are set and that username isn't
    already in the file, it's added as an admin (seeding an "Admin" role
    with every permission if one doesn't exist yet) — this only ever adds a
    missing account, never overwrites an existing one's password, so it
    doubles as a "lost the admin password" recovery path (delete the user's
    entry from users.yaml, restart with the env vars set) without silently
    resetting a password someone deliberately changed.

    A file written before roles existed has users with a bare "admin"/
    "viewer" string in `role` and no `roles` key at all — synthesize
    whichever of those two built-in roles are still actually referenced, so
    those accounts keep working. Purely additive, one-time, never touches a
    file that already has a `roles` key.
    """
    data = _read()
    changed = "session_secret" not in data
    secret = data.get("session_secret") or secrets.token_urlsafe(32)
    users = [User(**entry) for entry in data.get("users", [])]

    if "roles" in data:
        roles = [Role(**entry) for entry in data["roles"]]
    else:
        referenced = {u.role for u in users if u.role in _LEGACY_ROLE_PERMISSIONS}
        roles = [
            Role(id=rid, name=rid.capitalize(), permissions=_LEGACY_ROLE_PERMISSIONS[rid])
            for rid in referenced
        ]
        if roles:
            changed = True

    admin_username = os.environ.get("PRINTDECK_ADMIN_USERNAME", "")
    admin_password = os.environ.get("PRINTDECK_ADMIN_PASSWORD", "")
    if admin_username and admin_password and not any(u.username == admin_username for u in users):
        admin_role = next((r for r in roles if r.id == "admin"), None)
        if admin_role is None:
            admin_role = Role(id="admin", name="Admin", permissions=ALL_PERMISSIONS)
            roles.append(admin_role)
        users.append(User(
            username=admin_username,
            password_hash=hash_password(admin_password),
            role=admin_role.id,
        ))
        changed = True

    if changed:
        _write(secret, users, roles)

    return secret, users, roles


class UserStore:
    """In-memory user + role registry, persisted to users.yaml on every
    mutation — same shape as PrinterManager's relationship to printers.yaml.
    Session cookies only ever carry a username/session_version snapshot
    (see app/auth.py), so this is only touched on login and by the
    user/role-management endpoints, not on every authenticated request.
    """

    def __init__(self, session_secret: str, users: list[User], roles: list[Role]) -> None:
        self.session_secret = session_secret
        self._by_username: dict[str, User] = {u.username: u for u in users}
        self._by_role_id: dict[str, Role] = {r.id: r for r in roles}

    # --- users -------------------------------------------------------------

    def list(self) -> list[User]:
        return list(self._by_username.values())

    def get(self, username: str) -> User | None:
        return self._by_username.get(username)

    def verify(self, username: str, password: str) -> User | None:
        user = self._by_username.get(username)
        if user and verify_password(password, user.password_hash):
            return user
        return None

    def permissions_for(self, user: User) -> list[str]:
        role = self._by_role_id.get(user.role)
        return list(role.permissions) if role else []

    def create(self, username: str, password: str, role: str) -> User:
        if username in self._by_username:
            raise ValueError(f'"{username}" already exists.')
        if role not in self._by_role_id:
            raise KeyError(role)
        user = User(username=username, password_hash=hash_password(password), role=role)
        self._by_username[username] = user
        self._save()
        return user

    def update(self, username: str, *, password: str | None = None, role: str | None = None) -> User:
        user = self._by_username.get(username)
        if user is None:
            raise KeyError("user")
        if role is not None and role not in self._by_role_id:
            raise KeyError("role")
        new_role = role or user.role
        if new_role != user.role:
            self._assert_recovery_possible(role_overrides={username: new_role})
        updated = user.model_copy(update={
            "password_hash": hash_password(password) if password else user.password_hash,
            "role": new_role,
            # Invalidates every session already issued for this user — see
            # models.py's User.session_version.
            "session_version": user.session_version + 1 if password else user.session_version,
        })
        self._by_username[username] = updated
        self._save()
        return updated

    def delete(self, username: str) -> None:
        user = self._by_username.get(username)
        if user is None:
            raise KeyError(username)
        self._assert_recovery_possible(exclude_username=username)
        del self._by_username[username]
        self._save()

    # --- roles ---------------------------------------------------------------

    def list_roles(self) -> list[Role]:
        return list(self._by_role_id.values())

    def get_role(self, role_id: str) -> Role | None:
        return self._by_role_id.get(role_id)

    def create_role(self, name: str, permissions: list[str]) -> Role:
        name = name.strip()
        role_id = slugify(name)
        base_id, suffix = role_id, 2
        while role_id in self._by_role_id:
            role_id = f"{base_id}-{suffix}"
            suffix += 1
        role = Role(id=role_id, name=name, permissions=permissions)
        self._by_role_id[role_id] = role
        self._save()
        return role

    def update_role(self, role_id: str, *, name: str | None = None, permissions: list[str] | None = None) -> Role:
        role = self._by_role_id.get(role_id)
        if role is None:
            raise KeyError(role_id)
        if permissions is not None:
            self._assert_recovery_possible(role_permission_overrides={role_id: permissions})
        updated = role.model_copy(update={
            "name": name.strip() if name else role.name,
            "permissions": role.permissions if permissions is None else permissions,
        })
        self._by_role_id[role_id] = updated
        self._save()
        return updated

    def delete_role(self, role_id: str) -> None:
        if role_id not in self._by_role_id:
            raise KeyError(role_id)
        in_use = sum(1 for u in self._by_username.values() if u.role == role_id)
        if in_use:
            noun = "user" if in_use == 1 else "users"
            verb = "has" if in_use == 1 else "have"
            raise ValueError(
                f"{in_use} {noun} still {verb} this role — "
                "reassign or delete them first."
            )
        del self._by_role_id[role_id]
        self._save()

    # --- the "don't lock yourself out" invariant ----------------------------
    # At least one user must always hold both manage_users and manage_roles —
    # the minimum needed to recover from any misconfiguration without hand-
    # editing users.yaml. Every mutation that could shrink that set (delete a
    # user, change a user's role, strip permissions from a role) checks this
    # first, against the state as it would be *after* the change.

    def _assert_recovery_possible(
        self,
        *,
        exclude_username: str | None = None,
        role_overrides: dict[str, str] | None = None,
        role_permission_overrides: dict[str, list[str]] | None = None,
    ) -> None:
        role_overrides = role_overrides or {}
        role_permission_overrides = role_permission_overrides or {}

        def permissions_of(role_id: str) -> list[str]:
            if role_id in role_permission_overrides:
                return role_permission_overrides[role_id]
            role = self._by_role_id.get(role_id)
            return list(role.permissions) if role else []

        for username, user in self._by_username.items():
            if username == exclude_username:
                continue
            role_id = role_overrides.get(username, user.role)
            perms = permissions_of(role_id)
            if "manage_users" in perms and "manage_roles" in perms:
                return
        raise ValueError(
            "This would leave no user able to manage users and roles — "
            "nobody could recover from a mistake without hand-editing users.yaml."
        )

    def _save(self) -> None:
        _write(self.session_secret, self.list(), self.list_roles())
