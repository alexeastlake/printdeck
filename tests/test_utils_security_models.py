"""slugify, atomic writes, password hashing, PrinterConfig URLs."""

from __future__ import annotations

import pytest

from app import security
from app.models import ALL_PERMISSIONS, PERMISSION_CATALOG, PrinterConfig
from app.utils import atomic_write_text, slugify

# --- slugify ---------------------------------------------------------------

@pytest.mark.parametrize(
    ("name", "expected"),
    [
        ("K1C (garage)", "k1c-garage"),
        ("  Ender 3   ", "ender-3"),
        ("---", "id"),
        ("🖨️", "id"),
        ("already-a-slug", "already-a-slug"),
    ],
)
def test_slugify(name, expected):
    assert slugify(name) == expected


# --- atomic_write_text -----------------------------------------------------

def test_atomic_write_creates_and_replaces(tmp_path):
    target = tmp_path / "x.yaml"
    atomic_write_text(target, "one")
    assert target.read_text(encoding="utf-8") == "one"
    atomic_write_text(target, "two")
    assert target.read_text(encoding="utf-8") == "two"
    # No stray temp files left behind.
    assert [p.name for p in tmp_path.iterdir()] == ["x.yaml"]


def test_atomic_write_leaves_old_content_if_write_fails(tmp_path, monkeypatch):
    target = tmp_path / "x.yaml"
    atomic_write_text(target, "safe")

    import os

    def boom(*args, **kwargs):
        raise OSError("disk full")

    monkeypatch.setattr(os, "replace", boom)
    with pytest.raises(OSError):
        atomic_write_text(target, "new")
    assert target.read_text(encoding="utf-8") == "safe"
    assert [p.name for p in tmp_path.iterdir()] == ["x.yaml"]


# --- password hashing ------------------------------------------------------

def test_hash_roundtrip():
    stored = security.hash_password("correct horse")
    assert stored.startswith("pbkdf2_sha256$")
    assert security.verify_password("correct horse", stored)
    assert not security.verify_password("wrong", stored)


def test_hash_is_salted():
    assert security.hash_password("same") != security.hash_password("same")


@pytest.mark.parametrize("stored", ["", "garbage", "md5$1$00$00", "pbkdf2_sha256$notanint$00$00", None])
def test_verify_rejects_malformed(stored):
    assert not security.verify_password("x", stored)


# --- PrinterConfig URLs ----------------------------------------------------

def test_urls_ipv4_default():
    c = PrinterConfig(id="p", name="P", host="192.168.1.50")
    assert c.ws_url == "ws://192.168.1.50:7125/websocket"
    assert c.http_url("/printer/info") == "http://192.168.1.50:7125/printer/info"
    assert c.auth_headers == {}


def test_urls_ipv6_gets_brackets():
    c = PrinterConfig(id="p", name="P", host="2001:db8::1", moonraker_port=7126)
    assert c.netloc == "[2001:db8::1]:7126"
    assert c.ws_url == "ws://[2001:db8::1]:7126/websocket"


def test_urls_hostname_and_tls_and_key():
    c = PrinterConfig(id="p", name="P", host="printer.local", tls=True, api_key="abc")
    assert c.ws_url == "wss://printer.local:7125/websocket"
    assert c.http_url("/x") == "https://printer.local:7125/x"
    assert c.auth_headers == {"X-Api-Key": "abc"}


def test_permission_catalog_matches_literal():
    assert {p["id"] for p in PERMISSION_CATALOG} == set(ALL_PERMISSIONS)
    assert len(PERMISSION_CATALOG) == len(ALL_PERMISSIONS)
