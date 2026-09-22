# PrintDeck

A small self-hosted dashboard for Moonraker/Klipper 3D printers.

## Layout

```
app/                 FastAPI backend
  main.py            create_app(), page routes, security headers
  config.py          printers.yaml
  models.py          PrinterConfig, PrinterStatus, User, Role, permissions
  moonraker.py       per-printer websocket client + status normalisation
  routes/            printers, camera, files, jobs (+history, gcode), live (/ws); common.py has the Moonraker helpers
  auth.py            login, sessions, permission checks, users + roles API
  users_store.py     users.yaml
  security.py        PBKDF2 password hashing
  utils.py           slugify, atomic writes
web/pages/           HTML, served only via routes in main.py
web/static/          JS/CSS/icon, served at /static/<hash>/
tests/               pytest; HTTP layer runs against a fake Moonraker
printers.yaml        your printers (gitignored)
users.yaml           accounts + session secret (gitignored, auto-created)
```

## Run it

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -e .
uvicorn --factory app.main:create_app --reload
```

Open <http://localhost:8000> and add a printer with **+**. Without a
`printers.yaml` the bundled example is shown.

`PRINTDECK_PRINTERS` / `PRINTDECK_USERS` override where the two YAML files
live (default: repo root).

## Authentication

With no users configured the dashboard is **fully open**: every control
shows and every API call is accepted. It logs a warning. To turn auth on,
set these before the first start:

```powershell
$env:PRINTDECK_ADMIN_USERNAME = "you"
$env:PRINTDECK_ADMIN_PASSWORD = "a-good-password"
```

That writes one admin account (role "Admin", every permission) and a session
secret to `users.yaml`. After that the file is the source of truth; the env
vars are only re-read if that username is missing (a recovery path: delete
the entry, restart). Manage accounts from Settings → Manage users. Usernames:
1-32 chars, `[A-Za-z0-9._-]`. Passwords: 8+ chars.

### Roles

"Admin" is just a role. Roles are a name plus any subset of:

- **Manage printers**: add/remove/edit printers
- **Control printers**: temps, fans, moves, homing, start/pause/resume/cancel
- **Manage files**: upload/rename/delete, new folders, delete job history
- **Manage users**: accounts and role assignment
- **Manage roles**: roles and their permissions

Viewing status, camera, live feed, history, and the file list needs no
permission. A role with none of the above is a read-only viewer.

Two rules:

- **`manage_roles` is effectively admin.** It can put any permission on any
  role. You can't edit the permissions of the role you're signed in with,
  but treat it as a full grant.
- **There's always one user with `manage_users` + `manage_roles`.** Deleting
  or demoting the last one, or stripping that pair from every role, is
  refused.

Logins survive restarts (signing key is in `users.yaml`). Deleting a user or
changing their password kills their live sessions; role/permission changes
apply on the next request.

Failed logins back off 5 s → 5 min, tracked per IP *and* per username, so a
shared proxy IP doesn't let one person lock everyone out and a spray from
many IPs still hits the per-user limit.

### Exposing it

- Plain HTTP. Put it behind an HTTPS reverse proxy before leaving the LAN.
- Behind a proxy, set `FORWARDED_ALLOW_IPS` (Docker: `PRINTDECK_FORWARDED_ALLOW_IPS`)
  to the proxy's IP or the rate limiter sees only the proxy.
- The camera stream comes straight from the printer's own server on `:8000`,
  which has no auth. Moonraker is only reached through PrintDeck.

## Printer connection

Each printer: host (IPv4/IPv6/hostname), Moonraker port (7125), optional
API key, TLS toggle. All editable from the ⚙ editor.

- **API key**: needed if Moonraker's `[authorization]` doesn't trust
  PrintDeck's address. Sent as `X-Api-Key` on HTTP and the websocket
  handshake. Stored in `printers.yaml`, never returned to the browser.
- **TLS**: Moonraker behind its own HTTPS proxy.

Check reachability with `curl http://<printer-ip>:7125/printer/info`. Give
the printer a DHCP reservation; if the IP moves, the card shows offline and
keeps retrying until you update it.

## Safety

**Klipper enforces limits, not PrintDeck.** `printer.cfg` travel ranges and
heater `max_temp` are checked by Klipper for every command from any client.
PrintDeck doesn't duplicate that; a stale copy would be worse than none.
What it does: fixed jog steps (0.1/1/10/50 mm), absolute moves (a rejected
relative move would leave the printer in G91), jog disabled until homed and
idle, temp inputs capped at the `max_temp` Klipper reports, and Klipper's
error text unwrapped from Moonraker's JSON envelope so you can read it.

