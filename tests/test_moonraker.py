"""normalize(), state derivation, completion stamping, bounded fan-out."""

from __future__ import annotations

import asyncio

import pytest

from app.models import PrinterConfig
from app.moonraker import (
    SUBSCRIBER_QUEUE_SIZE,
    MoonrakerClient,
    PrinterManager,
    _derive_state,
    _estimate_eta,
    connecting_status,
    normalize,
    offline_status,
)

CFG = PrinterConfig(id="k1c", name="K1C", host="10.0.0.5", camera_url="http://10.0.0.5:8000/", group="Home", api_key="k")


def ready(**print_stats):
    return {"webhooks": {"state": "ready", "state_message": "Printer is ready"}, "print_stats": print_stats}


# --- state -----------------------------------------------------------------

@pytest.mark.parametrize(
    ("klipper", "job", "expected"),
    [
        ("ready", "standby", "idle"),
        ("ready", "printing", "printing"),
        ("ready", "paused", "paused"),
        ("ready", "complete", "complete"),
        ("ready", "cancelled", "idle"),
        ("ready", "error", "error"),
        ("shutdown", "printing", "error"),  # Klipper's state wins
        ("error", "standby", "error"),
        ("startup", None, "idle"),
        (None, None, "idle"),
    ],
)
def test_derive_state(klipper, job, expected):
    assert _derive_state({"state": klipper}, {"state": job}) == expected


# --- normalize -------------------------------------------------------------

def test_normalize_basic_fields():
    objects = ready(state="printing", filename="a.gcode", print_duration=600.0, filament_used=1234.5)
    objects.update({
        "extruder": {"temperature": 210.04, "target": 210},
        "heater_bed": {"temperature": 59.96, "target": 60},
        "display_status": {"progress": 0.25},
        "toolhead": {"position": [10.0, 20.0, 0.3, 0], "homed_axes": "xyz"},
        "fan": {"speed": 0.5},
        "fan_generic chamber_fan": {"speed": 1.0},
    })
    s = normalize(CFG, objects, {"extruder_max_temp": 300.0, "bed_max_temp": 110.0})
    assert s.online and s.state == "printing"
    assert (s.extruder_temp, s.extruder_target, s.bed_temp, s.bed_target) == (210.0, 210, 60.0, 60)
    assert (s.extruder_max_temp, s.bed_max_temp) == (300.0, 110.0)
    assert s.progress == 0.25 and s.filename == "a.gcode"
    assert s.eta_seconds == pytest.approx(1800.0)  # 600s at 25% → 1800s left
    assert s.filament_used == 1234.5
    assert (s.x, s.y, s.z, s.homed_axes) == (10.0, 20.0, 0.3, "xyz")
    assert [(f.id, f.name, f.speed) for f in s.fans] == [
        ("fan", "Part Fan", 0.5),
        ("fan_generic chamber_fan", "Chamber Fan", 1.0),
    ]
    # Connection details ride along; the key itself never does.
    assert s.host == "10.0.0.5" and s.has_api_key is True and s.camera_url == CFG.camera_url and s.group == "Home"
    assert not hasattr(s, "api_key")


def test_normalize_progress_falls_back_to_virtual_sdcard():
    objects = ready(state="printing")
    objects["virtual_sdcard"] = {"progress": 0.4}
    assert normalize(CFG, objects).progress == 0.4


def test_normalize_tolerates_missing_and_null_values():
    objects = {"extruder": {"temperature": None, "target": None}}
    s = normalize(CFG, objects)
    assert s.state == "idle" and s.extruder_temp == 0.0 and s.progress == 0.0
    assert s.eta_seconds is None and s.fans == [] and s.filename is None


def test_normalize_message_promotion():
    # Healthy: Klipper's line is status only, not an alert.
    s = normalize(CFG, ready(state="standby"))
    assert s.klipper_status == "Printer is ready" and s.message is None
    # Shutdown: the same line becomes the alert.
    objects = {"webhooks": {"state": "shutdown", "state_message": "MCU 'mcu' shutdown"}, "print_stats": {}}
    s = normalize(CFG, objects)
    assert s.state == "error" and s.message == "MCU 'mcu' shutdown"
    # A print_stats message (pause reason) takes precedence.
    objects = ready(state="paused", message="Filament runout")
    assert normalize(CFG, objects).message == "Filament runout"


def test_offline_and_connecting_carry_connection_fields():
    for status, state in ((offline_status(CFG), "offline"), (connecting_status(CFG), "connecting")):
        assert status.state == state and status.online is False
        assert status.host == "10.0.0.5" and status.has_api_key and status.group == "Home"


@pytest.mark.parametrize(
    ("duration", "progress", "expected"),
    [(600, 0.5, 600), (0, 0.5, 0), (100, 0.0, None), (100, 0.005, None), (100, None, None)],
)
def test_estimate_eta(duration, progress, expected):
    result = _estimate_eta(duration, progress)
    assert result == expected if expected is None else result == pytest.approx(expected)


# --- client message handling -----------------------------------------------

