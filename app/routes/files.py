"""Moonraker file proxy: browse, upload, rename, delete, plus per-file
metadata and thumbnails. Everything is confined to the gcodes root."""

from __future__ import annotations

import asyncio
import json
import logging
from urllib.parse import quote

import websockets
from fastapi import APIRouter, File, Form, HTTPException, Request, Response, UploadFile
from pydantic import BaseModel, Field

from ..models import PrinterConfig
from .common import (
    FILES_ROOT,
    clean_segments,
    extract_moonraker_error,
    http_client,
    join_root,
    manage_files_only,
    moonraker_json,
    moonraker_request,
    moonraker_result,
    relative_path,
    require_config,
    require_plain_name,
)

router = APIRouter()
log = logging.getLogger("printdeck.files")

MAX_UPLOAD_BYTES = 1024 * 1024 * 1024  # uploads are streamed; this just bounds one request


class NewFolder(BaseModel):
    path: str = Field(max_length=4096)  # parent, relative to gcodes root; "" = root
    name: str = Field(max_length=255)


class RenameEntry(BaseModel):
    path: str = Field(max_length=4096)
    new_name: str = Field(max_length=255)  # rename in place only


def _quoted(path: str) -> str:
    return quote(path, safe="/")


# --- browse / mutate ---------------------------------------------------------

@router.get("/printers/{printer_id}/files")
async def list_files(request: Request, printer_id: str, path: str = "") -> dict:
    config = require_config(request, printer_id)
    return await moonraker_result(
        request, config, "GET", f"/server/files/directory?path={_quoted(relative_path(path))}"
    )


@router.post("/printers/{printer_id}/files/folder", dependencies=manage_files_only)
async def create_folder(request: Request, printer_id: str, body: NewFolder) -> dict:
    config = require_config(request, printer_id)
    name = require_plain_name(body.name, "folder name")
    full_path = relative_path(f"{body.path}/{name}")
    return await moonraker_result(request, config, "POST", "/server/files/directory", json={"path": full_path})


@router.post("/printers/{printer_id}/files/rename", dependencies=manage_files_only)
async def rename_entry(request: Request, printer_id: str, body: RenameEntry) -> dict:
    config = require_config(request, printer_id)
    new_name = require_plain_name(body.new_name, "name")
    segments = clean_segments(body.path)
    if not segments:
        raise HTTPException(status_code=400, detail="Nothing to rename.")
    payload = {"source": join_root(segments), "dest": join_root([*segments[:-1], new_name])}
    return await moonraker_result(request, config, "POST", "/server/files/move", json=payload)


async def delete_file_via_rpc(config: PrinterConfig, path: str) -> dict:
    """JSON-RPC, not REST: Moonraker doesn't URL-decode the filename segment
    of DELETE /server/files/{root}/{filename}, so any name with a space
    (most gcode) 400s. Mainsail/Fluidd use RPC for this too.

    Fresh connection per call. A bulk delete hammers the printer with
    connects, and the embedded board occasionally refuses one for no reason
    related to the delete. Hence one retry."""
    last_exc: Exception | None = None
    for attempt in range(2):
        if attempt:
            await asyncio.sleep(0.75)
        try:
            async with websockets.connect(
                config.ws_url, additional_headers=config.auth_headers, open_timeout=10
            ) as ws:
                await ws.send(json.dumps({
                    "jsonrpc": "2.0",
                    "method": "server.files.delete_file",
                    "params": {"path": path},
                    "id": 1,
                }))
                try:
                    async with asyncio.timeout(15):
                        while True:
                            msg = json.loads(await ws.recv())
                            if msg.get("id") != 1:
                                continue
                            if "error" in msg:
                                raise RuntimeError(msg["error"].get("message") or "Moonraker refused the delete")
                            return msg.get("result", {})
                except TimeoutError:
                    # asyncio's TimeoutError has an empty message; say what happened.
                    raise TimeoutError("the printer didn't confirm the delete within 15s") from None
        except RuntimeError:
            raise  # Moonraker said no; retrying won't help
        except Exception as exc:
            last_exc = exc
    raise last_exc


async def _file_exists(request: Request, config: PrinterConfig, path: str) -> bool | None:
    """None if we can't tell (printer unreachable)."""
    try:
        resp = await http_client(request).get(
            config.http_url(f"/server/files/metadata?filename={quote(path, safe='/')}"),
            headers=config.auth_headers, timeout=10,
        )
    except Exception:
        return None
    if resp.status_code == 404:
        return False
    return True if resp.is_success else None


