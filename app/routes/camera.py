"""WebRTC signaling relay. The K1C camera is a tiny WebRTC server on :8000
that takes a base64 SDP offer at /call/webrtc_local. The browser can't POST
there (cross-origin), so we relay that one exchange. Video goes peer-to-peer,
never through here."""

from __future__ import annotations

import base64
import json

import httpx
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from .common import http_client

router = APIRouter()


class Offer(BaseModel):
    sdp: str = Field(max_length=65536)
    type: str = "offer"


async def negotiate(http: httpx.AsyncClient, signaling_url: str, sdp: str) -> dict:
    payload = base64.b64encode(json.dumps({"type": "offer", "sdp": sdp}).encode())
    # 15s: includes DNS, and a cold .local lookup on Windows can take ~10s.
    resp = await http.post(
        signaling_url, content=payload, headers={"Content-Type": "plain/text"}, timeout=15
    )
    resp.raise_for_status()
    return json.loads(base64.b64decode(resp.content))


@router.post("/printers/{printer_id}/camera/offer")
async def camera_offer(request: Request, printer_id: str, offer: Offer) -> dict:
    config = request.app.state.manager.config(printer_id)
    if config is None or not config.camera_url:
        raise HTTPException(status_code=404, detail="no camera for this printer")
    signaling_url = config.camera_url.rstrip("/") + "/call/webrtc_local"
    try:
        return await negotiate(http_client(request), signaling_url, offer.sdp)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"camera negotiation failed: {exc}")
