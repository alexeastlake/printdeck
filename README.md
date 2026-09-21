# PrintDeck

A dashboard for Moonraker-based 3D printers.

## What's where

```
app/                 FastAPI backend
  main.py            app entry; wires everything up, serves the API + web/ page
  config.py          reads/writes printers.yaml
  models.py          PrinterConfig, PrinterStatus, User, Role — the data shapes sent to the browser
  moonraker.py       the printer-facing half: connect, normalize, one task each
  routes.py          the endpoints: printer REST, camera signaling, /ws live feed
  auth.py            login, sessions, permission checks, user + role management (see below)
  users_store.py     reads/writes users.yaml (users and roles both)
  security.py        password hashing (stdlib PBKDF2, no extra dependency)
  utils.py           small shared helpers (e.g. slugify, for printer/role ids)
web/                 the entire frontend, hand-written, no build step
  index.html  app.js      the dashboard: search, groups, printer cards
  detail.html  detail.js  a printer's own page (bigger camera, full stats)
  users.html  users.js    user management (needs the manage_users permission)
  roles.html  roles.js    role management (needs the manage_roles permission)
  shared.js               formatters + camera + editor + settings dropdown,
                           used by all of the above
  style.css  login.html
printers.yaml        your printers (gitignored; copy from printers.example.yaml)
users.yaml           accounts (gitignored; created automatically — see below)
```

## Run it

```powershell
# one-time setup
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -e .

# point it at your printer
copy printers.example.yaml printers.yaml   # then edit the IP inside

# go
uvicorn app.main:app --reload
```

Open <http://localhost:8000>.

## Authentication

By default the dashboard is **open** — anyone who can reach the server sees your
printers (it logs a warning to remind you). To require a login, bootstrap an
admin account by setting these in the environment before the *first* start:

```powershell
$env:PRINTDECK_ADMIN_USERNAME = "you"
$env:PRINTDECK_ADMIN_PASSWORD = "a-good-password"
uvicorn app.main:app --reload
```

That creates `users.yaml` with one admin account — an "Admin" role holding
every permission — and a persistent session secret. From then on
`users.yaml` is the source of truth — those env vars are only read again if
that username ever goes missing from the file (a recovery path, not
something checked on every login), so changing/removing them afterward
doesn't do anything. Manage accounts from the **Users** page (Settings →
Manage users) instead of editing the file by hand.

### Roles are yours to define

Past that first bootstrap, "Admin" isn't a hardcoded concept — it's just a
role, editable and deletable like any other. Roles live on the **Roles**
page (Settings → Manage roles) and are each a name plus a subset of five
permissions:

- **Manage printers** — add, remove, and edit printer settings
- **Control printers** — temperature, fans, moves, homing
- **Manage files** — see the Files section, upload/rename/delete
- **Manage users** — create, edit, and delete accounts, and assign roles
- **Manage roles** — create, edit, and delete roles themselves

Viewing printer status/camera/files/the live feed isn't a permission — any
account can do that, same as before. A role with none of the five above is a
read-only viewer in effect, without "viewer" being special-cased anywhere;
create as many roles as make sense for who actually uses your dashboard.

One thing PrintDeck does enforce: **there's always at least one user who can
manage users and roles.** Deleting or demoting the last one, or editing a
role to strip that combination from everyone, is blocked — the whole point
of a self-service permissions system is not being able to lock yourself out
of it.

With any users configured, every page, API call, and the live WebSocket
require a login; unauthenticated visitors get bounced to a sign-in page, and
there's a **Sign out** button in the header. Unlike before, logins now
**survive a server restart** — the signing key lives in `users.yaml`, not a
value regenerated fresh each start. Deleting a user or changing their
password takes effect immediately for any session they're already logged
into, not just future logins — reassigning a user's role, or editing a
role's permissions, also applies live (to everyone with that role, for a
permission edit), without forcing a re-login.

Two caveats worth knowing:

- This runs over **plain HTTP**, so credentials are visible to anyone sniffing
  your LAN. That's fine for keeping casual devices out at home; put it behind
  **HTTPS** (a reverse proxy) before exposing it any wider.
- The login gates *this dashboard*. The camera stream comes peer-to-peer from
  the printer's own server on `:8000`, which has no auth of its own — anyone who
  knows the printer's IP can still reach that directly.

## A note on move/temperature safety

The detail page's Controls can move the toolhead and change heater targets —
worth being clear about where the actual safety checks live.