async def _delete_file(request: Request, config: PrinterConfig, full_path: str) -> dict:
    """RPC first (see delete_file_via_rpc), then the REST endpoint, then check
    whether the file is gone regardless of what the printer said. Creality's
    Moonraker fork has been seen to delete and then never reply."""
    relative = full_path[len(FILES_ROOT) + 1:]
    errors: list[str] = []
    try:
        return await delete_file_via_rpc(config, full_path)
    except Exception as exc:
        errors.append(f"rpc: {exc}")
    if await _file_exists(request, config, relative) is False:
        return {}
    try:
        resp = await http_client(request).delete(
            config.http_url(f"/server/files/{quote(full_path, safe='/')}"),
            headers=config.auth_headers, timeout=30,
        )
        if resp.is_success:
            return resp.json().get("result", {})
        errors.append(f"http {resp.status_code}: {extract_moonraker_error(resp.text)}")
    except Exception as exc:
        errors.append(f"http: {exc}")
    if await _file_exists(request, config, relative) is False:
        return {}
    log.warning("delete of %s on %s failed: %s", full_path, config.id, "; ".join(errors))
    raise HTTPException(status_code=502, detail=errors[0].split(": ", 1)[-1])


@router.delete("/printers/{printer_id}/files", dependencies=manage_files_only)
async def delete_entry(request: Request, printer_id: str, path: str, is_dir: bool = False) -> dict:
    config = require_config(request, printer_id)
    segments = clean_segments(path)
    if not segments:
        raise HTTPException(status_code=400, detail="Can't delete the gcodes root.")
    full_path = join_root(segments)
    if is_dir:
        return await moonraker_json(
            request, config, "DELETE", f"/server/files/directory?path={_quoted(full_path)}&force=true"
        )
    return await _delete_file(request, config, full_path)


@router.post("/printers/{printer_id}/files/upload", dependencies=manage_files_only)
async def upload_file(
    request: Request,
    printer_id: str,
    file: UploadFile = File(...),
    path: str = Form(""),
) -> dict:
    config = require_config(request, printer_id)
    filename = require_plain_name(file.filename or "", "filename")
    if file.size is not None and file.size > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=413, detail=f"File is larger than the {MAX_UPLOAD_BYTES // (1024 ** 2)} MB upload limit."
        )
    data = {"root": FILES_ROOT, "print": "false"}
    segments = clean_segments(path)
    if segments:
        data["path"] = "/".join(segments)
    # Pass the spooled file object through; gcode can be hundreds of MB.
    files = {"file": (filename, file.file, file.content_type or "application/octet-stream")}
    return await moonraker_result(
        request, config, "POST", "/server/files/upload", data=data, files=files, timeout=600,
    )


# --- metadata ----------------------------------------------------------------
# Moonraker parses thumbnails and slicer comments at upload time; these just proxy.

async def _metadata(request: Request, config: PrinterConfig, segments: list[str]) -> dict:
    return await moonraker_result(
        request, config, "GET", f"/server/files/metadata?filename={_quoted('/'.join(segments))}"
    )


@router.get("/printers/{printer_id}/files/info")
async def file_info(request: Request, printer_id: str, filename: str) -> dict:
    config = require_config(request, printer_id)
    return await _metadata(request, config, clean_segments(filename, "filename"))


@router.get("/printers/{printer_id}/files/thumbnail")
async def file_thumbnail(request: Request, printer_id: str, filename: str) -> Response:
    """Largest embedded thumbnail. `relative_path` in the metadata is relative
    to the gcode file's directory, not the root."""
    config = require_config(request, printer_id)
    segments = clean_segments(filename, "filename")
    thumbnails = (await _metadata(request, config, segments)).get("thumbnails") or []
    if not thumbnails:
        raise HTTPException(status_code=404, detail="no thumbnail for this file")
    largest = max(thumbnails, key=lambda t: t.get("size", 0))

    # relative_path comes from the printer, but it still goes into a URL we build.
    thumb_segments = segments[:-1] + clean_segments(str(largest.get("relative_path", "")), "thumbnail path")
    thumb_path = join_root(thumb_segments)
    resp = await moonraker_request(request, config, "GET", f"/server/files/{_quoted(thumb_path)}", timeout=15)
    content_type = "image/png" if thumb_path.lower().endswith(".png") else "image/jpeg"
    # Rows in the file and history lists each fetch one; a short cache stops
    # a re-render refetching them all.
    return Response(content=resp.content, media_type=content_type, headers={"Cache-Control": "private, max-age=300"})
