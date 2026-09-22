// Detail page for one printer (/printer/<id>). shared.js loads first.

const printerId = decodeURIComponent(location.pathname.split("/").pop());

const connLabel = document.getElementById("conn");
const card = document.getElementById("detail-card");
const notFound = document.getElementById("not-found");

let cameraStarted = false;

function render(status) {
  card.hidden = false;
  notFound.hidden = true;
  document.title = `${status.name} - PrintDeck`;

  card.dataset.host = status.host || "";
  card.dataset.port = String(status.moonraker_port || 7125);
  card.dataset.hasApiKey = String(Boolean(status.has_api_key));
  card.dataset.tls = String(Boolean(status.tls));
  card.dataset.crealityLight = String(Boolean(status.creality_light));
  card.dataset.cameraUrl = status.camera_url || "";
  card.dataset.group = status.group || "";
  const state = displayState(status);  // "complete" reads as idle once dismissed here
  card.dataset.state = state;
  card.style.setProperty("--state", STATE_COLOR[state] || STATE_COLOR.offline);

  card.querySelector(".name").textContent = status.name;
  card.querySelector(".badge").textContent = state;

  card.querySelector(".nozzle").innerHTML = temp(status.extruder_temp, status.extruder_target);
  card.querySelector(".bed").innerHTML = temp(status.bed_temp, status.bed_target);

  const shownHost = status.host ? (status.host.includes(":") ? `[${status.host}]` : status.host) : "-";
  const moonrakerUrl = status.host
    ? `${status.tls ? "https" : "http"}://${shownHost}:${status.moonraker_port || 7125}${status.has_api_key ? "  (API key set)" : ""}`
    : "-";
  card.querySelector(".printer-info-host").textContent = moonrakerUrl;
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
  renderHistoryVisibility(status);
}

const jobThumb = document.querySelector(".job-thumb");
const jobFilamentStat = document.querySelector(".job-stat-filament");
const jobFilamentValue = document.querySelector(".job-filament");
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

// --- filament formatting -------------------------------------------------------
// Moonraker reports length. Grams come from the slicer's weight/length ratio
// when the file's metadata has one; otherwise it's an estimate for 1.75 mm
// PLA (1.24 g/cm³ ≈ 2.98 g/m), marked as such.

const GRAMS_PER_METRE_PLA_175 = 2.98;

function filamentGrams(mm, meta) {
  if (meta?.filament_weight_total && meta?.filament_total) {
    return { grams: (mm / meta.filament_total) * meta.filament_weight_total, estimated: false };
  }
  return { grams: (mm / 1000) * GRAMS_PER_METRE_PLA_175, estimated: true };
}

function filamentText(mm, meta, { totalMm, totalGrams } = {}) {
  const metres = (mm / 1000).toFixed(2);
  const { grams, estimated } = filamentGrams(mm, meta);
  const g = grams >= 100 ? Math.round(grams) : grams.toFixed(1);
  const length = totalMm ? `${metres}/${(totalMm / 1000).toFixed(2)} m` : `${metres} m`;
  const weight = totalGrams ? `${g}/${totalGrams.toFixed(1)} g` : `${estimated ? "~" : ""}${g} g`;
  return `${length} · ${weight}`;
}

// --- "Show N" dropdowns --------------------------------------------------------
// Per-section row cap, remembered per browser. "all" -> Infinity.

function wirePageSize(select, storageKey, onChange) {
  let value = 10;
  try {
    const stored = localStorage.getItem(storageKey);
    if (stored && [...select.options].some((o) => o.value === stored)) select.value = stored;
  } catch { /* no storage */ }
  const read = () => (select.value === "all" ? Infinity : Number(select.value));
  value = read();
  select.addEventListener("change", () => {
    value = read();
    try { localStorage.setItem(storageKey, select.value); } catch { /* no storage */ }
    onChange(value);
  });
  return () => value;
}

function thumbnailUrl(path) {
  return `/api/printers/${encodeURIComponent(printerId)}/files/thumbnail?filename=${encodeURIComponent(path)}`;
}

// A small preview that only appears once it has actually loaded; `fallback`
// (an icon) stays until then, and for files with no thumbnail.
function wireThumb(img, fallback, path) {
  img.loading = "lazy";
  img.addEventListener("load", () => { img.hidden = false; if (fallback) fallback.hidden = true; });
  img.addEventListener("error", () => { img.hidden = true; });
  img.src = thumbnailUrl(path);
}

function renderJob(status) {
  const job = card.querySelector(".job");
  const state = displayState(status);
  const active = state === "printing" || state === "paused" || state === "complete";
  job.hidden = !active;
  if (!active) {
    jobFilename = null;
    return;
  }

  // Moonraker may still report <100% after completion.
  const progress = state === "complete" ? 1 : (status.progress || 0);
  card.querySelector(".progress-bar").style.width = `${Math.round(progress * 100)}%`;
  card.querySelector(".filename").textContent = status.filename || "-";
  renderJobDetails(status);
  renderJobControls(card, status);

  // Once per filename, not per tick.
  if (status.filename && status.filename !== jobFilename) {
    jobFilename = status.filename;
    loadPrintInfo(status.filename);
  }
}

