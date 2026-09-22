"""Bits every printer endpoint needs: the shared HTTP client, Moonraker
request wrappers, path hygiene, and the permission dependencies."""

from __future__ import annotations

import json

import httpx
from fastapi import Depends, HTTPException, Request

from ..auth import require_permission
from ..models import PrinterConfig

manage_printers_only = [Depends(require_permission("manage_printers"))]
manage_files_only = [Depends(require_permission("manage_files"))]
control_printers_only = [Depends(require_permission("control_printers"))]

FILES_ROOT = "gcodes"


def http_client(request: Request) -> httpx.AsyncClient:
    """Shared pooled client from lifespan. Timeouts are per call; they range
    from a metadata lookup to a 300 MB upload."""
    return request.app.state.http


def require_config(request: Request, printer_id: str) -> PrinterConfig:
    config = request.app.state.manager.config(printer_id)
    if config is None:
        raise HTTPException(status_code=404, detail="unknown printer")
    return config


# --- paths -------------------------------------------------------------------

def clean_segments(path: str, what: str = "path") -> list[str]:
    """Reject anything that could escape the gcodes root. Moonraker confines
    paths too, but don't rely on it."""
    if "\\" in path or "\x00" in path:
        raise HTTPException(status_code=400, detail=f"Invalid {what}.")
    segments = [segment for segment in path.split("/") if segment]
    if any(segment in (".", "..") for segment in segments):
        raise HTTPException(status_code=400, detail=f"Invalid {what}.")
    return segments


def relative_path(path: str, what: str = "path") -> str:
    return join_root(clean_segments(path, what))


def join_root(segments: list[str]) -> str:
    return "/".join([FILES_ROOT, *segments])


def require_plain_name(name: str, what: str) -> str:
    name = name.strip()
    if not name or "/" in name or "\\" in name or name in (".", "..") or "\x00" in name:
        raise HTTPException(status_code=400, detail=f"Enter a valid {what}, e.g. \"my-file.gcode\".")
    return name


# --- Moonraker HTTP ----------------------------------------------------------

def extract_moonraker_error(response_text: str) -> str:
    """Moonraker wraps errors as {"error": {"message": ...}}, and the message
    is often itself JSON from Klipper ({"code": ..., "msg": ...}). Dig out
    the readable text."""
    try:
        message = json.loads(response_text).get("error", {}).get("message", response_text)
    except (json.JSONDecodeError, AttributeError):
        return response_text[:300] or "Unknown error."
    try:
        inner = json.loads(message)
        if isinstance(inner, dict) and "msg" in inner:
            return str(inner["msg"])[:300]
    except (json.JSONDecodeError, TypeError):
        pass
    return str(message)[:300]


async def moonraker_request(
    request: Request, config: PrinterConfig, method: str, path: str, *, timeout: float = 30, **kwargs
) -> httpx.Response:
    try:
        resp = await http_client(request).request(
            method, config.http_url(path), headers=config.auth_headers, timeout=timeout, **kwargs
        )
        resp.raise_for_status()
        return resp
    except httpx.HTTPStatusError as exc:
        raise HTTPException(status_code=502, detail=extract_moonraker_error(exc.response.text))
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"couldn't reach printer: {exc}")


async def moonraker_json(request: Request, config: PrinterConfig, method: str, path: str, **kwargs) -> dict:
    return (await moonraker_request(request, config, method, path, **kwargs)).json()


async def moonraker_result(request: Request, config: PrinterConfig, method: str, path: str, **kwargs) -> dict:
    """The `result` object of a Moonraker reply."""
    return (await moonraker_json(request, config, method, path, **kwargs)).get("result", {})
