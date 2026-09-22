"""Printer CRUD, path hygiene, and the Moonraker proxies against a fake."""

from __future__ import annotations

import json

import httpx
import pytest
from fastapi import HTTPException

from app.routes.common import clean_segments, extract_moonraker_error, relative_path


def ok(result):
    return httpx.Response(200, json={"result": result})


# --- printers --------------------------------------------------------------

def test_create_printer_validation_and_id_derivation(open_client):
    bad = [
        ({"name": " ", "host": "1.2.3.4"}, 400),
        ({"name": "x", "host": "http://1.2.3.4"}, 400),
        ({"name": "x", "host": "1.2.3.4:7125"}, 400),
        ({"name": "x", "host": "has space"}, 400),
        ({"name": "x", "host": "1.2.3.4", "moonraker_port": 70000}, 400),
        ({"name": "x", "host": "1.2.3.4", "camera_url": "ftp://cam/"}, 400),
        ({"name": "x", "host": "1.2.3.4", "camera_url": "http:///nohost"}, 400),
        ({"name": "x", "host": "1.2.3.4", "api_key": "has spaces!"}, 400),
        ({"name": "x" * 300, "host": "1.2.3.4"}, 422),
    ]
    for body, status in bad:
        assert open_client.post("/api/printers", json=body).status_code == status, body

    r = open_client.post("/api/printers", json={"name": "Creality K1C 2025", "host": "[2001:db8::1]", "api_key": "abc", "tls": True})
    assert r.status_code == 200
    s = r.json()
    assert s["id"] == "creality-k1c-2025" and s["host"] == "2001:db8::1" and s["tls"] is True
    assert s["has_api_key"] is True and "api_key" not in s and s["state"] == "connecting"
    r = open_client.post("/api/printers", json={"name": "Creality K1C 2025", "host": "printer.local"})
    assert r.json()["id"] == "creality-k1c-2025-2"
    assert {p["id"] for p in open_client.get("/api/printers").json()} == {"k1c", "creality-k1c-2025", "creality-k1c-2025-2"}


def test_update_printer(open_client, data_dir):
    assert open_client.patch("/api/printers/ghost", json={"name": "x"}).status_code == 404
    assert open_client.patch("/api/printers/k1c", json={"name": " "}).status_code == 400
    # Host change keeps the camera URL in sync when it embeds the old host.
    r = open_client.patch("/api/printers/k1c", json={"host": "192.168.1.77"})
    assert r.json()["host"] == "192.168.1.77" and r.json()["camera_url"] == "http://192.168.1.77:8000/"
    # ...unless the camera URL is set explicitly in the same request.
    r = open_client.patch("/api/printers/k1c", json={"host": "192.168.1.78", "camera_url": "http://cam.local/"})
    assert r.json()["camera_url"] == "http://cam.local/"
    # Empty string clears camera + api key.
    open_client.patch("/api/printers/k1c", json={"api_key": "secret"})
    assert open_client.get("/api/printers/k1c/status").json()["has_api_key"] is True
    r = open_client.patch("/api/printers/k1c", json={"api_key": "", "camera_url": ""})
    assert r.json()["has_api_key"] is False and r.json()["camera_url"] is None
    # Persisted.
    text = (data_dir / "printers.yaml").read_text(encoding="utf-8")
    assert "192.168.1.78" in text and "secret" not in text


def test_delete_printer(open_client):
    with open_client.websocket_connect("/ws") as ws:
        ws.receive_json()  # snapshot
        assert open_client.delete("/api/printers/k1c").status_code == 200
        assert ws.receive_json() == {"type": "removed", "id": "k1c"}
    assert open_client.delete("/api/printers/k1c").status_code == 404
    assert open_client.get("/api/printers/k1c/status").status_code == 404
    assert open_client.get("/api/printers").json() == []


# --- path hygiene ----------------------------------------------------------

@pytest.mark.parametrize("path", ["../config", "a/../../b", "a/./b", "a\\b", "a\x00b", ".."])
def test_clean_segments_rejects_escapes(path):
    with pytest.raises(HTTPException) as exc:
        clean_segments(path)
    assert exc.value.status_code == 400


def test_relative_path_joins_cleanly():
    assert relative_path("") == "gcodes"
    assert relative_path("/sub//dir/") == "gcodes/sub/dir"


