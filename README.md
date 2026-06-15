# PrintDeck

A small, local dashboard for Moonraker-based 3D printers. Built first for a
**Creality K1C 2025** — whose port-80 web UI is missing, but whose Moonraker API
on **port 7125** works fine — and designed to watch a whole fleet later.

**v1 does live monitoring:** per-printer state, nozzle/bed temperatures, print
progress + rough ETA, and the camera feed. Controls, file upload, and job
history are deliberately left for later — the backend is structured to add them
without a rewrite.

## What's where

```
app/                 FastAPI backend
  main.py            app entry; serves the API and the web/ page from one process
  config.py          reads printers.yaml
  models.py          PrinterConfig + the flat PrinterStatus sent to the browser
  moonraker/         the printer-facing half
    client.py        one Moonraker websocket connection, subscribe + merge updates
    normalize.py     raw Moonraker objects -> PrinterStatus
    manager.py       one task per printer, reconnects, fans status out to the page
  api/               printers.py (REST) + stream.py (/ws live channel)
                     + camera.py (WebRTC signaling proxy for the camera)
web/                 the entire frontend, hand-written, no build step
  index.html  style.css  app.js
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

## Finding your K1C's IP

You haven't given the printer a static IP yet, so first find its current one:

- On the printer: **Settings → Network** shows the IP, or
- In your router's admin page, look at the **DHCP client list** for the K1C.

Sanity-check that Moonraker is reachable from your PC:

```powershell
curl http://<printer-ip>:7125/printer/info
```

You should get a JSON blob back. Put that IP into `printers.yaml`.

**Recommended:** give the printer a **DHCP reservation** (a.k.a. static lease) in
your router so its address never changes. Then the entry in `printers.yaml`
stays correct forever. If the address does change, PrintDeck just shows the
printer as *offline* and keeps retrying — update the IP and it reconnects.

## Notes & what's next

- **Camera** plays natively in the card: the browser does a WebRTC handshake
  with the printer (relayed once through `api/camera.py` to dodge CORS), and the
  video then streams peer-to-peer straight from the printer. The tile shows a
  cropped preview; click it for fullscreen. The backend only brokers the
  handshake — the video never passes through this process.
- **More printers:** just add entries to `printers.yaml`. The dashboard renders
  one card per printer automatically.
- **Homelab:** it's a single process, so deployment is a small Dockerfile (TODO)
  or just running `uvicorn` behind your reverse proxy. Add auth before exposing
  it beyond your LAN.
- **Deferred features** (already has a home in the structure): pause/resume/
  cancel + temperature/G-code controls, browser file upload + start print, and
  job history.
