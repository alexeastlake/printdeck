"""Print jobs (start/pause/resume/cancel), job history, and the G-code relay."""

from __future__ import annotations

import re
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from .common import (
    clean_segments,
    control_printers_only,
    manage_files_only,
    moonraker_json,
    moonraker_result,
    require_config,
)

router = APIRouter()

# Moonraker's own job endpoints, so the printer's PAUSE/CANCEL_PRINT macros run.
JOB_ACTIONS = {
    "pause": "/printer/print/pause",
    "resume": "/printer/print/resume",
    "cancel": "/printer/print/cancel",
}

GCODE_EXTENSIONS = (".gcode", ".gco", ".g", ".ufp")
HISTORY_PAGE_MAX = 100
_JOB_ID_RE = re.compile(r"^[A-Za-z0-9]{1,32}$")  # Moonraker ids look like 00001A


class StartPrint(BaseModel):
    filename: str = Field(max_length=4096)  # relative to gcodes root


class GcodeScript(BaseModel):
    script: str = Field(max_length=2000)


class LightSwitch(BaseModel):
    on: bool


async def _ok_result(request: Request, config, path: str, **kwargs) -> dict:
    # Moonraker returns the bare string "ok" here; wrap it so the shape is predictable.
    data = await moonraker_json(request, config, "POST", path, **kwargs)
    return {"result": data.get("result", "ok")}


# --- jobs --------------------------------------------------------------------

@router.post("/printers/{printer_id}/job/start", dependencies=control_printers_only)
async def start_print(request: Request, printer_id: str, body: StartPrint) -> dict:
    config = require_config(request, printer_id)
    segments = clean_segments(body.filename, "filename")
    if not segments or not segments[-1].lower().endswith(GCODE_EXTENSIONS):
        raise HTTPException(status_code=400, detail="Pick a G-code file to print.")
    # Klipper would refuse too, but with a cryptic virtual-SD error.
    status = request.app.state.manager.status(printer_id)
    if status is not None and status.state in ("printing", "paused"):
        raise HTTPException(status_code=409, detail="A print is already running on this printer.")
    filename = quote("/".join(segments), safe="/")
    return await _ok_result(request, config, f"/printer/print/start?filename={filename}", timeout=30)


@router.post("/printers/{printer_id}/job/{action}", dependencies=control_printers_only)
async def job_action(request: Request, printer_id: str, action: str) -> dict:
    config = require_config(request, printer_id)
    path = JOB_ACTIONS.get(action)
    if path is None:
        raise HTTPException(status_code=404, detail="unknown job action")
    # Pause/cancel block until the macros finish (retract, park), which takes a few seconds.
    return await _ok_result(request, config, path, timeout=60)


# --- history -----------------------------------------------------------------
# Read-only proxy of Moonraker's [history] component. If it's not enabled,
# Moonraker's error passes through.

@router.get("/printers/{printer_id}/history")
async def job_history(request: Request, printer_id: str, limit: int = 25, start: int = 0) -> dict:
    config = require_config(request, printer_id)
    limit = max(1, min(limit, HISTORY_PAGE_MAX))
    start = max(0, start)
    return await moonraker_result(
        request, config, "GET", f"/server/history/list?limit={limit}&start={start}&order=desc"
    )


@router.get("/printers/{printer_id}/history/totals")
async def job_history_totals(request: Request, printer_id: str) -> dict:
    config = require_config(request, printer_id)
    return await moonraker_result(request, config, "GET", "/server/history/totals")


@router.delete("/printers/{printer_id}/history/{job_id}", dependencies=manage_files_only)
async def delete_history_job(request: Request, printer_id: str, job_id: str) -> dict:
    config = require_config(request, printer_id)
    if not _JOB_ID_RE.match(job_id):
        raise HTTPException(status_code=400, detail="Invalid job id.")
    return {"deleted": await moonraker_result(request, config, "DELETE", f"/server/history/job?uid={job_id}")}


@router.delete("/printers/{printer_id}/history", dependencies=manage_files_only)
async def clear_history(request: Request, printer_id: str) -> dict:
    config = require_config(request, printer_id)
    return {"deleted": await moonraker_result(request, config, "DELETE", "/server/history/job?all=true")}


# --- Creality chamber light ----------------------------------------------------
# Not G-code: goes to Creality's port-9999 service (see creality.py). Klipper
# lights use the relay below.

@router.post("/printers/{printer_id}/creality/light", dependencies=control_printers_only)
async def set_creality_light(request: Request, printer_id: str, body: LightSwitch) -> dict:
    require_config(request, printer_id)
    try:
        await request.app.state.manager.set_creality_light(printer_id, body.on)
    except KeyError:
        raise HTTPException(status_code=404, detail="Creality light control isn't enabled for this printer.")
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    return {"ok": True}


# --- gcode relay -------------------------------------------------------------
# Every control on the detail page builds a G-code string and sends it here.

@router.post("/printers/{printer_id}/gcode", dependencies=control_printers_only)
async def run_gcode(request: Request, printer_id: str, body: GcodeScript) -> dict:
    config = require_config(request, printer_id)
    script = body.script.strip()
    if not script:
        raise HTTPException(status_code=400, detail="Empty G-code script.")
    # Moonraker waits for the command to finish (homing can take a while).
    return await _ok_result(request, config, "/printer/gcode/script", json={"script": script}, timeout=60)