def test_traversal_rejected_on_every_file_endpoint(open_client):
    c = open_client
    assert c.get("/api/printers/k1c/files?path=../config").status_code == 400
    assert c.get("/api/printers/k1c/files/info?filename=../moonraker.conf").status_code == 400
    assert c.get("/api/printers/k1c/files/thumbnail?filename=../x.png").status_code == 400
    assert c.delete("/api/printers/k1c/files?path=../x").status_code == 400
    assert c.delete("/api/printers/k1c/files?path=").status_code == 400  # not the root
    assert c.post("/api/printers/k1c/files/rename", json={"path": "../x", "new_name": "y"}).status_code == 400
    assert c.post("/api/printers/k1c/files/rename", json={"path": "x", "new_name": "../y"}).status_code == 400
    assert c.post("/api/printers/k1c/files/rename", json={"path": "", "new_name": "y"}).status_code == 400
    assert c.post("/api/printers/k1c/files/folder", json={"path": "..", "name": "y"}).status_code == 400
    assert c.post("/api/printers/k1c/files/folder", json={"path": "", "name": "a/b"}).status_code == 400
    assert c.post("/api/printers/k1c/job/start", json={"filename": "../a.gcode"}).status_code == 400


def testextract_moonraker_error():
    nested = json.dumps({"error": {"message": json.dumps({"code": "CC5000", "msg": "Move out of range: 999"})}})
    assert extract_moonraker_error(nested) == "Move out of range: 999"
    assert extract_moonraker_error(json.dumps({"error": {"message": "File not found"}})) == "File not found"
    assert extract_moonraker_error("<html>502</html>") == "<html>502</html>"
    assert extract_moonraker_error("") == "Unknown error."
    assert len(extract_moonraker_error(json.dumps({"error": {"message": "x" * 1000}}))) == 300


# --- proxies against the fake Moonraker ------------------------------------

def test_file_list_url_and_api_key_header(open_client, fake_moonraker):
    open_client.patch("/api/printers/k1c", json={"api_key": "key123", "tls": True, "moonraker_port": 7126})
    fake_moonraker.on("/server/files/directory", ok({"dirs": [], "files": [{"filename": "a b.gcode", "size": 1}]}))
    r = open_client.get("/api/printers/k1c/files?path=sub dir")
    assert r.status_code == 200 and r.json()["files"][0]["filename"] == "a b.gcode"
    req = fake_moonraker.last
    assert str(req.url) == "https://192.168.1.50:7126/server/files/directory?path=gcodes/sub%20dir"
    assert req.headers["x-api-key"] == "key123"


def test_moonraker_error_is_unwrapped_to_502(open_client, fake_moonraker):
    klipper = json.dumps({"code": "CC5000", "msg": "Move out of range: 999.000"})
    fake_moonraker.on("/printer/gcode/script", httpx.Response(400, json={"error": {"message": klipper}}))
    r = open_client.post("/api/printers/k1c/gcode", json={"script": "G1 X999"})
    assert r.status_code == 502 and r.json()["detail"] == "Move out of range: 999.000"
    assert json.loads(fake_moonraker.last.content) == {"script": "G1 X999"}
    assert open_client.post("/api/printers/k1c/gcode", json={"script": "  "}).status_code == 400
    assert open_client.post("/api/printers/k1c/gcode", json={"script": "x" * 3000}).status_code == 422


def test_unreachable_printer_is_502(open_client, fake_moonraker):
    def refuse(request):
        raise httpx.ConnectError("refused")

    fake_moonraker.on("/printer/gcode/script", refuse)
    r = open_client.post("/api/printers/k1c/gcode", json={"script": "G28"})
    assert r.status_code == 502 and "couldn't reach printer" in r.json()["detail"]


def test_upload_streams_form_fields(open_client, fake_moonraker):
    fake_moonraker.on("/server/files/upload", ok({"item": {"path": "sub/big.gcode"}}))
    r = open_client.post(
        "/api/printers/k1c/files/upload",
        data={"path": "sub"},
        files={"file": ("big.gcode", b"G28\nG1 X1\n", "text/plain")},
    )
    assert r.status_code == 200 and r.json()["item"]["path"] == "sub/big.gcode"
    body = fake_moonraker.last.content
    assert b'name="root"\r\n\r\ngcodes' in body and b'name="path"\r\n\r\nsub' in body
    assert b'filename="big.gcode"' in body and b"G28\nG1 X1\n" in body
    # A filename that isn't plain is refused before anything is sent.
    n = len(fake_moonraker.requests)
    r = open_client.post("/api/printers/k1c/files/upload", files={"file": ("../evil.gcode", b"x")})
    assert r.status_code == 400 and len(fake_moonraker.requests) == n


