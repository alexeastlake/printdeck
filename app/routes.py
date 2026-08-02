"""All the printer-facing endpoints.

api_router — REST (initial paint + fallback) and the camera signaling proxy;
             gated behind auth where it's mounted in main.py.
ws_router  — the /ws live channel. It guards itself, because auth dependencies
             don't run on a WebSocket handshake.
"""

from __future__ import annotations

import asyncio
import base64
import json
import urllib.request

from fastapi import (
    APIRouter,
    HTTPException,
    Request,
    WebSocket,
    WebSocketDisconnect,
)
from pydantic import BaseModel

from .auth import ws_authorized
from .models import PrinterStatus

api_router = APIRouter(prefix="/api")
ws_router = APIRouter()


# --- printer REST ----------------------------------------------------------

class PrinterUpdate(BaseModel):
    # All optional: send only the fields you're changing.
    name: str | None = None
    host: str | None = None


@api_router.get("/printers")
def list_printers(request: Request) -> list[PrinterStatus]:
    return request.app.state.manager.snapshots()


@api_router.get("/printers/{printer_id}/status")
def printer_status(request: Request, printer_id: str) -> PrinterStatus:
    for status in request.app.state.manager.snapshots():
        if status.id == printer_id:
            return status
    raise HTTPException(status_code=404, detail="unknown printer")


@api_router.patch("/printers/{printer_id}")
async def update_printer(
    request: Request, printer_id: str, update: PrinterUpdate
) -> PrinterStatus:
    """Edit a printer's settings at runtime — rename it, or repoint its
    IP/host (for roaming DHCP addresses) — and apply it in place."""
    manager = request.app.state.manager
    old = manager.config(printer_id)
    if old is None:
        raise HTTPException(status_code=404, detail="unknown printer")

    name = old.name
    if update.name is not None:
        name = update.name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="Name can't be empty.")

    host = old.host
    camera_url = old.camera_url
    if update.host is not None:
        host = update.host.strip()
        if not host or any(c.isspace() for c in host) or "/" in host:
            raise HTTPException(
                status_code=400,
                detail="Enter a bare IP or hostname, e.g. 192.168.1.50 — no http:// or spaces.",
            )
        # The IP is also baked into the camera URL; keep them in sync.
        if camera_url and old.host and old.host in camera_url:
            camera_url = camera_url.replace(old.host, host)

    return await manager.update_printer(
        printer_id, name=name, host=host, camera_url=camera_url
    )


# --- camera WebRTC signaling proxy -----------------------------------------
# The K1C's camera is a tiny WebRTC-only server on :8000. Its page does the
# handshake by POSTing a base64'd SDP offer to /call/webrtc_local and getting a
# base64'd answer back. The browser can't POST there itself (cross-origin), so
# we relay that one exchange; the video then flows peer-to-peer from the printer
# straight to the browser, never through this process.

class Offer(BaseModel):
    sdp: str
    type: str = "offer"


def _negotiate(signaling_url: str, sdp: str) -> dict:
    """Relay one offer/answer exchange to the printer's WebRTC server (blocking,
    so callers should run it off the event loop)."""
    payload = base64.b64encode(json.dumps({"type": "offer", "sdp": sdp}).encode())
    req = urllib.request.Request(
        signaling_url,
        data=payload,
        headers={"Content-Type": "plain/text"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        body = resp.read()
    return json.loads(base64.b64decode(body))


@api_router.post("/printers/{printer_id}/camera/offer")
async def camera_offer(request: Request, printer_id: str, offer: Offer) -> dict:
    config = request.app.state.manager.config(printer_id)
    if config is None or not config.camera_url:
        raise HTTPException(status_code=404, detail="no camera for this printer")
    signaling_url = config.camera_url.rstrip("/") + "/call/webrtc_local"
    try:
        return await asyncio.to_thread(_negotiate, signaling_url, offer.sdp)
    except Exception as exc:  # printer offline, refused, malformed answer, ...
        raise HTTPException(status_code=502, detail=f"camera negotiation failed: {exc}")


# --- live channel ----------------------------------------------------------
# A browser connects to /ws, immediately gets a full snapshot of every printer,
# then a steady trickle of per-printer updates as they change.

@ws_router.websocket("/ws")
async def stream(websocket: WebSocket) -> None:
    await websocket.accept()
    if not ws_authorized(websocket):
        await websocket.close(code=1008)  # policy violation — not logged in
        return
    manager = websocket.app.state.manager
    queue = manager.subscribe()
    try:
        # Paint everything we already know before streaming changes.
        await websocket.send_json(
            {
                "type": "snapshot",
                "printers": [s.model_dump() for s in manager.snapshots()],
            }
        )
        while True:
            status = await queue.get()
            await websocket.send_json({"type": "update", "printer": status.model_dump()})
    except WebSocketDisconnect:
        pass
    finally:
        manager.unsubscribe(queue)
