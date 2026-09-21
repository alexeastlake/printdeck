// PrintDeck printer detail page: one printer's live status full-size, with
// an always-on camera view. Shares formatters/camera/editor code with the
// dashboard via shared.js — the id lives in the URL (/printer/<id>).

const printerId = decodeURIComponent(location.pathname.split("/").pop());

const connLabel = document.getElementById("conn");
const card = document.getElementById("detail-card");
const notFound = document.getElementById("not-found");

let cameraStarted = false;

function render(status) {
  card.hidden = false;
  notFound.hidden = true;
  document.title = `${status.name} — PrintDeck`;

  card.dataset.host = status.host || "";
  card.dataset.cameraUrl = status.camera_url || "";
  card.dataset.group = status.group || "";
  card.dataset.state = status.state;
  card.style.setProperty("--state", STATE_COLOR[status.state] || STATE_COLOR.offline);

  card.querySelector(".name").textContent = status.name;
  card.querySelector(".badge").textContent = status.state;

  card.querySelector(".nozzle").innerHTML = temp(status.extruder_temp, status.extruder_target);
  card.querySelector(".bed").innerHTML = temp(status.bed_temp, status.bed_target);

  card.querySelector(".printer-info-host").textContent = status.host || "—";
  const cameraInfo = card.querySelector(".printer-info-camera-item");
  if (status.camera_url) {
    card.querySelector(".printer-info-camera").textContent = status.camera_url;
    cameraInfo.hidden = false;
  } else {
    cameraInfo.hidden = true;
  }

  renderJob(status);
  renderKlipperStatus(status);
  renderMessage(status);
  renderCamera(status);
  renderGraphs(status);
  renderControls(status);
  renderFilesVisibility(status);
}

const jobThumb = document.querySelector(".job-thumb");
const jobFilamentStat = document.querySelector(".job-stat-filament");
const jobFilamentValue = document.querySelector(".job-filament");
const jobWeightStat = document.querySelector(".job-stat-weight");
const jobWeightValue = document.querySelector(".job-weight");
const jobFilamentTypeStat = document.querySelector(".job-stat-filament-type");
const jobFilamentTypeValue = document.querySelector(".job-filament-type");
const jobLayerCountStat = document.querySelector(".job-stat-layer-count");
const jobLayerCountValue = document.querySelector(".job-layer-count");
const jobLayerHeightStat = document.querySelector(".job-stat-layer-height");
const jobLayerHeightValue = document.querySelector(".job-layer-height");
const jobNozzleStat = document.querySelector(".job-stat-nozzle");
const jobNozzleValue = document.querySelector(".job-nozzle");
const jobSlicerStat = document.querySelector(".job-stat-slicer");
const jobSlicerValue = document.querySelector(".job-slicer");

let jobFilename = null;  // the file this thumbnail/metadata belongs to
let printInfo = null;    // slicer metadata for jobFilename, once it's loaded

function renderJob(status) {
  const job = card.querySelector(".job");
  const active = status.state === "printing" || status.state === "paused";
  job.hidden = !active;
  if (!active) {
    jobFilename = null;
    return;
  }

  card.querySelector(".progress-bar").style.width = `${Math.round((status.progress || 0) * 100)}%`;
  card.querySelector(".filename").textContent = status.filename || "—";
  renderJobDetails(status);

  // Metadata/thumbnail don't change mid-print — fetch them once per
  // filename, not on every status tick.
  if (status.filename && status.filename !== jobFilename) {
    jobFilename = status.filename;
    loadPrintInfo(status.filename);
  }
}