function renderJobDetails(status) {
  // Slicer estimate beats elapsed/progress, which is wild at 1%.
  let etaSeconds = status.eta_seconds;
  if (printInfo?.estimated_time) {
    const remaining = printInfo.estimated_time - (status.print_duration || 0);
    if (remaining > 0) etaSeconds = remaining;
  }
  card.querySelector(".eta").textContent = eta(etaSeconds);

  // used/total in metres and grams. No live weight from Moonraker; grams
  // are scaled from the slicer's ratio (see filamentGrams).
  const usedMm = status.filament_used || 0;
  if (usedMm > 0) {
    jobFilamentValue.textContent = filamentText(usedMm, printInfo, {
      totalMm: printInfo?.filament_total,
      totalGrams: printInfo?.filament_weight_total,
    });
    jobFilamentStat.hidden = false;
  } else {
    jobFilamentStat.hidden = true;
  }

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
  jobThumb.src = thumbnailUrl(filename);

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

// No toggle here; the camera is the point of this page.
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
  filesSection.hidden = true;
  historySection.hidden = true;
  notFound.hidden = false;
  document.title = "PrintDeck";
}

// --- graphs ----------------------------------------------------------------
// In-memory since page open; no backend storage. They live inside
// .controls-section so visibility is handled there.

const GRAPH_WINDOW_MS = 10 * 60 * 1000; // last 10 minutes
const tempGraphSvg = document.querySelector(".temp-graph");
const fanGraphSvg = document.querySelector(".fan-graph");
const tempYMax = document.querySelector(".temp-y-max");
const tempYMid = document.querySelector(".temp-y-mid");
const graphXStarts = document.querySelectorAll(".graph-x-start");
const graphXMids = document.querySelectorAll(".graph-x-mid");

const FAN_COLORS = ["var(--printing)", "var(--accent)", "var(--paused)", "var(--idle)", "var(--error)"];
const fanColor = (i) => FAN_COLORS[i % FAN_COLORS.length];

let history = [];     // temps: { t, extruder, extruderTarget, bed, bedTarget }
let fanHistory = [];  // fans: { t, values: { [fanId]: speed } }

// Moonraker pushes ~4 updates/s while printing; redrawing four 2000-point
// paths each time is waste. Samples are recorded every tick, drawn at ~1 Hz.
const GRAPH_REDRAW_MS = 1000;
let graphRedrawTimer = null;
let graphRedrawPending = null;  // the status to draw from when the timer fires

function scheduleGraphRedraw(status) {
  graphRedrawPending = status;
  if (graphRedrawTimer) return;
  graphRedrawTimer = setTimeout(() => {
    graphRedrawTimer = null;
    const pending = graphRedrawPending;
    graphRedrawPending = null;
    if (pending) drawGraphs(pending);
  }, GRAPH_REDRAW_MS);
}

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
  scheduleGraphRedraw(status);
}

function drawGraphs(status) {
  // Offline zeroes everything; keep the last real legend values.
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

  // Axis labels grow with the data until they reach -10m/-5m.
  const spanMin = Math.max(1, Math.round((history[history.length - 1].t - history[0].t) / 60000));
  for (const el of graphXStarts) el.textContent = `−${spanMin}m`;
  for (const el of graphXMids) el.textContent = `−${Math.round(spanMin / 2)}m`;
}

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
  // stroke= attribute, not style=, because CSP blocks inline styles.
  const strokeAttr = stroke ? ` stroke="${stroke}"` : "";
  return `<path class="${cls}"${strokeAttr} d="${d}"/>`;
}

// --- controls ----------------------------------------------------------------
// Everything here builds a G-code string and POSTs it to the relay.

const controlsSection = document.querySelector(".controls-section");
const controlsStatus = document.querySelector(".controls-status");
const extruderTargetInput = document.querySelector(".extruder-target-input");
const bedTargetInput = document.querySelector(".bed-target-input");
const fanRowsContainer = document.querySelector(".fan-rows");
const fanRowTemplate = document.getElementById("fan-row-template");
const fanLegend = document.querySelector(".fan-legend");
const lightBlock = document.querySelector(".light-block");
const lightRowsContainer = document.querySelector(".light-rows");
const lightRowTemplate = document.getElementById("light-row-template");
const posX = document.querySelector(".pos-x");
const posY = document.querySelector(".pos-y");
const posZ = document.querySelector(".pos-z");
const moveDisabledNote = document.querySelector(".move-disabled-note");
const jogButtons = document.querySelectorAll(".jog-btn");
const jogHomeBtn = document.querySelector(".jog-home");
const stepButtons = document.querySelectorAll(".step-btn");

let jogStep = 1;
let jogBusy = false;    // a jog/home request is in flight
let lastStatus = null;  // most recent status; jogging needs the current position
let fanIds = [];        // built once, the first time a fan list arrives
let lightIds = [];      // same for lights

