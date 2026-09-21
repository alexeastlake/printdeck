"""All the printer-facing endpoints.

api_router — REST (initial paint + fallback) and the camera signaling proxy;
             gated behind auth where it's mounted in main.py.
ws_router  — the /ws live channel. It guards itself, because auth dependencies
             don't run on a WebSocket handshake.
"""

from __future__ import annotations

import asyncio
import base64
import json
import re
from urllib.parse import quote

import httpx
import websockets
from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    HTTPException,
    Request,
    Response,
    UploadFile,
    WebSocket,
    WebSocketDisconnect,
)
from pydantic import BaseModel

from .auth import require_permission, ws_authorized
from .models import PrinterStatus
from .utils import slugify

# Any logged-in account can see everything in this router (read-only) — a
# role with none of these three permissions is a viewer in effect, without
# "viewer" being a hardcoded concept anywhere here.
manage_printers_only = [Depends(require_permission("manage_printers"))]
manage_files_only = [Depends(require_permission("manage_files"))]
control_printers_only = [Depends(require_permission("control_printers"))]

api_router = APIRouter(prefix="/api")
ws_router = APIRouter()

# A bare IPv4 address or hostname: letters, digits, dots, hyphens only — no
# scheme, port, path, or whitespace. Rejects anything that could turn the
# stored host into something other than a plain ws://host:port target.
_HOST_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$")


# --- printer REST ----------------------------------------------------------

class PrinterUpdate(BaseModel):
    # All optional: send only the fields you're changing.
    name: str | None = None
    host: str | None = None
    camera_url: str | None = None  # an empty string clears it
    group: str | None = None


class NewPrinter(BaseModel):
    name: str
    host: str
    camera_url: str | None = None
    group: str = ""


def _validate_host(host: str) -> str:
    host = host.strip()
    if not _HOST_RE.match(host):
        raise HTTPException(
            status_code=400,
            detail="Enter a bare IP or hostname, e.g. 192.168.1.50 — no http://, port, or spaces.",
        )
    return host


@api_router.get("/printers")
def list_printers(request: Request) -> list[PrinterStatus]:
    return request.app.state.manager.snapshots()


@api_router.post("/printers", dependencies=manage_printers_only)
async def create_printer(request: Request, body: NewPrinter) -> PrinterStatus:
    """Add a new printer and start connecting to it immediately — no
    server restart, no hand-editing printers.yaml."""
    manager = request.app.state.manager
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Name can't be empty.")
    host = _validate_host(body.host)
    camera_url = (body.camera_url or "").strip() or None
    group = body.group.strip()

    # The id just needs to be unique and URL-safe (it lives in /printer/<id>
    # and as a printers.yaml key) — derive it from the name rather than
    # asking the admin to think up an identifier too.
    base_id = slugify(name)
    printer_id = base_id
    suffix = 2
    while manager.config(printer_id) is not None:
        printer_id = f"{base_id}-{suffix}"
        suffix += 1

    return await manager.add_printer(
        id=printer_id, name=name, host=host, camera_url=camera_url, group=group
    )


@api_router.delete("/printers/{printer_id}", dependencies=manage_printers_only)
async def delete_printer(request: Request, printer_id: str) -> dict:
    """Stop managing a printer — disconnects and forgets it. Doesn't touch
    the printer itself, just PrintDeck's own list."""
    try:
        await request.app.state.manager.remove_printer(printer_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="unknown printer")
    return {"ok": True}


@api_router.get("/printers/{printer_id}/status")
def printer_status(request: Request, printer_id: str) -> PrinterStatus:
    status = request.app.state.manager.status(printer_id)
    if status is None:
        raise HTTPException(status_code=404, detail="unknown printer")
    return status


@api_router.patch("/printers/{printer_id}", dependencies=manage_printers_only)
async def update_printer(
    request: Request, printer_id: str, update: PrinterUpdate
) -> PrinterStatus:
    """Edit a printer's settings at runtime — rename it, or repoint its
    IP/host (for roaming DHCP addresses) — and apply it in place."""
    manager = request.app.state.manager
    old = manager.config(printer_id)
    if old is None:
        raise HTTPException(status_code=404, detail="unknown printer")

    name = old.name
    if update.name is not None:
        name = update.name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="Name can't be empty.")

    host = old.host
    camera_url = old.camera_url
    if update.host is not None:
        host = _validate_host(update.host)
        # If the camera URL isn't being set explicitly in this same request,
        # keep it in sync with the IP it's presumably still baked into.
        if update.camera_url is None and camera_url and old.host and old.host in camera_url:
            camera_url = camera_url.replace(old.host, host)

    if update.camera_url is not None:
        camera_url = update.camera_url.strip() or None

    group = old.group
    if update.group is not None:
        group = update.group.strip()

    return await manager.update_printer(
        printer_id, name=name, host=host, camera_url=camera_url, group=group
    )