function renderJobDetails(status) {
  // Once the slicer's own time estimate is in, prefer it over the plain
  // elapsed/progress heuristic — that one's noisy early in a print (a
  // barely-started print with 1% progress gives a wild extrapolation).
  let etaSeconds = status.eta_seconds;
  if (printInfo?.estimated_time) {
    const remaining = printInfo.estimated_time - (status.print_duration || 0);
    if (remaining > 0) etaSeconds = remaining;
  }
  card.querySelector(".eta").textContent = eta(etaSeconds);

  const usedMm = status.filament_used || 0;
  if (usedMm > 0) {
    let text = `${(usedMm / 1000).toFixed(2)}`;
    if (printInfo?.filament_total) text += `/${(printInfo.filament_total / 1000).toFixed(2)}`;
    jobFilamentValue.textContent = `${text} m`;
    jobFilamentStat.hidden = false;
  } else {
    jobFilamentStat.hidden = true;
  }

  // Moonraker only gives a total weight estimate, not a live used-so-far
  // figure — scale it by how much of the total length has been used
  // (weight is proportional to length for a given filament/diameter).
  if (usedMm > 0 && printInfo?.filament_total && printInfo?.filament_weight_total) {
    const usedWeight = (usedMm / printInfo.filament_total) * printInfo.filament_weight_total;
    jobWeightValue.textContent = `${usedWeight.toFixed(1)}/${printInfo.filament_weight_total.toFixed(1)} g`;
    jobWeightStat.hidden = false;
  } else {
    jobWeightStat.hidden = true;
  }

  // Plain info, not live counters — one value each, straight from the
  // slicer's metadata, shown (or not) exactly as recorded.
  if (printInfo?.filament_type) {
    jobFilamentTypeValue.textContent = printInfo.filament_type;
    jobFilamentTypeStat.hidden = false;
  } else {
    jobFilamentTypeStat.hidden = true;
  }

  if (printInfo?.layer_count) {
    jobLayerCountValue.textContent = String(printInfo.layer_count);
    jobLayerCountStat.hidden = false;
  } else {
    jobLayerCountStat.hidden = true;
  }

  if (printInfo?.layer_height) {
    jobLayerHeightValue.textContent = `${printInfo.layer_height} mm`;
    jobLayerHeightStat.hidden = false;
  } else {
    jobLayerHeightStat.hidden = true;
  }

  if (printInfo?.nozzle_diameter) {
    jobNozzleValue.textContent = `${printInfo.nozzle_diameter} mm`;
    jobNozzleStat.hidden = false;
  } else {
    jobNozzleStat.hidden = true;
  }

  if (printInfo?.slicer) {
    jobSlicerValue.textContent = printInfo.slicer_version
      ? `${printInfo.slicer} ${printInfo.slicer_version}`
      : printInfo.slicer;
    jobSlicerStat.hidden = false;
  } else {
    jobSlicerStat.hidden = true;
  }
}

function loadPrintInfo(filename) {
  printInfo = null;
  jobThumb.hidden = true;
  jobThumb.src = `/api/printers/${encodeURIComponent(printerId)}/files/thumbnail?filename=${encodeURIComponent(filename)}`;

  fetch(`/api/printers/${encodeURIComponent(printerId)}/files/info?filename=${encodeURIComponent(filename)}`)
    .then((res) => (res.ok ? res.json() : null))
    .then((info) => {
      printInfo = info;
      if (filename === jobFilename && lastStatus) renderJobDetails(lastStatus);
    })
    .catch(() => {});
}

jobThumb.addEventListener("load", () => { jobThumb.hidden = false; });
jobThumb.addEventListener("error", () => { jobThumb.hidden = true; });
jobThumb.addEventListener("click", () => openImageLightbox(jobThumb.src, jobFilename || ""));

function renderKlipperStatus(status) {
  const el = card.querySelector(".klipper-status");
  card.querySelector(".klipper-status-value").textContent = status.klipper_status || "";
  el.hidden = !status.online || !status.klipper_status;
}

function renderMessage(status) {
  const el = card.querySelector(".detail-message");
  el.textContent = status.message || "";
  el.hidden = !status.message;
}

// Unlike the dashboard card, there's no toggle here — this page exists to
// look at one printer closely, so the camera just comes up on its own.
function renderCamera(status) {
  const camera = card.querySelector(".camera");
  if (status.camera_url && status.online) {
    camera.hidden = false;
    if (!cameraStarted) {
      cameraStarted = true;
      startCamera(card, printerId);
    }
  } else {
    camera.hidden = true;
    cameraStarted = false;
    stopCamera(card);
  }
}

function showNotFound() {
  card.hidden = true;
  notFound.hidden = false;
}

// --- history graphs --------------------------------------------------------
// Kept in memory only, since this page was opened — there's no time-series
// storage on the backend, so a reload starts the history over. Each graph
// lives right in its control block (see detail.html), not a separate
// section, so there's no visibility of its own to manage here — it's hidden
// along with the rest of .controls-section when the printer's offline.

const GRAPH_WINDOW_MS = 10 * 60 * 1000; // last 10 minutes
const tempGraphSvg = document.querySelector(".temp-graph");
const fanGraphSvg = document.querySelector(".fan-graph");
const tempYMax = document.querySelector(".temp-y-max");
const tempYMid = document.querySelector(".temp-y-mid");
const graphXStarts = document.querySelectorAll(".graph-x-start");
const graphXMids = document.querySelectorAll(".graph-x-mid");

// A printer can have any number of fans — cycle through a small palette
// rather than needing a fixed color per fan up front.
const FAN_COLORS = ["var(--printing)", "var(--accent)", "var(--paused)", "var(--idle)", "var(--error)"];
const fanColor = (i) => FAN_COLORS[i % FAN_COLORS.length];

