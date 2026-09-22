// Shared by every page. Plain script, no build step, so these are globals.

const STATE_COLOR = {
  idle: "var(--idle)",
  printing: "var(--printing)",
  paused: "var(--paused)",
  complete: "var(--complete)",
  error: "var(--error)",
  offline: "var(--offline)",
  connecting: "var(--connecting)",
};

// --- API helper ----------------------------------------------------------------
// fetch() that throws Error(detail) on a non-2xx. Returns the Response for
// callers that need the body. `json` sets the body and content-type.

async function api(url, { method = "GET", json, body, headers } = {}) {
  const init = { method, headers: { ...(headers || {}) } };
  if (json !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(json);
  } else if (body !== undefined) {
    init.body = body;
  }
  const res = await fetch(url, init);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || `error ${res.status}`);
  return res;
}

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

function displayState(status) {
  return isCompletionDismissed(status) ? "idle" : status.state;
}

function finishedAgo(completedAt) {
  if (!completedAt) return "Finished";
  const mins = Math.max(0, Math.round((Date.now() / 1000 - completedAt) / 60));
  if (mins < 1) return "Finished just now";
  if (mins < 60) return `Finished ${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `Finished ${hours}h ${mins % 60}m ago`;
  return `Finished ${Math.floor(hours / 24)}d ago`;
}

// --- job controls --------------------------------------------------------------
// `root` has .job-pause/.job-resume/.job-cancel/.job-dismiss and .job-error.
// Pause/resume/cancel are hidden without control_printers (style.css); the
// API enforces it anyway. Dismiss is local, so anyone gets it.

async function sendJobAction(id, action) {
  await api(`/api/printers/${encodeURIComponent(id)}/job/${action}`, { method: "POST" });
}

function wireJobControls(root, id, { onDismiss } = {}) {
  const errorEl = root.querySelector(".job-error");
  const showError = (message) => { errorEl.textContent = message; errorEl.hidden = !message; };

  const act = async (button, action) => {
    showError("");
    button.disabled = true;
    try {
      await sendJobAction(id, action);
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

function renderJobControls(root, status) {
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

// --- small formatters --------------------------------------------------------

function temp(current, target) {
  const now = `${current.toFixed(1)}°`;
  return target > 0 ? `${now} <span class="target">→ ${Math.round(target)}°</span>` : now;
}

function eta(seconds) {
  if (seconds == null) return "";
  const m = Math.round(seconds / 60);
  if (m < 60) return `~${m}m left`;
  const h = Math.floor(m / 60);
  return `~${h}h ${m % 60}m left`;
}

// --- printer editor ------------------------------------------------------------
// `root` is the card or #detail-card; values come from its dataset.

const API_KEY_UNCHANGED = "••••••••";  // the key is never sent to the browser

function wirePrinterEditor(root, id) {
  const editor = root.querySelector(".editor");
  const nameInput = root.querySelector(".name-input");
  const hostInput = root.querySelector(".host-input");
  const portInput = root.querySelector(".port-input");
  const apiKeyInput = root.querySelector(".api-key-input");
  const tlsInput = root.querySelector(".tls-input");
  const crealityLightInput = root.querySelector(".creality-light-input");
  const cameraUrlInput = root.querySelector(".camera-url-input");
  const groupInput = root.querySelector(".group-input");
  const error = root.querySelector(".editor-error");
  const saveBtn = root.querySelector(".btn-save");

  root.querySelector(".edit-toggle").addEventListener("click", () => {
    const opening = editor.hidden;
    editor.hidden = !opening;
    if (opening) {
      error.hidden = true;
      nameInput.value = root.querySelector(".name").textContent || "";
      hostInput.value = root.dataset.host || "";
      portInput.value = root.dataset.port || "7125";
      // Placeholder = leave as is; typing replaces; empty clears.
      apiKeyInput.value = root.dataset.hasApiKey === "true" ? API_KEY_UNCHANGED : "";
      tlsInput.checked = root.dataset.tls === "true";
      crealityLightInput.checked = root.dataset.crealityLight === "true";
      cameraUrlInput.value = root.dataset.cameraUrl || "";
      groupInput.value = root.dataset.group || "";
    }
  });

  root.querySelector(".btn-cancel").addEventListener("click", () => {
    editor.hidden = true;
  });

  editor.addEventListener("submit", async (event) => {
    event.preventDefault();
    error.hidden = true;
    saveBtn.disabled = true;
    try {
      const body = {
        name: nameInput.value.trim(),
        host: hostInput.value.trim(),
        moonraker_port: Number(portInput.value) || 7125,
        tls: tlsInput.checked,
        creality_light: crealityLightInput.checked,
        camera_url: cameraUrlInput.value.trim(),
        group: groupInput.value.trim(),
      };
      if (apiKeyInput.value !== API_KEY_UNCHANGED) body.api_key = apiKeyInput.value.trim();
      await api(`/api/printers/${encodeURIComponent(id)}`, { method: "PATCH", json: body });
      editor.hidden = true;  // the live feed repaints
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
    } finally {
      saveBtn.disabled = false;
    }
  });

  const deleteBtn = root.querySelector(".btn-delete-printer");
  deleteBtn.addEventListener("click", async () => {
    const ok = await confirmDialog({
      title: "Remove printer",
      message: `Remove "${root.querySelector(".name").textContent}" from PrintDeck? This only stops PrintDeck from managing it. The printer itself isn't affected.`,
      confirmLabel: "Remove",
      danger: true,
    });
    if (!ok) return;
    deleteBtn.disabled = true;
    try {
      await api(`/api/printers/${encodeURIComponent(id)}`, { method: "DELETE" });
      // Dashboard cards remove themselves on the "removed" event.
      if (root.id === "detail-card") location.href = "/";
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
      deleteBtn.disabled = false;
    }
  });
}

