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

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(name)s  %(message)s")

WEB_DIR = Path(__file__).resolve().parent.parent / "web"


@asynccontextmanager
async def lifespan(app: FastAPI):
    manager = PrinterManager(load_printers())
    app.state.manager = manager
    await manager.start()
    try:
        yield
    finally:
        await manager.stop()


app = FastAPI(title="PrintDeck", lifespan=lifespan)

# Signed session cookie for logins. http_only by default; not https-only since
# this runs over plain HTTP on a LAN (put it behind HTTPS to expose it wider).
app.add_middleware(
    SessionMiddleware, secret_key=auth.SECRET, same_site="lax", https_only=False
)

# Public: login/logout + session probe.
app.include_router(auth.router)
# Protected: the printer data only flows once you're logged in. The WebSocket
# guards itself (see routes.py) since dependencies don't gate ws handshakes.
gated = [Depends(auth.require_user)]
app.include_router(routes.api_router, dependencies=gated)
app.include_router(routes.ws_router)


@app.get("/login", include_in_schema=False)
def login_page() -> FileResponse:
    return FileResponse(WEB_DIR / "login.html")


@app.get("/", include_in_schema=False)
def index(request: Request):
    if auth.auth_enabled() and not request.session.get("user"):
        return RedirectResponse("/login")
    return FileResponse(WEB_DIR / "index.html")


# Static assets (app.js, style.css, the login page). Mounted last so the routes
# above win; these files aren't secret — the data behind them is what's gated.
app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
