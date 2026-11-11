// The current job: progress, ETA, thumbnail, and slicer metadata.

import { api } from "../lib/api.js";
import { openImageLightbox } from "../lib/dialogs.js";
import { displayState, eta, renderJobControls } from "../lib/printer.js";
import { filamentText } from "./format.js";
import { card, live, printerApiUrl, thumbnailUrl } from "./page.js";

const jobEl = card.querySelector(".job");
const jobThumb = document.querySelector(".job-thumb");
const filamentStat = document.querySelector(".job-stat-filament");
const filamentValue = document.querySelector(".job-filament");

// Rows straight from the file's slicer metadata; each hides when it's missing.
const SLICER_STATS = [
  ["filament-type", (info) => info.filament_type],
  ["layer-count", (info) => info.layer_count && String(info.layer_count)],
  ["layer-height", (info) => info.layer_height && `${info.layer_height} mm`],
  ["nozzle", (info) => info.nozzle_diameter && `${info.nozzle_diameter} mm`],
  ["slicer", (info) => info.slicer && [info.slicer, info.slicer_version].filter(Boolean).join(" ")],
].map(([key, format]) => ({
  stat: document.querySelector(`.job-stat-${key}`),
  value: document.querySelector(`.job-${key}`),
  format,
}));

let jobFilename = null;  // the file this thumbnail/metadata belongs to
let printInfo = null;    // slicer metadata for jobFilename, once it's loaded

export function renderJob(status) {
  const state = displayState(status);
  const active = state === "printing" || state === "paused" || state === "complete";
  jobEl.hidden = !active;
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
  filamentStat.hidden = usedMm <= 0;
  if (usedMm > 0) {
    filamentValue.textContent = filamentText(usedMm, printInfo, {
      totalMm: printInfo?.filament_total,
      totalGrams: printInfo?.filament_weight_total,
    });
  }

  for (const { stat, value, format } of SLICER_STATS) {
    const text = printInfo ? format(printInfo) : "";
    value.textContent = text || "";
    stat.hidden = !text;
  }
}

function loadPrintInfo(filename) {
  printInfo = null;
  jobThumb.hidden = true;
  jobThumb.src = thumbnailUrl(filename);

  api(printerApiUrl(`/files/info?filename=${encodeURIComponent(filename)}`))
    .then((res) => res.json())
    .then((info) => {
      printInfo = info;
      if (filename === jobFilename && live.status) renderJobDetails(live.status);
    })
    .catch(() => {});
}

jobThumb.addEventListener("load", () => { jobThumb.hidden = false; });
jobThumb.addEventListener("error", () => { jobThumb.hidden = true; });
jobThumb.addEventListener("click", () => openImageLightbox(jobThumb.src, jobFilename || ""));
