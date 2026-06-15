"""The live channel. A browser connects to /ws, immediately gets a full snapshot
of every printer, then a steady trickle of per-printer updates as they change."""

from __future__ import annotations

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

router = APIRouter()


@router.websocket("/ws")
async def stream(websocket: WebSocket) -> None:
    await websocket.accept()
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
