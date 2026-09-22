"""App factory. Run with:  uvicorn --factory app.main:create_app --reload

No module-level `app`: building it reads (and on first run writes)
users.yaml, and tests need to build one against scratch files.
"""

from __future__ import annotations

import hashlib
import logging
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from fastapi import Depends, FastAPI, Request
from fastapi.responses import HTMLResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.middleware.sessions import SessionMiddleware
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from . import auth, routes
from .config import default_printers_file, load_printers
from .moonraker import PrinterManager
from .users_store import UserStore, default_users_file, load_or_bootstrap

log = logging.getLogger("printdeck")

WEB_DIR = Path(__file__).resolve().parent.parent / "web"
PAGES_DIR = WEB_DIR / "pages"    # served only via the routes below, never as static files
STATIC_DIR = WEB_DIR / "static"

# No inline script or style="" anywhere in web/. Keep it that way or this
# breaks the page silently. JS may still set element.style.*.
CONTENT_SECURITY_POLICY = "; ".join([
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",  # data: for the select arrow in style.css
    "media-src 'self' blob:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
])

SECURITY_HEADERS = {
    b"content-security-policy": CONTENT_SECURITY_POLICY.encode(),
    b"x-content-type-options": b"nosniff",
    b"x-frame-options": b"DENY",
    b"referrer-policy": b"same-origin",
    b"permissions-policy": b"camera=(), microphone=(), geolocation=()",
}


def static_version(directory: Path) -> str:
    """Content hash of web/static, baked into every asset URL so a deploy
    can't leave a browser on stale JS. Those URLs are then cacheable forever."""
    digest = hashlib.sha256()
    for path in sorted(p for p in directory.rglob("*") if p.is_file()):
        digest.update(str(path.relative_to(directory)).encode())
        digest.update(path.read_bytes())
    return digest.hexdigest()[:12]


class CachedStaticFiles(StaticFiles):
    def file_response(self, *args, **kwargs) -> Response:
        response = super().file_response(*args, **kwargs)
        response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return response


class SecurityHeadersMiddleware:
    """Raw ASGI rather than @app.middleware("http"), which wraps every
    response in a streaming shim with known rough edges."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_with_headers(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = list(message.get("headers", []))
                headers.extend(SECURITY_HEADERS.items())
                message["headers"] = headers
            await send(message)

        await self.app(scope, receive, send_with_headers)


def create_app(*, printers_file: Path | None = None, users_file: Path | None = None) -> FastAPI:
    printers_file = printers_file or default_printers_file()
    users_file = users_file or default_users_file()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(name)s  %(message)s")

    # SessionMiddleware needs the secret at construction, so this can't wait for lifespan.
    session_secret, initial_users, initial_roles = load_or_bootstrap(users_file)
    if not initial_users:
        log.warning(
            "AUTH DISABLED: no users configured. Set PRINTDECK_ADMIN_USERNAME and "
            "PRINTDECK_ADMIN_PASSWORD (or add one to users.yaml) to require a "
            "login. Right now anyone who can reach this server can see AND "
            "control your printers."
        )

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        manager = PrinterManager(load_printers(printers_file), printers_file)
        app.state.manager = manager
        app.state.users = UserStore(users_file, session_secret, initial_users, initial_roles)
        app.state.http = httpx.AsyncClient()  # shared pool; timeouts are per call
        await manager.start()
        try:
            yield
        finally:
            await manager.stop()
            await app.state.http.aclose()

    app = FastAPI(title="PrintDeck", lifespan=lifespan)

    # https_only=False on purpose: this is plain HTTP on a LAN.
    app.add_middleware(
        SessionMiddleware, secret_key=session_secret, same_site="lax", https_only=False
    )
    app.add_middleware(SecurityHeadersMiddleware)

    # auth.router is public (login/logout/session); its user/role endpoints gate themselves.
    app.include_router(auth.router)
    # api_router needs a login; writes need specific permissions declared per endpoint.
    # The websocket checks auth itself; dependencies don't run on ws handshakes.
    gated = [Depends(auth.require_user)]
    app.include_router(routes.api_router, dependencies=gated)
    app.include_router(routes.ws_router)

    version = static_version(STATIC_DIR)
    versioned_prefix = f"/static/{version}/"

    def _render_page(filename: str) -> HTMLResponse:
        # The HTML carries the current asset version, so it must revalidate.
        html = (PAGES_DIR / filename).read_text(encoding="utf-8")
        html = html.replace('"/static/', f'"{versioned_prefix}')
        return HTMLResponse(html, headers={"Cache-Control": "no-cache"})

    @app.get("/login", include_in_schema=False)
    def login_page() -> HTMLResponse:
        return _render_page("login.html")

    def _page(request: Request, filename: str, *, require_permission: str | None = None):
        if auth.auth_enabled(request):
            permissions = auth.current_permissions(request)
            if permissions is None:
                return RedirectResponse("/login")
            if require_permission and require_permission not in permissions:
                return RedirectResponse("/")
        return _render_page(filename)

    @app.get("/", include_in_schema=False)
    def index(request: Request):
        return _page(request, "index.html")

    @app.get("/printer/{printer_id}", include_in_schema=False)
    def printer_detail(request: Request, printer_id: str):
        # Generic page; detail.js reads the id from location.pathname.
        return _page(request, "detail.html")

    @app.get("/users", include_in_schema=False)
    def users_page(request: Request):
        return _page(request, "users.html", require_permission="manage_users")

    @app.get("/roles", include_in_schema=False)
    def roles_page(request: Request):
        return _page(request, "roles.html", require_permission="manage_roles")

    # Pages reference the versioned mount; the plain one is for anything linking a bare path.
    app.mount(versioned_prefix.rstrip("/"), CachedStaticFiles(directory=STATIC_DIR), name="static-versioned")
    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

    return app
