// Dashboard: one card per printer over /ws, polling fallback.

import { api } from "./lib/api.js";
import { startCamera, stopCamera, wireCamera } from "./lib/camera.js";
import { mountChrome } from "./lib/chrome.js";
import { openModal, submitOnEnter } from "./lib/dialogs.js";
import { wirePrinterEditor } from "./lib/editor.js";
import { connectLive } from "./lib/live.js";
import { displayState, eta, renderCardHeader, renderJobControls, wireJobControls } from "./lib/printer.js";

mountChrome();

const groupsEl = document.getElementById("groups");
const emptyNote = document.getElementById("empty");
const cardTemplate = document.getElementById("card-template");
const groupTemplate = document.getElementById("group-template");
const searchInput = document.getElementById("search");

const cards = new Map();   // id -> card element
const groups = new Map();  // group name -> section ("" -> "Ungrouped")

// --- rendering ---------------------------------------------------------------

function cardFor(id) {
  let card = cards.get(id);
  if (card) return card;

  card = cardTemplate.content.firstElementChild.cloneNode(true);
  cards.set(id, card);

  const detailUrl = `/printer/${encodeURIComponent(id)}`;
  card.querySelector(".name").href = detailUrl;
  // Whole card is a click target; interactive children opt out.
  card.addEventListener("click", (event) => {
    if (event.target.closest("a, button, .editor, .camera")) return;
    location.href = detailUrl;
  });

  const toggle = card.querySelector(".cam-toggle");
  const camera = card.querySelector(".camera");
  toggle.addEventListener("click", () => {
    const opening = camera.hidden;
    camera.hidden = !opening;
    toggle.textContent = opening ? "Hide camera" : "Show camera";
    if (opening) startCamera(card, id);
    else stopCamera(card);
  });
  wireCamera(card, id);

  const thumb = card.querySelector(".job-thumb");
  thumb.addEventListener("load", () => { thumb.hidden = false; });
  thumb.addEventListener("error", () => { thumb.hidden = true; });

  wirePrinterEditor(card, id);
  // Dismiss is local, so repaint now rather than waiting for the next tick.
  wireJobControls(card, id, { onDismiss: () => { if (card._status) render(card._status); } });
  return card;
}

function render(status) {
  emptyNote.hidden = true;
  const card = cardFor(status.id);
  card._status = status;
  renderCardHeader(card, status);
  renderJob(card, status);
  renderCamera(card, status);
  placeInGroup(card, status.group);
  applySearchFilter();
}

function renderJob(card, status) {
  const job = card.querySelector(".job");
  const state = displayState(status);
  const active = state === "printing" || state === "paused" || state === "complete";
  job.hidden = !active;
  if (!active) {
    card._thumbFilename = null;
    return;
  }

  // Moonraker may still report <100% after completion.
  const progress = state === "complete" ? 1 : (status.progress || 0);
  card.querySelector(".progress-bar").style.width = `${Math.round(progress * 100)}%`;
  card.querySelector(".filename").textContent = status.filename || "-";
  card.querySelector(".eta").textContent = eta(status.eta_seconds);
  renderJobControls(card, status);

  // Once per filename, not per tick.
  if (status.filename && status.filename !== card._thumbFilename) {
    card._thumbFilename = status.filename;
    const thumb = card.querySelector(".job-thumb");
    thumb.hidden = true;
    thumb.src = `/api/printers/${encodeURIComponent(status.id)}/files/thumbnail?filename=${encodeURIComponent(status.filename)}`;
  }
}

function renderCamera(card, status) {
  const toggle = card.querySelector(".cam-toggle");
  if (status.camera_url && status.online) {
    toggle.hidden = false;
  } else {
    toggle.hidden = true;
    card.querySelector(".camera").hidden = true;
    toggle.textContent = "Show camera";
    stopCamera(card);
  }
}

// --- groups (collapsible sections) -------------------------------------------

function groupFor(name) {
  const key = name || "Ungrouped";
  let group = groups.get(key);
  if (group) return group;

  const el = groupTemplate.content.firstElementChild.cloneNode(true);
  el.querySelector(".group-name").textContent = key;
  const grid = el.querySelector(".group-grid");
  const countEl = el.querySelector(".group-count");

  try {
    const stored = localStorage.getItem(`printdeck-group-${key}`);
    if (stored) el.open = stored === "open";
  } catch { /* ignore */ }
  el.addEventListener("toggle", () => {
    try { localStorage.setItem(`printdeck-group-${key}`, el.open ? "open" : "closed"); } catch { /* ignore */ }
  });

  group = { el, grid, countEl };
  groups.set(key, group);
  insertGroupSorted(el, key);
  return group;
}

// Alphabetical, "Ungrouped" last.
function insertGroupSorted(el, key) {
  const before = [...groupsEl.children].find((child) => {
    if (key === "Ungrouped") return false;
    const otherKey = child.querySelector(".group-name").textContent;
    return otherKey === "Ungrouped" || otherKey.localeCompare(key) > 0;
  });
  groupsEl.insertBefore(el, before || null);
}

function placeInGroup(card, groupName) {
  const target = groupFor(groupName);
  const previousGrid = card.parentElement;
  // Usually already in the right group; still recount states.
  if (previousGrid !== target.grid) {
    target.grid.append(card);
    if (previousGrid && previousGrid.children.length === 0) {
      const previousKey = previousGrid.closest(".group").querySelector(".group-name").textContent;
      groups.get(previousKey).el.remove();
      groups.delete(previousKey);
    } else if (previousGrid) {
      updateGroupCount(groups.get(previousGrid.closest(".group").querySelector(".group-name").textContent));
    }
  }
  updateGroupCount(target);
}

// Most actionable first.
const STATE_ORDER = ["error", "printing", "paused", "complete", "connecting", "idle", "offline"];

function updateGroupCount(group) {
  const counts = {};
  for (const card of group.grid.children) {
    const state = card.dataset.state || "offline";
    counts[state] = (counts[state] || 0) + 1;
  }
  const parts = STATE_ORDER.filter((s) => counts[s]).map((s) => `${counts[s]} ${s}`);
  group.countEl.textContent = parts.length ? `(${parts.join(" · ")})` : "(0)";
}

function removeCard(id) {
  const card = cards.get(id);
  if (!card) return;
  const grid = card.parentElement;
  card.remove();
  cards.delete(id);

  if (grid) {
    const key = grid.closest(".group")?.querySelector(".group-name").textContent;
    const group = key && groups.get(key);
    if (group) {
      if (grid.children.length === 0) {
        group.el.remove();
        groups.delete(key);
      } else {
        updateGroupCount(group);
      }
    }
  }
  if (cards.size === 0) emptyNote.hidden = false;
}

// --- search --------------------------------------------------------------

searchInput.addEventListener("input", applySearchFilter);

function applySearchFilter() {
  const query = searchInput.value.trim().toLowerCase();
  for (const { el, grid } of groups.values()) {
    let anyVisible = false;
    for (const card of grid.children) {
      const match = !query || card.querySelector(".name").textContent.toLowerCase().includes(query);
      card.hidden = !match;
      if (match) anyVisible = true;
    }
    el.hidden = !anyVisible;
  }
}

// --- adding a printer ---------------------------------------------------
// The new card arrives via the live feed's "update" event.

document.getElementById("add-printer").addEventListener("click", () => {
  const { body, close } = openModal("Add printer");
  body.innerHTML = `
    <label class="modal-field">
      <span>Name</span>
      <input type="text" class="modal-input add-name" autocomplete="off">
    </label>
    <label class="modal-field">
      <span>IP / hostname</span>
      <input type="text" class="modal-input add-host" inputmode="decimal" autocomplete="off" spellcheck="false">
    </label>
    <label class="modal-field">
      <span>Moonraker port</span>
      <input type="number" class="modal-input add-port" min="1" max="65535" step="1" inputmode="numeric" autocomplete="off" value="7125">
    </label>
    <label class="modal-field">
      <span>API key (optional)</span>
      <input type="password" class="modal-input add-api-key" autocomplete="off" spellcheck="false" placeholder="Only if Moonraker requires one">
    </label>
    <label class="modal-field modal-field-check">
      <input type="checkbox" class="add-tls">
      <span>Connect over HTTPS/WSS</span>
    </label>
    <label class="modal-field modal-field-check">
      <input type="checkbox" class="add-creality-light">
      <span>Creality chamber light (K1 stock firmware, port 9999)</span>
    </label>
    <label class="modal-field">
      <span>Camera URL (optional)</span>
      <input type="text" class="modal-input add-camera" autocomplete="off" spellcheck="false">
    </label>
    <label class="modal-field">
      <span>Group (optional)</span>
      <input type="text" class="modal-input add-group" autocomplete="off">
    </label>
    <div class="modal-actions">
      <button type="button" class="modal-cancel">Cancel</button>
      <button type="button" class="modal-confirm">Add printer</button>
    </div>
    <p class="modal-message add-printer-error" hidden></p>
  `;
  const nameInput = body.querySelector(".add-name");
  const hostInput = body.querySelector(".add-host");
  const portInput = body.querySelector(".add-port");
  const apiKeyInput = body.querySelector(".add-api-key");
  const tlsInput = body.querySelector(".add-tls");
  const crealityLightInput = body.querySelector(".add-creality-light");
  const cameraInput = body.querySelector(".add-camera");
  const groupInput = body.querySelector(".add-group");
  const errorEl = body.querySelector(".add-printer-error");
  const confirmBtn = body.querySelector(".modal-confirm");

  const submit = async () => {
    errorEl.hidden = true;
    const name = nameInput.value.trim();
    const host = hostInput.value.trim();
    if (!name || !host) {
      errorEl.textContent = "Name and IP/hostname are required.";
      errorEl.hidden = false;
      return;
    }
    confirmBtn.disabled = true;
    try {
      await api("/api/printers", {
        method: "POST",
        json: {
          name,
          host,
          moonraker_port: Number(portInput.value) || 7125,
          api_key: apiKeyInput.value.trim(),
          tls: tlsInput.checked,
          creality_light: crealityLightInput.checked,
          camera_url: cameraInput.value.trim(),
          group: groupInput.value.trim(),
        },
      });
      close();  // the new card appears via the live feed
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
      confirmBtn.disabled = false;
    }
  };

  body.querySelector(".modal-cancel").addEventListener("click", close);
  confirmBtn.addEventListener("click", submit);
  submitOnEnter(body.querySelectorAll("input:not([type=checkbox])"), submit);
  nameInput.focus();
});

// --- live connection -------------------------------------------------------

// A full list has no "removed" events, so drop cards it stopped mentioning
// (a printer deleted while the feed was down).
function renderAll(printers) {
  const seen = new Set(printers.map((p) => p.id));
  for (const id of [...cards.keys()]) {
    if (!seen.has(id)) removeCard(id);
  }
  printers.forEach(render);
  if (printers.length === 0) emptyNote.hidden = false;
}

connectLive({ onFull: renderAll, onUpdate: render, onRemoved: removeCard });
