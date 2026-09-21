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
from .models import FanStatus, PrinterConfig, PrinterStatus

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
    "toolhead": None,        # position, homed axes — the detail page's jog controls
    "fan": None,             # the primary part-cooling fan; other fans this
                             # printer has are discovered per-connection, see
                             # MoonrakerClient._objects_to_subscribe
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
        # open_timeout covers DNS resolution too, not just the TCP/WS
        # handshake — the library's 10s default can be too tight for a
        # ".local" mDNS hostname on Windows, where a cold lookup can
        # legitimately take close to that long on its own (mDNS resolves
        # near-instantly on macOS/Linux; Windows is slower to warm up).
        # Aborting at 10s just means the next retry starts DNS over from
        # scratch instead of letting a slow-but-working lookup finish.
        async with websockets.connect(
            self.ws_url, open_timeout=15, ping_interval=20, ping_timeout=20, max_size=None
        ) as ws:
            log.info("connected to %s", self.ws_url)
            objects = await self._objects_to_subscribe(ws)
            await ws.send(json.dumps(self._subscribe_request(objects)))
            while True:
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=RESUBSCRIBE_AFTER)
                except asyncio.TimeoutError:
                    # Gone quiet — our subscription may have been dropped. Renew
                    # it; the reply carries a full snapshot that catches us up.
                    await ws.send(json.dumps(self._subscribe_request(objects)))
                    continue
                changed = self._extract_status(json.loads(raw))
                if changed is None:
                    continue
                self._merge(changed)
                yield self._objects

    async def _objects_to_subscribe(self, ws) -> dict[str, None]:
        """The fixed set this app always wants, plus whichever fan objects
        this specific printer happens to have configured. Klipper has no
        fixed list of fan names — a printer can have any number of
        `[fan_generic <name>]` sections beyond the one default `[fan]` — so
        we have to ask what's actually there rather than guess."""
        objects = dict(SUBSCRIBED_OBJECTS)
        try:
            await ws.send(json.dumps(
                {"jsonrpc": "2.0", "method": "printer.objects.list", "id": 2}
            ))
            async with asyncio.timeout(5):
                while True:
                    msg = json.loads(await ws.recv())
                    if msg.get("id") != 2:
                        continue  # a push notification arrived first; keep waiting
                    for name in msg.get("result", {}).get("objects", []):
                        if name == "fan" or name.startswith("fan_generic "):
                            objects[name] = None
                    break
        except Exception as exc:
            # Not fatal — we still get the one fan we always subscribe to.
            log.info("couldn't list extra fan objects for %s: %s", self.host, exc)
        return objects

    @staticmethod
    def _subscribe_request(objects: dict[str, None]) -> dict:
        return {
            "jsonrpc": "2.0",
            "method": "printer.objects.subscribe",
            "params": {"objects": objects},
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

def _extract_fans(objects: dict[str, dict]) -> list[FanStatus]:
    """Every fan-like object we're subscribed to — the primary `fan` plus
    whichever `fan_generic <name>` objects this printer has configured (see
    MoonrakerClient._objects_to_subscribe). Order is whatever dict iteration
    gives us, which is insertion order — primary fan first, since it's
    always in SUBSCRIBED_OBJECTS before any discovered ones get added."""
    fans = []
    for name, data in objects.items():
        if name == "fan":
            # Klipper's bare [fan] section has no name of its own — it's
            # always exactly one thing, the part-cooling fan. "Part Fan"
            # matches how Fluidd/Mainsail label it, and reads better next to
            # properly-named fan_generic entries than a bare "Fan" would.
            fans.append(FanStatus(id="fan", name="Part Fan", speed=data.get("speed", 0.0)))
        elif name.startswith("fan_generic "):
            fans.append(FanStatus(
                id=name,
                name=_humanize(name.split(" ", 1)[1]),
                speed=data.get("speed", 0.0),
            ))
    return fans


def _humanize(config_name: str) -> str:
    """Klipper section names are snake_case (`model_fan`, `chassis-fan`) —
    turn that into a normal display label ("Model Fan") instead of showing
    the raw config identifier verbatim."""
    return config_name.replace("_", " ").replace("-", " ").title()


def normalize(config: PrinterConfig, objects: dict[str, dict]) -> PrinterStatus:
    webhooks = objects.get("webhooks", {})
    print_stats = objects.get("print_stats", {})
    display = objects.get("display_status", {})
    sdcard = objects.get("virtual_sdcard", {})
    extruder = objects.get("extruder", {})
    bed = objects.get("heater_bed", {})
    toolhead = objects.get("toolhead", {})

    progress = display.get("progress")
    if progress is None:
        progress = sdcard.get("progress", 0.0)

    print_duration = print_stats.get("print_duration", 0.0) or 0.0
    position = toolhead.get("position") or [0.0, 0.0, 0.0]
    print_info = print_stats.get("info") or {}
    # webhooks.state_message is Klipper's own status line — for a healthy
    # printer that's just "Printer is ready". It's always shown labeled as
    # Status on the detail page (klipper_status), but only promoted to the
    # attention-grabbing `message` field when Klipper isn't in its normal
    # ready state (startup/shutdown/error), where it's actually noteworthy.
    klipper_status = webhooks.get("state_message") or None
    webhooks_message = klipper_status if webhooks.get("state") != "ready" else None

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
        fans=_extract_fans(objects),
        progress=progress,
        filename=print_stats.get("filename") or None,
        print_duration=print_duration,
        eta_seconds=_estimate_eta(print_duration, progress),
        filament_used=print_stats.get("filament_used", 0.0) or 0.0,
        current_layer=print_info.get("current_layer"),
        total_layer=print_info.get("total_layer"),
        x=position[0],
        y=position[1],
        z=position[2],
        homed_axes=toolhead.get("homed_axes", ""),
        message=print_stats.get("message") or webhooks_message or None,
        klipper_status=klipper_status,
        camera_url=config.camera_url,
        group=config.group,
    )