def test_rename_and_folder_and_delete_dir(open_client, fake_moonraker):
    fake_moonraker.on("/server/files/move", ok({}))
    fake_moonraker.on("/server/files/directory", ok({}))
    open_client.post("/api/printers/k1c/files/rename", json={"path": "sub/old.gcode", "new_name": "new.gcode"})
    assert json.loads(fake_moonraker.last.content) == {"source": "gcodes/sub/old.gcode", "dest": "gcodes/sub/new.gcode"}
    open_client.post("/api/printers/k1c/files/folder", json={"path": "sub", "name": "inner"})
    assert json.loads(fake_moonraker.last.content) == {"path": "gcodes/sub/inner"}
    open_client.delete("/api/printers/k1c/files?path=sub/inner&is_dir=true")
    assert fake_moonraker.last.method == "DELETE"
    assert str(fake_moonraker.last.url).endswith("/server/files/directory?path=gcodes/sub/inner&force=true")


def test_thumbnail_resolves_relative_to_file_dir(open_client, fake_moonraker):
    fake_moonraker.on("/server/files/metadata", ok({
        "thumbnails": [
            {"size": 100, "relative_path": ".thumbs/a-32x32.png"},
            {"size": 900, "relative_path": ".thumbs/a-300x300.png"},
        ],
    }))
    fake_moonraker.on("/server/files/gcodes/sub/.thumbs/a-300x300.png", httpx.Response(200, content=b"\x89PNG"))
    r = open_client.get("/api/printers/k1c/files/thumbnail?filename=sub/a.gcode")
    assert r.status_code == 200 and r.content == b"\x89PNG" and r.headers["content-type"] == "image/png"

    fake_moonraker.on("/server/files/metadata", ok({"thumbnails": []}))
    assert open_client.get("/api/printers/k1c/files/thumbnail?filename=sub/a.gcode").status_code == 404
    # A hostile relative_path from the printer side is refused too.
    fake_moonraker.on("/server/files/metadata", ok({"thumbnails": [{"size": 1, "relative_path": "../../etc/x.png"}]}))
    assert open_client.get("/api/printers/k1c/files/thumbnail?filename=sub/a.gcode").status_code == 400


def test_file_info_passthrough(open_client, fake_moonraker):
    fake_moonraker.on("/server/files/metadata", ok({"estimated_time": 1200, "slicer": "OrcaSlicer"}))
    r = open_client.get("/api/printers/k1c/files/info?filename=a b.gcode")
    assert r.json()["slicer"] == "OrcaSlicer"
    assert str(fake_moonraker.last.url).endswith("/server/files/metadata?filename=a%20b.gcode")


def test_camera_offer_relay(open_client, fake_moonraker):
    import base64

    def answer(request):
        offer = json.loads(base64.b64decode(request.content))
        assert offer == {"type": "offer", "sdp": "v=0 fake"}
        return httpx.Response(200, content=base64.b64encode(json.dumps({"type": "answer", "sdp": "v=0 reply"}).encode()))

    fake_moonraker.on("/call/webrtc_local", answer)
    r = open_client.post("/api/printers/k1c/camera/offer", json={"sdp": "v=0 fake"})
    assert r.status_code == 200 and r.json()["sdp"] == "v=0 reply"
    assert str(fake_moonraker.last.url) == "http://192.168.1.50:8000/call/webrtc_local"
    open_client.patch("/api/printers/k1c", json={"camera_url": ""})
    assert open_client.post("/api/printers/k1c/camera/offer", json={"sdp": "x"}).status_code == 404


# --- jobs + history --------------------------------------------------------

def test_job_actions(open_client, fake_moonraker):
    for action in ("pause", "resume", "cancel"):
        fake_moonraker.on(f"/printer/print/{action}", ok("ok"))
        r = open_client.post(f"/api/printers/k1c/job/{action}")
        assert r.status_code == 200 and r.json() == {"result": "ok"}
        assert fake_moonraker.last.url.path == f"/printer/print/{action}" and fake_moonraker.last.method == "POST"
    assert open_client.post("/api/printers/k1c/job/explode").status_code == 404
    assert open_client.post("/api/printers/ghost/job/pause").status_code == 404


