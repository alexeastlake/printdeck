"""Login, sessions, lockout, permission gate, users/roles API."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.models import ALL_PERMISSIONS

ADMIN = {"username": "admin", "password": "adminpass1"}  # matches conftest's bootstrap


# --- open mode -------------------------------------------------------------

def test_open_mode_reports_every_permission_and_allows_writes(open_client):
    session = open_client.get("/api/session").json()
    assert session["enabled"] is False and session["user"] is None
    assert set(session["permissions"]) == set(ALL_PERMISSIONS)
    # No login needed, and the pages don't redirect.
    assert open_client.get("/", follow_redirects=False).status_code == 200
    assert open_client.get("/users", follow_redirects=False).status_code == 200
    assert open_client.post("/api/printers", json={"name": "New", "host": "10.0.0.9"}).status_code == 200
    login = open_client.post("/auth/login", json={"username": "x", "password": "y"}).json()
    assert login["ok"] and set(login["permissions"]) == set(ALL_PERMISSIONS)


def test_open_mode_websocket_streams_snapshot(open_client):
    with open_client.websocket_connect("/ws") as ws:
        msg = ws.receive_json()
        assert msg["type"] == "snapshot" and [p["id"] for p in msg["printers"]] == ["k1c"]


# --- auth mode: gate -------------------------------------------------------

def test_anonymous_is_bounced(anon_client):
    assert anon_client.get("/api/session").json() == {
        "enabled": True, "user": None, "role": None, "role_name": None, "permissions": [],
    }
    assert anon_client.get("/api/printers").status_code == 401
    assert anon_client.post("/api/printers", json={"name": "x", "host": "1.1.1.1"}).status_code == 401
    for page in ("/", "/printer/k1c", "/users", "/roles"):
        r = anon_client.get(page, follow_redirects=False)
        assert r.status_code == 307 and r.headers["location"] == "/login", page
    assert anon_client.get("/login").status_code == 200
    with pytest.raises(WebSocketDisconnect):
        with anon_client.websocket_connect("/ws"):
            pass


def test_login_wrong_password_and_success(anon_client):
    r = anon_client.post("/auth/login", json={"username": ADMIN["username"], "password": "wrong"})
    assert r.status_code == 401
    r = anon_client.post("/auth/login", json={"username": "nobody", "password": "wrong"})
    assert r.status_code == 401  # same answer for unknown users
    r = anon_client.post("/auth/login", json=ADMIN)
    assert r.status_code == 200 and r.json()["user"] == "admin" and "manage_roles" in r.json()["permissions"]
    session = anon_client.get("/api/session").json()
    assert session["user"] == "admin" and session["role_name"] == "Admin"
    assert anon_client.get("/api/printers").status_code == 200
    with anon_client.websocket_connect("/ws") as ws:
        assert ws.receive_json()["type"] == "snapshot"
    anon_client.post("/auth/logout")
    assert anon_client.get("/api/session").json()["user"] is None


def test_websocket_rejects_cross_origin(admin_client):
    with pytest.raises(WebSocketDisconnect):
        with admin_client.websocket_connect("/ws", headers={"origin": "http://evil.example"}):
            pass
    with admin_client.websocket_connect("/ws", headers={"origin": "http://testserver"}) as ws:
        assert ws.receive_json()["type"] == "snapshot"


def test_lockout_is_per_username_across_clients(auth_app):
    with TestClient(auth_app) as a:
        for _ in range(5):
            assert a.post("/auth/login", json={"username": "admin", "password": "wrong"}).status_code == 401
        r = a.post("/auth/login", json=ADMIN)
        assert r.status_code == 429 and "Try again" in r.json()["detail"]
        # Same source IP either way; the unit test below covers per-username.
        b = TestClient(auth_app)
        assert b.post("/auth/login", json=ADMIN).status_code == 429


def test_backoff_tracks_username_and_ip_independently():
    from app.auth import MAX_ATTEMPTS, _LoginBackoff

    backoff = _LoginBackoff()
    for _ in range(MAX_ATTEMPTS):
        backoff.record_failure(["ip:1.1.1.1", "user:alice"])
    assert backoff.locked_for(["ip:9.9.9.9", "user:alice"]) > 0
    assert backoff.locked_for(["ip:1.1.1.1", "user:bob"]) > 0
    assert backoff.locked_for(["ip:2.2.2.2", "user:bob"]) == 0
    backoff.clear(["ip:1.1.1.1", "user:alice"])
    assert backoff.locked_for(["ip:1.1.1.1", "user:alice"]) == 0


def test_backoff_evicts_stale_entries(monkeypatch):
    import time

    from app import auth

    backoff = auth._LoginBackoff()
    now = 1000.0
    monkeypatch.setattr(time, "monotonic", lambda: now)
    backoff.record_failure(["user:old"])
    assert "user:old" in backoff._entries
    now += auth.FAILURE_TTL + 1
    backoff.locked_for(["user:other"])  # any call sweeps
    assert "user:old" not in backoff._entries


def test_password_change_invalidates_existing_session(admin_client, viewer_client):
    assert viewer_client.get("/api/session").json()["user"] == "viewer"
    assert admin_client.patch("/api/users/viewer", json={"password": "changed-pass1"}).status_code == 200
    assert viewer_client.get("/api/session").json()["user"] is None
    assert viewer_client.get("/api/printers").status_code == 401


def test_deleting_a_user_kicks_them(admin_client, viewer_client):
    assert admin_client.delete("/api/users/viewer").status_code == 200
    assert viewer_client.get("/api/printers").status_code == 401


# --- permissions -----------------------------------------------------------

def test_viewer_can_read_but_not_write(viewer_client):
    assert viewer_client.get("/api/printers").status_code == 200
    assert viewer_client.get("/api/roles").status_code == 200
    assert viewer_client.get("/api/permissions").status_code == 200
    assert viewer_client.get("/", follow_redirects=False).status_code == 200
    # Pages that need a permission bounce to the dashboard, not to login.
    for page in ("/users", "/roles"):
        r = viewer_client.get(page, follow_redirects=False)
        assert r.status_code == 307 and r.headers["location"] == "/"
    forbidden = [
        ("post", "/api/printers", {"name": "x", "host": "1.1.1.1"}),
        ("patch", "/api/printers/k1c", {"name": "x"}),
        ("delete", "/api/printers/k1c", None),
        ("post", "/api/printers/k1c/gcode", {"script": "G28"}),
        ("post", "/api/printers/k1c/job/pause", None),
        ("post", "/api/printers/k1c/creality/light", {"on": True}),
        ("post", "/api/printers/k1c/job/start", {"filename": "a.gcode"}),
        ("post", "/api/printers/k1c/files/folder", {"path": "", "name": "x"}),
        ("post", "/api/printers/k1c/files/rename", {"path": "a", "new_name": "b"}),
        ("delete", "/api/printers/k1c/files?path=a", None),
        ("delete", "/api/printers/k1c/history/00001A", None),
        ("delete", "/api/printers/k1c/history", None),
        ("get", "/api/users", None),
        ("post", "/api/users", {"username": "z", "password": "zzzzzzzz", "role": "viewer"}),
        ("post", "/api/roles", {"name": "z"}),
        ("patch", "/api/roles/viewer", {"name": "z"}),
        ("delete", "/api/roles/viewer", None),
    ]
    for method, url, body in forbidden:
        r = getattr(viewer_client, method)(url, json=body) if body is not None else getattr(viewer_client, method)(url)
        assert r.status_code == 403, (method, url, r.status_code)


# --- users endpoints -------------------------------------------------------

@pytest.mark.parametrize("username", ["a/b", "", " ", "x" * 33, "-lead", "sp ace", "ünï"])
def test_username_validation(admin_client, username):
    r = admin_client.post("/api/users", json={"username": username, "password": "longenough", "role": "admin"})
    assert r.status_code == 400


def test_password_rules(admin_client):
    assert admin_client.post("/api/users", json={"username": "u", "password": "short", "role": "admin"}).status_code == 400
    assert admin_client.post("/api/users", json={"username": "u", "password": "x" * 300, "role": "admin"}).status_code == 422
    assert admin_client.patch("/api/users/admin", json={"password": "short"}).status_code == 400


def test_user_crud_and_guards(admin_client):
    assert admin_client.post("/api/users", json={"username": "u", "password": "longenough", "role": "nope"}).status_code == 400
    r = admin_client.post("/api/users", json={"username": "u", "password": "longenough", "role": "admin"})
    assert r.status_code == 200 and r.json() == {"username": "u", "role": "admin"}
    assert admin_client.post("/api/users", json={"username": "u", "password": "longenough", "role": "admin"}).status_code == 409
    assert {u["username"] for u in admin_client.get("/api/users").json()} == {"admin", "u"}
    assert admin_client.patch("/api/users/ghost", json={"role": "admin"}).status_code == 404
    assert admin_client.patch("/api/users/u", json={"role": "ghost"}).status_code == 400
    assert admin_client.delete("/api/users/ghost").status_code == 404
    # Two admins now, so deleting one is fine; deleting the last is not.
    assert admin_client.delete("/api/users/u").status_code == 200
    assert admin_client.delete("/api/users/admin").status_code == 409


def test_deleting_own_account_ends_session(admin_client):
    admin_client.post("/api/users", json={"username": "other", "password": "longenough", "role": "admin"})
    assert admin_client.delete("/api/users/admin").status_code == 200
    assert admin_client.get("/api/session").json()["user"] is None


# --- roles endpoints -------------------------------------------------------

def test_role_crud(admin_client):
    assert admin_client.post("/api/roles", json={"name": "  "}).status_code == 400
    assert admin_client.post("/api/roles", json={"name": "x", "permissions": ["fly"]}).status_code == 422
    r = admin_client.post("/api/roles", json={"name": "Ops", "permissions": ["control_printers"]})
    assert r.status_code == 200 and r.json()["id"] == "ops"
    assert admin_client.post("/api/roles", json={"name": "ops"}).status_code == 409
    assert admin_client.patch("/api/roles/ops", json={"name": "Operators"}).json()["name"] == "Operators"
    assert admin_client.patch("/api/roles/ghost", json={"name": "x"}).status_code == 404
    assert admin_client.delete("/api/roles/ghost").status_code == 404
    assert admin_client.delete("/api/roles/ops").status_code == 200


def test_cannot_edit_own_roles_permissions(admin_client):
    r = admin_client.patch("/api/roles/admin", json={"permissions": ["manage_users", "manage_roles"]})
    assert r.status_code == 403
    assert admin_client.patch("/api/roles/admin", json={"name": "Administrator"}).status_code == 200
    # Another role's permissions are fair game (within the recovery invariant).
    admin_client.post("/api/roles", json={"name": "Ops", "permissions": []})
    assert admin_client.patch("/api/roles/ops", json={"permissions": ["manage_files"]}).status_code == 200


def test_cannot_strip_last_recovery_role_via_api(admin_client):
    admin_client.post("/api/roles", json={"name": "Second", "permissions": list(ALL_PERMISSIONS)})
    admin_client.post("/api/users", json={"username": "s", "password": "longenough", "role": "second"})
    assert admin_client.patch("/api/roles/second", json={"permissions": []}).status_code == 200
    # Moving admin onto the now-empty role would leave nobody.
    assert admin_client.patch("/api/users/admin", json={"role": "second"}).status_code == 409
