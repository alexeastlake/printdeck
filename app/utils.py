from __future__ import annotations

import os
import re
import tempfile
from pathlib import Path


def slugify(name: str) -> str:
    """"K1C (garage)" -> "k1c-garage". Used for printer and role ids."""
    slug = re.sub(r"[^a-z0-9]+", "-", name.strip().lower()).strip("-")
    return slug or "id"


def atomic_write_text(path: Path, text: str) -> None:
    """Temp file + os.replace, so a crash mid-write can't leave an empty
    users.yaml (which would take the session secret and every account with it).

    Replaces the inode, which is why Docker mounts the data *directory*, not
    the files. A single-file bind mount pins the old inode and the rename fails."""
    path = Path(path)
    fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp_name, path)
    except BaseException:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise
