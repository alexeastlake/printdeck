// File browser for the gcodes root. Fetched on demand, not over the live
// feed; sorting, filtering and paging are client-side over one folder.

import { api } from "../lib/api.js";
import { confirmDialog, promptDialog } from "../lib/dialogs.js";
import { fileSize, formatDate } from "./format.js";
import { createSelection, showingText, statusLine, wirePageSize } from "./list.js";
import { live, printerApiUrl, wireThumb } from "./page.js";

const filesSection = document.querySelector(".files-section");
const filesUploadInput = document.querySelector(".files-upload-input");
const filesSearchInput = document.querySelector(".files-search");
const filesBreadcrumb = document.querySelector(".files-breadcrumb");
const filesList = document.querySelector(".files-list");
const filesLoadMoreBtn = document.querySelector(".files-load-more");
const filesCountEl = document.querySelector(".files-count");
const filesSortBtns = document.querySelectorAll(".files-sort-btn");

const setFilesStatus = statusLine(document.querySelector(".files-status"), "files-error");
const filesPageSize = wirePageSize(document.querySelector(".files-page-size"), "printdeck-page-size-files", (n) => {
  visibleCount = n;
  renderEntries();
});

const PRINTABLE = /\.(gcode|gco|g|ufp)$/i;

let filesPath = "";
let filesReady = false;  // have we done the first load since coming online?
let filesRequestId = 0;  // bumped on every loadFiles(); see fetchFiles()
let allEntries = [];     // everything in the current folder, dirs then files
let shownPaths = [];     // paths of the rows currently rendered
let visibleCount = filesPageSize();
let sortField = "name";
let sortDir = 1;         // 1 ascending, -1 descending

const selection = createSelection({
  selectAll: document.querySelector(".files-select-all"),
  bar: document.querySelector(".files-bulk-bar"),
  count: document.querySelector(".files-bulk-count"),
  deleteBtn: document.querySelector(".files-bulk-delete"),
  visibleKeys: () => shownPaths,
  onSelectAll: () => renderEntries(),
  confirm: (n) => confirmDialog({
    title: "Delete selected",
    message: `Delete ${n} item${n === 1 ? "" : "s"}? This can't be undone.`,
    confirmLabel: "Delete",
    danger: true,
  }),
  deleteOne: (path) => deletePath(path, entryAt(path)?.isDir ?? false),
  afterDelete: () => fetchFiles(++filesRequestId),
  setStatus: setFilesStatus,
  what: ["item", "items"],
});

// Load once per online period, not per tick.
export function renderFiles(status) {
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

export function hideFiles() {
  filesSection.hidden = true;
}

function filesApiUrl(suffix = "") {
  return printerApiUrl(`/files${suffix}`);
}

function entryPathFor(name) {
  return filesPath ? `${filesPath}/${name}` : name;
}

function entryAt(path) {
  return allEntries.find((e) => entryPathFor(e.name) === path);
}

// --- printing --------------------------------------------------------------------

// Print buttons go inert rather than disappearing, so the list doesn't reflow.
function canStartPrint() {
  return Boolean(live.status?.online) && ["idle", "complete"].includes(live.status.state);
}

function updatePrintButtons() {
  const enabled = canStartPrint();
  for (const btn of filesList.querySelectorAll(".file-print")) {
    btn.disabled = !enabled;
    btn.title = enabled ? "Print this file" : "The printer is busy";
  }
}

async function startPrint(path, name) {
  const ok = await confirmDialog({
    title: "Start print",
    message: `Start printing "${name}"? Make sure the bed is clear first.`,
    confirmLabel: "Start print",
  });
  if (!ok) return;
  setFilesStatus(`Starting ${name}…`);
  try {
    await api(printerApiUrl("/job/start"), { method: "POST", json: { filename: path } });
    setFilesStatus(`Print started: ${name}`);
  } catch (err) {
    setFilesStatus(`Couldn't start print: ${err.message}`, true);
  }
}

// --- loading and rendering ---------------------------------------------------------

// Blur first: removing a focused element mid-swap jumps the page to the top.
function loadFiles() {
  document.activeElement?.blur();
  filesSearchInput.value = "";
  allEntries = [];
  shownPaths = [];
  selection.clear();
  setFilesStatus("Loading…");
  filesList.innerHTML = "";
  filesLoadMoreBtn.hidden = true;
  filesCountEl.hidden = true;
  fetchFiles(++filesRequestId);
}

async function fetchFiles(requestId) {
  try {
    const dir = await (await api(filesApiUrl(`?${new URLSearchParams({ path: filesPath })}`))).json();
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
    shownPaths = [];
    filesList.innerHTML = "";
    selection.sync();
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

function renderEntries() {
  const matches = currentMatches();
  const shown = matches.slice(0, visibleCount);
  const searching = Boolean(filesSearchInput.value.trim());
  shownPaths = shown.map((e) => entryPathFor(e.name));

  filesList.replaceChildren(...shown.map(fileRow));
  if (matches.length === 0) {
    filesList.innerHTML = `<li class="file-empty">${searching ? "No matches." : "Empty folder."}</li>`;
  }
  filesLoadMoreBtn.hidden = matches.length <= visibleCount;
  filesCountEl.textContent = searching
    ? showingText(shown.length, matches.length, "match", "matches")
    : showingText(shown.length, matches.length, "item");
  filesCountEl.hidden = matches.length === 0;
  selection.sync();
}

function fileRow(entry) {
  const { name, size, modified, isDir } = entry;
  const path = entryPathFor(name);
  const printable = !isDir && PRINTABLE.test(name);
  const li = document.createElement("li");
  li.className = isDir ? "file-entry file-entry-dir" : "file-entry";
  // .files-manage cells hide without manage_files (style.css).
  li.innerHTML = `
    <span class="files-col-check files-manage">
      <input type="checkbox" class="file-checkbox" aria-label="Select ${isDir ? "folder" : "file"}">
    </span>
    <span class="file-name-cell">
      <span class="file-icon">${isDir ? "📁" : "📄"}</span>
      ${printable ? '<img class="file-thumb" alt="" hidden>' : ""}
      <span class="file-name"></span>
    </span>
    <span class="file-meta">${isDir ? "" : fileSize(size)}</span>
    <span class="file-modified">${modified ? formatDate(modified) : ""}</span>
    <span class="file-actions">
      ${printable ? '<button type="button" class="file-print job-control" title="Print this file" aria-label="Print">▶</button>' : ""}
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

  selection.bind(li.querySelector(".file-checkbox"), path);

  if (isDir) li.addEventListener("click", () => openFolder(path));
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

function openFolder(path) {
  filesPath = path;
  loadFiles();
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
    btn.addEventListener("click", () => openFolder(parts.slice(0, i).join("/")));
    filesBreadcrumb.append(btn);
  });
}

// --- changes -----------------------------------------------------------------------

function deletePath(path, isDir) {
  return api(filesApiUrl(`?${new URLSearchParams({ path, is_dir: isDir })}`), { method: "DELETE" });
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
    await deletePath(path, isDir);
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

// --- wiring ------------------------------------------------------------------------

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

document.querySelector(".files-refresh").addEventListener("click", loadFiles);
document.querySelector(".files-new-folder").addEventListener("click", createFolder);
document.querySelector(".files-upload").addEventListener("click", () => filesUploadInput.click());
filesUploadInput.addEventListener("change", () => {
  const file = filesUploadInput.files[0];
  filesUploadInput.value = "";  // so picking the same file again still fires "change"
  if (file) uploadFile(file);
});
