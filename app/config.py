"""Load the printer registry from printers.yaml (falling back to the example
file so a fresh clone still boots and shows something).

Set PRINTDECK_PRINTERS to store the registry somewhere else — e.g. a mounted
data volume in Docker (PRINTDECK_PRINTERS=/data/printers.yaml), so UI edits
persist outside the container. Unset, it's just printers.yaml at the repo root.
"""

from __future__ import annotations

import os
from pathlib import Path

import yaml

from .models import PrinterConfig

ROOT = Path(__file__).resolve().parent.parent
PRINTERS_FILE = Path(os.environ.get("PRINTDECK_PRINTERS") or ROOT / "printers.yaml")
EXAMPLE_FILE = ROOT / "printers.example.yaml"


def load_printers() -> list[PrinterConfig]:
    path = PRINTERS_FILE if PRINTERS_FILE.exists() else EXAMPLE_FILE
    data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    return [PrinterConfig(**entry) for entry in data.get("printers", [])]


def save_printers(configs: list[PrinterConfig]) -> None:
    """Persist the registry to printers.yaml so UI edits survive a restart.

    This rewrites the file from the live config, so any hand-written comments are
    lost once the UI has saved — the file becomes UI-managed, which is the point
    (a roaming DHCP address shouldn't mean editing YAML by hand every day)."""
    data = {"printers": [c.model_dump() for c in configs]}
    PRINTERS_FILE.write_text(
        yaml.safe_dump(data, sort_keys=False, allow_unicode=True), encoding="utf-8"
    )