# --- camera WebRTC signaling proxy -----------------------------------------
# The K1C's camera is a tiny WebRTC-only server on :8000. Its page does the
# handshake by POSTing a base64'd SDP offer to /call/webrtc_local and getting a
# base64'd answer back. The browser can't POST there itself (cross-origin), so
# we relay that one exchange; the video then flows peer-to-peer from the printer
# straight to the browser, never through this process.

class Offer(BaseModel):
    sdp: str
    type: str = "offer"


async def _negotiate(signaling_url: str, sdp: str) -> dict:
    """Relay one offer/answer exchange to the printer's WebRTC server."""
    payload = base64.b64encode(json.dumps({"type": "offer", "sdp": sdp}).encode())
    # Same reasoning as MoonrakerClient's open_timeout: this covers DNS
    # resolution too, not just the HTTP round trip, and a ".local" mDNS
    # hostname can legitimately need close to 10s to resolve cold on
    # Windows — the old 10s default was cutting that off mid-resolution.
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(
            signaling_url, content=payload, headers={"Content-Type": "plain/text"}
        )
        resp.raise_for_status()
    return json.loads(base64.b64decode(resp.content))


@api_router.post("/printers/{printer_id}/camera/offer")
async def camera_offer(request: Request, printer_id: str, offer: Offer) -> dict:
    config = request.app.state.manager.config(printer_id)
    if config is None or not config.camera_url:
        raise HTTPException(status_code=404, detail="no camera for this printer")
    signaling_url = config.camera_url.rstrip("/") + "/call/webrtc_local"
    try:
        return await _negotiate(signaling_url, offer.sdp)
    except Exception as exc:  # printer offline, refused, malformed answer, ...
        raise HTTPException(status_code=502, detail=f"camera negotiation failed: {exc}")


# --- Moonraker file browser proxy -------------------------------------------
# Everything here talks to the *printer's own* Moonraker HTTP API (the same
# one Mainsail/Fluidd use) — never anything else. It's scoped to browsing,
# uploading, renaming, and deleting files; starting/managing a print job is a
# separate (deferred) feature, not this.

_FILES_ROOT = "gcodes"  # the only root the UI exposes — plenty for "see my files"


def _moonraker_url(config, path: str) -> str:
    return f"http://{config.host}:{config.moonraker_port}{path}"


def _require_config(request: Request, printer_id: str):
    config = request.app.state.manager.config(printer_id)
    if config is None:
        raise HTTPException(status_code=404, detail="unknown printer")
    return config


def _relative_path(path: str) -> str:
    """root + a path *within* it, joined and cleaned of any empty segments
    (e.g. from an empty parent path) so it doesn't come out as "gcodes//x"."""
    parts = [_FILES_ROOT] + [segment for segment in path.split("/") if segment]
    return "/".join(parts)


def _require_plain_name(name: str, what: str) -> str:
    name = name.strip()
    if not name or "/" in name or name in (".", ".."):
        raise HTTPException(status_code=400, detail=f"Enter a valid {what}, e.g. \"my-file.gcode\".")
    return name


def _extract_moonraker_error(response_text: str) -> str:
    """Moonraker error bodies look like {"error": {"message": "..."}}, and
    that message is very often itself a JSON-encoded Klipper error like
    {"code": "CC5000", "msg": "Move out of range: ...", ...} — dig out just
    the human-readable text instead of handing back that doubly-nested mess."""
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


async def _moonraker_request(method: str, url: str, **kwargs) -> dict:
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.request(method, url, **kwargs)
            resp.raise_for_status()
            return resp.json()
    except httpx.HTTPStatusError as exc:
        raise HTTPException(status_code=502, detail=_extract_moonraker_error(exc.response.text))
    except Exception as exc:  # printer offline, refused, timed out, ...
        raise HTTPException(status_code=502, detail=f"couldn't reach printer: {exc}")


class NewFolder(BaseModel):
    path: str  # parent folder, relative to the gcodes root ("" for the root itself)
    name: str


class RenameEntry(BaseModel):
    path: str  # current path of the file/folder, relative to the gcodes root
    new_name: str  # just the new filename/dirname — this only renames in place


