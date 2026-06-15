"""Keeps a live connection to every configured printer and fans their status
out to whoever's watching (the browser, over our own websocket).

One asyncio task per printer. If a printer drops off the network — or is just
powered down, or its DHCP lease moved — its task quietly retries with a capped
backoff and the dashboard shows it as offline in the meantime.
"""

from __future__ import annotations

import asyncio
import logging

from ..models import PrinterConfig, PrinterStatus
from .client import MoonrakerClient
from .normalize import normalize, offline_status

log = logging.getLogger("printdeck.manager")

RECONNECT_MIN = 2.0
RECONNECT_MAX = 30.0


class PrinterManager:
    def __init__(self, configs: list[PrinterConfig]) -> None:
        self._configs = configs
        self._by_id: dict[str, PrinterConfig] = {c.id: c for c in configs}
        self._status: dict[str, PrinterStatus] = {
            c.id: offline_status(c) for c in configs
        }
        self._tasks: list[asyncio.Task] = []
        self._subscribers: set[asyncio.Queue[PrinterStatus]] = set()

    # --- lifecycle -------------------------------------------------------

    async def start(self) -> None:
        self._tasks = [
            asyncio.create_task(self._run(c), name=f"printer:{c.id}")
            for c in self._configs
        ]

    async def stop(self) -> None:
        for task in self._tasks:
            task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        self._tasks.clear()

    # --- reads -----------------------------------------------------------

    def snapshots(self) -> list[PrinterStatus]:
        return list(self._status.values())

    def config(self, printer_id: str) -> PrinterConfig | None:
        return self._by_id.get(printer_id)

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
        client = MoonrakerClient(config.host, config.moonraker_port)
        backoff = RECONNECT_MIN
        while True:
            try:
                async for objects in client.stream():
                    self._publish(normalize(config, objects))
                    backoff = RECONNECT_MIN  # healthy connection, reset
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # connection refused, timeout, reset, ...
                log.info("printer %s unreachable: %s", config.id, exc)

            self._publish(offline_status(config))
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, RECONNECT_MAX)