## Docker

```bash
git clone https://github.com/alexeastlake/printdeck.git && cd printdeck
cp .env.example .env     # admin credentials, or leave blank
docker compose up -d --build
```

- `./data` is mounted at `/data`; `printers.yaml` and `users.yaml` live
  there. It's created on first run. Drop a `printers.yaml` in beforehand to
  start with a list.
- Directory mount, not file mounts: saves are atomic (temp file + rename),
  and a single-file bind mount pins the old inode so the rename fails.
- Runs as uid 1000, read-only rootfs, no capabilities. Permission error on
  save → make `./data` writable by uid 1000.
- Update: `git pull && docker compose up -d --build`.

Env vars (`.env`):

| Var | Default | |
|---|---|---|
| `PRINTDECK_DATA_DIR` | `./data` | host dir for the YAML files |
| `PRINTDECK_PORT` | `8000` | host port |
| `PRINTDECK_IMAGE_TAG` | `latest` | tag to pull when not building locally |
| `PRINTDECK_FORWARDED_ALLOW_IPS` | `127.0.0.1` | reverse proxy IP |

CI (`.github/workflows/ci.yml`) lints and tests every push; on `main` and
`v*` tags it then publishes `ghcr.io/alexeastlake/printdeck` (amd64 +
arm64). The package is public, so drop `build: .` from the compose file to
pull instead of build.

## Features

- **Camera**: WebRTC, handshake relayed through `/api/printers/<id>/camera/offer`
  to dodge CORS, video peer-to-peer from the printer. Click for fullscreen.
- **Editor (⚙)**: name, host, port, API key, TLS, Creality light, camera URL, group. Host
  changes reconnect live and rewrite the camera URL if it embedded the old
  host.
- **Detail page** `/printer/<id>`: bigger camera, Klipper status line,
  controls, files, history.
- **Files**: browse the gcodes root with slicer thumbnails; with `manage_files`: upload, rename,
  delete (incl. multi-select), new folder. With `control_printers`: ▶ starts
  a print (idle printers only, confirms first).
- **Jobs**: Pause/Resume/Cancel on the card and detail page, via Moonraker's
  job endpoints so the printer's own macros run.
- **Complete state**: a finished print stays on the card ("Finished 12 min
  ago") until you Dismiss it. Dismiss is per browser. The timestamp is
  PrintDeck's own, so a server restarted after the fact just says "Finished".
- **History**: Moonraker's job history with lifetime totals: file, result,
  started, finished, duration, filament (metres and grams), thumbnail while
  the file still exists. Result is Completed, Not completed, or In progress
  (firmware isn't consistent about anything finer; a K1 logs a screen cancel
  as an error), with roughly how far an unfinished print got. Search by
  filename, filter by result; a filter pulls in the rest of the list so it
  isn't partial. With `manage_files`: delete a row, or clear the lot.
  Needs the `[history]` component on the printer.
- **Controls**: nozzle/bed targets, jog/home, every fan Klipper reports
  (discovered via `printer.objects.list`), and lights: LED strips plus any
  `output_pin` whose name looks like one (led/light/lamp/chamber/case), with
  a brightness slider where the pin is PWM. Creality K1-series stock firmware
  doesn't expose its chamber light to Klipper at all; tick **Creality chamber
  light** in the printer's editor and PrintDeck drives it through Creality's
  own service on port 9999 instead (on/off only, which is all it offers). 10-minute graphs, in-memory only.
  All via `POST /api/printers/<id>/gcode`.
- **Print details**: slicer thumbnail, filament used vs estimate in metres
  and grams, layer count/height, slicer. ETA prefers the slicer's estimate. No live
  layer counter: without `SET_PRINT_STATS_INFO` the only source is Z, and
  Z-hops make it jitter.
- **Search / groups**: filter by name; group printers into collapsible
  sections, collapse state remembered per browser.
- **Theme**: light/dark/system, per browser.
- **Cache busting**: assets served at `/static/<hash>/…` (immutable), pages
  `no-cache`, so a deploy never leaves a tab on old JS.

## Next

- mDNS auto-discovery.
- Notifications (webhook/ntfy/Gotify) on complete/error.

## Development

```bash
pip install -e ".[dev]"
ruff check .
pytest
```

Tests build the app with `create_app(printers_file=…, users_file=…)` against
temp files, stub the printer connection loop, and fake Moonraker with
`httpx.MockTransport` (`tests/conftest.py`). CI runs the same on 3.11-3.13.

## License

[MIT](LICENSE).