@api_router.get("/printers/{printer_id}/files")
async def list_files(request: Request, printer_id: str, path: str = "") -> dict:
    """One directory's worth of dirs/files under the gcodes root."""
    config = _require_config(request, printer_id)
    full_path = quote(_relative_path(path), safe="/")
    url = _moonraker_url(config, f"/server/files/directory?path={full_path}")
    data = await _moonraker_request("GET", url)
    return data.get("result", {})


@api_router.post("/printers/{printer_id}/files/folder", dependencies=manage_files_only)
async def create_folder(request: Request, printer_id: str, body: NewFolder) -> dict:
    config = _require_config(request, printer_id)
    name = _require_plain_name(body.name, "folder name")
    full_path = _relative_path(f"{body.path}/{name}")
    url = _moonraker_url(config, "/server/files/directory")
    data = await _moonraker_request("POST", url, json={"path": full_path})
    return data.get("result", {})


@api_router.post("/printers/{printer_id}/files/rename", dependencies=manage_files_only)
async def rename_entry(request: Request, printer_id: str, body: RenameEntry) -> dict:
    config = _require_config(request, printer_id)
    new_name = _require_plain_name(body.new_name, "name")
    parent = "/".join(body.path.split("/")[:-1])
    source = _relative_path(body.path)
    dest = _relative_path(f"{parent}/{new_name}")
    url = _moonraker_url(config, "/server/files/move")
    data = await _moonraker_request("POST", url, json={"source": source, "dest": dest})
    return data.get("result", {})


async def _delete_file_via_rpc(host: str, port: int, path: str) -> dict:
    """Delete a single file over Moonraker's JSON-RPC channel, not HTTP.

    The REST endpoint (DELETE /server/files/{root}/{filename}) embeds the
    filename directly in the URL path, and Moonraker doesn't URL-decode that
    particular segment — so any filename with a space (i.e. most gcode
    files, since slicers name them after the profile) 400s with "Invalid
    file path" even though the request is correctly encoded. JSON-RPC sends
    the path as a plain JSON string instead, sidestepping URL-encoding
    entirely — this is also what Mainsail/Fluidd actually use for this.

    This opens a fresh connection per call, which is fine for one file but
    means a multi-file bulk delete hits the printer with a burst of rapid
    connect/disconnect cycles — on a resource-constrained embedded device
    that can occasionally get a connection refused/reset for no reason
    related to the delete itself. One retry after a short pause absorbs
    that instead of failing a delete that would have worked a moment later.
    """
    last_exc: Exception | None = None
    for attempt in range(2):
        if attempt:
            await asyncio.sleep(0.75)
        try:
            async with websockets.connect(f"ws://{host}:{port}/websocket", open_timeout=10) as ws:
                await ws.send(json.dumps({
                    "jsonrpc": "2.0",
                    "method": "server.files.delete_file",
                    "params": {"path": path},
                    "id": 1,
                }))
                async with asyncio.timeout(15):
                    while True:
                        msg = json.loads(await ws.recv())
                        if msg.get("id") != 1:
                            continue  # some other notification arrived first; keep waiting
                        if "error" in msg:
                            raise RuntimeError(msg["error"].get("message", "delete failed"))
                        return msg.get("result", {})
        except RuntimeError:
            raise  # Moonraker actually answered "no" — retrying won't change that
        except Exception as exc:  # connection refused/reset/timed out — worth one retry
            last_exc = exc
    raise last_exc


@api_router.delete("/printers/{printer_id}/files", dependencies=manage_files_only)
async def delete_entry(
    request: Request, printer_id: str, path: str, is_dir: bool = False
) -> dict:
    config = _require_config(request, printer_id)
    full_path = _relative_path(path)
    if is_dir:
        quoted = quote(full_path, safe="/")
        url = _moonraker_url(config, f"/server/files/directory?path={quoted}&force=true")
        return await _moonraker_request("DELETE", url)
    try:
        return await _delete_file_via_rpc(config.host, config.moonraker_port, full_path)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"delete failed: {exc}")


@api_router.post("/printers/{printer_id}/files/upload", dependencies=manage_files_only)
async def upload_file(
    request: Request,
    printer_id: str,
    file: UploadFile = File(...),
    path: str = Form(""),
) -> dict:
    config = _require_config(request, printer_id)
    url = _moonraker_url(config, "/server/files/upload")
    data = {"root": _FILES_ROOT, "print": "false"}
    if path:
        data["path"] = path
    contents = await file.read()
    files = {"file": (file.filename, contents, file.content_type or "application/octet-stream")}
    try:
        async with httpx.AsyncClient(timeout=180) as client:  # big gcode files take a while
            resp = await client.post(url, data=data, files=files)
            resp.raise_for_status()
            return resp.json().get("result", {})
    except httpx.HTTPStatusError as exc:
        raise HTTPException(status_code=502, detail=_extract_moonraker_error(exc.response.text))
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"couldn't reach printer: {exc}")


