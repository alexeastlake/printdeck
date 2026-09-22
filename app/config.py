"""printers.yaml. Path comes from create_app (PRINTDECK_PRINTERS or repo
root); a missing file falls back to the bundled example."""

from __future__ import annotations

import os
from pathlib import Path

import yaml

from .models import PrinterConfig
from .utils import atomic_write_text

ROOT = Path(__file__).resolve().parent.parent
EXAMPLE_FILE = ROOT / "printers.example.yaml"


def default_printers_file() -> Path:
    return Path(os.environ.get("PRINTDECK_PRINTERS") or ROOT / "printers.yaml")


def load_printers(path: Path) -> list[PrinterConfig]:
    source = path if path.exists() else EXAMPLE_FILE
    data = yaml.safe_load(source.read_text(encoding="utf-8")) or {}
    return [PrinterConfig(**entry) for entry in data.get("printers", [])]


def save_printers(path: Path, configs: list[PrinterConfig]) -> None:
    """Rewrites the whole file, so hand-written comments don't survive a UI edit."""
    data = {"printers": [c.model_dump() for c in configs]}
    atomic_write_text(path, yaml.safe_dump(data, sort_keys=False, allow_unicode=True))
