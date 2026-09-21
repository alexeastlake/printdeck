"""PrintDeck — a small local dashboard for Moonraker printers.

Run it with:  uvicorn app.main:app --reload  (then open http://localhost:8000)

One process serves both the JSON/websocket API and the static page in web/.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, Request
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.sessions import SessionMiddleware

from . import auth, routes
from .config import load_printers
from .moonraker import PrinterManager
from .users_store import UserStore, load_or_bootstrap

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(name)s  %(message)s")
log = logging.getLogger("printdeck.auth")

WEB_DIR = Path(__file__).resolve().parent.parent / "web"

# Needed before SessionMiddleware is constructed below, so this runs at
# import time rather than in the async lifespan — same spot the old fixed
# SECRET constant used to live. The secret is persisted in users.yaml (see
# users_store.load_or_bootstrap), so — unlike before — logins now survive a
# server restart.
_session_secret, _initial_users, _initial_roles = load_or_bootstrap()
if not _initial_users:
    log.warning(
        "AUTH DISABLED — no users configured. Set PRINTDECK_ADMIN_USERNAME and "
        "PRINTDECK_ADMIN_PASSWORD (or add one to users.yaml) to require a "
        "login. Right now anyone who can reach this server sees your printers."
    )


@asynccontextmanager
async def lifespan(app: FastAPI):
    manager = PrinterManager(load_printers())
    app.state.manager = manager
    app.state.users = UserStore(_session_secret, _initial_users, _initial_roles)
    await manager.start()
    try:
        yield
    finally:
        await manager.stop()


app = FastAPI(title="PrintDeck", lifespan=lifespan)

# Signed session cookie for logins. http_only by default; not https-only since
# this runs over plain HTTP on a LAN (put it behind HTTPS to expose it wider).
app.add_middleware(
    SessionMiddleware, secret_key=_session_secret, same_site="lax", https_only=False
)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    """Baseline hardening headers — cheap, and there's no reason not to."""
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "same-origin"
    return response


# Public: login/logout + session probe. User/role management lives here too
# (each of those endpoints gates itself with require_permission — see auth.py).
app.include_router(auth.router)
# Protected: the printer data only flows once you're logged in — any role.
# Mutating endpoints additionally require specific permissions (declared
# per-endpoint in routes.py — a plain viewer-equivalent role grants none of
# them). The WebSocket guards itself (see routes.py) since dependencies
# don't gate ws handshakes.
gated = [Depends(auth.require_user)]
app.include_router(routes.api_router, dependencies=gated)
app.include_router(routes.ws_router)


@app.get("/login", include_in_schema=False)
def login_page() -> FileResponse:
    return FileResponse(WEB_DIR / "login.html")


def _page(request: Request, filename: str, *, require_permission: str | None = None):
    """Serve a page from web/, bouncing to /login if auth is on and no one's
    signed in (or their session's since been invalidated), or to / if the
    page needs a permission the session doesn't (still, right now) have."""
    if auth.auth_enabled(request):
        permissions = auth.current_permissions(request)
        if permissions is None:
            return RedirectResponse("/login")
        if require_permission and require_permission not in permissions:
            return RedirectResponse("/")
    return FileResponse(WEB_DIR / filename)


@app.get("/", include_in_schema=False)
def index(request: Request):
    return _page(request, "index.html")


@app.get("/printer/{printer_id}", include_in_schema=False)
def printer_detail(request: Request, printer_id: str):
    # The id lives in the URL for a clean link + so a refresh keeps working;
    # the page itself is generic and reads it back out of location.pathname.
    return _page(request, "detail.html")


@app.get("/users", include_in_schema=False)
def users_page(request: Request):
    return _page(request, "users.html", require_permission="manage_users")


@app.get("/roles", include_in_schema=False)
def roles_page(request: Request):
    return _page(request, "roles.html", require_permission="manage_roles")


# Static assets (app.js, style.css, the login page). Mounted last so the routes
# above win; these files aren't secret — the data behind them is what's gated.
app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
