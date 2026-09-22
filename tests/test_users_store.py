"""Bootstrap/migration, the store, and the lock-out invariant."""

from __future__ import annotations

import pytest
import yaml

from app.models import ALL_PERMISSIONS
from app.security import verify_password
from app.users_store import UserStore, load_or_bootstrap


def make_store(path, *, with_admin=True):
    secret, users, roles = load_or_bootstrap(path)
    store = UserStore(path, secret, users, roles)
    if with_admin:
        store.create_role("Admin", list(ALL_PERMISSIONS))
        store.create("admin", "adminpass1", "admin")
    return store


# --- load_or_bootstrap -----------------------------------------------------

def test_fresh_file_gets_secret_and_is_written(tmp_path):
    path = tmp_path / "users.yaml"
    secret, users, roles = load_or_bootstrap(path)
    assert len(secret) > 20 and users == [] and roles == []
    assert yaml.safe_load(path.read_text())["session_secret"] == secret
    # Stable across restarts.
    assert load_or_bootstrap(path)[0] == secret


def test_env_bootstraps_admin_once(tmp_path, monkeypatch):
    path = tmp_path / "users.yaml"
    monkeypatch.setenv("PRINTDECK_ADMIN_USERNAME", "root")
    monkeypatch.setenv("PRINTDECK_ADMIN_PASSWORD", "firstpass1")
    _, users, roles = load_or_bootstrap(path)
    assert [u.username for u in users] == ["root"] and users[0].role == "admin"
    assert roles[0].id == "admin" and set(roles[0].permissions) == set(ALL_PERMISSIONS)
    assert verify_password("firstpass1", users[0].password_hash)

    # Changing the env var later never overwrites an existing account's password.
    monkeypatch.setenv("PRINTDECK_ADMIN_PASSWORD", "different")
    _, users, _ = load_or_bootstrap(path)
    assert verify_password("firstpass1", users[0].password_hash)


def test_legacy_file_gets_roles_synthesized(tmp_path):
    path = tmp_path / "users.yaml"
    path.write_text(yaml.safe_dump({
        "session_secret": "s",
        "users": [
            {"username": "a", "password_hash": "x", "role": "admin"},
            {"username": "v", "password_hash": "x", "role": "viewer"},
        ],
    }))
    _, users, roles = load_or_bootstrap(path)
    by_id = {r.id: r for r in roles}
    assert set(by_id) == {"admin", "viewer"}
    assert set(by_id["admin"].permissions) == set(ALL_PERMISSIONS) and by_id["viewer"].permissions == []
    assert "roles" in yaml.safe_load(path.read_text())  # migrated on disk, one time


# --- users -----------------------------------------------------------------

def test_create_verify_update_delete(tmp_path):
    store = make_store(tmp_path / "users.yaml")
    store.create_role("Viewer", [])
    user = store.create("bob", "bobpass123", "viewer")
    assert store.verify("bob", "bobpass123") is user
    assert store.verify("bob", "nope") is None and store.verify("ghost", "x") is None
    assert store.permissions_for(user) == []

    with pytest.raises(ValueError):
        store.create("bob", "again1234", "viewer")
    with pytest.raises(KeyError):
        store.create("carol", "carolpass1", "no-such-role")

    updated = store.update("bob", password="newpass999")
    assert updated.session_version == user.session_version + 1
    assert store.verify("bob", "newpass999") is not None
    same = store.update("bob", role="viewer")  # role change alone doesn't bump the version
    assert same.session_version == updated.session_version

    store.delete("bob")
    assert store.get("bob") is None
    with pytest.raises(KeyError):
        store.delete("bob")

    # Everything above landed on disk.
    on_disk = yaml.safe_load((tmp_path / "users.yaml").read_text())
    assert [u["username"] for u in on_disk["users"]] == ["admin"]


# --- roles -----------------------------------------------------------------

def test_role_ids_and_names(tmp_path):
    store = make_store(tmp_path / "users.yaml")
    ops = store.create_role("Ops Team", ["control_printers"])
    assert ops.id == "ops-team"
    with pytest.raises(ValueError):
        store.create_role("ops team", [])  # case-insensitive name clash
    with pytest.raises(ValueError):
        store.update_role(ops.id, name="ADMIN")
    assert store.update_role(ops.id, name="Ops").name == "Ops"  # renaming to a free name is fine
    assert store.update_role(ops.id, name="Ops").name == "Ops"  # keeping your own name is fine too

    store.create("op", "operator1", ops.id)
    with pytest.raises(ValueError, match="still"):
        store.delete_role(ops.id)
    store.delete("op")
    store.delete_role(ops.id)
    assert store.get_role(ops.id) is None
    with pytest.raises(KeyError):
        store.delete_role(ops.id)


# --- the invariant ---------------------------------------------------------

def test_cannot_remove_last_recovery_user(tmp_path):
    store = make_store(tmp_path / "users.yaml")
    store.create_role("Viewer", [])
    with pytest.raises(ValueError, match="no user able"):
        store.delete("admin")
    with pytest.raises(ValueError, match="no user able"):
        store.update("admin", role="viewer")
    with pytest.raises(ValueError, match="no user able"):
        store.update_role("admin", permissions=["manage_users"])  # dropping manage_roles
    # With a second recovery-capable user, all of those become fine.
    store.create("backup", "backuppass", "admin")
    store.update("admin", role="viewer")
    store.delete("admin")
    assert [u.username for u in store.list()] == ["backup"]
