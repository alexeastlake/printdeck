// Job history and lifetime totals, from Moonraker's [history] component.
// Loaded when the printer comes online, when a print ends, and on refresh.
// Pages come from Moonraker; search/filter run over what's loaded, and pull
// the rest in (up to a cap) so a search isn't silently partial.

import { api } from "../lib/api.js";
import { confirmDialog } from "../lib/dialogs.js";
import { duration, filamentText, formatWhen } from "./format.js";
import { createSelection, showingText, statusLine, wirePageSize } from "./list.js";
import { printerApiUrl, wireThumb } from "./page.js";

const HISTORY_FETCH_SIZE = 50;   // rows per request to Moonraker (backend caps at 100)
const HISTORY_FETCH_CAP = 1000;  // most a search or "Show all" will pull in

const historySection = document.querySelector(".history-section");
const historyList = document.querySelector(".history-list");
const lifetimeStats = document.querySelector(".lifetime-stats");
const historyLoadMoreBtn = document.querySelector(".history-load-more");
const historyCountEl = document.querySelector(".history-count");
const historySearchInput = document.querySelector(".history-search");
const historyFilterSelect = document.querySelector(".history-filter");

const setHistoryStatus = statusLine(document.querySelector(".history-status"), "files-error");
const historyPageSize = wirePageSize(document.querySelector(".history-page-size"), "printdeck-page-size-history", (n) => {
  historyVisible = n;
  renderHistoryRows();
  ensureHistoryLoaded(historyRequestId);
});

let historyReady = false;   // loaded since the printer last came online?
let historyLoading = false; // first page in flight; suppresses the "nothing yet" row
let historyCount = 0;       // total jobs Moonraker has, from the last response
let historyJobs = [];       // everything loaded so far, newest first
let shownJobIds = [];       // job_ids of the rows currently rendered
let historyRequestId = 0;
let lastJobState = null;    // to notice a print ending, which changes the list
let historyVisible = historyPageSize();  // rows to show; grows with Load more

const selection = createSelection({
  selectAll: document.querySelector(".history-select-all"),
  bar: document.querySelector(".history-bulk-bar"),
  count: document.querySelector(".history-bulk-count"),
  deleteBtn: document.querySelector(".history-bulk-delete"),
  visibleKeys: () => shownJobIds,
  onSelectAll: () => renderHistoryRows(),
  confirm: (n) => confirmDialog({
    title: "Delete from history",
    message: `Remove ${n} entr${n === 1 ? "y" : "ies"} from the printer's history? Files aren't touched.`,
    confirmLabel: "Delete",
    danger: true,
  }),
  deleteOne: deleteJob,
  afterDelete: () => {
    renderHistoryRows();
    loadHistoryTotals();
  },
  setStatus: setHistoryStatus,
  what: ["entry", "entries"],
});

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

export function renderHistory(status) {
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
  if (!historyReady || (wasActive && !isActive)) {
    historyReady = true;
    loadHistoryTotals();  // one small request; don't make it wait behind the first page of rows
    loadHistory();
  }
}

export function hideHistory() {
  historySection.hidden = true;
}

function historyApiUrl(suffix = "") {
  return printerApiUrl(`/history${suffix}`);
}

// --- loading -----------------------------------------------------------------------

async function loadHistory() {
  const requestId = ++historyRequestId;
  historyJobs = [];
  historyCount = 0;
  historyVisible = historyPageSize();
  historyLoading = true;
  renderHistoryRows();
  selection.clear();
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

// Lifetime counters Moonraker keeps in its own database. They cover every
// print ever recorded and don't shrink when history rows are deleted, which
// is why they sit under the status line rather than in the History header.
async function loadHistoryTotals() {
  try {
    const t = (await (await api(historyApiUrl("/totals"))).json()).job_totals || {};
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

// --- rendering ---------------------------------------------------------------------

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
  shownJobIds = shown.map((j) => j.job_id);
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
  historyCountEl.textContent = filtered
    ? showingText(shown.length, total, "match", "matches")
    : showingText(shown.length, total, "print");
  historyCountEl.hidden = historyLoading || total === 0;
  selection.sync();
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

function historyRow(job) {
  const bucket = historyBucket(job.status);
  const [label, color] = HISTORY_BUCKETS[bucket];
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
  detail.textContent = bucket === "not_completed" ? historyProgress(job) : "";
  detail.hidden = !detail.textContent;
  li.querySelector(".history-started").textContent = job.start_time ? formatWhen(job.start_time) : "";
  li.querySelector(".history-finished").textContent = job.end_time ? formatWhen(job.end_time) : "";
  li.querySelector(".history-duration").textContent = job.print_duration ? duration(job.print_duration) : "";
  li.querySelector(".history-filament").textContent = job.filament_used ? filamentText(job.filament_used, job.metadata) : "";
  li.querySelector(".history-delete").addEventListener("click", () => deleteHistoryJob(job));
  selection.bind(li.querySelector(".history-checkbox"), job.job_id);
  return li;
}

// --- deleting ----------------------------------------------------------------------

async function deleteJob(jobId) {
  await api(historyApiUrl(`/${encodeURIComponent(jobId)}`), { method: "DELETE" });
  historyJobs = historyJobs.filter((j) => j.job_id !== jobId);
  historyCount = Math.max(0, historyCount - 1);
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
    await deleteJob(job.job_id);
    selection.remove(job.job_id);
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

// --- wiring ------------------------------------------------------------------------

document.querySelector(".history-refresh").addEventListener("click", loadHistory);
document.querySelector(".history-clear").addEventListener("click", clearHistory);
historyLoadMoreBtn.addEventListener("click", () => {
  historyVisible += historyPageSize();
  renderHistoryRows();
  ensureHistoryLoaded(historyRequestId);
});
historySearchInput.addEventListener("input", () => { renderHistoryRows(); ensureAllLoadedForFilter(); });
historyFilterSelect.addEventListener("change", () => { renderHistoryRows(); ensureAllLoadedForFilter(); });