def test_start_print(open_client, fake_moonraker):
    fake_moonraker.on("/printer/print/start", ok("ok"))
    assert open_client.post("/api/printers/k1c/job/start", json={"filename": "notes.txt"}).status_code == 400
    r = open_client.post("/api/printers/k1c/job/start", json={"filename": "sub/my part.gcode"})
    assert r.status_code == 200
    assert str(fake_moonraker.last.url).endswith("/printer/print/start?filename=sub/my%20part.gcode")
    # Refused from this side while a print is running.
    manager = open_client.app.state.manager
    manager._status["k1c"] = manager._status["k1c"].model_copy(update={"state": "printing"})
    r = open_client.post("/api/printers/k1c/job/start", json={"filename": "a.gcode"})
    assert r.status_code == 409


def test_history_proxy_clamps_and_passes_through(open_client, fake_moonraker):
    fake_moonraker.on("/server/history/list", ok({"count": 1, "jobs": [{"filename": "a.gcode", "status": "completed"}]}))
    fake_moonraker.on("/server/history/totals", ok({"job_totals": {"total_jobs": 1}}))
    r = open_client.get("/api/printers/k1c/history?limit=500&start=-5")
    assert r.json()["jobs"][0]["status"] == "completed"
    assert str(fake_moonraker.last.url).endswith("/server/history/list?limit=100&start=0&order=desc")
    assert open_client.get("/api/printers/k1c/history/totals").json()["job_totals"]["total_jobs"] == 1
    # No [history] component → Moonraker's error comes through as a 502 with its text.
    fake_moonraker.on("/server/history/list", httpx.Response(404, json={"error": {"message": "Not Found"}}))
    r = open_client.get("/api/printers/k1c/history")
    assert r.status_code == 502 and r.json()["detail"] == "Not Found"


def test_history_delete(open_client, fake_moonraker):
    fake_moonraker.on("/server/history/job", ok(["00001A"]))
    r = open_client.delete("/api/printers/k1c/history/00001A")
    assert r.status_code == 200 and r.json() == {"deleted": ["00001A"]}
    assert fake_moonraker.last.method == "DELETE" and str(fake_moonraker.last.url).endswith("/server/history/job?uid=00001A")
    assert open_client.delete("/api/printers/k1c/history/../etc").status_code in (400, 404)
    assert open_client.delete("/api/printers/k1c/history/not%20ok").status_code == 400
    r = open_client.delete("/api/printers/k1c/history")
    assert r.status_code == 200 and str(fake_moonraker.last.url).endswith("/server/history/job?all=true")


def test_delete_file_falls_back_to_http_when_rpc_fails(open_client, fake_moonraker, monkeypatch):
    from app.routes import files

    async def rpc_times_out(config, path):
        raise TimeoutError("the printer didn't confirm the delete within 15s")

    monkeypatch.setattr(files, "delete_file_via_rpc", rpc_times_out)
    fake_moonraker.on("/server/files/metadata", ok({"size": 1}))  # still there after the rpc attempt
    fake_moonraker.on("/server/files/gcodes/sub/未命名.gcode", ok({"item": {"path": "sub/未命名.gcode"}}))
    r = open_client.delete("/api/printers/k1c/files?path=sub/未命名.gcode")
    assert r.status_code == 200
    http_deletes = [q for q in fake_moonraker.requests if q.method == "DELETE"]
    assert len(http_deletes) == 1 and http_deletes[0].url.path == "/server/files/gcodes/sub/未命名.gcode"


def test_delete_file_treats_vanished_file_as_success(open_client, fake_moonraker, monkeypatch):
    from app.routes import files

    async def rpc_times_out(config, path):
        raise TimeoutError("the printer didn't confirm the delete within 15s")

    monkeypatch.setattr(files, "delete_file_via_rpc", rpc_times_out)
    fake_moonraker.on("/server/files/metadata", httpx.Response(404, json={"error": {"message": "File not found"}}))
    r = open_client.delete("/api/printers/k1c/files?path=gone.gcode")
    assert r.status_code == 200
    assert not [q for q in fake_moonraker.requests if q.method == "DELETE"]  # no need for the http attempt


def test_delete_file_reports_a_real_message_when_everything_fails(open_client, fake_moonraker, monkeypatch):
    from app.routes import files

    async def rpc_times_out(config, path):
        raise TimeoutError("the printer didn't confirm the delete within 15s")

    monkeypatch.setattr(files, "delete_file_via_rpc", rpc_times_out)
    fake_moonraker.on("/server/files/metadata", ok({"size": 1}))
    fake_moonraker.on("/server/files/gcodes/stuck.gcode", httpx.Response(400, json={"error": {"message": "Invalid file path"}}))
    r = open_client.delete("/api/printers/k1c/files?path=stuck.gcode")
    assert r.status_code == 502 and r.json()["detail"] == "the printer didn't confirm the delete within 15s"
