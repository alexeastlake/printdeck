"""The printer-facing half of PrintDeck, all in one place:

  MoonrakerClient — one websocket per printer: subscribe once, merge partial
                    updates, yield the full picture each time.
  normalize()     — turn Moonraker's raw objects into our flat PrinterStatus.
  PrinterManager  — one asyncio task per printer: connect, reconnect with
                    backoff, and fan status out to the browser.

Moonraker speaks JSON-RPC 2.0 over ws://host:7125/websocket and only sends the
*changed* fields, so the client keeps a running merge.
Docs: https://moonraker.readthedocs.io/en/latest/web_api/
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncIterator

import websockets

from .config import save_printers
from .models import PrinterConfig, PrinterStatus

log = logging.getLogger("printdeck.moonraker")


# --- one printer's Moonraker connection ------------------------------------

# If Moonraker goes this long without sending anything, re-subscribe. Klipper
# can restart underneath a still-open websocket and silently drop our
# subscription — no error, just no more updates — so we'd otherwise show stale
# values forever. While the printer sits idle at a stable temperature this is
# just a cheap periodic refresh; during a print, updates arrive constantly and
# the timeout never fires.
RESUBSCRIBE_AFTER = 20.0

# The Klipper objects the dashboard needs. `null` means "subscribe to all
# fields of this object". Add more here as the dashboard grows.
SUBSCRIBED_OBJECTS = {
    "webhooks": None,        # klipper ready / shutdown / error
    "print_stats": None,     # state, filename, duration, message
    "display_status": None,  # progress (0..1)
    "virtual_sdcard": None,  # progress fallback
    "heater_bed": None,      # bed temperature + target
    "extruder": None,        # nozzle temperature + target
    "toolhead": None,        # position, homed axes (used later)
}


class MoonrakerClient:
    def __init__(self, host: str, port: int = 7125) -> None:
        self.host = host
        self.port = port
        self._objects: dict[str, dict] = {}

    @property
    def ws_url(self) -> str:
        return f"ws://{self.host}:{self.port}/websocket"

    async def stream(self) -> AsyncIterator[dict[str, dict]]:
        """Connect, subscribe, and yield the merged object state on every update.

        Raises on connection loss so the caller can decide how to reconnect.
        """
        self._objects = {}
        async with websockets.connect(
            self.ws_url, ping_interval=20, ping_timeout=20, max_size=None
        ) as ws:
            await ws.send(json.dumps(self._subscribe_request()))
            while True:
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=RESUBSCRIBE_AFTER)
                except asyncio.TimeoutError:
                    # Gone quiet — our subscription may have been dropped. Renew
                    # it; the reply carries a full snapshot that catches us up.
                    await ws.send(json.dumps(self._subscribe_request()))
                    continue
                changed = self._extract_status(json.loads(raw))
                if changed is None:
                    continue
                self._merge(changed)
                yield self._objects

    @staticmethod
    def _subscribe_request() -> dict:
        return {
            "jsonrpc": "2.0",
            "method": "printer.objects.subscribe",
            "params": {"objects": SUBSCRIBED_OBJECTS},
            "id": 1,
        }

    @staticmethod
    def _extract_status(msg: dict) -> dict | None:
        """Pull the status payload out of either the subscribe reply or a
        push notification; ignore everything else Moonraker chatters about."""
        # Reply to our subscribe call: {"result": {"status": {...}}}
        result = msg.get("result")
        if isinstance(result, dict) and "status" in result:
            return result["status"]
        # Push update: {"method": "notify_status_update", "params": [{...}, time]}
        if msg.get("method") == "notify_status_update":
            params = msg.get("params") or [{}]
            return params[0]
        return None

    def _merge(self, changed: dict[str, dict]) -> None:
        for obj_name, fields in changed.items():
            self._objects.setdefault(obj_name, {}).update(fields)


# --- raw Moonraker objects -> our flat PrinterStatus -----------------------

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
        host=config.host,
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
        host=config.host,
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


# --- one task per printer, fanning status out to the page ------------------

RECONNECT_MIN = 2.0
RECONNECT_MAX = 30.0


class PrinterManager:
    def __init__(self, configs: list[PrinterConfig]) -> None:
        self._configs = configs
        self._by_id: dict[str, PrinterConfig] = {c.id: c for c in configs}
        self._status: dict[str, PrinterStatus] = {
            c.id: offline_status(c) for c in configs
        }
        self._tasks: dict[str, asyncio.Task] = {}
        self._subscribers: set[asyncio.Queue[PrinterStatus]] = set()

    # --- lifecycle -------------------------------------------------------

    async def start(self) -> None:
        for c in self._configs:
            self._spawn(c)

    async def stop(self) -> None:
        tasks = list(self._tasks.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        self._tasks.clear()

    def _spawn(self, config: PrinterConfig) -> None:
        self._tasks[config.id] = asyncio.create_task(
            self._run(config), name=f"printer:{config.id}"
        )

    # --- reads -----------------------------------------------------------

    def snapshots(self) -> list[PrinterStatus]:
        return list(self._status.values())

    def config(self, printer_id: str) -> PrinterConfig | None:
        return self._by_id.get(printer_id)

    # --- runtime edits ---------------------------------------------------

    async def update_printer(
        self, printer_id: str, *, name: str, host: str, camera_url: str | None
    ) -> PrinterStatus:
        """Edit a printer's settings and apply them in place — no server restart.
        Persists the change so it survives the next boot. Only a changed host
        forces a reconnect; renaming just refreshes the card."""
        old = self._by_id[printer_id]
        new = old.model_copy(
            update={"name": name, "host": host, "camera_url": camera_url}
        )
        self._by_id[printer_id] = new
        self._configs = [new if c.id == printer_id else c for c in self._configs]
        save_printers(self._configs)

        if new.host != old.host:
            # Tear the old connection down before bringing the new one up, so we
            # never have two tasks talking for the same printer.
            task = self._tasks.pop(printer_id, None)
            if task:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
            self._publish(offline_status(new))  # reflect the change immediately
            self._spawn(new)
        else:
            # Same address — no need to drop the live connection. Repaint the
            # card now; the running task already reads the live config.
            current = self._status[printer_id]
            self._publish(
                current.model_copy(update={"name": new.name, "camera_url": new.camera_url})
            )
        return self._status[printer_id]

    # --- frontend fan-out ------------------------------------------------

    def subscribe(self) -> asyncio.Queue[PrinterStatus]:
        queue: asyncio.Queue[PrinterStatus] = asyncio.Queue()
        self._subscribers.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue[PrinterStatus]) -> None:
        self._subscribers.discard(queue)

    def _publish(self, status: PrinterStatus) -> None:
        self._status[status.id] = status
        for queue in self._subscribers:
            queue.put_nowait(status)

    # --- per-printer connection loop -------------------------------------

    async def _run(self, config: PrinterConfig) -> None:
        # The host is fixed for this task (a host change respawns the task), but
        # name/camera edits land in self._by_id, so read it live when publishing.
        client = MoonrakerClient(config.host, config.moonraker_port)
        backoff = RECONNECT_MIN
        while True:
            try:
                async for objects in client.stream():
                    self._publish(normalize(self._by_id[config.id], objects))
                    backoff = RECONNECT_MIN  # healthy connection, reset
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # connection refused, timeout, reset, ...
                log.info("printer %s unreachable: %s", config.id, exc)

            self._publish(offline_status(self._by_id[config.id]))
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, RECONNECT_MAX)
