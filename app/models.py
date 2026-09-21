"""The two data shapes PrintDeck cares about: how a printer is configured,
and the normalized status we hand to the browser."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class PrinterConfig(BaseModel):
    """One entry from printers.yaml."""

    id: str
    name: str
    host: str
    moonraker_port: int = 7125
    camera_url: str | None = None
    group: str = ""  # freeform label; printers with the same group sit in one section


# The fixed vocabulary of things a role can grant — see app/auth.py's
# require_permission. Viewing printer status/camera/files/the live feed
# isn't in this list; that's the implicit baseline for any logged-in
# account, same as it's always been.
Permission = Literal[
    "manage_printers",   # add/remove printers, edit settings
    "control_printers",  # the gcode relay: temps, fans, moves, homing
    "manage_files",      # upload/rename/delete files, create folders
    "manage_users",      # create/edit/delete accounts, assign roles
    "manage_roles",      # create/edit/delete roles and their permissions
]


class Role(BaseModel):
    """One entry from users.yaml's roles list. Admin-defined — nothing
    about a role's name or permission set is hardcoded past what
    users_store.load_or_bootstrap seeds the very first account with."""

    id: str
    name: str
    permissions: list[Permission] = Field(default_factory=list)


class User(BaseModel):
    """One entry from users.yaml. Never leaves the backend as-is — API
    responses use UserOut instead, which drops password_hash."""

    username: str
    password_hash: str
    role: str  # a Role.id reference, not a fixed set of literal values
    # Bumped whenever the password changes; the session cookie carries the
    # value it was issued with, so a stale session (anyone still logged in
    # with the old password) stops working immediately — see auth.py's
    # _live_user. Not bumped by a role change; that's already re-checked
    # live on every request regardless.
    session_version: int = 0


class UserOut(BaseModel):
    """A user as the frontend is allowed to see it — no password hash."""

    username: str
    role: str


class FanStatus(BaseModel):
    """One fan Klipper knows about — a printer can have any number of these
    (the primary part-cooling fan, plus whatever `[fan_generic ...]`
    sections are configured), so this isn't a fixed set of fields."""

    id: str    # the raw Klipper/Moonraker object name, e.g. "fan_generic Aux"
    name: str  # display label, e.g. "Fan" or "Aux"
    speed: float = 0.0  # 0..1


class PrinterStatus(BaseModel):
    """A flattened, browser-friendly snapshot of a printer.

    This is deliberately not a 1:1 mirror of Moonraker's objects — it's only
    what the dashboard needs to render, so the frontend stays dumb and small.
    """

    id: str
    name: str
    host: str = ""  # current IP/hostname, so the UI can show & edit it
    online: bool = False
    # one of: idle, printing, paused, error, offline, connecting
    state: str = "offline"

    extruder_temp: float = 0.0
    extruder_target: float = 0.0
    bed_temp: float = 0.0
    bed_target: float = 0.0
    fans: list[FanStatus] = Field(default_factory=list)

    progress: float = 0.0  # 0..1
    filename: str | None = None
    print_duration: float = 0.0  # seconds elapsed on the current print
    eta_seconds: float | None = None  # rough estimate, None when unknown
    filament_used: float = 0.0  # mm, current print only
    # Only set if the slicer emits SET_PRINT_STATS_INFO — many don't.
    current_layer: int | None = None
    total_layer: int | None = None

    # Toolhead position, for the detail page's jog controls.
    x: float = 0.0
    y: float = 0.0
    z: float = 0.0
    homed_axes: str = ""  # e.g. "xyz"; empty/partial means not (fully) homed

    message: str | None = None  # an actionable alert (pause reason, error) — not set otherwise
    klipper_status: str | None = None  # Klipper's own status line, e.g. "Printer is ready"
    camera_url: str | None = None
    group: str = ""
