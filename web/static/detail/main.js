// Detail page for one printer (/printer/<id>). Entry module: each section
// lives in its own module and exports a render(status) that this calls on
// every update.

import { startCamera, stopCamera, wireCamera } from "../lib/camera.js";
import { mountChrome } from "../lib/chrome.js";
import { wirePrinterEditor } from "../lib/editor.js";
import { connectLive } from "../lib/live.js";
import { renderCardHeader, wireJobControls } from "../lib/printer.js";
import { renderControls } from "./controls.js";
import { hideFiles, renderFiles } from "./files.js";
import { renderGraphs } from "./graphs.js";
import { hideHistory, renderHistory } from "./history.js";
import { renderJob } from "./job.js";
import { card, live, printerId } from "./page.js";

mountChrome();

const notFound = document.getElementById("not-found");

let cameraStarted = false;

function render(status) {
  live.status = status;
  card.hidden = false;
  notFound.hidden = true;
  document.title = `${status.name} - PrintDeck`;
  renderCardHeader(card, status);
  renderPrinterInfo(status);
  renderJob(status);
  renderKlipperStatus(status);
  renderMessage(status);
  renderCamera(status);
  renderGraphs(status);
  renderControls(status);
  renderFiles(status);
  renderHistory(status);
}

function renderPrinterInfo(status) {
  const shownHost = status.host ? (status.host.includes(":") ? `[${status.host}]` : status.host) : "-";
  const moonrakerUrl = status.host
    ? `${status.tls ? "https" : "http"}://${shownHost}:${status.moonraker_port || 7125}${status.has_api_key ? "  (API key set)" : ""}`
    : "-";
  card.querySelector(".printer-info-host").textContent = moonrakerUrl;
  card.querySelector(".printer-info-camera").textContent = status.camera_url || "";
  card.querySelector(".printer-info-camera-item").hidden = !status.camera_url;
}

function renderKlipperStatus(status) {
  card.querySelector(".klipper-status-value").textContent = status.klipper_status || "";
  card.querySelector(".klipper-status").hidden = !status.online || !status.klipper_status;
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
  stopCamera(card);
  cameraStarted = false;
  card.hidden = true;
  hideFiles();
  hideHistory();
  notFound.hidden = false;
  document.title = "PrintDeck";
}

wirePrinterEditor(card, printerId);
// Dismiss is local, so repaint now rather than waiting for the next tick.
wireJobControls(card, printerId, { onDismiss: () => { if (live.status) render(live.status); } });
wireCamera(card, printerId);

connectLive({
  onFull: (printers) => {
    const found = printers.find((p) => p.id === printerId);
    if (found) render(found);
    else showNotFound();
  },
  onUpdate: (printer) => { if (printer.id === printerId) render(printer); },
  onRemoved: (id) => { if (id === printerId) showNotFound(); },  // deleted elsewhere
});