let history = [];     // temps: { t, extruder, extruderTarget, bed, bedTarget }
let fanHistory = [];  // fans: { t, values: { [fanId]: speed } }

function renderGraphs(status) {
  if (status.online) {
    const now = Date.now();
    history.push({
      t: now,
      extruder: status.extruder_temp,
      extruderTarget: status.extruder_target,
      bed: status.bed_temp,
      bedTarget: status.bed_target,
    });
    const cutoff = now - GRAPH_WINDOW_MS;
    while (history.length && history[0].t < cutoff) history.shift();

    const values = {};
    for (const fan of status.fans) values[fan.id] = fan.speed;
    fanHistory.push({ t: now, values });
    while (fanHistory.length && fanHistory[0].t < cutoff) fanHistory.shift();
  }

  if (history.length < 2) return;

  // Offline status has everything zeroed out — leave the legend showing the
  // last real values instead of flashing to "0° → 0°".
  if (status.online) {
    document.querySelector(".extruder-value").textContent =
      `${status.extruder_temp.toFixed(0)}° → ${status.extruder_target.toFixed(0)}°`;
    document.querySelector(".bed-value").textContent =
      `${status.bed_temp.toFixed(0)}° → ${status.bed_target.toFixed(0)}°`;
    status.fans.forEach((fan, i) => {
      const el = fanLegend.querySelector(`[data-fan-id="${CSS.escape(fan.id)}"] .legend-value`);
      if (el) el.textContent = `${Math.round(fan.speed * 100)}%`;
    });
  }

  drawTempGraph();
  drawFanGraph();

  // Both graphs cover the same window, so these are the same labels either
  // way — just how far back the oldest point we've got actually goes
  // (starts short and grows to "-10m"/"-5m" once the page's been open that
  // long).
  const spanMin = Math.max(1, Math.round((history[history.length - 1].t - history[0].t) / 60000));
  for (const el of graphXStarts) el.textContent = `−${spanMin}m`;
  for (const el of graphXMids) el.textContent = `−${Math.round(spanMin / 2)}m`;
}

// A horizontal line at the midpoint, so the mid-scale label has something
// to anchor to instead of floating unlabeled space between top and bottom.
function midGridline(h, w) {
  return `<line class="graph-grid" x1="0" y1="${h / 2}" x2="${w}" y2="${h / 2}"/>`;
}

function drawTempGraph() {
  const w = 600, h = 140;
  const tMin = history[0].t, tMax = history[history.length - 1].t;
  const values = history.flatMap((p) => [p.extruder, p.extruderTarget, p.bed, p.bedTarget]);
  const maxV = Math.max(60, ...values) + 10;
  tempYMax.textContent = `${Math.round(maxV)}°`;
  tempYMid.textContent = `${Math.round(maxV / 2)}°`;
  const line = (get, cls) => graphPath(history, get, 0, maxV, w, h, tMin, tMax, cls);
  tempGraphSvg.innerHTML =
    midGridline(h, w) +
    line((p) => p.extruderTarget, "graph-line graph-extruder graph-target") +
    line((p) => p.bedTarget, "graph-line graph-bed graph-target") +
    line((p) => p.extruder, "graph-line graph-extruder") +
    line((p) => p.bed, "graph-line graph-bed");
}

function drawFanGraph() {
  if (fanHistory.length < 2) { fanGraphSvg.innerHTML = ""; return; }
  const w = 600, h = 70;
  const tMin = fanHistory[0].t, tMax = fanHistory[fanHistory.length - 1].t;
  fanGraphSvg.innerHTML = midGridline(h, w) + fanIds
    .map((id, i) => graphPath(
      fanHistory, (p) => p.values[id] || 0, 0, 1, w, h, tMin, tMax, "graph-line", fanColor(i)
    ))
    .join("");
}

