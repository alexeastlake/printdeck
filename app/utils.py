"""Small helpers shared across more than one part of the app."""

from __future__ import annotations

import re


def slugify(name: str) -> str:
    """A URL-safe id derived from a display name — e.g. "K1C (garage)" ->
    "k1c-garage". Falls back to a generic name if nothing alphanumeric
    survives (an all-emoji name, say). Used for printer ids and role ids —
    both need something short/stable to key on, and asking the user to
    think one up separately from the name they already typed is friction
    for no benefit."""
    slug = re.sub(r"[^a-z0-9]+", "-", name.strip().lower()).strip("-")
    return slug or "id"
