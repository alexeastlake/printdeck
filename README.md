# PrintDeck

A dashboard for Moonraker-based 3D printers.

## What's where

```
app/                 FastAPI backend
  main.py            app entry; wires everything up, serves the API + web/ page
  config.py          reads/writes printers.yaml
  models.py          PrinterConfig + the flat PrinterStatus sent to the browser
  moonraker.py       the printer-facing half: connect, normalize, one task each
  routes.py          the endpoints: printer REST, camera signaling, /ws live feed
  auth.py            optional username/password login (see below)
web/                 the entire frontend, hand-written, no build step
  index.html  style.css  app.js  login.html
printers.yaml        your printers (gitignored; copy from printers.example.yaml)
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
printers (it logs a warning to remind you). To require a login, set a username
and password in the environment before starting:

```powershell
$env:PRINTDECK_USERNAME = "you"
$env:PRINTDECK_PASSWORD = "a-good-password"
uvicorn app.main:app --reload
```

With those set, every page, API call, and the live WebSocket require a login;
unauthenticated visitors get bounced to a sign-in page, and there's a **Sign
out** button in the header. Logins reset when the server restarts (the cookie
signing key is regenerated each start) — fine for a personal dashboard.

Two caveats worth knowing:

- This runs over **plain HTTP**, so credentials are visible to anyone sniffing
  your LAN. That's fine for keeping casual devices out at home; put it behind
  **HTTPS** (a reverse proxy) before exposing it any wider.
- The login gates *this dashboard*. The camera stream comes peer-to-peer from
  the printer's own server on `:8000`, which has no auth of its own — anyone who
  knows the printer's IP can still reach that directly.

## Run it with Docker

The whole app is one process, so the container is tiny. On your homelab:

```bash
git clone <your-repo-url> printdeck && cd printdeck

cp printers.example.yaml printers.yaml   # edit the printer IP inside
cp .env.example .env                      # set username/password/secret (or leave blank)

docker compose up -d --build
```

Then open `http://<homelab-ip>:8000`. A few notes:

- **Your printer edits persist.** `printers.yaml` is mounted from the host, so
  changing a printer's IP or name in the UI writes back to the file and survives
  rebuilds. (The file must exist before you start — hence the `cp` above.)
- **Credentials** come from `.env` (gitignored). Blank = no login, with a warning.
- **Camera still works** — it streams peer-to-peer from the printer straight to
  your browser, so it doesn't route through the container.
- **Updating** as we keep building: `git pull && docker compose up -d --build`.

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
- **Editing a printer:** the ⚙ on each card edits its name and IP/hostname,
  reconnects that printer live (no server restart), and saves to `printers.yaml`.
  Handy when a roaming DHCP address moves.
- **Auto-discovery (TODO):** find the printer on the LAN automatically via
  mDNS/hostname, so a roaming DHCP address updates itself instead of needing the
  new IP typed into the ⚙ settings. Would remove the manual lookup step entirely.
- **Homelab:** it's a single process — run it with Docker (see below) or just
  `uvicorn` behind your reverse proxy. Add auth before exposing it beyond your LAN.
- **Deferred features** (already has a home in the structure): pause/resume/
  cancel + temperature/G-code controls, browser file upload + start print, and
  job history.