function graphPath(points, getValue, minV, maxV, w, h, tMin, tMax, cls, stroke = "") {
  const span = (tMax - tMin) || 1;
  const range = (maxV - minV) || 1;
  const d = points
    .map((p, i) => {
      const x = ((p.t - tMin) / span) * w;
      const y = h - ((getValue(p) - minV) / range) * h;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${Math.max(0, Math.min(h, y)).toFixed(1)}`;
    })
    .join(" ");
  const style = stroke ? ` style="stroke:${stroke}"` : "";
  return `<path class="${cls}"${style} d="${d}"/>`;
}

// --- controls ----------------------------------------------------------------
// Move/temperature/fan controls. Everything here just constructs a G-code
// string and sends it through the generic relay in app/routes.py.

const controlsSection = document.querySelector(".controls-section");
const controlsStatus = document.querySelector(".controls-status");
const extruderTargetInput = document.querySelector(".extruder-target-input");
const bedTargetInput = document.querySelector(".bed-target-input");
const fanRowsContainer = document.querySelector(".fan-rows");
const fanRowTemplate = document.getElementById("fan-row-template");
const fanLegend = document.querySelector(".fan-legend");
const posX = document.querySelector(".pos-x");
const posY = document.querySelector(".pos-y");
const posZ = document.querySelector(".pos-z");
const moveDisabledNote = document.querySelector(".move-disabled-note");
const jogButtons = document.querySelectorAll(".jog-btn");
const jogHomeBtn = document.querySelector(".jog-home");
const stepButtons = document.querySelectorAll(".step-btn");

let jogStep = 1;
let jogBusy = false;    // a jog/home request is in flight
let lastStatus = null;  // most recent status — jogging needs the current position
let fanIds = [];        // built once, the first time a fan list arrives

function setControlsStatus(text, isError = false) {
  controlsStatus.textContent = text;
  controlsStatus.hidden = !text;
  controlsStatus.classList.toggle("controls-error", isError);
}

async function sendGcode(script) {
  try {
    const res = await fetch(`/api/printers/${encodeURIComponent(printerId)}/gcode`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ script }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || `error ${res.status}`);
    setControlsStatus("");
  } catch (err) {
    setControlsStatus(err.message, true);
  }
}

function updateJogEnabled() {
  if (!lastStatus || !lastStatus.online) {
    for (const btn of jogButtons) btn.disabled = true;
    jogHomeBtn.disabled = true;
    return;
  }
  // Manual moves are only safe when idle (not mid-print/paused), only
  // per-axis once homed, and not while a previous move is still in flight
  // (so the next one isn't computed from a stale position).
  const canMove = (lastStatus.state === "idle" || lastStatus.state === "error") && !jogBusy;
  const homed = new Set((lastStatus.homed_axes || "").split(""));
  for (const btn of jogButtons) {
    btn.disabled = !canMove || !homed.has(btn.dataset.axis.toLowerCase());
  }
  jogHomeBtn.disabled = !canMove;
}

// Disabled controls with no explanation just look broken — this is why.
function updateMoveNote(status) {
  let reason = "";
  if (status.state === "printing" || status.state === "paused") {
    reason = "Manual moves are disabled while printing.";
  } else {
    const homed = new Set((status.homed_axes || "").split(""));
    if (!["x", "y", "z"].every((a) => homed.has(a))) {
      reason = "Home the printer (⌂) before moving it manually.";
    }
  }
  moveDisabledNote.textContent = reason;
  moveDisabledNote.hidden = !reason;
}

// A printer's fan list doesn't change at runtime, so this only actually
// builds anything the first time it's called.
function buildFanRows(fans) {
  if (fanIds.length || fans.length === 0) return;
  fanIds = fans.map((f) => f.id);
  fanRowsContainer.innerHTML = "";
  fanLegend.innerHTML = "";
  // .legend-item is itself a flex container, so it's block-level by
  // default — without a flex row to hold them, each fan's legend entry
  // stacked on its own line instead of flowing left-to-right like the
  // nozzle/bed legend does.
  const legendRow = document.createElement("div");
  legendRow.className = "legend-row";
  fanLegend.append(legendRow);

  fans.forEach((fan, i) => {
    const row = fanRowTemplate.content.firstElementChild.cloneNode(true);
    row.querySelector(".control-label").textContent = fan.name;
    const input = row.querySelector(".fan-target-input");
    input.dataset.fanId = fan.id;
    row.querySelector(".fan-set-btn").addEventListener("click", () => {
      const v = Number(input.value);
      if (!Number.isFinite(v) || v < 0 || v > 100) {
        return setControlsStatus("Enter a fan speed between 0 and 100.", true);
      }
      sendGcode(fanSetScript(fan.id, v));
    });
    row.querySelector(".fan-off-btn").addEventListener("click", () => {
      input.value = "0";
      sendGcode(fanOffScript(fan.id));
    });
    fanRowsContainer.append(row);

    const legendItem = document.createElement("span");
    legendItem.className = "legend-item";
    legendItem.dataset.fanId = fan.id;
    legendItem.innerHTML =
      `<span class="legend-swatch" style="background:${fanColor(i)}"></span>` +
      `${fan.name} <b class="legend-value"></b>`;
    legendRow.append(legendItem);
  });
}

// The primary fan is only controllable via M106/M107 — SET_FAN_SPEED is for
// the printer.cfg-configured [fan_generic ...] fans (id "fan_generic Name").
function fanSetScript(id, percent) {
  if (id === "fan") return `M106 S${Math.round((percent / 100) * 255)}`;
  const name = id.slice("fan_generic ".length);
  return `SET_FAN_SPEED FAN=${name} SPEED=${(percent / 100).toFixed(2)}`;
}
function fanOffScript(id) {
  if (id === "fan") return "M107";
  const name = id.slice("fan_generic ".length);
  return `SET_FAN_SPEED FAN=${name} SPEED=0`;
}

function renderControls(status) {
  lastStatus = status;
  controlsSection.hidden = !status.online;
  if (!status.online) return;

  updateJogEnabled();
  updateMoveNote(status);
  posX.textContent = status.x.toFixed(1);
  posY.textContent = status.y.toFixed(1);
  posZ.textContent = status.z.toFixed(1);

  // Don't fight the user while they're actively editing these — and show
  // "0" rather than leaving the field blank just because a heater is off.
  if (document.activeElement !== extruderTargetInput) {
    extruderTargetInput.value = Math.round(status.extruder_target);
  }
  if (document.activeElement !== bedTargetInput) {
    bedTargetInput.value = Math.round(status.bed_target);
  }

  buildFanRows(status.fans);
  for (const fan of status.fans) {
    const input = fanRowsContainer.querySelector(`[data-fan-id="${CSS.escape(fan.id)}"]`);
    if (input && document.activeElement !== input) input.value = Math.round(fan.speed * 100);
  }
}

document.querySelector(".extruder-set-btn").addEventListener("click", () => {
  const v = Number(extruderTargetInput.value);
  if (!Number.isFinite(v) || v < 0 || v > 300) return setControlsStatus("Enter a nozzle temp between 0 and 300.", true);
  sendGcode(`M104 S${v}`);
});
document.querySelector(".extruder-off-btn").addEventListener("click", () => {
  extruderTargetInput.value = "0";
  sendGcode("M104 S0");
});
document.querySelector(".bed-set-btn").addEventListener("click", () => {
  const v = Number(bedTargetInput.value);
  if (!Number.isFinite(v) || v < 0 || v > 130) return setControlsStatus("Enter a bed temp between 0 and 130.", true);
  sendGcode(`M140 S${v}`);
});
document.querySelector(".bed-off-btn").addEventListener("click", () => {
  bedTargetInput.value = "0";
  sendGcode("M140 S0");
});

for (const btn of stepButtons) {
  btn.addEventListener("click", () => {
    jogStep = Number(btn.dataset.step);
    for (const b of stepButtons) b.classList.toggle("active", b === btn);
  });
}

for (const btn of jogButtons) {
  btn.addEventListener("click", async () => {
    if (jogBusy || !lastStatus) return;
    const axis = btn.dataset.axis;
    const current = { X: lastStatus.x, Y: lastStatus.y, Z: lastStatus.z }[axis];
    const target = (current + Number(btn.dataset.dir) * jogStep).toFixed(3);
    const feedrate = axis === "Z" ? 600 : 3000;
    jogBusy = true;
    updateJogEnabled();
    // An absolute move, not a relative (G91) one: if a relative move gets
    // rejected mid-command (e.g. past a travel limit), the printer is left
    // stuck in relative mode for whatever command comes next — its own
    // hazard. Sending G90 first and an absolute target sidesteps that
    // regardless of whatever mode was active before.
    await sendGcode(`G90\nG1 ${axis}${target} F${feedrate}`);
    jogBusy = false;
    updateJogEnabled();
  });
}

jogHomeBtn.addEventListener("click", async () => {
  if (jogBusy) return;
  jogBusy = true;
  updateJogEnabled();
  await sendGcode("G28");
  jogBusy = false;
  updateJogEnabled();
});

// --- file browser --------------------------------------------------------
// Browse (and manage) the printer's own gcode folder, fetched on demand —
// not pushed over the live channel. Root is always "gcodes"; that's the one
// folder anyone actually cares about here.

const filesSection = document.querySelector(".files-section");
const filesRefreshBtn = document.querySelector(".files-refresh");
const filesNewFolderBtn = document.querySelector(".files-new-folder");
const filesUploadBtn = document.querySelector(".files-upload");
const filesUploadInput = document.querySelector(".files-upload-input");
const filesSearchInput = document.querySelector(".files-search");
const filesBreadcrumb = document.querySelector(".files-breadcrumb");
const filesList = document.querySelector(".files-list");
const filesLoadMoreBtn = document.querySelector(".files-load-more");
const filesStatus = document.querySelector(".files-status");
const filesSelectAll = document.querySelector(".files-select-all");
const filesSortBtns = document.querySelectorAll(".files-sort-btn");
const filesBulkBar = document.querySelector(".files-bulk-bar");
const filesBulkCount = document.querySelector(".files-bulk-count");
const filesBulkDeleteBtn = document.querySelector(".files-bulk-delete");

const FILES_PAGE_SIZE = 50;

let filesPath = "";
let filesReady = false;  // have we done the first load since coming online?
let filesRequestId = 0;  // bumped on every loadFiles() — see fetchFiles()
let allEntries = [];     // everything in the current folder — dirs then files
let visibleCount = FILES_PAGE_SIZE;
let sortField = "name";
let sortDir = 1;         // 1 ascending, -1 descending
let selected = new Set(); // paths selected for bulk delete, within this folder

// Only bother the printer's HTTP API once it's actually reachable, and only
// once per online period — not on every websocket status tick.
function renderFilesVisibility(status) {
  if (!status.online) {
    filesSection.hidden = true;
    filesReady = false;
    return;
  }
  filesSection.hidden = false;
  if (!filesReady) {
    filesReady = true;
    loadFiles();
  }
}

function setFilesStatus(text, isError = false) {
  filesStatus.textContent = text;
  filesStatus.hidden = !text;
  filesStatus.classList.toggle("files-error", isError);
}

function filesApiUrl(suffix = "") {
  return `/api/printers/${encodeURIComponent(printerId)}/files${suffix}`;
}

function entryPathFor(name) {
  return filesPath ? `${filesPath}/${name}` : name;
}

// Clicking a breadcrumb/folder/action button leaves it focused; the very
// next thing we do is usually rip out the list it lives in. Losing a
// focused element mid-DOM-swap is what was causing the whole page to jump
// back to the top — clearing focus first heads that off.
function loadFiles() {
  document.activeElement?.blur();
  filesSearchInput.value = "";
  selected.clear();
  updateBulkBar();
  setFilesStatus("Loading…");
  filesList.innerHTML = "";
  // Otherwise it stays visible (stale, from whatever the previous folder
  // needed it for) right through the loading state — renderEntries() sets
  // it correctly again once the new folder's data actually arrives.
  filesLoadMoreBtn.hidden = true;
  fetchFiles(++filesRequestId);
}

async function fetchFiles(requestId) {
  try {
    const params = new URLSearchParams({ path: filesPath });
    const res = await fetch(filesApiUrl(`?${params}`));
    if (!res.ok) throw new Error(`error ${res.status}`);
    const dir = await res.json();
    // A slower-to-resolve request for a folder we've since navigated away
    // from can otherwise land *after* the one for where we actually are
    // now, clobbering it with stale data — only the most recent request
    // still gets to touch the DOM.
    if (requestId !== filesRequestId) return;
    renderBreadcrumb();
    allEntries = [
      ...(dir.dirs || []).map((d) => ({ name: d.dirname, size: null, modified: d.modified || 0, isDir: true })),
      ...(dir.files || []).map((f) => ({ name: f.filename, size: f.size, modified: f.modified || 0, isDir: false })),
    ];
    visibleCount = FILES_PAGE_SIZE;
    renderEntries();
    setFilesStatus("");
  } catch {
    if (requestId !== filesRequestId) return;
    allEntries = [];
    filesList.innerHTML = "";
    setFilesStatus("Couldn't load files from the printer.", true);
  }
}

// Folders always sort before files (regardless of field — a folder's "size"
// isn't really comparable to a file's), each group sorted by whatever the
// user picked.
function sortedEntries() {
  const cmp = (a, b) => {
    if (sortField === "name") return a.name.localeCompare(b.name) * sortDir;
    return ((a[sortField] ?? 0) - (b[sortField] ?? 0)) * sortDir;
  };
  const dirs = allEntries.filter((e) => e.isDir).sort(cmp);
  const files = allEntries.filter((e) => !e.isDir).sort(cmp);
  return [...dirs, ...files];
}

function currentMatches() {
  const query = filesSearchInput.value.trim().toLowerCase();
  const all = sortedEntries();
  return query ? all.filter((e) => e.name.toLowerCase().includes(query)) : all;
}

// Filters/sorts/paginates what's already been fetched — no extra requests
// for any of it. A folder with a thousand files shouldn't turn this page
// into a thousand-row wall.
function renderEntries() {
  const matches = currentMatches();

  filesList.innerHTML = "";
  for (const entry of matches.slice(0, visibleCount)) {
    filesList.append(fileRow(entry));
  }
  if (matches.length === 0) {
    filesList.innerHTML = `<li class="file-empty">${filesSearchInput.value.trim() ? "No matches." : "Empty folder."}</li>`;
  }
  filesLoadMoreBtn.hidden = matches.length <= visibleCount;
  updateSelectAllState(matches);
}

filesSearchInput.addEventListener("input", () => {
  visibleCount = FILES_PAGE_SIZE;
  renderEntries();
});
filesLoadMoreBtn.addEventListener("click", () => {
  visibleCount += FILES_PAGE_SIZE;
  renderEntries();
});

for (const btn of filesSortBtns) {
  btn.addEventListener("click", () => {
    if (sortField === btn.dataset.sort) sortDir *= -1;
    else { sortField = btn.dataset.sort; sortDir = 1; }
    for (const b of filesSortBtns) b.classList.toggle("active", b === btn);
    btn.dataset.dir = sortDir === 1 ? "asc" : "desc";
    renderEntries();
  });
}

function updateSelectAllState(matches) {
  const paths = matches.map((e) => entryPathFor(e.name));
  const selectedCount = paths.filter((p) => selected.has(p)).length;
  filesSelectAll.checked = paths.length > 0 && selectedCount === paths.length;
  filesSelectAll.indeterminate = selectedCount > 0 && selectedCount < paths.length;
}

filesSelectAll.addEventListener("change", () => {
  for (const entry of currentMatches()) {
    const path = entryPathFor(entry.name);
    if (filesSelectAll.checked) selected.add(path);
    else selected.delete(path);
  }
  renderEntries();
  updateBulkBar();
});

function updateBulkBar() {
  filesBulkBar.hidden = selected.size === 0;
  filesBulkCount.textContent = `${selected.size} selected`;
}

async function deleteSelected() {
  const paths = [...selected];
  if (paths.length === 0) return;
  const ok = await confirmDialog({
    title: "Delete selected",
    message: `Delete ${paths.length} item${paths.length === 1 ? "" : "s"}? This can't be undone.`,
    confirmLabel: "Delete",
    danger: true,
  });
  if (!ok) return;

  filesBulkDeleteBtn.disabled = true;
  const byPath = new Map(allEntries.map((e) => [entryPathFor(e.name), e]));
  setFilesStatus(`Deleting ${paths.length} item${paths.length === 1 ? "" : "s"}…`);
  let failed = 0;
  for (const path of paths) {
    const isDir = byPath.get(path)?.isDir ?? false;
    try {
      const params = new URLSearchParams({ path, is_dir: String(isDir) });
      const res = await fetch(filesApiUrl(`?${params}`), { method: "DELETE" });
      if (!res.ok) throw new Error();
    } catch {
      failed++;
    }
  }
  selected.clear();
  updateBulkBar();
  await fetchFiles(++filesRequestId);
  if (failed) setFilesStatus(`${paths.length - failed} of ${paths.length} deleted — ${failed} failed.`, true);
  filesBulkDeleteBtn.disabled = false;
}

