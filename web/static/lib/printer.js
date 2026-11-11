// Printer status as both pages show it: the card header, the job controls,
// and the local "dismiss a finished print" state.

import { api, printerUrl } from "./api.js";
import { confirmDialog } from "./dialogs.js";

// --- "complete" + dismiss ----------------------------------------------------
// Klipper reports "complete" until the next print starts, so without this a
// card sits there for days. Dismiss is per browser (localStorage); the
// printer is untouched. Keyed by printer+file+finish time so the next
// print's completion isn't pre-dismissed.

const DISMISS_KEY = "printdeck-dismissed";

function completionKey(status) {
  return `${status.id}|${status.filename || ""}|${status.completed_at || ""}`;
}

function readDismissed() {
  try { return JSON.parse(localStorage.getItem(DISMISS_KEY) || "{}"); } catch { return {}; }
}

function isCompletionDismissed(status) {
  return status.state === "complete" && Boolean(readDismissed()[completionKey(status)]);
}

function dismissCompletion(status) {
  try {
    const all = readDismissed();
    for (const key of Object.keys(all)) if (key.startsWith(`${status.id}|`)) delete all[key];
    all[completionKey(status)] = true;
    localStorage.setItem(DISMISS_KEY, JSON.stringify(all));
  } catch { /* no storage: dismiss won't survive a reload */ }
}

// "complete" reads as idle once dismissed here.
export function displayState(status) {
  return isCompletionDismissed(status) ? "idle" : status.state;
}

export function finishedAgo(completedAt) {
  if (!completedAt) return "Finished";
  const mins = Math.max(0, Math.round((Date.now() / 1000 - completedAt) / 60));
  if (mins < 1) return "Finished just now";
  if (mins < 60) return `Finished ${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `Finished ${hours}h ${mins % 60}m ago`;
  return `Finished ${Math.floor(hours / 24)}d ago`;
}

// --- small formatters --------------------------------------------------------

// HTML; both values are numbers.
export function temp(current, target) {
  const now = `${current.toFixed(1)}°`;
  return target > 0 ? `${now} <span class="target">→ ${Math.round(target)}°</span>` : now;
}

export function eta(seconds) {
  if (seconds == null) return "";
  const m = Math.round(seconds / 60);
  if (m < 60) return `~${m}m left`;
  const h = Math.floor(m / 60);
  return `~${h}h ${m % 60}m left`;
}

// --- card header -------------------------------------------------------------
// What the dashboard card and the detail page render the same way. The
// dataset prefills the editor; data-state picks the colour (style.css).
// Returns the displayed state.

export function renderCardHeader(root, status) {
  Object.assign(root.dataset, {
    host: status.host || "",
    port: String(status.moonraker_port || 7125),
    hasApiKey: String(Boolean(status.has_api_key)),
    tls: String(Boolean(status.tls)),
    crealityLight: String(Boolean(status.creality_light)),
    cameraUrl: status.camera_url || "",
    group: status.group || "",
  });
  const state = displayState(status);
  root.dataset.state = state;
  root.querySelector(".name").textContent = status.name;
  root.querySelector(".badge").textContent = state;
  root.querySelector(".nozzle").innerHTML = temp(status.extruder_temp, status.extruder_target);
  root.querySelector(".bed").innerHTML = temp(status.bed_temp, status.bed_target);
  return state;
}

// --- job controls --------------------------------------------------------------
// `root` has .job-pause/.job-resume/.job-cancel/.job-dismiss and .job-error.
// Pause/resume/cancel are hidden without control_printers (style.css); the
// API enforces it anyway. Dismiss is local, so anyone gets it.

export function wireJobControls(root, id, { onDismiss } = {}) {
  const errorEl = root.querySelector(".job-error");
  const showError = (message) => { errorEl.textContent = message; errorEl.hidden = !message; };

  const act = async (button, action) => {
    showError("");
    button.disabled = true;
    try {
      await api(printerUrl(id, `/job/${action}`), { method: "POST" });
    } catch (err) {
      showError(err.message);
    } finally {
      button.disabled = false;
    }
  };

  const pauseBtn = root.querySelector(".job-pause");
  const resumeBtn = root.querySelector(".job-resume");
  const cancelBtn = root.querySelector(".job-cancel");
  pauseBtn.addEventListener("click", () => act(pauseBtn, "pause"));
  resumeBtn.addEventListener("click", () => act(resumeBtn, "resume"));
  cancelBtn.addEventListener("click", async () => {
    // Don't read event.currentTarget after an await: it's null once dispatch ends.
    const ok = await confirmDialog({
      title: "Cancel print",
      message: `Cancel "${root._jobStatus?.filename || "the current print"}"? The printer will stop and the print can't be resumed.`,
      confirmLabel: "Cancel print",
      danger: true,
    });
    if (ok) act(cancelBtn, "cancel");
  });
  root.querySelector(".job-dismiss").addEventListener("click", () => {
    if (!root._jobStatus) return;
    dismissCompletion(root._jobStatus);
    if (onDismiss) onDismiss(root._jobStatus);
  });
}

export function renderJobControls(root, status) {
  root._jobStatus = status;
  const state = displayState(status);
  root.querySelector(".job-pause").hidden = state !== "printing";
  root.querySelector(".job-resume").hidden = state !== "paused";
  root.querySelector(".job-cancel").hidden = state !== "printing" && state !== "paused";
  const finished = root.querySelector(".job-finished");
  finished.hidden = state !== "complete";
  finished.textContent = state === "complete" ? finishedAgo(status.completed_at) : "";
  root.querySelector(".job-dismiss").hidden = state !== "complete";
  root.querySelector(".eta").hidden = state === "complete";
}
