"""The printer camera.

The K1C camera is a tiny WebRTC server on :8000 that only offers its LAN
address. Browsers never talk to it: PrintDeck is the WebRTC peer
(camera_relay.py) and /ws/camera/<id> sends the frames on, so the picture
takes the same path as everything else: through this server.
"""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from ..auth import ws_authorized
from ..camera_relay import FORMATS, CameraError
from ..models import PrinterConfig

ws_router = APIRouter()


def signaling_url(config: PrinterConfig) -> str:
    return config.camera_url.rstrip("/") + "/call/webrtc_local"


@ws_router.websocket("/ws/camera/{printer_id}")
async def camera_stream(websocket: WebSocket, printer_id: str) -> None:
    """One binary message per frame: the printer's own H.264 with
    ?format=h264 (see CameraRelay.frames for the framing), JPEGs otherwise.
    Closes with 1011 and a readable reason when the camera can't be reached
    or stops."""
    if not ws_authorized(websocket):
        await websocket.close(code=1008)  # before accept() → client sees a failed handshake
        return
    app = websocket.app
    config = app.state.manager.config(printer_id)
    if config is None or not config.camera_url:
        await websocket.close(code=1008)
        return
    fmt = websocket.query_params.get("format")
    if fmt not in FORMATS:
        fmt = "jpeg"
    await websocket.accept()

    async def drain_incoming() -> None:
        # The browser never sends anything; this is how we notice it leaving.
        while True:
            await websocket.receive_bytes()

    async def push_frames(relay) -> None:
        async for message in relay.frames(fmt):
            await websocket.send_bytes(message)

    async with app.state.cameras.watch(app.state.http, printer_id, signaling_url(config)) as relay:
        reader = asyncio.create_task(drain_incoming())
        writer = asyncio.create_task(push_frames(relay))
        try:
            done, _ = await asyncio.wait({reader, writer}, return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                exc = task.exception()
                if isinstance(exc, CameraError):
                    await websocket.close(code=1011, reason=str(exc))
                # Client gone: WebSocketDisconnect from the reader, or a failed send. Not log-worthy.
                elif exc is not None and not isinstance(exc, (WebSocketDisconnect, OSError, RuntimeError)):
                    raise exc
        finally:
            reader.cancel()
            writer.cancel()