filesBulkDeleteBtn.addEventListener("click", deleteSelected);

function fileRow(entry) {
  const { name, size, modified, isDir } = entry;
  const path = entryPathFor(name);
  const li = document.createElement("li");
  li.className = isDir ? "file-entry file-entry-dir" : "file-entry";
  li.innerHTML = `
    <span class="files-col-check">
      <input type="checkbox" class="file-checkbox" aria-label="Select ${isDir ? "folder" : "file"}">
    </span>
    <span class="file-name-cell">
      <span class="file-icon">${isDir ? "📁" : "📄"}</span>
      <span class="file-name"></span>
    </span>
    <span class="file-meta">${isDir ? "" : fileSize(size)}</span>
    <span class="file-modified">${modified ? formatModified(modified) : ""}</span>
    <span class="file-actions">
      <button type="button" class="file-rename" title="Rename" aria-label="Rename">✎</button>
      <button type="button" class="file-delete" title="Delete" aria-label="Delete">🗑</button>
    </span>
  `;
  li.querySelector(".file-name").textContent = name;

  const checkbox = li.querySelector(".file-checkbox");
  checkbox.checked = selected.has(path);
  checkbox.addEventListener("click", (event) => event.stopPropagation());
  checkbox.addEventListener("change", () => {
    if (checkbox.checked) selected.add(path);
    else selected.delete(path);
    updateBulkBar();
    updateSelectAllState(currentMatches());
  });

  if (isDir) {
    li.addEventListener("click", () => {
      filesPath = path;
      loadFiles();
    });
  }
  li.querySelector(".file-rename").addEventListener("click", (event) => {
    event.stopPropagation();
    renameEntry(path, name);
  });
  li.querySelector(".file-delete").addEventListener("click", (event) => {
    event.stopPropagation();
    deleteEntry(path, name, isDir);
  });
  return li;
}

