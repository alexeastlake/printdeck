"""PrintDeck — a small local dashboard for Moonraker printers.

Run it with:  uvicorn app.main:app --reload  (then open http://localhost:8000)

One process serves both the JSON/websocket API and the static page in web/.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from .api import camera, printers, stream
from .config import load_printers
from .moonraker.manager import PrinterManager

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

app.include_router(printers.router)
app.include_router(stream.router)
app.include_router(camera.router)

# Serve the hand-written frontend at the root. html=True makes "/" return
# index.html. Mounted last so it doesn't shadow the API routes above.
app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