function setControlsStatus(text, isError = false) {
  controlsStatus.textContent = text;
  controlsStatus.hidden = !text;
  controlsStatus.classList.toggle("controls-error", isError);
}

async function sendGcode(script) {
  try {
    await api(`/api/printers/${encodeURIComponent(printerId)}/gcode`, { method: "POST", json: { script } });
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
  // Idle only, per-axis once homed, and not while a move is in flight
  // (the next target is computed from the current position).
  const canMove = ["idle", "complete", "error"].includes(lastStatus.state) && !jogBusy;
  const homed = new Set((lastStatus.homed_axes || "").split(""));
  for (const btn of jogButtons) {
    btn.disabled = !canMove || !homed.has(btn.dataset.axis.toLowerCase());
  }
  jogHomeBtn.disabled = !canMove;
}

// Say why the jog buttons are disabled.
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

// Fan list doesn't change at runtime, so this builds once.
function buildFanRows(fans) {
  if (fanIds.length || fans.length === 0) return;
  fanIds = fans.map((f) => f.id);
  fanRowsContainer.innerHTML = "";
  fanLegend.innerHTML = "";
  // .legend-item is flex (block-level) and needs a row wrapper or they stack.
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

    // Fan name comes from the printer, so no innerHTML. Colour via CSSOM (CSP).
    const legendItem = document.createElement("span");
    legendItem.className = "legend-item";
    legendItem.dataset.fanId = fan.id;
    const swatch = document.createElement("span");
    swatch.className = "legend-swatch";
    swatch.style.background = fanColor(i);
    const value = document.createElement("b");
    value.className = "legend-value";
    legendItem.append(swatch, `${fan.name} `, value);
    legendRow.append(legendItem);
  });
}

// [fan] is M106/M107; [fan_generic X] is SET_FAN_SPEED.
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

// Fallbacks if the printer didn't report max_temp. Klipper enforces the real one.
const DEFAULT_EXTRUDER_MAX = 300;
const DEFAULT_BED_MAX = 130;

function extruderMax() { return lastStatus?.extruder_max_temp || DEFAULT_EXTRUDER_MAX; }
function bedMax() { return lastStatus?.bed_max_temp || DEFAULT_BED_MAX; }

// --- lights --------------------------------------------------------------------
// output_pin: SET_PIN VALUE is 0..scale (1 unless printer.cfg says otherwise).
// LED strips: SET_LED with every channel at the same level = white at that
// brightness. An unconfigured strip left at a colour keeps it until "Off".

function lightScript(light, level) {
  if (light.kind === "pin") return `SET_PIN PIN=${light.id.slice("output_pin ".length)} VALUE=${(level * light.scale).toFixed(3)}`;
  const name = light.id.split(" ", 2)[1];
  const v = level.toFixed(3);
  return `SET_LED LED=${name} RED=${v} GREEN=${v} BLUE=${v}${light.white ? ` WHITE=${v}` : ""}`;
}

async function setCrealityLight(on) {
  try {
    await api(`/api/printers/${encodeURIComponent(printerId)}/creality/light`, { method: "POST", json: { on } });
    setControlsStatus("");
  } catch (err) {
    setControlsStatus(err.message, true);
  }
}

function buildLightRows(lights) {
  const ids = lights.map((l) => l.id);
  if (ids.join("|") === lightIds.join("|")) return;
  lightIds = ids;
  lightRowsContainer.innerHTML = "";
  for (const light of lights) {
    const row = lightRowTemplate.content.firstElementChild.cloneNode(true);
    row.dataset.lightId = light.id;
    row.querySelector(".control-label").textContent = light.name;
    const slider = row.querySelector(".light-level");
    const value = row.querySelector(".light-value");
    if (light.dimmable) {
      slider.hidden = false;
      slider.addEventListener("change", () => sendGcode(lightScript(light, Number(slider.value) / 100)));
      slider.addEventListener("input", () => { value.textContent = `${slider.value}%`; });
    } else {
      value.hidden = true;
      row.classList.add("light-row-switch");
    }
    // Creality's light isn't G-code; it has its own endpoint.
    const turn = light.kind === "creality"
      ? (on) => setCrealityLight(on)
      : (on) => sendGcode(lightScript(light, on ? 1 : 0));
    row.querySelector(".light-on-btn").addEventListener("click", () => turn(true));
    row.querySelector(".light-off-btn").addEventListener("click", () => turn(false));
    lightRowsContainer.append(row);
  }
}

function renderLights(lights) {
  lightBlock.hidden = lights.length === 0;
  buildLightRows(lights);
  for (const light of lights) {
    const row = lightRowsContainer.querySelector(`[data-light-id="${CSS.escape(light.id)}"]`);
    if (!row) continue;
    const pct = Math.round(light.value * 100);
    const slider = row.querySelector(".light-level");
    if (light.dimmable && document.activeElement !== slider) {
      slider.value = String(pct);
      row.querySelector(".light-value").textContent = `${pct}%`;
    }
    row.querySelector(".light-on-btn").classList.toggle("active", light.value > 0);
  }
}