function formatModified(unixSeconds) {
  const d = new Date(unixSeconds * 1000);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function renderBreadcrumb() {
  const parts = filesPath ? filesPath.split("/") : [];
  filesBreadcrumb.innerHTML = "";
  ["gcodes", ...parts].forEach((label, i) => {
    if (i > 0) filesBreadcrumb.append(" / ");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "breadcrumb-segment";
    btn.textContent = label;
    btn.addEventListener("click", () => {
      filesPath = parts.slice(0, i).join("/");
      loadFiles();
    });
    filesBreadcrumb.append(btn);
  });
}

function fileSize(bytes) {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

async function renameEntry(path, currentName) {
  const newName = await promptDialog({
    title: "Rename",
    label: "New name",
    value: currentName,
    confirmLabel: "Rename",
  });
  if (!newName || newName === currentName) return;
  setFilesStatus("Renaming…");
  try {
    const res = await fetch(filesApiUrl("/rename"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, new_name: newName }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || `error ${res.status}`);
    loadFiles();
  } catch (err) {
    setFilesStatus(`Rename failed: ${err.message}`, true);
  }
}

async function deleteEntry(path, name, isDir) {
  const ok = await confirmDialog({
    title: "Delete",
    message: `Delete "${name}"?${isDir ? " This removes everything inside it too." : ""}`,
    confirmLabel: "Delete",
    danger: true,
  });
  if (!ok) return;
  setFilesStatus("Deleting…");
  try {
    const params = new URLSearchParams({ path, is_dir: isDir });
    const res = await fetch(filesApiUrl(`?${params}`), { method: "DELETE" });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || `error ${res.status}`);
    loadFiles();
  } catch (err) {
    setFilesStatus(`Delete failed: ${err.message}`, true);
  }
}

async function createFolder() {
  const name = await promptDialog({ title: "New folder", label: "Folder name", confirmLabel: "Create" });
  if (!name) return;
  setFilesStatus("Creating folder…");
  try {
    const res = await fetch(filesApiUrl("/folder"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: filesPath, name }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || `error ${res.status}`);
    loadFiles();
  } catch (err) {
    setFilesStatus(`Couldn't create folder: ${err.message}`, true);
  }
}

async function uploadFile(file) {
  setFilesStatus(`Uploading ${file.name}…`);
  const form = new FormData();
  form.append("file", file);
  form.append("path", filesPath);
  try {
    const res = await fetch(filesApiUrl("/upload"), { method: "POST", body: form });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || `error ${res.status}`);
    loadFiles();
  } catch (err) {
    setFilesStatus(`Upload failed: ${err.message}`, true);
  }
}