**Klipper enforces the real limits, not PrintDeck.** Your `printer.cfg`
defines each axis's travel range (`position_min`/`position_max`) and each
heater's safe range (`min_temp`/`max_temp`); Klipper itself rejects any
G-code command that would exceed them, regardless of which client sent it —
PrintDeck, Mainsail, Fluidd, or a raw terminal. That's the message you'd see
if a jog would move past the bed edge, for instance: it's the printer
refusing the command, not PrintDeck blocking it client-side. Those Moonraker
error messages get cleaned up before you see them (Klipper's own errors
arrive as JSON nested inside Moonraker's own JSON error envelope — PrintDeck
unwraps that down to just the readable text).

PrintDeck deliberately doesn't duplicate that enforcement. It could try to
fetch and cache your configured limits and pre-validate moves client-side,
but that's a second copy of a fact Klipper already knows authoritatively —
one that could drift out of sync if you ever change `printer.cfg`, either
false-blocking a legitimate move or (worse) giving false confidence in a
check that's gone stale. What PrintDeck *does* contribute: fixed, sane jog
step sizes (0.1/1/10/50mm — no free-form "move by any amount" input),
absolute-position moves so a rejected command can't leave the printer stuck
in relative-positioning mode, jog controls disabled until the relevant axis
is actually homed and the printer is idle, and clear surfacing of whatever
Klipper itself rejects — rather than a second, potentially-wrong safety net.

## Run it with Docker

The whole app is one process, so the container is tiny. On your homelab:

```bash
git clone <your-repo-url> printdeck && cd printdeck

cp printers.example.yaml printers.yaml   # edit the printer IP inside
touch users.yaml                         # accounts live here — starts empty
cp .env.example .env                     # set an admin username/password (or leave blank)

docker compose up -d --build
```

Then open `http://<homelab-ip>:8000`. A few notes:

- **Your printer edits persist.** `printers.yaml` is mounted from the host, so
  changing a printer's IP or name in the UI writes back to the file and survives
  rebuilds. (The file must exist before you start — hence the `cp` above.)
- **Accounts persist too.** `users.yaml` is mounted the same way — the admin
  account from `.env` gets written into it on first boot, and any users you
  add/remove from the Users page afterward survive rebuilds. (Same deal: the
  file must exist first, hence `touch users.yaml` above — an empty file is
  fine, PrintDeck fills it in.)
- **Credentials** come from `.env` (gitignored) but only bootstrap that first
  admin account — see "Authentication" above. Blank = no login, with a warning.
- **Camera still works** — it streams peer-to-peer from the printer straight to
  your browser, so it doesn't route through the container.
- **Updating** as we keep building: `git pull && docker compose up -d --build`.

### Deploying it somewhere other than a standalone clone

Everything host-specific is an env var (set in `.env`, or however your
deployment injects environment variables) rather than hardcoded in
`docker-compose.yml`:

- `PRINTDECK_DATA_DIR` — where `printers.yaml`/`users.yaml` live on the host.
  Defaults to `.` (next to the compose file). Point it at wherever your
  actual persistent/backed-up storage is if "next to the compose file" isn't
  durable in your setup (e.g. that directory gets rebuilt from git on every
  deploy) — same idea as any other stack that keeps its data on a separate
  volume instead of alongside its own compose file.
- `PRINTDECK_PORT` — host port to publish. Defaults to `8000`.
- `PRINTDECK_IMAGE_TAG` — which published tag to run when you're *not*
  building locally (no `--build`, no source tree present). Defaults to
  `latest`.

A GitHub Actions workflow (`.github/workflows/publish.yml`) builds and
publishes `ghcr.io/alexeastlake/printdeck` on every push to `main` (`:latest`
+ a `:sha-<commit>` tag) and on version tags (`v1.2.3` → `:v1.2.3`) — no
Docker or PAT needed locally, it authenticates with the repo's own
`GITHUB_TOKEN`. That means a deployment that only has this repo's
`docker-compose.yml` (not the source tree) can reference the image directly
— omit `build: .` from the service and it'll pull instead. The package is
public, so no registry login is needed to pull it.

## Finding your printer's IP

- On the printer: **Settings → Network** shows the IP
- In your router's admin page, look at the **DHCP client list** for the printer

Sanity-check that Moonraker is reachable from your PC:

```powershell
curl http://<printer-ip>:7125/printer/info
```

You should get a JSON blob back. Put that IP into `printers.yaml`.

**Recommended:** give the printer a **DHCP reservation** in
your router so its address never changes. Then the entry in `printers.yaml`
stays correct forever. If the address does change, PrintDeck just shows the
printer as *offline* and keeps retrying - update the IP and it reconnects.

## Notes & what's next

- **Camera** plays natively in the card: the browser does a WebRTC handshake
  with the printer (relayed once through `api/camera.py` to dodge CORS), and the
  video then streams peer-to-peer straight from the printer. The tile shows a
  cropped preview; click it for fullscreen. The backend only brokers the
  handshake - the video never passes through this process.