function renderControls(status) {
  lastStatus = status;
  controlsSection.hidden = !status.online;
  if (!status.online) return;

  extruderTargetInput.max = String(extruderMax());
  bedTargetInput.max = String(bedMax());

  updateJogEnabled();
  updateMoveNote(status);
  posX.textContent = status.x.toFixed(1);
  posY.textContent = status.y.toFixed(1);
  posZ.textContent = status.z.toFixed(1);

  // Don't overwrite a field the user is typing in.
  if (document.activeElement !== extruderTargetInput) {
    extruderTargetInput.value = Math.round(status.extruder_target);
  }
  if (document.activeElement !== bedTargetInput) {
    bedTargetInput.value = Math.round(status.bed_target);
  }

  renderLights(status.lights || []);

  buildFanRows(status.fans);
  for (const fan of status.fans) {
    const input = fanRowsContainer.querySelector(`[data-fan-id="${CSS.escape(fan.id)}"]`);
    if (input && document.activeElement !== input) input.value = Math.round(fan.speed * 100);
  }
}

document.querySelector(".extruder-set-btn").addEventListener("click", () => {
  const v = Number(extruderTargetInput.value);
  if (!Number.isFinite(v) || v < 0 || v > extruderMax()) return setControlsStatus(`Enter a nozzle temp between 0 and ${extruderMax()}.`, true);
  sendGcode(`M104 S${v}`);
});
document.querySelector(".extruder-off-btn").addEventListener("click", () => {
  extruderTargetInput.value = "0";
  sendGcode("M104 S0");
});
document.querySelector(".bed-set-btn").addEventListener("click", () => {
  const v = Number(bedTargetInput.value);
  if (!Number.isFinite(v) || v < 0 || v > bedMax()) return setControlsStatus(`Enter a bed temp between 0 and ${bedMax()}.`, true);
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
    // Absolute, not G91: a rejected relative move leaves the printer stuck
    // in relative mode for whatever comes next.
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

// --- files ---------------------------------------------------------------
// Fetched on demand, not over the live feed. Root is always "gcodes".

const filesSection = document.querySelector(".files-section");
const filesRefreshBtn = document.querySelector(".files-refresh");
const filesNewFolderBtn = document.querySelector(".files-new-folder");
const filesUploadBtn = document.querySelector(".files-upload");
const filesUploadInput = document.querySelector(".files-upload-input");
const filesSearchInput = document.querySelector(".files-search");
const filesBreadcrumb = document.querySelector(".files-breadcrumb");
const filesList = document.querySelector(".files-list");
const filesLoadMoreBtn = document.querySelector(".files-load-more");
const filesCountEl = document.querySelector(".files-count");
const filesStatus = document.querySelector(".files-status");
const filesSelectAll = document.querySelector(".files-select-all");
const filesSortBtns = document.querySelectorAll(".files-sort-btn");
const filesBulkBar = document.querySelector(".files-bulk-bar");
const filesBulkCount = document.querySelector(".files-bulk-count");
const filesBulkDeleteBtn = document.querySelector(".files-bulk-delete");

const filesPageSizeSelect = document.querySelector(".files-page-size");
const filesPageSize = wirePageSize(filesPageSizeSelect, "printdeck-page-size-files", (n) => {
  visibleCount = n;
  renderEntries();
});

let filesPath = "";
let filesReady = false;  // have we done the first load since coming online?
let filesRequestId = 0;  // bumped on every loadFiles(); see fetchFiles()
let allEntries = [];     // everything in the current folder, dirs then files
let visibleCount = filesPageSize();
let sortField = "name";
let sortDir = 1;         // 1 ascending, -1 descending
let selected = new Set(); // paths selected for bulk delete, within this folder

// Load once per online period, not per tick.
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
  updatePrintButtons();
}

// Print buttons go inert rather than disappearing, so the list doesn't reflow.
function canStartPrint() {
  return Boolean(lastStatus?.online) && ["idle", "complete"].includes(lastStatus.state);
}

function updatePrintButtons() {
  const enabled = canStartPrint();
  for (const btn of filesList.querySelectorAll(".file-print")) {
    btn.disabled = !enabled;
    btn.title = enabled ? "Print this file" : "The printer is busy";
  }
}

const PRINTABLE = /\.(gcode|gco|g|ufp)$/i;

async function startPrint(path, name) {
  const ok = await confirmDialog({
    title: "Start print",
    message: `Start printing "${name}"? Make sure the bed is clear first.`,
    confirmLabel: "Start print",
  });
  if (!ok) return;
  setFilesStatus(`Starting ${name}…`);
  try {
    await api(`/api/printers/${encodeURIComponent(printerId)}/job/start`, { method: "POST", json: { filename: path } });
    setFilesStatus(`Print started: ${name}`);
  } catch (err) {
    setFilesStatus(`Couldn't start print: ${err.message}`, true);
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

// Blur first: removing a focused element mid-swap jumps the page to the top.
function loadFiles() {
  document.activeElement?.blur();
  filesSearchInput.value = "";
  selected.clear();
  updateBulkBar();
  setFilesStatus("Loading…");
  filesList.innerHTML = "";
  filesLoadMoreBtn.hidden = true;
  filesCountEl.hidden = true;
  fetchFiles(++filesRequestId);
}

async function fetchFiles(requestId) {
  try {
    const params = new URLSearchParams({ path: filesPath });
    const res = await fetch(filesApiUrl(`?${params}`));
    if (!res.ok) throw new Error(`error ${res.status}`);
    const dir = await res.json();
    // A slow response for a folder we've left must not clobber the current one.
    if (requestId !== filesRequestId) return;
    renderBreadcrumb();
    allEntries = [
      ...(dir.dirs || []).map((d) => ({ name: d.dirname, size: null, modified: d.modified || 0, isDir: true })),
      ...(dir.files || []).map((f) => ({ name: f.filename, size: f.size, modified: f.modified || 0, isDir: false })),
    ];
    visibleCount = filesPageSize();
    renderEntries();
    setFilesStatus("");
  } catch {
    if (requestId !== filesRequestId) return;
    allEntries = [];
    filesList.innerHTML = "";
    setFilesStatus("Couldn't load files from the printer.", true);
  }
}

// Folders first, then files, each sorted by the chosen field.
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

// Filter/sort/paginate client-side; no extra requests.
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
  const shownCount = Math.min(visibleCount, matches.length);
  const noun = filesSearchInput.value.trim() ? "match" : "item";
  filesCountEl.textContent = `Showing ${shownCount} of ${matches.length} ${noun}${matches.length === 1 ? "" : "s"}`;
  filesCountEl.hidden = matches.length === 0;
  updateSelectAllState(matches);
}

filesSearchInput.addEventListener("input", () => {
  visibleCount = filesPageSize();
  renderEntries();
});
filesLoadMoreBtn.addEventListener("click", () => {
  visibleCount += filesPageSize();
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
  if (failed) setFilesStatus(`${paths.length - failed} of ${paths.length} deleted, ${failed} failed.`, true);
  filesBulkDeleteBtn.disabled = false;
}

filesBulkDeleteBtn.addEventListener("click", deleteSelected);

function fileRow(entry) {
  const { name, size, modified, isDir } = entry;
  const path = entryPathFor(name);
  const li = document.createElement("li");
  li.className = isDir ? "file-entry file-entry-dir" : "file-entry";
  // .files-manage cells hide without manage_files (style.css).
  li.innerHTML = `
    <span class="files-col-check files-manage">
      <input type="checkbox" class="file-checkbox" aria-label="Select ${isDir ? "folder" : "file"}">
    </span>
    <span class="file-name-cell">
      <span class="file-icon">${isDir ? "📁" : "📄"}</span>
      ${!isDir && PRINTABLE.test(name) ? '<img class="file-thumb" alt="" hidden>' : ""}
      <span class="file-name"></span>
    </span>
    <span class="file-meta">${isDir ? "" : fileSize(size)}</span>
    <span class="file-modified">${modified ? formatModified(modified) : ""}</span>
    <span class="file-actions">
      ${!isDir && PRINTABLE.test(name) ? '<button type="button" class="file-print job-control" title="Print this file" aria-label="Print">▶</button>' : ""}
      <button type="button" class="file-rename files-manage" title="Rename" aria-label="Rename">✎</button>
      <button type="button" class="file-delete files-manage" title="Delete" aria-label="Delete">🗑</button>
    </span>
  `;
  li.querySelector(".file-name").textContent = name;
  const thumb = li.querySelector(".file-thumb");
  if (thumb) wireThumb(thumb, li.querySelector(".file-icon"), path);
  const printBtn = li.querySelector(".file-print");
  if (printBtn) {
    printBtn.disabled = !canStartPrint();
    printBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      startPrint(path, name);
    });
  }

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
    await api(filesApiUrl("/rename"), { method: "POST", json: { path, new_name: newName } });
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
    await api(filesApiUrl(`?${params}`), { method: "DELETE" });
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
    await api(filesApiUrl("/folder"), { method: "POST", json: { path: filesPath, name } });
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
    await api(filesApiUrl("/upload"), { method: "POST", body: form });
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
wireJobControls(card, printerId, { onDismiss: () => { if (lastStatus) render(lastStatus); } });
card.querySelector(".cam-status").addEventListener("click", (event) => {
  if (event.currentTarget.dataset.state === "error") startCamera(card, printerId);
});
const cameraVideo = card.querySelector(".cam-frame");
cameraVideo.addEventListener("click", () => {
  if (cameraVideo.srcObject && document.fullscreenEnabled) cameraVideo.requestFullscreen();
});

// --- live connection ---------------------------------------------------------

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
    } else if (msg.type === "removed" && msg.id === printerId) {
      // Deleted elsewhere.
      stopCamera(card);
      showNotFound();
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

// --- history -----------------------------------------------------------------
// Loaded when the printer comes online, when a print ends, and on refresh.
// Pages come from Moonraker; search/filter run over what's loaded, and pull
// the rest in (up to a cap) so a search isn't silently partial.

const historySection = document.querySelector(".history-section");
const historyList = document.querySelector(".history-list");
const lifetimeStats = document.querySelector(".lifetime-stats");
const historyStatus = document.querySelector(".history-status");
const historyRefreshBtn = document.querySelector(".history-refresh");
const historyLoadMoreBtn = document.querySelector(".history-load-more");
const historyCountEl = document.querySelector(".history-count");
const historySearchInput = document.querySelector(".history-search");
const historyFilterSelect = document.querySelector(".history-filter");
const historyClearBtn = document.querySelector(".history-clear");
const historySelectAll = document.querySelector(".history-select-all");
const historyBulkBar = document.querySelector(".history-bulk-bar");
const historyBulkCount = document.querySelector(".history-bulk-count");
const historyBulkDeleteBtn = document.querySelector(".history-bulk-delete");

const HISTORY_FETCH_SIZE = 50;   // rows per request to Moonraker (backend caps at 100)
const HISTORY_FETCH_CAP = 1000;  // most a search or "Show all" will pull in
const historyPageSizeSelect = document.querySelector(".history-page-size");
const historyPageSize = wirePageSize(historyPageSizeSelect, "printdeck-page-size-history", (n) => {
  historyVisible = n;
  renderHistoryRows();
  ensureHistoryLoaded(historyRequestId);
});

let historyReady = false;   // loaded since the printer last came online?
let historyLoading = false; // first page in flight; suppresses the "nothing yet" row
let historyCount = 0;       // total jobs Moonraker has, from the last response
let historyJobs = [];       // everything loaded so far, newest first
let historyRequestId = 0;
let lastJobState = null;    // to notice a print ending, which changes the list
let historySelected = new Set();  // job_ids ticked for bulk delete
let historyVisible = historyPageSize();  // rows to show; grows with Load more

// Moonraker's statuses (completed, cancelled, error, klippy_shutdown,
// klippy_disconnect, interrupted, server_exit, in_progress) collapse to three
// buckets. Firmware isn't consistent about the rest (Creality's K1 logs a
// screen cancel as "error"), so the distinctions aren't worth showing.
function historyBucket(status) {
  if (status === "completed") return "completed";
  if (status === "in_progress") return "in_progress";
  return "not_completed";
}

const HISTORY_BUCKETS = {
  completed: ["Completed", "var(--printing)"],
  not_completed: ["Not completed", "var(--paused)"],
  in_progress: ["In progress", "var(--accent)"],
};

function renderHistoryVisibility(status) {
  if (!status.online) {
    historySection.hidden = true;
    lifetimeStats.hidden = true;
    historyReady = false;
    lastJobState = null;
    return;
  }
  historySection.hidden = false;
  const wasActive = lastJobState === "printing" || lastJobState === "paused";
  const isActive = status.state === "printing" || status.state === "paused";
  lastJobState = status.state;
  if (!historyReady) {
    historyReady = true;
    loadHistoryTotals();  // one small request; don't make it wait behind the first page of rows
    loadHistory();
  } else if (wasActive && !isActive) {
    loadHistoryTotals();
    loadHistory();
  }
}

function setHistoryStatus(text, isError = false) {
  historyStatus.textContent = text;
  historyStatus.hidden = !text;
  historyStatus.classList.toggle("files-error", isError);
}

function historyApiUrl(suffix = "") {
  return `/api/printers/${encodeURIComponent(printerId)}/history${suffix}`;
}

async function loadHistory() {
  const requestId = ++historyRequestId;
  historyJobs = [];
  historyCount = 0;
  historySelected.clear();
  updateHistoryBulkBar();
  historyVisible = historyPageSize();
  historyLoading = true;
  renderHistoryRows();
  setHistoryStatus("Loading…");
  await fetchHistoryPage(requestId);
  if (requestId !== historyRequestId) return;
  historyLoading = false;
  renderHistoryRows();
  ensureHistoryLoaded(requestId);
}

// Fetch pages until there are enough rows to fill the visible window (or
// everything, for "Show all"), within the cap.
async function ensureHistoryLoaded(requestId) {
  while (
    requestId === historyRequestId
    && historyJobs.length < historyCount
    && historyJobs.length < HISTORY_FETCH_CAP
    && historyJobs.filter(historyMatches).length < historyVisible
  ) {
    if (historyVisible === Infinity) setHistoryStatus(`Loading all ${historyCount} prints…`);
    if (!(await fetchHistoryPage(requestId))) return;
  }
}

async function fetchHistoryPage(requestId) {
  try {
    const params = new URLSearchParams({ limit: HISTORY_FETCH_SIZE, start: historyJobs.length });
    const data = await (await api(historyApiUrl(`?${params}`))).json();
    if (requestId !== historyRequestId) return false;
    historyCount = data.count || 0;
    historyJobs.push(...(data.jobs || []));
    renderHistoryRows();
    setHistoryStatus("");
    return true;
  } catch (err) {
    if (requestId !== historyRequestId) return false;
    // Usually: [history] isn't enabled in moonraker.conf.
    setHistoryStatus(`Couldn't load history: ${err.message}`, true);
    return false;
  }
}

// A filter over a partial list would hide matches that just aren't loaded yet.
async function ensureAllLoadedForFilter() {
  if (!historyFilterActive()) return;
  const requestId = historyRequestId;
  while (historyJobs.length < historyCount && historyJobs.length < HISTORY_FETCH_CAP) {
    setHistoryStatus(`Loading all ${historyCount} prints to search…`);
    if (!(await fetchHistoryPage(requestId))) return;
  }
}

function historyFilterActive() {
  return historySearchInput.value.trim() !== "" || historyFilterSelect.value !== "all";
}

function historyMatches(job) {
  const query = historySearchInput.value.trim().toLowerCase();
  if (query && !(job.filename || "").toLowerCase().includes(query)) return false;
  const want = historyFilterSelect.value;
  return want === "all" || historyBucket(job.status) === want;
}

function renderHistoryRows() {
  const matches = historyJobs.filter(historyMatches);
  const shown = matches.slice(0, historyVisible);
  historyList.replaceChildren(...shown.map(historyRow));
  if (shown.length === 0 && !historyLoading) {
    const li = document.createElement("li");
    li.className = "file-empty";
    li.textContent = historyJobs.length === 0 ? "No prints recorded yet." : "No matches.";
    historyList.append(li);
  }
  // More to show if rows are held back client-side, or Moonraker has more pages.
  const filtered = historyFilterActive();
  const total = filtered ? matches.length : historyCount;
  const moreOnServer = historyJobs.length < historyCount && !filtered;
  historyLoadMoreBtn.hidden = !(shown.length < matches.length || moreOnServer);
  const noun = filtered ? "match" : "print";
  historyCountEl.textContent = `Showing ${shown.length} of ${total} ${noun}${total === 1 ? "" : "s"}`;
  historyCountEl.hidden = historyLoading || total === 0;
  updateHistorySelectAll(shown);
}

function updateHistorySelectAll(shown) {
  const picked = shown.filter((j) => historySelected.has(j.job_id)).length;
  historySelectAll.checked = shown.length > 0 && picked === shown.length;
  historySelectAll.indeterminate = picked > 0 && picked < shown.length;
}

function updateHistoryBulkBar() {
  historyBulkBar.hidden = historySelected.size === 0;
  historyBulkCount.textContent = `${historySelected.size} selected`;
}

historySelectAll.addEventListener("change", () => {
  for (const job of historyJobs.filter(historyMatches).slice(0, historyVisible)) {
    if (historySelectAll.checked) historySelected.add(job.job_id);
    else historySelected.delete(job.job_id);
  }
  renderHistoryRows();
  updateHistoryBulkBar();
});

async function deleteSelectedHistory() {
  const ids = [...historySelected];
  if (ids.length === 0) return;
  const ok = await confirmDialog({
    title: "Delete from history",
    message: `Remove ${ids.length} entr${ids.length === 1 ? "y" : "ies"} from the printer's history? Files aren't touched.`,
    confirmLabel: "Delete",
    danger: true,
  });
  if (!ok) return;
  historyBulkDeleteBtn.disabled = true;
  setHistoryStatus(`Deleting ${ids.length}…`);
  let failed = 0;
  for (const id of ids) {
    try {
      await api(historyApiUrl(`/${encodeURIComponent(id)}`), { method: "DELETE" });
      historyJobs = historyJobs.filter((j) => j.job_id !== id);
      historyCount = Math.max(0, historyCount - 1);
    } catch {
      failed++;
    }
  }
  historySelected.clear();
  updateHistoryBulkBar();
  renderHistoryRows();
  loadHistoryTotals();
  setHistoryStatus(failed ? `${ids.length - failed} of ${ids.length} deleted, ${failed} failed.` : "", Boolean(failed));
  historyBulkDeleteBtn.disabled = false;
}

historyBulkDeleteBtn.addEventListener("click", deleteSelectedHistory);

// Lifetime counters Moonraker keeps in its own database. They cover every
// print ever recorded and don't shrink when history rows are deleted, which
// is why they sit under the status line rather than in the History header.
async function loadHistoryTotals() {
  try {
    const res = await fetch(historyApiUrl("/totals"));
    if (!res.ok) throw new Error();
    const t = (await res.json()).job_totals || {};
    lifetimeStats.querySelector(".lifetime-prints").textContent = String(t.total_jobs || 0);
    lifetimeStats.querySelector(".lifetime-time").textContent = t.total_print_time ? duration(t.total_print_time) : "0s";
    lifetimeStats.querySelector(".lifetime-filament").textContent = t.total_filament_used ? filamentText(t.total_filament_used, null) : "0 m";
    const longest = lifetimeStats.querySelector(".lifetime-longest-item");
    longest.hidden = !t.longest_print;
    if (t.longest_print) lifetimeStats.querySelector(".lifetime-longest").textContent = duration(t.longest_print);
    lifetimeStats.hidden = false;
  } catch {
    lifetimeStats.hidden = true;  // no [history] component, or the printer's away
  }
}

// How far an unfinished print got, from filament (best) or elapsed time.
function historyProgress(job) {
  const meta = job.metadata || {};
  let fraction = null;
  if (meta.filament_total && job.filament_used) fraction = job.filament_used / meta.filament_total;
  else if (meta.estimated_time && job.print_duration) fraction = job.print_duration / meta.estimated_time;
  if (fraction == null) return "";
  return `stopped at about ${Math.min(99, Math.max(1, Math.round(fraction * 100)))}%`;
}

function historyDetail(job) {
  return historyBucket(job.status) === "not_completed" ? historyProgress(job) : "";
}

function historyRow(job) {
  const [label, color] = HISTORY_BUCKETS[historyBucket(job.status)];
  const li = document.createElement("li");
  li.className = "file-entry history-entry";
  li.innerHTML = `
    <span class="files-col-check files-manage">
      <input type="checkbox" class="history-checkbox" aria-label="Select entry">
    </span>
    <span class="file-name-cell">
      <span class="file-icon">📄</span>
      <img class="file-thumb" alt="" hidden>
      <span class="file-name"></span>
    </span>
    <span class="history-result">
      <span class="history-result-main"><span class="history-dot"></span><span class="history-label"></span></span>
      <span class="history-detail" hidden></span>
    </span>
    <span class="history-started"></span>
    <span class="history-finished"></span>
    <span class="history-duration"></span>
    <span class="history-filament"></span>
    <span class="file-actions files-manage">
      <button type="button" class="history-delete" title="Delete from history" aria-label="Delete from history">🗑</button>
    </span>
  `;
  li.querySelector(".file-name").textContent = job.filename || "-";
  // Only files still on the printer have a thumbnail to fetch.
  if (job.exists && job.filename) wireThumb(li.querySelector(".file-thumb"), li.querySelector(".file-icon"), job.filename);
  li.querySelector(".history-dot").style.background = color;
  li.querySelector(".history-label").textContent = label;
  const detail = li.querySelector(".history-detail");
  detail.textContent = historyDetail(job);
  detail.hidden = !detail.textContent;
  li.querySelector(".history-started").textContent = job.start_time ? formatWhen(job.start_time) : "";
  li.querySelector(".history-finished").textContent = job.end_time ? formatWhen(job.end_time) : "";
  li.querySelector(".history-duration").textContent = job.print_duration ? duration(job.print_duration) : "";
  li.querySelector(".history-filament").textContent = job.filament_used ? filamentText(job.filament_used, job.metadata) : "";
  li.querySelector(".history-delete").addEventListener("click", () => deleteHistoryJob(job));
  const checkbox = li.querySelector(".history-checkbox");
  checkbox.checked = historySelected.has(job.job_id);
  checkbox.addEventListener("change", () => {
    if (checkbox.checked) historySelected.add(job.job_id);
    else historySelected.delete(job.job_id);
    updateHistoryBulkBar();
    updateHistorySelectAll(historyJobs.filter(historyMatches).slice(0, historyVisible));
  });
  return li;
}

async function deleteHistoryJob(job) {
  const ok = await confirmDialog({
    title: "Delete from history",
    message: `Remove "${job.filename || job.job_id}" from the printer's history? The file itself isn't touched.`,
    confirmLabel: "Delete",
    danger: true,
  });
  if (!ok) return;
  try {
    await api(historyApiUrl(`/${encodeURIComponent(job.job_id)}`), { method: "DELETE" });
    historyJobs = historyJobs.filter((j) => j.job_id !== job.job_id);
    historyCount = Math.max(0, historyCount - 1);
    historySelected.delete(job.job_id);
    updateHistoryBulkBar();
    renderHistoryRows();
    loadHistoryTotals();
  } catch (err) {
    setHistoryStatus(`Couldn't delete: ${err.message}`, true);
  }
}

async function clearHistory() {
  const ok = await confirmDialog({
    title: "Clear history",
    message: `Delete all ${historyCount} history entries on this printer? This can't be undone. Files aren't touched.`,
    confirmLabel: "Clear history",
    danger: true,
  });
  if (!ok) return;
  try {
    await api(historyApiUrl(), { method: "DELETE" });
    loadHistory();
  } catch (err) {
    setHistoryStatus(`Couldn't clear history: ${err.message}`, true);
  }
}

function formatWhen(unixSeconds) {
  return new Date(unixSeconds * 1000).toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

function duration(seconds) {
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${total}s`;
}

historyRefreshBtn.addEventListener("click", loadHistory);
historyLoadMoreBtn.addEventListener("click", () => {
  historyVisible += historyPageSize();
  renderHistoryRows();
  ensureHistoryLoaded(historyRequestId);
});
historyClearBtn.addEventListener("click", clearHistory);
historySearchInput.addEventListener("input", () => { renderHistoryRows(); ensureAllLoadedForFilter(); });
historyFilterSelect.addEventListener("change", () => { renderHistoryRows(); ensureAllLoadedForFilter(); });
