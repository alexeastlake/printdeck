"""users.yaml: users, roles, and the session-cookie signing secret.

No example file is shipped (even a fake password hash in the repo is a bad
habit). No users.yaml and no PRINTDECK_ADMIN_* env → auth disabled.
"""

from __future__ import annotations

import os
import secrets
import threading
from pathlib import Path

import yaml

from .models import ALL_PERMISSIONS, Role, User
from .security import hash_password, verify_password
from .utils import atomic_write_text, slugify

ROOT = Path(__file__).resolve().parent.parent

# Pre-roles files had a bare "admin"/"viewer" string in `role`. Used only by
# the one-time migration below.
_LEGACY_ROLE_PERMISSIONS = {"admin": list(ALL_PERMISSIONS), "viewer": []}


def default_users_file() -> Path:
    return Path(os.environ.get("PRINTDECK_USERS") or ROOT / "users.yaml")


def _read(path: Path) -> dict:
    if not path.exists():
        return {}
    return yaml.safe_load(path.read_text(encoding="utf-8")) or {}


def _write(path: Path, session_secret: str, users: list[User], roles: list[Role]) -> None:
    data = {
        "session_secret": session_secret,
        "roles": [r.model_dump() for r in roles],
        "users": [u.model_dump() for u in users],
    }
    atomic_write_text(path, yaml.safe_dump(data, sort_keys=False, allow_unicode=True))


def load_or_bootstrap(path: Path) -> tuple[str, list[User], list[Role]]:
    """Read users.yaml; create/migrate it if missing or old-shaped.

    PRINTDECK_ADMIN_USERNAME/PASSWORD add that account if it's missing and
    never overwrite an existing one. That doubles as password recovery:
    delete the user's entry, restart with the env vars set.

    A file with no `roles` key is pre-roles: synthesize admin/viewer for
    whichever are still referenced. Never touches a file that has `roles`.
    """
    data = _read(path)
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
            admin_role = Role(id="admin", name="Admin", permissions=list(ALL_PERMISSIONS))
            roles.append(admin_role)
        users.append(User(
            username=admin_username,
            password_hash=hash_password(admin_password),
            role=admin_role.id,
        ))
        changed = True

    if changed:
        _write(path, secret, users, roles)

    return secret, users, roles


class UserStore:
    """In-memory, written back on every mutation. Raises KeyError("user") /
    KeyError("role") for a missing record and ValueError for a rule violation.

    The auth routes are sync `def` (PBKDF2 off the event loop), so FastAPI
    runs them on worker threads, hence the lock around mutations."""

    def __init__(self, path: Path, session_secret: str, users: list[User], roles: list[Role]) -> None:
        self._path = path
        self.session_secret = session_secret
        self._by_username: dict[str, User] = {u.username: u for u in users}
        self._by_role_id: dict[str, Role] = {r.id: r for r in roles}
        self._lock = threading.RLock()

    # --- users -------------------------------------------------------------

    def list(self) -> list[User]:
        with self._lock:
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
        with self._lock:
            if username in self._by_username:
                raise ValueError(f'"{username}" already exists.')
            if role not in self._by_role_id:
                raise KeyError("role")
            user = User(username=username, password_hash=hash_password(password), role=role)
            self._by_username[username] = user
            self._save()
            return user

    def update(self, username: str, *, password: str | None = None, role: str | None = None) -> User:
        with self._lock:
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
                "session_version": user.session_version + 1 if password else user.session_version,
            })
            self._by_username[username] = updated
            self._save()
            return updated

    def delete(self, username: str) -> None:
        with self._lock:
            user = self._by_username.get(username)
            if user is None:
                raise KeyError("user")
            self._assert_recovery_possible(exclude_username=username)
            del self._by_username[username]
            self._save()

    # --- roles ---------------------------------------------------------------

    def list_roles(self) -> list[Role]:
        with self._lock:
            return list(self._by_role_id.values())

    def get_role(self, role_id: str) -> Role | None:
        return self._by_role_id.get(role_id)

    def _assert_role_name_free(self, name: str, *, except_id: str | None = None) -> None:
        # Names are what show in dropdowns; "Admin" and "admin" both existing is a trap.
        wanted = name.casefold()
        for role in self._by_role_id.values():
            if role.id != except_id and role.name.casefold() == wanted:
                raise ValueError(f'A role named "{role.name}" already exists.')

    def create_role(self, name: str, permissions: list[str]) -> Role:
        with self._lock:
            name = name.strip()
            self._assert_role_name_free(name)
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
        with self._lock:
            role = self._by_role_id.get(role_id)
            if role is None:
                raise KeyError("role")
            if name:
                name = name.strip()
                self._assert_role_name_free(name, except_id=role_id)
            if permissions is not None:
                self._assert_recovery_possible(role_permission_overrides={role_id: permissions})
            updated = role.model_copy(update={
                "name": name if name else role.name,
                "permissions": role.permissions if permissions is None else permissions,
            })
            self._by_role_id[role_id] = updated
            self._save()
            return updated

    def delete_role(self, role_id: str) -> None:
        with self._lock:
            if role_id not in self._by_role_id:
                raise KeyError("role")
            in_use = sum(1 for u in self._by_username.values() if u.role == role_id)
            if in_use:
                noun = "user" if in_use == 1 else "users"
                verb = "has" if in_use == 1 else "have"
                raise ValueError(
                    f"{in_use} {noun} still {verb} this role. "
                    "reassign or delete them first."
                )
            del self._by_role_id[role_id]
            self._save()

    # --- don't lock yourself out ---------------------------------------------
    # Someone must always hold manage_users + manage_roles, or the only way
    # back is hand-editing users.yaml. Checked against the post-change state.

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
            "This would leave no user able to manage users and roles. "
            "nobody could recover from a mistake without hand-editing users.yaml."
        )

    def _save(self) -> None:
        _write(self._path, self.session_secret, self.list(), self.list_roles())
