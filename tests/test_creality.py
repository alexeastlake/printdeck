"""Creality port-9999 light: message parsing, manager merge, endpoint."""

from __future__ import annotations

import asyncio

import pytest

from app import creality
from app.models import PrinterConfig
from app.moonraker import PrinterManager, normalize

CFG = PrinterConfig(id="k1c", name="K1C", host="10.0.0.5", creality_light=True)


@pytest.mark.parametrize(
    ("msg", "expected"),
    [
        ({"lightSw": 1}, True),
        ({"lightSw": 0, "nozzleTemp": 25}, False),
        ({"lightSw": "1"}, True),
        ({"lightSw": "garbage"}, None),
        ({"nozzleTemp": 25}, None),
        ("not a dict", None),
        ([1, 2], None),
    ],
)
def test_light_state_from(msg, expected):
    assert creality.light_state_from(msg) is expected


def test_heartbeat_detection():
    assert creality.is_heartbeat({"ModeCode": "heart_beat", "msg": 123})
    assert not creality.is_heartbeat({"lightSw": 1})


def test_light_status_shape():
    light = creality.light_status(True)
    assert (light.id, light.kind, light.value, light.dimmable) == ("creality:light", "creality", 1.0, False)


class FakeClient:
    def __init__(self):
        self.state = None
        self.calls = []

    async def set(self, on):
        self.calls.append(on)
        self.state = on


def test_manager_merges_creality_light_into_status(tmp_path):
    m = PrinterManager([CFG], tmp_path / "printers.yaml")
    fake = FakeClient()
    m._light_clients["k1c"] = fake
    objects = {"webhooks": {"state": "ready"}, "print_stats": {"state": "standby"}}

    # Service not connected yet: no light in the list.
    s = m._with_creality_light(normalize(CFG, objects))
    assert s.lights == []

    fake.state = True
    s = m._with_creality_light(normalize(CFG, objects))
    assert [(light.id, light.value) for light in s.lights] == [("creality:light", 1.0)]

    # Offline printer never shows it, whatever the service says.
    from app.moonraker import offline_status

    assert m._with_creality_light(offline_status(CFG)).lights == []


def test_manager_republishes_on_light_change(tmp_path):
    m = PrinterManager([CFG], tmp_path / "printers.yaml")
    fake = FakeClient()
    m._light_clients["k1c"] = fake
    q = m.subscribe()
    objects = {"webhooks": {"state": "ready"}, "print_stats": {"state": "standby"}}
    m._publish(normalize(CFG, objects))
    q.get_nowait()

    fake.state = False
    m._on_creality_light("k1c", False)
    msg = q.get_nowait()
    assert msg["printer"]["lights"] == [{"id": "creality:light", "name": "Chamber Light", "kind": "creality", "value": 0.0, "dimmable": False, "scale": 1.0, "white": False}]

    # Disconnect: the light drops out of the list.
    fake.state = None
    m._on_creality_light("k1c", None)
    assert q.get_nowait()["printer"]["lights"] == []


def test_manager_set_routes_to_client(tmp_path):
    m = PrinterManager([CFG], tmp_path / "printers.yaml")
    fake = FakeClient()
    m._light_clients["k1c"] = fake
    asyncio.run(m.set_creality_light("k1c", True))
    assert fake.calls == [True]
    with pytest.raises(KeyError):
        asyncio.run(m.set_creality_light("other", True))


def test_light_endpoint(open_client):
    manager = open_client.app.state.manager
    fake = FakeClient()
    manager._light_clients["k1c"] = fake
    r = open_client.post("/api/printers/k1c/creality/light", json={"on": True})
    assert r.status_code == 200 and fake.calls == [True]
    manager._light_clients.clear()
    assert open_client.post("/api/printers/k1c/creality/light", json={"on": False}).status_code == 404
    assert open_client.post("/api/printers/ghost/creality/light", json={"on": False}).status_code == 404


def test_light_endpoint_reports_disconnected_service(open_client):
    class Down:
        async def set(self, on):
            raise RuntimeError("the printer's light service isn't connected")

    open_client.app.state.manager._light_clients["k1c"] = Down()
    r = open_client.post("/api/printers/k1c/creality/light", json={"on": True})
    assert r.status_code == 502 and "isn't connected" in r.json()["detail"]


def test_printer_api_carries_the_flag(open_client):
    r = open_client.patch("/api/printers/k1c", json={"creality_light": True})
    assert r.json()["creality_light"] is True
    r = open_client.post("/api/printers", json={"name": "Other", "host": "10.0.0.6", "creality_light": True})
    assert r.json()["creality_light"] is True
