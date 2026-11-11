// Temperature and fan graphs. In-memory since page open; no backend storage.
// They sit inside .controls-section, so controls.js handles visibility.

const GRAPH_WINDOW_MS = 10 * 60 * 1000;  // last 10 minutes
// Moonraker pushes ~4 updates/s while printing; redrawing four 2000-point
// paths each time is waste. Samples are recorded every tick, drawn at ~1 Hz.
const GRAPH_REDRAW_MS = 1000;

const tempGraphSvg = document.querySelector(".temp-graph");
const fanGraphSvg = document.querySelector(".fan-graph");
const tempYMax = document.querySelector(".temp-y-max");
const tempYMid = document.querySelector(".temp-y-mid");
const graphXStarts = document.querySelectorAll(".graph-x-start");
const graphXMids = document.querySelectorAll(".graph-x-mid");
const fanLegend = document.querySelector(".fan-legend");

const FAN_COLORS = ["var(--printing)", "var(--accent)", "var(--paused)", "var(--idle)", "var(--error)"];
const fanColor = (i) => FAN_COLORS[i % FAN_COLORS.length];

let tempHistory = [];  // { t, extruder, extruderTarget, bed, bedTarget }
let fanHistory = [];   // { t, values: { [fanId]: speed } }
let fanIds = [];       // legend order, fixed the first time a fan list arrives

let redrawTimer = null;
let redrawPending = null;  // the status to draw from when the timer fires

export function renderGraphs(status) {
  if (status.online) {
    buildFanLegend(status.fans);
    const now = Date.now();
    const cutoff = now - GRAPH_WINDOW_MS;
    tempHistory.push({
      t: now,
      extruder: status.extruder_temp,
      extruderTarget: status.extruder_target,
      bed: status.bed_temp,
      bedTarget: status.bed_target,
    });
    while (tempHistory.length && tempHistory[0].t < cutoff) tempHistory.shift();

    const values = {};
    for (const fan of status.fans) values[fan.id] = fan.speed;
    fanHistory.push({ t: now, values });
    while (fanHistory.length && fanHistory[0].t < cutoff) fanHistory.shift();
  }

  if (tempHistory.length < 2) return;
  scheduleRedraw(status);
}

function scheduleRedraw(status) {
  redrawPending = status;
  if (redrawTimer) return;
  redrawTimer = setTimeout(() => {
    redrawTimer = null;
    const pending = redrawPending;
    redrawPending = null;
    if (pending) draw(pending);
  }, GRAPH_REDRAW_MS);
}

// Fan list doesn't change at runtime, so this builds once.
function buildFanLegend(fans) {
  if (fanIds.length || fans.length === 0) return;
  fanIds = fans.map((f) => f.id);
  fanLegend.innerHTML = "";
  // .legend-item is flex (block-level) and needs a row wrapper or they stack.
  const legendRow = document.createElement("div");
  legendRow.className = "legend-row";
  fanLegend.append(legendRow);

  fans.forEach((fan, i) => {
    // Fan name comes from the printer, so no innerHTML. Colour via CSSOM (CSP).
    const item = document.createElement("span");
    item.className = "legend-item";
    item.dataset.fanId = fan.id;
    const swatch = document.createElement("span");
    swatch.className = "legend-swatch";
    swatch.style.background = fanColor(i);
    const value = document.createElement("b");
    value.className = "legend-value";
    item.append(swatch, `${fan.name} `, value);
    legendRow.append(item);
  });
}

function draw(status) {
  // Offline zeroes everything; keep the last real legend values.
  if (status.online) {
    document.querySelector(".extruder-value").textContent =
      `${status.extruder_temp.toFixed(0)}° → ${status.extruder_target.toFixed(0)}°`;
    document.querySelector(".bed-value").textContent =
      `${status.bed_temp.toFixed(0)}° → ${status.bed_target.toFixed(0)}°`;
    for (const fan of status.fans) {
      const el = fanLegend.querySelector(`[data-fan-id="${CSS.escape(fan.id)}"] .legend-value`);
      if (el) el.textContent = `${Math.round(fan.speed * 100)}%`;
    }
  }

  drawTempGraph();
  drawFanGraph();

  // Axis labels grow with the data until they reach -10m/-5m.
  const spanMin = Math.max(1, Math.round((tempHistory[tempHistory.length - 1].t - tempHistory[0].t) / 60000));
  for (const el of graphXStarts) el.textContent = `−${spanMin}m`;
  for (const el of graphXMids) el.textContent = `−${Math.round(spanMin / 2)}m`;
}

function midGridline(h, w) {
  return `<line class="graph-grid" x1="0" y1="${h / 2}" x2="${w}" y2="${h / 2}"/>`;
}

function drawTempGraph() {
  const w = 600, h = 140;
  const tMin = tempHistory[0].t, tMax = tempHistory[tempHistory.length - 1].t;
  const values = tempHistory.flatMap((p) => [p.extruder, p.extruderTarget, p.bed, p.bedTarget]);
  const maxV = Math.max(60, ...values) + 10;
  tempYMax.textContent = `${Math.round(maxV)}°`;
  tempYMid.textContent = `${Math.round(maxV / 2)}°`;
  const line = (get, cls) => graphPath(tempHistory, get, 0, maxV, w, h, tMin, tMax, cls);
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
      fanHistory, (p) => p.values[id] || 0, 0, 1, w, h, tMin, tMax, "graph-line", fanColor(i),
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