# --- print file metadata (thumbnail + slicer estimates) --------------------
# The detail page's job panel wants a preview image and slicer estimates
# (filament, layers, estimated time) for the file currently printing.
# Moonraker already computes all of this at upload time (parsed from the
# slicer's embedded thumbnails and gcode comments), so this is just a thin
# proxy — no image or gcode processing happens here.

@api_router.get("/printers/{printer_id}/files/info")
async def file_info(request: Request, printer_id: str, filename: str) -> dict:
    """Slicer metadata for one gcode file — filename is relative to the
    gcodes root, exactly as Moonraker's print_stats.filename reports it."""
    config = _require_config(request, printer_id)
    quoted = quote(filename, safe="/")
    url = _moonraker_url(config, f"/server/files/metadata?filename={quoted}")
    data = await _moonraker_request("GET", url)
    return data.get("result", {})


@api_router.get("/printers/{printer_id}/files/thumbnail")
async def file_thumbnail(request: Request, printer_id: str, filename: str) -> Response:
    """The largest embedded thumbnail for one gcode file, proxied as an image.

    A thumbnail's `relative_path` (from the metadata response) is relative to
    the gcode file's own parent directory, not the gcodes root — it has to be
    resolved against `filename`'s directory before it can be fetched.
    """
    config = _require_config(request, printer_id)
    quoted = quote(filename, safe="/")
    meta_url = _moonraker_url(config, f"/server/files/metadata?filename={quoted}")
    meta = await _moonraker_request("GET", meta_url)
    thumbnails = meta.get("result", {}).get("thumbnails") or []
    if not thumbnails:
        raise HTTPException(status_code=404, detail="no thumbnail for this file")
    largest = max(thumbnails, key=lambda t: t.get("size", 0))

    parent = "/".join(filename.split("/")[:-1])
    thumb_path = _relative_path(f"{parent}/{largest['relative_path']}")
    image_url = _moonraker_url(config, f"/server/files/{quote(thumb_path, safe='/')}")
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(image_url)
            resp.raise_for_status()
    except httpx.HTTPStatusError as exc:
        raise HTTPException(status_code=502, detail=_extract_moonraker_error(exc.response.text))
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"couldn't reach printer: {exc}")

    content_type = "image/png" if thumb_path.lower().endswith(".png") else "image/jpeg"
    return Response(content=resp.content, media_type=content_type)


# --- G-code relay ------------------------------------------------------------
# Backs the detail page's move/temperature/fan controls — all of them just
# construct a G-code string and send it here. This is otherwise exactly what
# Moonraker's own HTTP API takes, so there's nothing printer-control-specific
# in this file; the frontend is what constrains this to sensible commands.

class GcodeScript(BaseModel):
    script: str


@api_router.post("/printers/{printer_id}/gcode", dependencies=control_printers_only)
async def run_gcode(request: Request, printer_id: str, body: GcodeScript) -> dict:
    config = _require_config(request, printer_id)
    script = body.script.strip()
    if not script or len(script) > 2000:
        raise HTTPException(status_code=400, detail="Empty or implausibly long G-code script.")

    url = _moonraker_url(config, "/printer/gcode/script")
    # Homing/long moves can take a while — Moonraker's response waits for the
    # command to actually finish, not just be queued. Moonraker's own
    # "result" here is just the string "ok", not an object — wrap it so this
    # endpoint always hands back a predictable {"result": ...} shape.
    try:
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(url, json={"script": script})
            resp.raise_for_status()
            return {"result": resp.json().get("result", "ok")}
    except httpx.HTTPStatusError as exc:
        raise HTTPException(status_code=502, detail=_extract_moonraker_error(exc.response.text))
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"couldn't reach printer: {exc}")


# --- live channel ----------------------------------------------------------
# A browser connects to /ws, immediately gets a full snapshot of every printer,
# then a steady trickle of per-printer updates as they change.

@ws_router.websocket("/ws")
async def stream(websocket: WebSocket) -> None:
    await websocket.accept()
    if not ws_authorized(websocket):
        await websocket.close(code=1008)  # policy violation — not logged in
        return
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
            await websocket.send_json(await queue.get())
    except WebSocketDisconnect:
        pass
    finally:
        manager.unsubscribe(queue)
