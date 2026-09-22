"""Fixtures. Every app is built against tmp_path files; the printer
connection loop is stubbed; Moonraker HTTP is faked via `fake_moonraker`."""

from __future__ import annotations

import shutil
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from app import auth
from app.config import EXAMPLE_FILE
from app.main import create_app
from app.moonraker import PrinterManager

ADMIN = {"username": "admin", "password": "adminpass1"}


@pytest.fixture(autouse=True)
def _isolate(monkeypatch):
    """No printer sockets, no leaked lockout state, no accidental admin bootstrap."""

    async def no_start(self):
        return None

    monkeypatch.setattr(PrinterManager, "start", no_start)
    monkeypatch.delenv("PRINTDECK_ADMIN_USERNAME", raising=False)
    monkeypatch.delenv("PRINTDECK_ADMIN_PASSWORD", raising=False)
    auth._backoff._entries.clear()
    yield
    auth._backoff._entries.clear()


@pytest.fixture
def data_dir(tmp_path: Path) -> Path:
    shutil.copy(EXAMPLE_FILE, tmp_path / "printers.yaml")
    return tmp_path


@pytest.fixture
def make_app(data_dir):
    def _make(*, admin: bool = False):
        if admin:
            import os

            os.environ["PRINTDECK_ADMIN_USERNAME"] = ADMIN["username"]
            os.environ["PRINTDECK_ADMIN_PASSWORD"] = ADMIN["password"]
        try:
            return create_app(printers_file=data_dir / "printers.yaml", users_file=data_dir / "users.yaml")
        finally:
            if admin:
                del os.environ["PRINTDECK_ADMIN_USERNAME"]
                del os.environ["PRINTDECK_ADMIN_PASSWORD"]

    return _make


@pytest.fixture
def open_client(make_app):
    """Auth disabled: no users configured."""
    with TestClient(make_app()) as client:
        yield client


@pytest.fixture
def auth_app(make_app):
    return make_app(admin=True)


@pytest.fixture
def anon_client(auth_app):
    """Auth enabled, nobody signed in."""
    with TestClient(auth_app) as client:
        yield client


@pytest.fixture
def admin_client(auth_app):
    with TestClient(auth_app) as client:
        assert client.post("/auth/login", json=ADMIN).status_code == 200
        yield client


@pytest.fixture
def viewer_client(admin_client, auth_app):
    """A second session, on a role with no permissions at all."""
    assert admin_client.post("/api/roles", json={"name": "Viewer", "permissions": []}).status_code == 200
    assert admin_client.post(
        "/api/users", json={"username": "viewer", "password": "viewerpass", "role": "viewer"}
    ).status_code == 200
    client = TestClient(auth_app)
    assert client.post("/auth/login", json={"username": "viewer", "password": "viewerpass"}).status_code == 200
    return client


class FakeMoonraker:
    """Records requests; answers from `responses` (path -> Response or callable)."""

    def __init__(self):
        self.requests: list[httpx.Request] = []
        self.responses: dict[str, object] = {}

    def on(self, path: str, response):
        self.responses[path] = response

    async def handle(self, request: httpx.Request) -> httpx.Response:
        await request.aread()
        self.requests.append(request)
        handler = self.responses.get(request.url.path)
        if handler is None:
            return httpx.Response(404, json={"error": {"message": f"no fake for {request.url.path}"}})
        if callable(handler):
            return handler(request)
        return handler

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handle)

    @property
    def last(self) -> httpx.Request:
        return self.requests[-1]


@pytest.fixture
def fake_moonraker(open_client):
    fake = FakeMoonraker()
    app = open_client.app
    app.state.http = httpx.AsyncClient(transport=fake.transport())
    return fake
