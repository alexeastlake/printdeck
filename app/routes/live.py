"""/ws: a snapshot of every printer on connect, then per-printer updates.
Checks auth itself; dependencies don't run on websocket handshakes."""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from ..auth import ws_authorized

router = APIRouter()


@router.websocket("/ws")
async def stream(websocket: WebSocket) -> None:
    if not ws_authorized(websocket):
        await websocket.close(code=1008)  # before accept() → client sees a failed handshake
        return
    await websocket.accept()
    manager = websocket.app.state.manager
    queue = manager.subscribe()

    async def drain_incoming() -> None:
        # The browser never sends anything, but without a receive we don't
        # notice it going away until a send fails.
        while True:
            await websocket.receive_text()

    async def push_updates() -> None:
        await websocket.send_json({
            "type": "snapshot",
            "printers": [s.model_dump() for s in manager.snapshots()],
        })
        while True:
            await websocket.send_json(await queue.get())

    reader = asyncio.create_task(drain_incoming())
    writer = asyncio.create_task(push_updates())
    try:
        done, _ = await asyncio.wait({reader, writer}, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            exc = task.exception()
            # Client gone: WebSocketDisconnect from the reader, or a failed send. Not log-worthy.
            if exc is not None and not isinstance(exc, (WebSocketDisconnect, OSError, RuntimeError)):
                raise exc
    finally:
        reader.cancel()
        writer.cancel()
        manager.unsubscribe(queue)