filesRefreshBtn.addEventListener("click", loadFiles);
filesNewFolderBtn.addEventListener("click", createFolder);
filesUploadBtn.addEventListener("click", () => filesUploadInput.click());
filesUploadInput.addEventListener("change", () => {
  const file = filesUploadInput.files[0];
  filesUploadInput.value = "";  // so picking the same file again still fires "change"
  if (file) uploadFile(file);
});

wirePrinterEditor(card, printerId);
card.querySelector(".cam-status").addEventListener("click", (event) => {
  if (event.currentTarget.dataset.state === "error") startCamera(card, printerId);
});
// The preview fills the frame; click it to see the whole thing fullscreen —
// same as the dashboard card (that wiring lives in app.js per-card, so this
// page needs its own copy).
const cameraVideo = card.querySelector(".cam-frame");
cameraVideo.addEventListener("click", () => {
  if (cameraVideo.srcObject && document.fullscreenEnabled) cameraVideo.requestFullscreen();
});

// --- live connection ---------------------------------------------------------
// Same pattern as the dashboard: a live WS channel for this one printer,
// falling back to polling its status endpoint if the socket drops.

let pollTimer = null;

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${proto}://${location.host}/ws`);

  socket.addEventListener("open", () => {
    setConn("open", "Connected to server");
    stopPolling();
  });

  socket.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === "snapshot") {
      const found = msg.printers.find((p) => p.id === printerId);
      if (found) render(found);
      else showNotFound();
    } else if (msg.type === "update" && msg.printer.id === printerId) {
      render(msg.printer);
    }
  });

  socket.addEventListener("close", () => {
    setConn("closed", "Reconnecting to server…");
    startPolling();
    setTimeout(connect, 3000);
  });

  socket.addEventListener("error", () => socket.close());
}

function startPolling() {
  if (pollTimer) return;
  const tick = async () => {
    try {
      const res = await fetch(`/api/printers/${encodeURIComponent(printerId)}/status`);
      if (res.status === 401) return void (location.href = "/login");
      if (res.status === 404) return showNotFound();
      render(await res.json());
    } catch { /* still offline; the next tick will try again */ }
  };
  tick();
  pollTimer = setInterval(tick, 5000);
}

function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
}

function setConn(state, label) {
  connLabel.dataset.state = state;
  connLabel.textContent = label;
}

connect();
