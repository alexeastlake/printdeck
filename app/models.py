"""Data shapes: printer config, the flat status the browser gets, users, roles."""

from __future__ import annotations

import ipaddress
from typing import Literal, get_args

from pydantic import BaseModel, Field


class PrinterConfig(BaseModel):
    """One entry in printers.yaml."""

    id: str
    name: str
    host: str
    moonraker_port: int = 7125
    api_key: str | None = None  # X-Api-Key, if Moonraker's [authorization] requires it
    tls: bool = False
    camera_url: str | None = None
    group: str = ""
    # K1-series stock firmware: drive the chamber light via Creality's own
    # port-9999 service, since it isn't a Klipper object there. See creality.py.
    creality_light: bool = False

    # The only place printer URLs get assembled. IPv6 needs brackets.

    @property
    def netloc(self) -> str:
        host = self.host
        try:
            if isinstance(ipaddress.ip_address(host), ipaddress.IPv6Address):
                host = f"[{host}]"
        except ValueError:
            pass
        return f"{host}:{self.moonraker_port}"

    @property
    def ws_url(self) -> str:
        scheme = "wss" if self.tls else "ws"
        return f"{scheme}://{self.netloc}/websocket"

    def http_url(self, path: str) -> str:
        scheme = "https" if self.tls else "http"
        return f"{scheme}://{self.netloc}{path}"

    @property
    def auth_headers(self) -> dict[str, str]:
        return {"X-Api-Key": self.api_key} if self.api_key else {}


# Viewing status/camera/files/history needs none of these.
Permission = Literal[
    "manage_printers",
    "control_printers",
    "manage_files",
    "manage_users",
    "manage_roles",
]

ALL_PERMISSIONS: tuple[str, ...] = get_args(Permission)

PERMISSION_CATALOG: list[dict[str, str]] = [
    {"id": "manage_printers", "label": "Manage printers",
     "description": "Add, remove, and edit printer settings (name, address, API key, camera URL, group)."},
    {"id": "control_printers", "label": "Control printers",
     "description": "Set nozzle/bed temperature, fan speed, move/home the toolhead, "
                    "and start, pause, resume, or cancel prints."},
    {"id": "manage_files", "label": "Manage files",
     "description": "Upload, rename, and delete files, create folders, and delete job history. "
                    "Browsing files and history doesn't need this."},
    {"id": "manage_users", "label": "Manage users",
     "description": "Create, edit, and delete accounts, and assign them roles."},
    {"id": "manage_roles", "label": "Manage roles",
     "description": "Create, edit, and delete roles and the permissions they grant. "
                    "Effectively grants everything: a role can be edited to hold every permission."},
]
assert {p["id"] for p in PERMISSION_CATALOG} == set(ALL_PERMISSIONS), "PERMISSION_CATALOG out of sync with Permission"


class Role(BaseModel):
    id: str
    name: str
    permissions: list[Permission] = Field(default_factory=list)


class User(BaseModel):
    """Never sent to the browser as-is; see UserOut."""

    username: str
    password_hash: str
    role: str  # Role.id
    # Bumped on password change; sessions carry the value they were issued
    # with, so old ones die. Role changes don't bump it; those are re-read live.
    session_version: int = 0


class UserOut(BaseModel):
    username: str
    role: str


class FanStatus(BaseModel):
    id: str    # Klipper object name, e.g. "fan_generic Aux"
    name: str  # display label
    speed: float = 0.0  # 0..1


class LightStatus(BaseModel):
    id: str     # Klipper object name, e.g. "output_pin LED" or "neopixel chamber"
    name: str   # display label
    kind: str   # "pin" (SET_PIN), "led" (SET_LED), or "creality" (port-9999 service)
    value: float = 0.0  # 0..1 brightness
    dimmable: bool = False  # pwm pin, or any led strip
    scale: float = 1.0  # output_pin's `scale`; SET_PIN VALUE is 0..scale
    white: bool = False  # led strip has a white channel


class PrinterStatus(BaseModel):
    """Only what the UI renders, not a mirror of Moonraker's objects."""

    id: str
    name: str
    host: str = ""
    moonraker_port: int = 7125
    tls: bool = False
    has_api_key: bool = False  # never the key itself
    creality_light: bool = False
    online: bool = False
    state: str = "offline"  # idle | printing | paused | complete | error | offline | connecting
    # Set when PrintDeck itself sees printing→complete; Klipper has no end
    # timestamp, so it's None if the server started after the print finished.
    completed_at: float | None = None

    extruder_temp: float = 0.0
    extruder_target: float = 0.0
    bed_temp: float = 0.0
    bed_target: float = 0.0
    extruder_max_temp: float | None = None  # from printer.cfg, read once per connection
    bed_max_temp: float | None = None
    fans: list[FanStatus] = Field(default_factory=list)
    lights: list[LightStatus] = Field(default_factory=list)

    progress: float = 0.0  # 0..1
    filename: str | None = None
    print_duration: float = 0.0  # seconds
    eta_seconds: float | None = None
    filament_used: float = 0.0  # mm

    x: float = 0.0
    y: float = 0.0
    z: float = 0.0
    homed_axes: str = ""  # e.g. "xyz"

    message: str | None = None  # something worth attention: pause reason, shutdown text
    klipper_status: str | None = None  # Klipper's own line, e.g. "Printer is ready"
    camera_url: str | None = None
    group: str = ""
