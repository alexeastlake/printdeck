"""Printer registry: list, add, edit, remove."""

from __future__ import annotations

import ipaddress
import re
from urllib.parse import urlsplit

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from ..models import PrinterConfig, PrinterStatus
from ..utils import slugify
from .common import manage_printers_only

router = APIRouter()

# Hostnames only; IP literals go through the ipaddress module (an IPv6 regex is a trap).
_HOSTNAME_RE = re.compile(r"^(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))*\.?$")
_API_KEY_RE = re.compile(r"[A-Za-z0-9._~+/=-]+")


class PrinterUpdate(BaseModel):
    name: str | None = Field(default=None, max_length=200)
    host: str | None = Field(default=None, max_length=253)
    moonraker_port: int | None = None
    api_key: str | None = Field(default=None, max_length=256)  # "" clears
    tls: bool | None = None
    camera_url: str | None = Field(default=None, max_length=2000)  # "" clears
    group: str | None = Field(default=None, max_length=200)
    creality_light: bool | None = None


class NewPrinter(BaseModel):
    name: str = Field(max_length=200)
    host: str = Field(max_length=253)
    moonraker_port: int = 7125
    api_key: str | None = Field(default=None, max_length=256)
    tls: bool = False
    camera_url: str | None = Field(default=None, max_length=2000)
    group: str = Field(default="", max_length=200)
    creality_light: bool = False


# --- validation --------------------------------------------------------------

def validate_name(name: str) -> str:
    name = name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Name can't be empty.")
    return name


def validate_host(host: str) -> str:
    """Bare IPv4/IPv6/hostname. No scheme, port, or path."""
    host = host.strip()
    if host.startswith("[") and host.endswith("]"):
        host = host[1:-1]
    try:
        return str(ipaddress.ip_address(host))
    except ValueError:
        pass
    if _HOSTNAME_RE.match(host):
        return host
    raise HTTPException(
        status_code=400,
        detail="Enter a bare IP address or hostname, e.g. 192.168.1.50 or printer.local. No http://, port, or spaces.",
    )


def validate_port(port: int) -> int:
    if not 1 <= port <= 65535:
        raise HTTPException(status_code=400, detail="Port must be between 1 and 65535.")
    return port


def validate_camera_url(url: str | None) -> str | None:
    # The server POSTs to this (see camera.negotiate), so treat it as an SSRF target.
    url = (url or "").strip()
    if not url:
        return None
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise HTTPException(
            status_code=400,
            detail="Camera URL must start with http:// or https:// and include the printer's address, e.g. http://192.168.1.50:8000/",
        )
    return url


def validate_api_key(key: str | None) -> str | None:
    key = (key or "").strip()
    if key and not _API_KEY_RE.fullmatch(key):
        raise HTTPException(status_code=400, detail="That doesn't look like a Moonraker API key.")
    return key or None


def unique_id(manager, name: str) -> str:
    """Slug of the name, suffixed if taken. Nobody wants to invent an id."""
    base_id = slugify(name)
    printer_id = base_id
    suffix = 2
    while manager.config(printer_id) is not None:
        printer_id = f"{base_id}-{suffix}"
        suffix += 1
    return printer_id


# --- endpoints ---------------------------------------------------------------

@router.get("/printers")
def list_printers(request: Request) -> list[PrinterStatus]:
    return request.app.state.manager.snapshots()


@router.post("/printers", dependencies=manage_printers_only)
async def create_printer(request: Request, body: NewPrinter) -> PrinterStatus:
    manager = request.app.state.manager
    name = validate_name(body.name)
    config = PrinterConfig(
        id=unique_id(manager, name),
        name=name,
        host=validate_host(body.host),
        moonraker_port=validate_port(body.moonraker_port),
        api_key=validate_api_key(body.api_key),
        tls=body.tls,
        camera_url=validate_camera_url(body.camera_url),
        group=body.group.strip(),
        creality_light=body.creality_light,
    )
    return await manager.add_printer(config)


@router.delete("/printers/{printer_id}", dependencies=manage_printers_only)
async def delete_printer(request: Request, printer_id: str) -> dict:
    try:
        await request.app.state.manager.remove_printer(printer_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="unknown printer")
    return {"ok": True}


@router.get("/printers/{printer_id}/status")
def printer_status(request: Request, printer_id: str) -> PrinterStatus:
    status = request.app.state.manager.status(printer_id)
    if status is None:
        raise HTTPException(status_code=404, detail="unknown printer")
    return status


@router.patch("/printers/{printer_id}", dependencies=manage_printers_only)
async def update_printer(request: Request, printer_id: str, update: PrinterUpdate) -> PrinterStatus:
    manager = request.app.state.manager
    old = manager.config(printer_id)
    if old is None:
        raise HTTPException(status_code=404, detail="unknown printer")

    fields: dict = {}
    if update.name is not None:
        fields["name"] = validate_name(update.name)

    camera_url = old.camera_url
    if update.host is not None:
        host = validate_host(update.host)
        fields["host"] = host
        # Camera is usually on the same host, so follow it unless set explicitly.
        if update.camera_url is None and camera_url and old.host and old.host in camera_url:
            camera_url = camera_url.replace(old.host, host)
    if update.camera_url is not None:
        camera_url = validate_camera_url(update.camera_url)
    fields["camera_url"] = camera_url

    if update.moonraker_port is not None:
        fields["moonraker_port"] = validate_port(update.moonraker_port)
    if update.api_key is not None:
        fields["api_key"] = validate_api_key(update.api_key)
    if update.tls is not None:
        fields["tls"] = update.tls
    if update.group is not None:
        fields["group"] = update.group.strip()
    if update.creality_light is not None:
        fields["creality_light"] = update.creality_light

    return await manager.update_printer(printer_id, **fields)