// --- camera (WebRTC) ---------------------------------------------------------
// Offer made here, relayed via the backend, video peer-to-peer from the
// printer. `card` has .cam-frame and .cam-status.

// Must outlast the backend's 15s negotiation timeout, plus the encoder can
// take a while to send a keyframe.
const CAMERA_TIMEOUT_MS = 25000;

function setCamStatus(card, state, text) {
  const status = card.querySelector(".cam-status");
  status.dataset.state = state;
  status.textContent = text;
  status.hidden = !text;
}

async function startCamera(card, id) {
  const video = card.querySelector(".cam-frame");
  setCamStatus(card, "loading", "Connecting…");

  const watchdog = setTimeout(() => {
    setCamStatus(card, "error", "Camera didn't respond. Click to retry.");
    resetConnection(card);
  }, CAMERA_TIMEOUT_MS);
  card._camWatchdog = watchdog;

  // STUN even on a LAN: browsers mask host candidates as .local mDNS names,
  // which the printer's WebRTC server can't resolve.
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  });
  card._pc = pc;
  // The printer's server expects sendrecv, same as its own page sends.
  pc.addTransceiver("video", { direction: "sendrecv" });
  pc.ontrack = (event) => { video.srcObject = event.streams[0]; };
  pc.addEventListener("connectionstatechange", () => {
    if (pc.connectionState === "failed") {
      setCamStatus(card, "error", "Camera connection failed. Click to retry.");
      resetConnection(card);
    }
  });
  // Clear the overlay only once a frame actually renders.
  video.addEventListener("playing", () => {
    setCamStatus(card, "", "");
    clearTimeout(card._camWatchdog);
    card._camWatchdog = null;
  }, { once: true });

  try {
    await pc.setLocalDescription(await pc.createOffer());
    await usableCandidate(pc);
    const res = await fetch(`/api/printers/${id}/camera/offer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sdp: pc.localDescription.sdp, type: "offer" }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.detail || `signaling ${res.status}`);
    }
    await pc.setRemoteDescription(await res.json());
  } catch (err) {
    console.error("camera failed", err);
    setCamStatus(card, "error", "Couldn't reach the camera. Click to retry.");
    resetConnection(card);
  }
}

// Tear down but keep the status message (used on failure).
function resetConnection(card) {
  const video = card.querySelector(".cam-frame");
  if (card._camWatchdog) { clearTimeout(card._camWatchdog); card._camWatchdog = null; }
  if (card._pc) { card._pc.close(); card._pc = null; }
  video.srcObject = null;
}

function stopCamera(card) {
  resetConnection(card);
  setCamStatus(card, "", "");
}

// No trickle ICE on the printer side, so the offer needs a dialable
// candidate. Waiting for "complete" gathering is slow (IPv6, quiescence
// timer); the first non-mDNS candidate is enough.
function usableCandidate(pc, timeoutMs = 3000) {
  const isUsable = (candidate) => candidate && !candidate.candidate.includes(".local");
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      pc.removeEventListener("icecandidate", onCandidate);
      pc.removeEventListener("icegatheringstatechange", onStateChange);
      clearTimeout(timer);
      resolve();
    };
    const onCandidate = (event) => {
      if (isUsable(event.candidate)) done();
    };
    const onStateChange = () => {
      if (pc.iceGatheringState === "complete") done();
    };
    const timer = setTimeout(done, timeoutMs);
    pc.addEventListener("icecandidate", onCandidate);
    pc.addEventListener("icegatheringstatechange", onStateChange);
  });
}

// --- theme --------------------------------------------------------------------
// "system" = no override. First paint is handled by theme-init.js; this
// loads too late for that.

const THEME_KEY = "printdeck-theme";

function getTheme() {
  try {
    return localStorage.getItem(THEME_KEY) || "system";
  } catch {
    return "system";
  }
}

function setTheme(theme) {
  try {
    if (theme === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, theme);
  } catch { /* no storage: theme won't persist */ }
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}

// --- session (fetched once per page) ------------------------------------------

let _sessionPromise = null;
function fetchSession() {
  if (!_sessionPromise) {
    _sessionPromise = fetch("/api/session")
      .then((r) => r.json())
      .catch(() => ({ enabled: false, user: null, role: null, role_name: null, permissions: [] }));
  }
  return _sessionPromise;
}

// One body.can-<permission> class per permission; style.css hides controls
// by selector instead of every page checking.
function applyPermissionStyling() {
  fetchSession().then(({ permissions }) => {
    for (const permission of permissions || []) {
      document.body.classList.add(`can-${permission.replace(/_/g, "-")}`);
    }
  });
}

// --- header dropdowns ---------------------------------------------------
// `menu` must already sit right after `toggle` inside a .dropdown wrapper.

function wireDropdown(toggle, menu) {
  function close() {
    menu.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
  }
  toggle.addEventListener("click", (event) => {
    event.stopPropagation();
    const opening = menu.hidden;
    menu.hidden = !opening;
    toggle.setAttribute("aria-expanded", String(opening));
  });
  menu.addEventListener("click", (event) => event.stopPropagation());
  document.addEventListener("click", close);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
  });
}

// --- topbar --------------------------------------------------------------
// Pages ship an empty <header class="topbar">; data-conn adds #conn,
// data-add-printer adds the + button. Static markup only.

function mountTopbar() {
  const bar = document.querySelector("header.topbar");
  if (!bar || bar.children.length) return;
  const wantsConn = bar.hasAttribute("data-conn");
  const wantsAdd = bar.hasAttribute("data-add-printer");
  bar.innerHTML = `
    <h1><a href="/">PrintDeck</a></h1>
    ${wantsConn ? '<span id="conn" class="conn" data-state="connecting">Connecting to server…</span>' : ""}
    <div class="header-actions">
      ${wantsAdd ? `<button id="add-printer" class="icon-btn add-printer-btn" type="button"
              title="Add printer" aria-label="Add printer">+</button>` : ""}
      <div class="dropdown">
        <button id="settings-toggle" class="icon-btn" type="button"
                aria-haspopup="true" aria-expanded="false"
                title="Settings" aria-label="Settings">⚙</button>
      </div>
      <div class="dropdown">
        <button id="account-toggle" class="icon-btn account-toggle" type="button" hidden
                aria-haspopup="true" aria-expanded="false"
                title="Account" aria-label="Account"></button>
      </div>
    </div>
  `;
}

// --- settings menu -----------------------------------------------------------

const GITHUB_USER = "alexeastlake";
const GITHUB_URL = `https://github.com/${GITHUB_USER}/printdeck`;

function mountSettingsMenu() {
  const toggle = document.getElementById("settings-toggle");
  if (!toggle) return;

  const menu = document.createElement("div");
  menu.className = "settings-menu";
  menu.hidden = true;
  menu.innerHTML = `
    <fieldset class="theme-picker">
      <legend>Color theme</legend>
      <label class="theme-option"><input type="radio" name="theme" value="system"> System</label>
      <label class="theme-option"><input type="radio" name="theme" value="light"> Light</label>
      <label class="theme-option"><input type="radio" name="theme" value="dark"> Dark</label>
    </fieldset>
    <div class="settings-links">
      <a class="settings-users" href="/users" hidden>Manage users →</a>
      <a class="settings-roles" href="/roles" hidden>Manage roles →</a>
      <a class="settings-github" href="${GITHUB_URL}" target="_blank" rel="noopener">
        View source on GitHub ↗
      </a>
    </div>
    <p class="settings-credit"><a href="https://github.com/${GITHUB_USER}" target="_blank" rel="noopener">@${GITHUB_USER}</a></p>
  `;
  toggle.insertAdjacentElement("afterend", menu);

  fetchSession().then(({ permissions }) => {
    if ((permissions || []).includes("manage_users")) menu.querySelector(".settings-users").hidden = false;
    if ((permissions || []).includes("manage_roles")) menu.querySelector(".settings-roles").hidden = false;
  });

  const current = getTheme();
  for (const input of menu.querySelectorAll('input[name="theme"]')) {
    input.checked = input.value === current;
    input.addEventListener("change", () => setTheme(input.value));
  }

  wireDropdown(toggle, menu);
}

// --- account menu ----------------------------------------------------------

function mountAccountMenu() {
  const toggle = document.getElementById("account-toggle");
  if (!toggle) return;

  const menu = document.createElement("div");
  menu.className = "settings-menu account-menu";
  menu.hidden = true;
  menu.innerHTML = `
    <p class="account-user"></p>
    <p class="account-role"></p>
    <button type="button" class="account-logout">Sign out</button>
  `;
  toggle.insertAdjacentElement("afterend", menu);

  fetchSession().then(({ enabled, user, role_name }) => {
    if (!enabled || !user) return;
    toggle.hidden = false;
    toggle.title = `Signed in as ${user}`;
    // An initial, not an emoji, because emoji ignore the button's color.
    toggle.textContent = user[0].toUpperCase();
    menu.querySelector(".account-user").textContent = user;
    menu.querySelector(".account-role").textContent = role_name || "";
  });

  menu.querySelector(".account-logout").addEventListener("click", async () => {
    try { await fetch("/auth/logout", { method: "POST" }); } catch { /* ignore */ }
    location.href = "/login";
  });

  wireDropdown(toggle, menu);
}

// --- modals -----------------------------------------------------------------
// Not confirm()/prompt(): native dialogs restore focus in a way that jumps
// the scroll position when the DOM under the trigger changes right after
// (delete-then-refresh).

function openModal(title) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal-panel" role="dialog" aria-modal="true">
      <p class="modal-title"></p>
      <div class="modal-body"></div>
    </div>
  `;
  overlay.querySelector(".modal-title").textContent = title;
  document.body.append(overlay);
  return { overlay, body: overlay.querySelector(".modal-body") };
}

function confirmDialog({ title = "Are you sure?", message = "", confirmLabel = "Confirm", danger = false } = {}) {
  return new Promise((resolve) => {
    const { overlay, body } = openModal(title);
    body.innerHTML = `
      <p class="modal-message"></p>
      <div class="modal-actions">
        <button type="button" class="modal-cancel">Cancel</button>
        <button type="button" class="modal-confirm${danger ? " danger" : ""}"></button>
      </div>
    `;
    body.querySelector(".modal-message").textContent = message;
    const confirmBtn = body.querySelector(".modal-confirm");
    confirmBtn.textContent = confirmLabel;

    const finish = (result) => {
      overlay.remove();
      document.removeEventListener("keydown", onKey);
      resolve(result);
    };
    // No Enter handler on purpose: confirm is focused so Enter already
    // clicks it, and a document-level one fires before a focused Cancel's
    // click, so Tab-to-Cancel-Enter would confirm.
    const onKey = (event) => {
      if (event.key === "Escape") finish(false);
    };

    overlay.addEventListener("click", (event) => { if (event.target === overlay) finish(false); });
    body.querySelector(".modal-cancel").addEventListener("click", () => finish(false));
    confirmBtn.addEventListener("click", () => finish(true));
    document.addEventListener("keydown", onKey);
    confirmBtn.focus();
  });
}

function promptDialog({ title = "Enter a value", label = "", value = "", confirmLabel = "Save" } = {}) {
  return new Promise((resolve) => {
    const { overlay, body } = openModal(title);
    body.innerHTML = `
      <label class="modal-field">
        <span></span>
        <input type="text" class="modal-input" autocomplete="off">
      </label>
      <div class="modal-actions">
        <button type="button" class="modal-cancel">Cancel</button>
        <button type="button" class="modal-confirm"></button>
      </div>
    `;
    body.querySelector(".modal-field span").textContent = label;
    const input = body.querySelector(".modal-input");
    input.value = value;
    const confirmBtn = body.querySelector(".modal-confirm");
    confirmBtn.textContent = confirmLabel;

    const finish = (result) => {
      overlay.remove();
      document.removeEventListener("keydown", onKey);
      resolve(result);
    };
    const submit = () => finish(input.value.trim() || null);
    const onKey = (event) => {
      if (event.key === "Escape") finish(null);
      // Text field only; Enter on Cancel must cancel (see confirmDialog).
      if (event.key === "Enter" && event.target === input) submit();
    };

    overlay.addEventListener("click", (event) => { if (event.target === overlay) finish(null); });
    body.querySelector(".modal-cancel").addEventListener("click", () => finish(null));
    confirmBtn.addEventListener("click", submit);
    document.addEventListener("keydown", onKey);
    input.focus();
    input.select();
  });
}

// --- image lightbox -----------------------------------------------------------

function openImageLightbox(src, alt = "") {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay lightbox-overlay";
  const img = document.createElement("img");
  img.className = "lightbox-image";
  img.src = src;
  img.alt = alt;
  overlay.append(img);
  document.body.append(overlay);

  const finish = () => {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (event) => { if (event.key === "Escape") finish(); };
  overlay.addEventListener("click", finish);
  document.addEventListener("keydown", onKey);
}

mountTopbar();
mountSettingsMenu();
mountAccountMenu();
applyPermissionStyling();
