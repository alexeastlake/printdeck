"""The two data shapes PrintDeck cares about: how a printer is configured,
and the normalized status we hand to the browser."""

from __future__ import annotations

from pydantic import BaseModel


class PrinterConfig(BaseModel):
    """One entry from printers.yaml."""

    id: str
    name: str
    host: str
    moonraker_port: int = 7125
    camera_url: str | None = None


class PrinterStatus(BaseModel):
    """A flattened, browser-friendly snapshot of a printer.

    This is deliberately not a 1:1 mirror of Moonraker's objects — it's only
    what the dashboard needs to render, so the frontend stays dumb and small.
    """

    id: str
    name: str
    online: bool = False
    # one of: idle, printing, paused, error, offline
    state: str = "offline"

    extruder_temp: float = 0.0
    extruder_target: float = 0.0
    bed_temp: float = 0.0
    bed_target: float = 0.0

    progress: float = 0.0  # 0..1
    filename: str | None = None
    print_duration: float = 0.0  # seconds elapsed on the current print
    eta_seconds: float | None = None  # rough estimate, None when unknown

    message: str | None = None  # Klipper/Moonraker status message, if any
    camera_url: str | None = None
