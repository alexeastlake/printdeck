"""Printer side: one websocket per printer, Moonraker objects → PrinterStatus,
and the manager that owns the tasks and fans updates out to browsers.

Moonraker is JSON-RPC over ws://host:7125/websocket and only sends changed
fields, so the client keeps a running merge.
https://moonraker.readthedocs.io/en/latest/web_api/
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from collections.abc import AsyncIterator
from pathlib import Path

import websockets

from . import creality
from .config import save_printers
from .models import FanStatus, LightStatus, PrinterConfig, PrinterStatus

log = logging.getLogger("printdeck.moonraker")


# Klipper can restart under an open websocket and silently drop our
# subscription. If nothing arrives for this long, re-subscribe; the reply is
# a full snapshot. During a print updates are constant, so this never fires.
RESUBSCRIBE_AFTER = 20.0

# None = all fields. Extra fans are discovered per connection.
SUBSCRIBED_OBJECTS = {
    "webhooks": None,
    "print_stats": None,
    "display_status": None,
    "virtual_sdcard": None,  # progress fallback
    "heater_bed": None,
    "extruder": None,
    "toolhead": None,
    "fan": None,
}

# Klipper has no "light" type. LED strips are unambiguous; an output_pin is
# only a light if its name says so (the K1's chamber light is [output_pin LED]).
_LED_PREFIXES = ("led ", "neopixel ", "dotstar ", "pca9632 ", "pca9533 ")
_LIGHT_PIN_RE = re.compile(r"(led|light|lamp|chamber|case)", re.IGNORECASE)


def is_light_object(name: str) -> bool:
    if name.startswith(_LED_PREFIXES):
        return True
    return name.startswith("output_pin ") and bool(_LIGHT_PIN_RE.search(name.split(" ", 1)[1]))


# Requests are sequential, so ids only need to be distinct.
_ID_SUBSCRIBE = 1
_ID_OBJECT_LIST = 2
_ID_CONFIG_QUERY = 3


class MoonrakerClient:
    def __init__(self, config: PrinterConfig) -> None:
        self.config = config
        self._objects: dict[str, dict] = {}
        self.limits: dict[str, float] = {}  # heater max_temp, see _read_limits
        self.pin_settings: dict[str, dict] = {}  # output_pin name -> {pwm, scale}, see _read_limits

    async def stream(self) -> AsyncIterator[dict[str, dict]]:
        """Yield the merged object state on every update. Raises on disconnect."""
        self._objects = {}
        self.limits = {}
        self.pin_settings = {}
        # open_timeout includes DNS. A cold ".local" lookup on Windows can
        # take close to 10s, so the library default was too tight.
        async with websockets.connect(
            self.config.ws_url,
            additional_headers=self.config.auth_headers,
            open_timeout=15,
            ping_interval=20,
            ping_timeout=20,
            max_size=None,
        ) as ws:
            log.info("connected to %s", self.config.ws_url)
            objects = await self._objects_to_subscribe(ws)
            await self._read_limits(ws)
            await ws.send(json.dumps(self._subscribe_request(objects)))
            while True:
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=RESUBSCRIBE_AFTER)
                except TimeoutError:
                    await ws.send(json.dumps(self._subscribe_request(objects)))
                    continue
                changed = self._extract_status(json.loads(raw))
                if changed is None:
                    continue
                self._merge(changed)
                yield self._objects

    @staticmethod
    async def _rpc(ws, method: str, params: dict | None, request_id: int, timeout: float = 5) -> dict:
        # Push notifications can interleave; read until our id comes back.
        message: dict = {"jsonrpc": "2.0", "method": method, "id": request_id}
        if params is not None:
            message["params"] = params
        await ws.send(json.dumps(message))
        async with asyncio.timeout(timeout):
            while True:
                msg = json.loads(await ws.recv())
                if msg.get("id") == request_id:
                    if "error" in msg:
                        raise RuntimeError(msg["error"].get("message", method))
                    return msg.get("result", {})

    async def _objects_to_subscribe(self, ws) -> dict[str, None]:
        # Klipper has no fixed fan list (any number of [fan_generic X]), so ask.
        objects = dict(SUBSCRIBED_OBJECTS)
        try:
            result = await self._rpc(ws, "printer.objects.list", None, _ID_OBJECT_LIST)
            for name in result.get("objects", []):
                if name == "fan" or name.startswith("fan_generic ") or is_light_object(name):
                    objects[name] = None
        except Exception as exc:
            log.info("couldn't list extra fan objects for %s: %s", self.config.id, exc)
        return objects

    async def _read_limits(self, ws) -> None:
        # Only so the UI can cap its inputs at the real max_temp; Klipper
        # enforces it regardless. One-off query: a config change restarts
        # Klipper, which reconnects us.
        try:
            result = await self._rpc(
                ws, "printer.objects.query",
                {"objects": {"configfile": ["settings"]}}, _ID_CONFIG_QUERY,
            )
            settings = result.get("status", {}).get("configfile", {}).get("settings", {})
            for section, key in (("extruder", "extruder_max_temp"), ("heater_bed", "bed_max_temp")):
                value = settings.get(section, {}).get("max_temp")
                if isinstance(value, (int, float)):
                    self.limits[key] = float(value)
            # Whether a light pin can dim, and what SET_PIN's full-on value is.
            for section, cfg in settings.items():
                if section.startswith("output_pin ") and isinstance(cfg, dict):
                    self.pin_settings[section] = {
                        "pwm": bool(cfg.get("pwm", False)),
                        "scale": float(cfg.get("scale", 1.0) or 1.0),
                    }
        except Exception as exc:
            log.info("couldn't read heater limits for %s: %s", self.config.id, exc)

    @staticmethod
    def _subscribe_request(objects: dict[str, None]) -> dict:
        return {
            "jsonrpc": "2.0",
            "method": "printer.objects.subscribe",
            "params": {"objects": objects},
            "id": _ID_SUBSCRIBE,
        }

    @staticmethod
    def _extract_status(msg: dict) -> dict | None:
        # Subscribe reply: {"result": {"status": {...}}}
        result = msg.get("result")
        if isinstance(result, dict) and "status" in result:
            return result["status"]
        # Push: {"method": "notify_status_update", "params": [{...}, eventtime]}
        if msg.get("method") == "notify_status_update":
            params = msg.get("params") or [{}]
            return params[0]
        return None

    def _merge(self, changed: dict[str, dict]) -> None:
        for obj_name, fields in changed.items():
            self._objects.setdefault(obj_name, {}).update(fields)


# --- Moonraker objects -> PrinterStatus ------------------------------------

def _extract_fans(objects: dict[str, dict]) -> list[FanStatus]:
    # Insertion order: "fan" is in SUBSCRIBED_OBJECTS, so it comes first.
    fans = []
    for name, data in objects.items():
        if name == "fan":
            # [fan] has no name of its own; "Part Fan" matches Mainsail/Fluidd.
            fans.append(FanStatus(id="fan", name="Part Fan", speed=data.get("speed", 0.0)))
        elif name.startswith("fan_generic "):
            fans.append(FanStatus(
                id=name,
                name=_humanize(name.split(" ", 1)[1]),
                speed=data.get("speed", 0.0),
            ))
    return fans


def _extract_lights(objects: dict[str, dict], pin_settings: dict[str, dict]) -> list[LightStatus]:
    lights = []
    for name, data in objects.items():
        if not is_light_object(name):
            continue
        kind, label = name.split(" ", 1)
        if kind == "output_pin":
            cfg = pin_settings.get(name, {})
            scale = cfg.get("scale", 1.0) or 1.0
            lights.append(LightStatus(
                id=name, name=_humanize(label), kind="pin",
                value=min(1.0, max(0.0, float(data.get("value") or 0.0) / scale)),
                dimmable=cfg.get("pwm", False), scale=scale,
            ))
        else:
            # color_data is a list of [r, g, b(, w)] per pixel; brightness is the brightest channel.
            pixels = data.get("color_data") or []
            first = pixels[0] if pixels else []
            lights.append(LightStatus(
                id=name, name=_humanize(label), kind="led",
                value=float(max(first)) if first else 0.0,
                dimmable=True, white=len(first) >= 4,
            ))
    return lights


def _humanize(config_name: str) -> str:
    """model_fan -> "Model Fan"."""
    return config_name.replace("_", " ").replace("-", " ").title()


def _connection_fields(config: PrinterConfig) -> dict:
    return {
        "id": config.id,
        "name": config.name,
        "host": config.host,
        "moonraker_port": config.moonraker_port,
        "tls": config.tls,
        "has_api_key": bool(config.api_key),
        "creality_light": config.creality_light,
        "camera_url": config.camera_url,
        "group": config.group,
    }


def normalize(
    config: PrinterConfig,
    objects: dict[str, dict],
    limits: dict[str, float] | None = None,
    pin_settings: dict[str, dict] | None = None,
) -> PrinterStatus:
    limits = limits or {}
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
    # state_message is "Printer is ready" when healthy; only worth promoting
    # to the alert line when Klipper isn't ready.
    klipper_status = webhooks.get("state_message") or None
    webhooks_message = klipper_status if webhooks.get("state") != "ready" else None

    return PrinterStatus(
        **_connection_fields(config),
        online=True,
        state=_derive_state(webhooks, print_stats),
        extruder_temp=round(extruder.get("temperature") or 0.0, 1),
        extruder_target=extruder.get("target") or 0.0,
        bed_temp=round(bed.get("temperature") or 0.0, 1),
        bed_target=bed.get("target") or 0.0,
        extruder_max_temp=limits.get("extruder_max_temp"),
        bed_max_temp=limits.get("bed_max_temp"),
        fans=_extract_fans(objects),
        lights=_extract_lights(objects, pin_settings or {}),
        progress=progress or 0.0,
        filename=print_stats.get("filename") or None,
        print_duration=print_duration,
        eta_seconds=_estimate_eta(print_duration, progress or 0.0),
        filament_used=print_stats.get("filament_used", 0.0) or 0.0,
        x=position[0],
        y=position[1],
        z=position[2],
        homed_axes=toolhead.get("homed_axes", ""),
        message=print_stats.get("message") or webhooks_message or None,
        klipper_status=klipper_status,
    )


def offline_status(config: PrinterConfig) -> PrinterStatus:
    return PrinterStatus(**_connection_fields(config), online=False, state="offline")


def connecting_status(config: PrinterConfig) -> PrinterStatus:
    # "offline" means we tried and failed; this means we haven't heard back
    # yet. Without it every printer flashes offline on startup.
    return PrinterStatus(**_connection_fields(config), online=False, state="connecting")


def _derive_state(webhooks: dict, print_stats: dict) -> str:
    klipper = webhooks.get("state")  # ready | startup | shutdown | error
    if klipper in ("shutdown", "error"):
        return "error"

    job = print_stats.get("state")  # standby | printing | paused | complete | cancelled | error
    if job == "printing":
        return "printing"
    if job == "paused":
        return "paused"
    if job == "error":
        return "error"
    if job == "complete":
        # Sticky: Klipper reports this until the next print (or SDCARD_RESET_FILE).
        return "complete"
    return "idle"


def _estimate_eta(print_duration: float, progress: float) -> float | None:
    # Fallback only; the detail page prefers the slicer's estimate once loaded.
    if progress and progress > 0.01:
        total = print_duration / progress
        return max(total - print_duration, 0.0)
    return None


# --- manager ---------------------------------------------------------------

RECONNECT_MIN = 2.0
RECONNECT_MAX = 30.0

# Per browser connection. A tab that stops draining (backgrounded phone,
# half-open TCP) would otherwise grow forever. Every message is a full
# snapshot, so dropping the oldest loses nothing.
SUBSCRIBER_QUEUE_SIZE = 256

# Changing any of these reconnects; anything else just repaints the card.
_CONNECTION_KEYS = ("host", "moonraker_port", "api_key", "tls", "creality_light")


class PrinterManager:
    def __init__(self, configs: list[PrinterConfig], printers_file: Path) -> None:
        self._printers_file = printers_file
        self._configs = configs
        self._by_id: dict[str, PrinterConfig] = {c.id: c for c in configs}
        self._status: dict[str, PrinterStatus] = {
            c.id: connecting_status(c) for c in configs
        }
        self._tasks: dict[str, asyncio.Task] = {}
        self._subscribers: set[asyncio.Queue[dict]] = set()
        self._completed_at: dict[str, float] = {}
        # Creality light service, only for printers that opt in (see creality.py).
        self._light_tasks: dict[str, asyncio.Task] = {}
        self._light_clients: dict[str, creality.CrealityLightClient] = {}

    # --- lifecycle -------------------------------------------------------

    async def start(self) -> None:
        for c in self._configs:
            self._spawn(c)

    async def stop(self) -> None:
        tasks = list(self._tasks.values()) + list(self._light_tasks.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        self._tasks.clear()
        self._light_tasks.clear()
        self._light_clients.clear()

    def _spawn(self, config: PrinterConfig) -> None:
        self._tasks[config.id] = asyncio.create_task(
            self._run(config), name=f"printer:{config.id}"
        )
        if config.creality_light:
            client = creality.CrealityLightClient(
                config, lambda state, pid=config.id: self._on_creality_light(pid, state)
            )
            self._light_clients[config.id] = client
            self._light_tasks[config.id] = asyncio.create_task(client.run(), name=f"light:{config.id}")

    async def _despawn(self, printer_id: str) -> None:
        tasks = [t for t in (self._tasks.pop(printer_id, None), self._light_tasks.pop(printer_id, None)) if t]
        self._light_clients.pop(printer_id, None)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    # --- Creality light --------------------------------------------------

    def _with_creality_light(self, status: PrinterStatus) -> PrinterStatus:
        client = self._light_clients.get(status.id)
        lights = [light for light in status.lights if light.id != creality.LIGHT_ID]
        if client is not None and client.state is not None and status.online:
            lights.append(creality.light_status(client.state))
        status.lights = lights
        return status

    def _on_creality_light(self, printer_id: str, state: bool | None) -> None:
        current = self._status.get(printer_id)
        if current is not None and current.online:
            self._publish(self._with_creality_light(current.model_copy()))

    async def set_creality_light(self, printer_id: str, on: bool) -> None:
        client = self._light_clients.get(printer_id)
        if client is None:
            raise KeyError(printer_id)
        await client.set(on)

    # --- reads -----------------------------------------------------------

    def snapshots(self) -> list[PrinterStatus]:
        return list(self._status.values())

    def status(self, printer_id: str) -> PrinterStatus | None:
        return self._status.get(printer_id)

    def config(self, printer_id: str) -> PrinterConfig | None:
        return self._by_id.get(printer_id)

    def _save(self) -> None:
        save_printers(self._printers_file, self._configs)

    # --- edits -----------------------------------------------------------

    async def update_printer(self, printer_id: str, **fields) -> PrinterStatus:
        old = self._by_id[printer_id]
        new = old.model_copy(update=fields)
        self._by_id[printer_id] = new
        self._configs = [new if c.id == printer_id else c for c in self._configs]
        self._save()

        if any(getattr(new, key) != getattr(old, key) for key in _CONNECTION_KEYS):
            # Old task down before the new one up, never two per printer.
            await self._despawn(printer_id)
            self._publish(offline_status(new))
            self._spawn(new)
        else:
            current = self._status[printer_id]
            self._publish(current.model_copy(update=_connection_fields(new)))
        return self._status[printer_id]

    async def add_printer(self, config: PrinterConfig) -> PrinterStatus:
        self._configs.append(config)
        self._by_id[config.id] = config
        self._save()
        self._spawn(config)
        status = connecting_status(config)
        self._publish(status)
        return status

    async def remove_printer(self, printer_id: str) -> None:
        if printer_id not in self._by_id:
            raise KeyError(printer_id)
        await self._despawn(printer_id)
        del self._by_id[printer_id]
        self._configs = [c for c in self._configs if c.id != printer_id]
        self._status.pop(printer_id, None)
        self._save()
        self._broadcast({"type": "removed", "id": printer_id})

    # --- fan-out ---------------------------------------------------------

    def subscribe(self) -> asyncio.Queue[dict]:
        queue: asyncio.Queue[dict] = asyncio.Queue(maxsize=SUBSCRIBER_QUEUE_SIZE)
        self._subscribers.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue[dict]) -> None:
        self._subscribers.discard(queue)

    def _publish(self, status: PrinterStatus) -> None:
        self._status[status.id] = status
        self._broadcast({"type": "update", "printer": status.model_dump()})

    def _track_completion(self, status: PrinterStatus) -> PrinterStatus:
        # Klipper has no end timestamp, so "finished N min ago" comes from
        # noticing the printing→complete transition ourselves. Keyed by
        # printer so it survives reconnects; gone once the state moves on.
        if status.state != "complete":
            self._completed_at.pop(status.id, None)
            return status
        previous = self._status.get(status.id)
        if previous is not None and previous.state in ("printing", "paused"):
            self._completed_at[status.id] = time.time()
        status.completed_at = self._completed_at.get(status.id)
        return status

    def _broadcast(self, message: dict) -> None:
        for queue in self._subscribers:
            if queue.full():
                try:
                    queue.get_nowait()
                except asyncio.QueueEmpty:
                    pass
            queue.put_nowait(message)

    # --- per-printer loop ------------------------------------------------

    async def _run(self, config: PrinterConfig) -> None:
        # Connection details are fixed for this task (a change respawns it);
        # name/camera edits land in self._by_id, so read that when publishing.
        client = MoonrakerClient(config)
        backoff = RECONNECT_MIN
        # First failure INFO, repeats DEBUG, so an unplugged printer doesn't spam the log every 30s.
        was_reachable = True
        while True:
            self._publish(connecting_status(self._by_id[config.id]))
            try:
                async for objects in client.stream():
                    status = normalize(self._by_id[config.id], objects, client.limits, client.pin_settings)
                    self._publish(self._with_creality_light(self._track_completion(status)))
                    backoff = RECONNECT_MIN
                    was_reachable = True
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                log.log(
                    logging.INFO if was_reachable else logging.DEBUG,
                    "printer %s unreachable: %s", config.id, exc,
                )
                was_reachable = False

            self._publish(offline_status(self._by_id[config.id]))
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, RECONNECT_MAX)
