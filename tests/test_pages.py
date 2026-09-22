"""Page serving: security headers, the pages/static split, and cache-busting."""

from __future__ import annotations

import re

from app.main import STATIC_DIR, static_version


def test_security_headers_on_every_response(open_client):
    for url in ("/", "/login", "/api/session", "/api/printers"):
        h = open_client.get(url).headers
        assert h["x-frame-options"] == "DENY" and h["x-content-type-options"] == "nosniff", url
        csp = h["content-security-policy"]
        assert "script-src 'self'" in csp and "unsafe-inline" not in csp and "frame-ancestors 'none'" in csp


def test_pages_are_not_reachable_as_static_files(open_client):
    for url in ("/static/../pages/users.html", "/users.html", "/static/users.html", "/pages/users.html"):
        assert open_client.get(url).status_code == 404, url


def test_pages_reference_versioned_assets_and_no_inline_script(open_client):
    version = static_version(STATIC_DIR)
    for url in ("/", "/printer/k1c", "/users", "/roles", "/login"):
        r = open_client.get(url)
        assert r.status_code == 200 and r.headers["cache-control"] == "no-cache", url
        html = r.text
        assert f"/static/{version}/style.css" in html, url
        assert '"/static/' not in html.replace(f"/static/{version}/", ""), url  # nothing left unversioned
        assert not re.search(r"<script(?![^>]*\bsrc=)", html), url  # no inline <script> (CSP)
        assert 'style="' not in html, url  # no inline style attributes (CSP)


def test_versioned_assets_cache_forever_and_plain_ones_dont(open_client):
    version = static_version(STATIC_DIR)
    r = open_client.get(f"/static/{version}/app.js")
    assert r.status_code == 200 and r.headers["cache-control"] == "public, max-age=31536000, immutable"
    r = open_client.get("/static/app.js")
    assert r.status_code == 200 and "immutable" not in r.headers.get("cache-control", "")
    assert open_client.get(f"/static/{version}/missing.js").status_code == 404


def test_static_version_changes_with_content(tmp_path):
    (tmp_path / "a.js").write_text("1")
    v1 = static_version(tmp_path)
    assert re.fullmatch(r"[0-9a-f]{12}", v1)
    assert static_version(tmp_path) == v1  # deterministic
    (tmp_path / "a.js").write_text("2")
    assert static_version(tmp_path) != v1


def test_every_page_script_exists(open_client):
    """A typo'd asset path would otherwise only show up as a blank page."""
    version = static_version(STATIC_DIR)
    for url in ("/", "/printer/k1c", "/users", "/roles", "/login"):
        html = open_client.get(url).text
        for asset in re.findall(r'(?:src|href)="(/static/[^"]+)"', html):
            assert open_client.get(asset).status_code == 200, (url, asset)
            assert asset.startswith(f"/static/{version}/")
