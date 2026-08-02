"""Optional username/password gate for the dashboard.

Auth turns on when both PRINTDECK_USERNAME and PRINTDECK_PASSWORD are set in the
environment. When they aren't, the dashboard stays open (handy for local dev)
and we log a loud warning. Login issues a signed session cookie; the signing key
is generated fresh each start, so logins reset when the server restarts.

Credentials never live in the repo — they come from the environment, so a public
clone ships nothing secret.
"""

from __future__ import annotations

import hmac
import logging
import os
import secrets

from fastapi import APIRouter, HTTPException, Request, WebSocket
from pydantic import BaseModel

log = logging.getLogger("printdeck.auth")

USERNAME = os.environ.get("PRINTDECK_USERNAME", "")
PASSWORD = os.environ.get("PRINTDECK_PASSWORD", "")
# Session-cookie signing key, regenerated each start (so logins reset on restart).
SECRET = secrets.token_urlsafe(32)


def auth_enabled() -> bool:
    return bool(USERNAME and PASSWORD)


if not auth_enabled():
    log.warning(
        "AUTH DISABLED — set PRINTDECK_USERNAME and PRINTDECK_PASSWORD to require "
        "a login. Right now anyone who can reach this server sees your printers."
    )

router = APIRouter()


class Credentials(BaseModel):
    username: str
    password: str


def _matches(given: str, expected: str) -> bool:
    return hmac.compare_digest(given.encode(), expected.encode())


@router.post("/auth/login")
def login(request: Request, creds: Credentials) -> dict:
    if not auth_enabled():
        return {"ok": True, "user": None}
    # Compare both fields before deciding, so timing doesn't reveal which was wrong.
    user_ok = _matches(creds.username, USERNAME)
    pass_ok = _matches(creds.password, PASSWORD)
    if not (user_ok and pass_ok):
        raise HTTPException(status_code=401, detail="Wrong username or password.")
    request.session["user"] = creds.username
    return {"ok": True, "user": creds.username}


@router.post("/auth/logout")
def logout(request: Request) -> dict:
    request.session.clear()
    return {"ok": True}


@router.get("/api/session")
def session_info(request: Request) -> dict:
    """Public: lets the frontend show a Sign out button (and who's logged in)."""
    return {"enabled": auth_enabled(), "user": request.session.get("user")}


def require_user(request: Request) -> str:
    """FastAPI dependency: 401 unless logged in (or auth is disabled)."""
    if not auth_enabled():
        return "anonymous"
    user = request.session.get("user")
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return user


def ws_authorized(websocket: WebSocket) -> bool:
    if not auth_enabled():
        return True
    return bool(websocket.session.get("user"))
