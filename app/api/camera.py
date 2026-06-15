"""WebRTC signaling proxy for printer cameras.

The K1C's camera is a tiny WebRTC-only server on :8000. Its page does the
handshake by POSTing a base64'd SDP offer to /call/webrtc_local and getting a
base64'd answer back. The browser can't POST there itself (cross-origin), so we
relay that one exchange here; the actual video then flows peer-to-peer from the
printer straight to the browser, never through this process.
"""

from __future__ import annotations

import asyncio
import base64
import json
import urllib.request

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

router = APIRouter(prefix="/api")


class Offer(BaseModel):
    sdp: str
    type: str = "offer"


def _negotiate(signaling_url: str, sdp: str) -> dict:
    """Relay one offer/answer exchange to the printer's WebRTC server (blocking,
    so callers should run it off the event loop)."""
    payload = base64.b64encode(
        json.dumps({"type": "offer", "sdp": sdp}).encode()
    )
    req = urllib.request.Request(
        signaling_url,
        data=payload,
        headers={"Content-Type": "plain/text"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        body = resp.read()
    return json.loads(base64.b64decode(body))


@router.post("/printers/{printer_id}/camera/offer")
async def camera_offer(request: Request, printer_id: str, offer: Offer) -> dict:
    config = request.app.state.manager.config(printer_id)
    if config is None or not config.camera_url:
        raise HTTPException(status_code=404, detail="no camera for this printer")
    signaling_url = config.camera_url.rstrip("/") + "/call/webrtc_local"
    try:
        return await asyncio.to_thread(_negotiate, signaling_url, offer.sdp)
    except Exception as exc:  # printer offline, refused, malformed answer, ...
        raise HTTPException(status_code=502, detail=f"camera negotiation failed: {exc}")
