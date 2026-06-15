"""A thin client for a single printer's Moonraker instance.

Moonraker speaks JSON-RPC 2.0 over a websocket at ws://host:7125/websocket.
We subscribe once to the printer objects we care about and then receive partial
updates as things change. Moonraker only sends the *changed* fields, so this
client keeps a running merge and yields the full picture each time.

Docs: https://moonraker.readthedocs.io/en/latest/web_api/
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator

import websockets

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
