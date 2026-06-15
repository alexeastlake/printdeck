"""Load the printer registry from printers.yaml (falling back to the example
file so a fresh clone still boots and shows something)."""

from __future__ import annotations

from pathlib import Path

import yaml

from .models import PrinterConfig

ROOT = Path(__file__).resolve().parent.parent
PRINTERS_FILE = ROOT / "printers.yaml"
EXAMPLE_FILE = ROOT / "printers.example.yaml"


def load_printers() -> list[PrinterConfig]:
    path = PRINTERS_FILE if PRINTERS_FILE.exists() else EXAMPLE_FILE
    data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    return [PrinterConfig(**entry) for entry in data.get("printers", [])]
