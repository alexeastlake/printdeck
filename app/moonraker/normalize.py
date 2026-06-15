"""Turn Moonraker's raw object dict into our flat PrinterStatus.

Kept as a plain function (no state) so it's trivial to read and to test against
a captured Moonraker payload later.
"""

from __future__ import annotations

from ..models import PrinterConfig, PrinterStatus


def normalize(config: PrinterConfig, objects: dict[str, dict]) -> PrinterStatus:
    webhooks = objects.get("webhooks", {})
    print_stats = objects.get("print_stats", {})
    display = objects.get("display_status", {})
    sdcard = objects.get("virtual_sdcard", {})
    extruder = objects.get("extruder", {})
    bed = objects.get("heater_bed", {})

    progress = display.get("progress")
    if progress is None:
        progress = sdcard.get("progress", 0.0)

    print_duration = print_stats.get("print_duration", 0.0) or 0.0

    return PrinterStatus(
        id=config.id,
        name=config.name,
        online=True,
        state=_derive_state(webhooks, print_stats),
        extruder_temp=round(extruder.get("temperature", 0.0), 1),
        extruder_target=extruder.get("target", 0.0),
        bed_temp=round(bed.get("temperature", 0.0), 1),
        bed_target=bed.get("target", 0.0),
        progress=progress,
        filename=print_stats.get("filename") or None,
        print_duration=print_duration,
        eta_seconds=_estimate_eta(print_duration, progress),
        message=print_stats.get("message") or webhooks.get("state_message") or None,
        camera_url=config.camera_url,
    )


def offline_status(config: PrinterConfig) -> PrinterStatus:
    """What we report when we can't reach the printer at all."""
    return PrinterStatus(
        id=config.id,
        name=config.name,
        online=False,
        state="offline",
        camera_url=config.camera_url,
    )


def _derive_state(webhooks: dict, print_stats: dict) -> str:
    klipper = webhooks.get("state")  # ready, startup, shutdown, error
    if klipper in ("shutdown", "error"):
        return "error"

    job = print_stats.get("state")  # standby, printing, paused, complete, error
    if job == "printing":
        return "printing"
    if job == "paused":
        return "paused"
    if job == "error":
        return "error"
    return "idle"


def _estimate_eta(print_duration: float, progress: float) -> float | None:
    """A rough ETA from elapsed time and progress fraction. Good enough for a
    glanceable dashboard; we can swap in slicer time estimates later."""
    if progress and progress > 0.01:
        total = print_duration / progress
        return max(total - print_duration, 0.0)
    return None