- **More printers:** just add entries to `printers.yaml`. The dashboard renders
  one card per printer automatically.
- **Editing a printer:** the ⚙ on each card (or on its own detail page) edits
  its name, IP/hostname, camera URL, and group, reconnects that printer live
  (no server restart), and saves to `printers.yaml`. Handy when a roaming
  DHCP address moves — changing just the IP keeps the camera URL in sync
  automatically (it's usually the same host); setting the camera URL
  explicitly in the same edit overrides that.
- **Printer detail page:** click a printer's card (or just its name) to open a
  bigger, single-printer view at `/printer/<id>` — full stats, a larger
  always-on camera, and the same settings editor. Shareable/bookmarkable URL.
  Its IP/hostname and camera URL are always shown (not just inside the
  editor). A labeled "Status" line under the header shows Klipper's own status text
  (e.g. "Printer is ready") whenever the printer's online — distinct from the
  message shown below the temps, which is reserved for something actually
  worth your attention (a pause reason, a shutdown/error message).
- **Files (on the detail page):** browse the printer's gcodes folder — navigate
  into subfolders, upload a file, rename/delete one file or a multi-selected
  batch, make a new folder, search/sort/paginate a folder with lots of files.
  This is filesystem management, not print-job management: nothing here
  starts a print from a file (still deferred — see below).
- **Controls (on the detail page):** set nozzle/bed target, jog/home the
  toolhead, and set speed on *every* fan the printer reports — not just the
  primary part-cooling fan. Klipper has no fixed list of fan names (a
  printer can have any number of `[fan_generic ...]` sections beyond the
  default `[fan]`), so PrintDeck asks each printer what it's actually got
  (`printer.objects.list`) rather than assuming there's only one. Each
  control is paired with its own recent-history graph (last 10
  minutes, kept in memory in your browser tab — no time-series database
  behind it, so it resets on reload). All of it sends G-code through one
  relay endpoint (`POST /api/printers/<id>/gcode`) to the printer's own
  Moonraker — same trust boundary as everything else here (see Authentication
  above). Jogging is disabled unless the printer is idle and that axis is
  homed, since a stray move mid-print or before homing can crash into the
  frame — and it's implemented as absolute moves (`G90` + a computed target),
  not relative ones, so a rejected move (e.g. past a travel limit) can't leave
  the printer stuck in relative-positioning mode for whatever command runs
  next. The actual travel-limit/temperature-limit enforcement is Klipper's,
  not this app's — see "A note on move/temperature safety" below.
- **Print details (on the detail page):** while a print is active, the job
  panel shows the slicer's embedded thumbnail (proxied from the printer's own
  Moonraker via `GET /api/printers/<id>/files/thumbnail`), and filament used
  so far against the slicer's total estimate (plus total weight, when the
  slicer records it). A current/total layer count and printed-height readout
  were tried and pulled again — without a live exact count from the printer
  (which needs the slicer's layer-change G-code to call
  `SET_PRINT_STATS_INFO`, and most profiles don't), the only option was
  estimating from the toolhead's Z, and the jitter from travel Z-hops made
  the number visibly jump around rather than climb steadily — not worth
  keeping over that. The ETA prefers the slicer's own time estimate once
  it's loaded — steadier than the
  elapsed/progress heuristic used before it, which is still the fallback for
  files without one. Slicer name/version only shows up if the slicer
  actually recorded it. This is all read-only reporting, not a G-code
  preview or 3D toolpath viewer.
- **Search:** the box above the dashboard filters cards by name as you type.
- **Groups:** give printers the same `group` in `printers.yaml` (or via the ⚙
  editor) to have them sit together in a named, collapsible section. Printers
  with no group land in "Ungrouped". Collapsed/expanded state is remembered
  per browser.
- **Settings (⚙ in the header):** a small dropdown, not a full page — there's
  only a color theme so far (Light, Dark, or System, the default) plus a link
  to this repo. Theme is stored in the browser, not `printers.yaml` — it's a
  per-device preference, not shared config.
- **Auto-discovery (TODO):** find the printer on the LAN automatically via
  mDNS/hostname, so a roaming DHCP address updates itself instead of needing the
  new IP typed into the ⚙ editor. Would remove the manual lookup step entirely.
- **Homelab:** it's a single process — run it with Docker (see below) or just
  `uvicorn` behind your reverse proxy. Add auth before exposing it beyond your LAN.
- **Deferred features** (already has a home in the structure): pause/resume/
  cancel a print, starting a print from an uploaded file, and job history.
