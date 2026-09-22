"""Printer endpoints, one module per concern.

api_router is auth-gated where it's mounted (main.py); ws_router guards itself.
"""

from __future__ import annotations

from fastapi import APIRouter

from . import camera, files, jobs, live, printers

api_router = APIRouter(prefix="/api")
for module in (printers, camera, files, jobs):
    api_router.include_router(module.router)

ws_router = live.router

__all__ = ["api_router", "ws_router"]