def test_extract_status_and_merge():
    client = MoonrakerClient(CFG)
    assert MoonrakerClient._extract_status({"result": {"status": {"fan": {"speed": 1}}}}) == {"fan": {"speed": 1}}
    assert MoonrakerClient._extract_status({"method": "notify_status_update", "params": [{"fan": {"speed": 0}}, 1.0]}) == {"fan": {"speed": 0}}
    assert MoonrakerClient._extract_status({"method": "notify_proc_stat_update", "params": [{}]}) is None
    assert MoonrakerClient._extract_status({"result": "ok", "id": 5}) is None

    client._merge({"extruder": {"temperature": 20, "target": 0}})
    client._merge({"extruder": {"temperature": 25}})  # partial update keeps target
    assert client._objects == {"extruder": {"temperature": 25, "target": 0}}


# --- manager ---------------------------------------------------------------

def test_track_completion_stamps_on_transition_only(tmp_path):
    m = PrinterManager([], tmp_path / "printers.yaml")
    m._status["k1c"] = m._track_completion(normalize(CFG, ready(state="printing", filename="a.gcode")))
    done = m._track_completion(normalize(CFG, ready(state="complete", filename="a.gcode")))
    assert done.completed_at is not None
    m._status["k1c"] = done
    again = m._track_completion(normalize(CFG, ready(state="complete", filename="a.gcode")))
    assert again.completed_at == done.completed_at  # sticky across ticks
    m._status["k1c"] = again
    idle = m._track_completion(normalize(CFG, ready(state="standby")))
    assert idle.completed_at is None and "k1c" not in m._completed_at


def test_track_completion_unknown_when_already_complete_at_startup(tmp_path):
    m = PrinterManager([], tmp_path / "printers.yaml")
    # First thing we ever see is "complete": no transition, so no stamp.
    assert m._track_completion(normalize(CFG, ready(state="complete"))).completed_at is None


def test_broadcast_drops_oldest_for_slow_subscriber(tmp_path):
    async def run():
        m = PrinterManager([], tmp_path / "printers.yaml")
        q = m.subscribe()
        for i in range(SUBSCRIBER_QUEUE_SIZE + 10):
            m._broadcast({"n": i})
        assert q.qsize() == SUBSCRIBER_QUEUE_SIZE
        assert (await q.get())["n"] == 10  # the first ten were dropped, newest kept
        m.unsubscribe(q)
        m._broadcast({"n": -1})  # no subscribers: nothing to do, nothing raised
        assert q.qsize() == SUBSCRIBER_QUEUE_SIZE - 1

    asyncio.run(run())


def test_update_and_remove_printer_persist(tmp_path):
    async def run():
        path = tmp_path / "printers.yaml"
        m = PrinterManager([CFG], path)
        # Rename must not try to (re)spawn a task.
        status = await m.update_printer("k1c", name="Renamed", group="Garage")
        assert status.name == "Renamed" and status.group == "Garage"
        assert "Renamed" in path.read_text(encoding="utf-8")
        assert m.config("k1c").api_key == "k"  # untouched fields survive
        await m.remove_printer("k1c")
        assert m.config("k1c") is None and m.status("k1c") is None
        assert "k1c" not in path.read_text(encoding="utf-8")
        with pytest.raises(KeyError):
            await m.remove_printer("k1c")

    asyncio.run(run())


# --- lights ----------------------------------------------------------------

@pytest.mark.parametrize(
    ("name", "expected"),
    [
        ("output_pin LED", True),
        ("output_pin chamber_light", True),
        ("output_pin caselight", True),
        ("output_pin beeper", False),
        ("output_pin relay", False),
        ("neopixel chamber", True),
        ("led status", True),
        ("dotstar strip", True),
        ("fan", False),
        ("extruder", False),
    ],
)
def test_is_light_object(name, expected):
    from app.moonraker import is_light_object

    assert is_light_object(name) is expected


def test_normalize_lights():
    objects = ready(state="standby")
    objects.update({
        "output_pin LED": {"value": 0.5},              # pwm, scale 1
        "output_pin bed_light": {"value": 255.0},      # pwm, scale 255 → full on
        "output_pin case_lamp": {"value": 1.0},        # not pwm → a plain switch
        "output_pin beeper": {"value": 0.0},           # not a light
        "neopixel chamber": {"color_data": [[0.2, 0.2, 0.2, 0.8], [0, 0, 0, 0]]},
        "led bar": {"color_data": [[1.0, 0.5, 0.0]]},
    })
    pins = {
        "output_pin LED": {"pwm": True, "scale": 1.0},
        "output_pin bed_light": {"pwm": True, "scale": 255.0},
        "output_pin case_lamp": {"pwm": False, "scale": 1.0},
    }
    lights = {light.id: light for light in normalize(CFG, objects, None, pins).lights}
    assert set(lights) == {"output_pin LED", "output_pin bed_light", "output_pin case_lamp", "neopixel chamber", "led bar"}
    assert lights["output_pin LED"].value == 0.5 and lights["output_pin LED"].dimmable and lights["output_pin LED"].name == "Led"
    assert lights["output_pin bed_light"].value == 1.0 and lights["output_pin bed_light"].scale == 255.0
    assert lights["output_pin case_lamp"].dimmable is False and lights["output_pin case_lamp"].value == 1.0
    assert lights["neopixel chamber"].value == 0.8 and lights["neopixel chamber"].white is True and lights["neopixel chamber"].kind == "led"
    assert lights["led bar"].value == 1.0 and lights["led bar"].white is False


def test_normalize_without_pin_settings_treats_pins_as_switches():
    objects = ready(state="standby")
    objects["output_pin LED"] = {"value": 1.0}
    [light] = normalize(CFG, objects).lights
    assert light.dimmable is False and light.value == 1.0 and light.scale == 1.0