def offline_status(config: PrinterConfig) -> PrinterStatus:
    """What we report once a connection attempt has actually failed."""
    return PrinterStatus(
        id=config.id,
        name=config.name,
        host=config.host,
        online=False,
        state="offline",
        camera_url=config.camera_url,
        group=config.group,
    )


def connecting_status(config: PrinterConfig) -> PrinterStatus:
    """What we report while a connection attempt is in flight but hasn't
    resolved either way yet — right after server startup, and at the start
    of every reconnect attempt. Distinct from offline_status: "offline"
    means we tried and it's actually unreachable, this just means we don't
    know yet. Without this, a printer flashes "offline" for a moment on
    every startup even though it's fine — just not yet checked."""
    return PrinterStatus(
        id=config.id,
        name=config.name,
        host=config.host,
        online=False,
        state="connecting",
        camera_url=config.camera_url,
        group=config.group,
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
            c.id: connecting_status(c) for c in configs
        }
        self._tasks: dict[str, asyncio.Task] = {}
        self._subscribers: set[asyncio.Queue[dict]] = set()

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

    def status(self, printer_id: str) -> PrinterStatus | None:
        return self._status.get(printer_id)

    def config(self, printer_id: str) -> PrinterConfig | None:
        return self._by_id.get(printer_id)

    # --- runtime edits ---------------------------------------------------

    async def update_printer(
        self,
        printer_id: str,
        *,
        name: str,
        host: str,
        camera_url: str | None,
        group: str,
    ) -> PrinterStatus:
        """Edit a printer's settings and apply them in place — no server restart.
        Persists the change so it survives the next boot. Only a changed host
        forces a reconnect; renaming/regrouping just refreshes the card."""
        old = self._by_id[printer_id]
        new = old.model_copy(
            update={"name": name, "host": host, "camera_url": camera_url, "group": group}
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
                current.model_copy(
                    update={"name": new.name, "camera_url": new.camera_url, "group": new.group}
                )
            )
        return self._status[printer_id]

    # --- adding / removing printers ---------------------------------------

    async def add_printer(
        self, *, id: str, name: str, host: str, camera_url: str | None, group: str
    ) -> PrinterStatus:
        """Add a new printer at runtime — persists it and starts connecting
        immediately, no server restart needed."""
        config = PrinterConfig(id=id, name=name, host=host, camera_url=camera_url, group=group)
        self._configs.append(config)
        self._by_id[id] = config
        save_printers(self._configs)
        self._spawn(config)
        status = connecting_status(config)
        self._publish(status)
        return status

    async def remove_printer(self, printer_id: str) -> None:
        """Remove a printer at runtime — stop talking to it, forget it, and
        tell connected browsers to drop its card. Just stops PrintDeck from
        managing it; doesn't touch the printer itself."""
        if printer_id not in self._by_id:
            raise KeyError(printer_id)
        task = self._tasks.pop(printer_id, None)
        if task:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        del self._by_id[printer_id]
        self._configs = [c for c in self._configs if c.id != printer_id]
        self._status.pop(printer_id, None)
        save_printers(self._configs)
        self._broadcast({"type": "removed", "id": printer_id})

    # --- frontend fan-out ------------------------------------------------

    def subscribe(self) -> asyncio.Queue[dict]:
        queue: asyncio.Queue[dict] = asyncio.Queue()
        self._subscribers.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue[dict]) -> None:
        self._subscribers.discard(queue)

    def _publish(self, status: PrinterStatus) -> None:
        self._status[status.id] = status
        self._broadcast({"type": "update", "printer": status.model_dump()})

    def _broadcast(self, message: dict) -> None:
        for queue in self._subscribers:
            queue.put_nowait(message)

    # --- per-printer connection loop -------------------------------------

    async def _run(self, config: PrinterConfig) -> None:
        # The host is fixed for this task (a host change respawns the task), but
        # name/camera edits land in self._by_id, so read it live when publishing.
        client = MoonrakerClient(config.host, config.moonraker_port)
        backoff = RECONNECT_MIN
        while True:
            self._publish(connecting_status(self._by_id[config.id]))
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
