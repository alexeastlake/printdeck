// PrintDeck dashboard. No framework: open the websocket, keep one card per
// printer in sync (organized into collapsible group sections), and fall
// back to polling if the socket goes away. Shared formatters/camera/editor
// code lives in shared.js, loaded before this file.

const groupsEl = document.getElementById("groups");
const emptyNote = document.getElementById("empty");
const connLabel = document.getElementById("conn");
const cardTemplate = document.getElementById("card-template");
const groupTemplate = document.getElementById("group-template");
const searchInput = document.getElementById("search");

// Keep references to each card so updates are a cheap lookup, not a re-render.
const cards = new Map();
// One collapsible section per group name ("" -> "Ungrouped").
const groups = new Map();

// --- rendering ---------------------------------------------------------------

function cardFor(id) {
  let card = cards.get(id);
  if (card) return card;

  card = cardTemplate.content.firstElementChild.cloneNode(true);
  cards.set(id, card);

  const detailUrl = `/printer/${encodeURIComponent(id)}`;
  card.querySelector(".name").href = detailUrl;
  // The name is a real link, but the whole card is also a click target — an
  // easier target to hit than the title text alone. Clicks on anything
  // actually interactive (links, buttons, the editor, the camera) opt out.
  card.addEventListener("click", (event) => {
    if (event.target.closest("a, button, .editor, .camera")) return;
    location.href = detailUrl;
  });

  const toggle = card.querySelector(".cam-toggle");
  const camera = card.querySelector(".camera");
  const video = card.querySelector(".cam-frame");
  toggle.addEventListener("click", () => {
    const opening = camera.hidden;
    camera.hidden = !opening;
    toggle.textContent = opening ? "Hide camera" : "Show camera";
    // Open the WebRTC connection only on reveal; tear it down when hidden.
    if (opening) startCamera(card, id);
    else stopCamera(card);
  });
  // The preview fills the card; click it to see the whole frame fullscreen.
  video.addEventListener("click", () => {
    if (video.srcObject && document.fullscreenEnabled) video.requestFullscreen();
  });
  // "Click to retry" in the error overlay actually does something.
  card.querySelector(".cam-status").addEventListener("click", (event) => {
    if (event.currentTarget.dataset.state === "error") startCamera(card, id);
  });

  const thumb = card.querySelector(".job-thumb");
  thumb.addEventListener("load", () => { thumb.hidden = false; });
  thumb.addEventListener("error", () => { thumb.hidden = true; });

  wirePrinterEditor(card, id);
  return card;
}

function render(status) {
  emptyNote.hidden = true;
  const card = cardFor(status.id);
  card.dataset.host = status.host || "";  // prefill for the editor
  card.dataset.cameraUrl = status.camera_url || "";
  card.dataset.group = status.group || "";
  card.dataset.state = status.state;
  card.style.setProperty("--state", STATE_COLOR[status.state] || STATE_COLOR.offline);

  card.querySelector(".name").textContent = status.name;

  const badge = card.querySelector(".badge");
  badge.textContent = status.state;

  card.querySelector(".nozzle").innerHTML = temp(status.extruder_temp, status.extruder_target);
  card.querySelector(".bed").innerHTML = temp(status.bed_temp, status.bed_target);

  renderJob(card, status);
  renderCamera(card, status);
  placeInGroup(card, status.group);
  applySearchFilter();
}

function renderJob(card, status) {
  const job = card.querySelector(".job");
  const active = status.state === "printing" || status.state === "paused";
  job.hidden = !active;
  if (!active) {
    card._thumbFilename = null;
    return;
  }

  card.querySelector(".progress-bar").style.width = `${Math.round((status.progress || 0) * 100)}%`;
  card.querySelector(".filename").textContent = status.filename || "—";
  card.querySelector(".eta").textContent = eta(status.eta_seconds);

  // Fetch once per filename, not on every status tick — the thumbnail
  // doesn't change mid-print.
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
    // No camera, or the printer dropped off — hide and tear down any stream.
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

  // Remember whether this section was left open or collapsed.
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

// Alphabetical, but "Ungrouped" always sorts last — it's the catch-all, not
// a category anyone named on purpose.
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
  // The common case: this card was already in the right group and just had
  // a status change (e.g. connecting -> idle) — still need to recompute
  // the group's state breakdown, just not move anything.
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

// Most-actionable state first, so a glance at a big group catches problems
// before it catches printers just sitting idle.
const STATE_ORDER = ["error", "printing", "paused", "connecting", "idle", "offline"];

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
// Needs manage_printers in practice (the button's hidden without it — see
// body:not(.can-manage-printers) in style.css — and the API enforces it
// regardless). The new card itself appears via the live feed's own
// "update" event once the POST succeeds, same as any other status change.

document.getElementById("add-printer").addEventListener("click", () => {
  const { overlay, body } = openModal("Add printer");
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
  const cameraInput = body.querySelector(".add-camera");
  const groupInput = body.querySelector(".add-group");
  const errorEl = body.querySelector(".add-printer-error");
  const confirmBtn = body.querySelector(".modal-confirm");

  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  };

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
      const res = await fetch("/api/printers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          host,
          camera_url: cameraInput.value.trim(),
          group: groupInput.value.trim(),
        }),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.detail || `error ${res.status}`);
      }
      close();  // success — the new card appears via the live feed
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
      confirmBtn.disabled = false;
    }
  };

  const onKey = (event) => {
    if (event.key === "Escape") close();
    if (event.key === "Enter") submit();
  };

  overlay.addEventListener("click", (event) => { if (event.target === overlay) close(); });
  body.querySelector(".modal-cancel").addEventListener("click", close);
  confirmBtn.addEventListener("click", submit);
  document.addEventListener("keydown", onKey);
  nameInput.focus();
});

// --- live connection -------------------------------------------------------

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
      if (msg.printers.length === 0) emptyNote.hidden = false;
      msg.printers.forEach(render);
    } else if (msg.type === "update") {
      render(msg.printer);
    } else if (msg.type === "removed") {
      removeCard(msg.id);
    }
  });

  socket.addEventListener("close", () => {
    setConn("closed", "Reconnecting to server…");
    startPolling();
    setTimeout(connect, 3000);
  });

  socket.addEventListener("error", () => socket.close());
}

// While the socket is down, keep the cards roughly current over plain REST.
function startPolling() {
  if (pollTimer) return;
  const tick = async () => {
    try {
      const res = await fetch("/api/printers");
      if (res.status === 401) return void (location.href = "/login");  // session expired
      const printers = await res.json();
      const seen = new Set(printers.map((p) => p.id));
      printers.forEach(render);
      // A printer removed by someone else while this tab's WS was down
      // otherwise never disappears here — the snapshot just stops
      // mentioning it, nothing tells this tab to drop the card.
      for (const id of [...cards.keys()]) {
        if (!seen.has(id)) removeCard(id);
      }
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
