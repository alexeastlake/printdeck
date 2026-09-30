"""Printer registry: list, add, edit, remove, and scan for a printer whose IP moved."""

from __future__ import annotations

import asyncio
import ipaddress
import re
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from ..models import PrinterConfig, PrinterStatus
from ..utils import slugify
from .common import http_client, manage_printers_only, require_config

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


class ScanRange(BaseModel):
    start: str = Field(max_length=15)
    end: str = Field(max_length=15)


# One /24's worth. A scan is a burst of requests, so keep it LAN-sized.
SCAN_MAX_ADDRESSES = 256
SCAN_TIMEOUT = 2.0
SCAN_CONCURRENCY = 64  # stays under httpx's default pool of 100


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


def validate_scan_range(start: str, end: str) -> list[str]:
    try:
        first = ipaddress.IPv4Address(start.strip())
        last = ipaddress.IPv4Address(end.strip())
    except ValueError:
        raise HTTPException(status_code=400, detail="Enter IPv4 addresses, e.g. 192.168.1.100 to 192.168.1.130.")
    if first > last:
        first, last = last, first
    count = int(last) - int(first) + 1
    if count > SCAN_MAX_ADDRESSES:
        raise HTTPException(status_code=400, detail=f"That's {count} addresses; scan at most {SCAN_MAX_ADDRESSES}.")
    addresses = [ipaddress.IPv4Address(n) for n in range(int(first), int(last) + 1)]
    if not all(a.is_private for a in addresses):
        raise HTTPException(status_code=400, detail="Only private (LAN) addresses can be scanned.")
    return [str(a) for a in addresses]


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


async def _probe(client: httpx.AsyncClient, config: PrinterConfig, host: str) -> dict | None:
    """Moonraker at `host` on this printer's port/TLS/key, plus its hostname
    so the user can tell printers apart. None if nothing answers."""
    candidate = config.model_copy(update={"host": host})

    async def result(path: str) -> dict:
        resp = await client.get(candidate.http_url(path), headers=candidate.auth_headers, timeout=SCAN_TIMEOUT)
        resp.raise_for_status()
        body = resp.json()
        if not isinstance(body, dict) or not isinstance(body.get("result"), dict):
            raise ValueError("not a Moonraker reply")
        return body["result"]

    try:
        await result("/server/info")
    except (httpx.HTTPError, ValueError):
        return None
    try:  # Klippy may be down; Moonraker still answered, so report it anyway.
        hostname = (await result("/printer/info")).get("hostname")
    except (httpx.HTTPError, ValueError):
        hostname = None
    return {"host": host, "hostname": hostname}


@router.post("/printers/{printer_id}/scan", dependencies=manage_printers_only)
async def scan_for_printer(request: Request, printer_id: str, body: ScanRange) -> list[dict]:
    """Moonraker instances in the range. Changes nothing; the user picks one
    in the editor and saves it as the host."""
    config = require_config(request, printer_id)
    hosts = validate_scan_range(body.start, body.end)
    client = http_client(request)
    limit = asyncio.Semaphore(SCAN_CONCURRENCY)

    async def probe(host: str) -> dict | None:
        async with limit:
            return await _probe(client, config, host)

    results = await asyncio.gather(*(probe(h) for h in hosts))
    return [r for r in results if r is not None]
