"""Chamber light on Creality K1-series stock firmware.

The light isn't a Klipper object there, so Moonraker can't see it. Creality's
own service on port 9999 (what the touchscreen and Creality Print use) speaks
JSON over a websocket: it pushes state objects that include `lightSw` (0/1),
and `{"method": "set", "params": {"lightSw": 1}}` switches it. That service
also sends heartbeat frames it expects echoed back, or it drops the client.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Callable

import websockets

from .models import LightStatus, PrinterConfig

log = logging.getLogger("printdeck.creality")

PORT = 9999
LIGHT_ID = "creality:light"
RECONNECT_MIN = 5.0
RECONNECT_MAX = 60.0


def light_status(on: bool) -> LightStatus:
    return LightStatus(id=LIGHT_ID, name="Chamber Light", kind="creality", value=1.0 if on else 0.0)


def light_state_from(msg: object) -> bool | None:
    """`lightSw` out of a pushed state object, if it's there."""
    if isinstance(msg, dict) and "lightSw" in msg:
        try:
            return bool(int(msg["lightSw"]))
        except (TypeError, ValueError):
            return None
    return None


def is_heartbeat(msg: object) -> bool:
    return isinstance(msg, dict) and msg.get("ModeCode") == "heart_beat"


class CrealityLightClient:
    """One connection per printer, kept open so state stays current.
    `on_change(state)` gets True/False from the printer, or None on disconnect."""

    def __init__(self, config: PrinterConfig, on_change: Callable[[bool | None], None]) -> None:
        self.config = config
        self.on_change = on_change
        self.state: bool | None = None
        self._ws = None

    @property
    def url(self) -> str:
        return f"ws://{self.config.host}:{PORT}"

    async def run(self) -> None:
        backoff = RECONNECT_MIN
        while True:
            try:
                # No ping/pong: Creality's server doesn't answer them, and a
                # ping timeout would tear down a perfectly good connection.
                async with websockets.connect(
                    self.url, open_timeout=25, ping_interval=None, max_size=None
                ) as ws:
                    self._ws = ws
                    log.info("creality light service connected for %s", self.config.id)
                    backoff = RECONNECT_MIN
                    async for raw in ws:
                        try:
                            msg = json.loads(raw)
                        except (TypeError, ValueError):
                            continue
                        if is_heartbeat(msg):
                            await ws.send(raw)
                            continue
                        state = light_state_from(msg)
                        if state is not None and state != self.state:
                            self.state = state
                            self.on_change(state)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                log.debug("creality light service for %s: %s", self.config.id, exc)
            finally:
                self._ws = None
                if self.state is not None:
                    self.state = None
                    self.on_change(None)
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, RECONNECT_MAX)

    async def set(self, on: bool) -> None:
        ws = self._ws
        if ws is None:
            raise RuntimeError("the printer's light service isn't connected")
        await ws.send(json.dumps({"method": "set", "params": {"lightSw": 1 if on else 0}}))
        # The service echoes the new state back, but don't make the UI wait for it.
        if self.state != on:
            self.state = on
            self.on_change(on)
