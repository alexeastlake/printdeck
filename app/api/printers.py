"""REST endpoints. Small on purpose: the websocket does the live work, REST is
just for the initial paint and as a fallback when the socket is down."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from ..models import PrinterStatus

router = APIRouter(prefix="/api")


@router.get("/printers")
def list_printers(request: Request) -> list[PrinterStatus]:
    return request.app.state.manager.snapshots()


@router.get("/printers/{printer_id}/status")
def printer_status(request: Request, printer_id: str) -> PrinterStatus:
    for status in request.app.state.manager.snapshots():
        if status.id == printer_id:
            return status
    raise HTTPException(status_code=404, detail="unknown printer")
