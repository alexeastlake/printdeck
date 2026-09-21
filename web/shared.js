// Code shared between the dashboard (app.js) and the printer detail page
// (detail.js). Loaded before either, as a plain script — no build step, so
// these are just global functions.

const STATE_COLOR = {
  idle: "var(--idle)",
  printing: "var(--printing)",
  paused: "var(--paused)",
  error: "var(--error)",
  offline: "var(--offline)",
  connecting: "var(--connecting)",
};

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

// --- editing a printer (name / host / group) ---------------------------------
// Used both by the dashboard card's inline editor and the detail page's own
// copy of the same form. `root` is any element containing the same class
// names as the card template's .editor form.

function wirePrinterEditor(root, id) {
  const editor = root.querySelector(".editor");
  const nameInput = root.querySelector(".name-input");
  const hostInput = root.querySelector(".host-input");
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
      const res = await fetch(`/api/printers/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: nameInput.value.trim(),
          host: hostInput.value.trim(),
          camera_url: cameraUrlInput.value.trim(),
          group: groupInput.value.trim(),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail || `error ${res.status}`);
      }
      editor.hidden = true;  // success — the live feed repaints the page
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
      message: `Remove "${root.querySelector(".name").textContent}" from PrintDeck? This only stops PrintDeck from managing it — the printer itself isn't affected.`,
      confirmLabel: "Remove",
      danger: true,
    });
    if (!ok) return;
    deleteBtn.disabled = true;
    try {
      const res = await fetch(`/api/printers/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail || `error ${res.status}`);
      }
      // On the detail page there's nothing left to show; on the dashboard
      // the card removes itself once the live feed's "removed" event
      // arrives, so nothing else to do here in that case.
      if (root.id === "detail-card") location.href = "/";
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
      deleteBtn.disabled = false;
    }
  });
}

// --- camera (WebRTC) ---------------------------------------------------------
// The printer runs a tiny WebRTC server. We make the offer here, relay it
// through our backend (which forwards it to the printer), and the video then
// streams peer-to-peer straight from the printer to whichever page asked.
// `card` is any element with the same .cam-frame/.cam-status children as the
// card template (the dashboard card, or the detail page's camera block).

// The connection itself is normally fast (well under a second), but a frame
// won't actually render until the printer's encoder sends a keyframe, which
// can lag behind — so give it a generous window before calling it failed
// rather than leaving a black box up forever. Needs to comfortably outlast
// the backend's own negotiation timeout (15s, see _negotiate in routes.py —
// a ".local" hostname can need most of that just for DNS) or this fires
// and gives up while the backend request is still genuinely in flight.
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

  // STUN is required even on a LAN: browsers hide a host candidate's real IP
  // behind a random ".local" mDNS name for privacy, which the printer's tiny
  // WebRTC server can't resolve. STUN hands back a server-reflexive
  // candidate carrying the real, dialable LAN IP instead.
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  });
  card._pc = pc;
  // Mirror the printer page's own handshake (it offers sendrecv even though we
  // only ever receive); its minimal server expects exactly this.
  pc.addTransceiver("video", { direction: "sendrecv" });
  pc.ontrack = (event) => { video.srcObject = event.streams[0]; };
  pc.addEventListener("connectionstatechange", () => {
    if (pc.connectionState === "failed") {
      setCamStatus(card, "error", "Camera connection failed. Click to retry.");
      resetConnection(card);
    }
  });
  // The status overlay sits on top of the video regardless of what's
  // rendering underneath, so only clear it once a frame is actually visible —
  // and cancel the watchdog, since we made it after all.
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

// Tears down the peer connection but leaves whatever status message is
// showing in place — used on failure, where the message *is* the point.
function resetConnection(card) {
  const video = card.querySelector(".cam-frame");
  if (card._camWatchdog) { clearTimeout(card._camWatchdog); card._camWatchdog = null; }
  if (card._pc) { card._pc.close(); card._pc = null; }
  video.srcObject = null;
}

// User-facing "hide camera" / printer-went-offline path: tear down and go
// quiet, no lingering error from a previous attempt.
function stopCamera(card) {
  resetConnection(card);
  setCamStatus(card, "", "");
}

// The printer's server expects a complete offer (no trickle ICE), so we need
// at least one candidate the printer can actually dial before sending it.
// Waiting for gathering to reach "complete" works but is slower than it
// needs to be — it also waits out irrelevant candidates (IPv6, other
// interfaces) and a quiescence timer. Resolving as soon as the first usable
// (non-mDNS) candidate arrives is normally much quicker, since that's
// typically the first — and only — thing STUN returns on a LAN.
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
// The actual light/dark values live in style.css; this just decides which
// set applies. "system" means no override — let the prefers-color-scheme
// media query decide. The very first paint is handled separately by an
// inline snippet in each page's <head> (see index.html etc.), since loading
// this file is too late to avoid a flash of the wrong theme.

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
  } catch { /* private browsing, storage disabled, etc. — theme just won't persist */ }
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}

// --- session info (cached) --------------------------------------------------
// Fetched once per page load, shared by mountAccountMenu/mountSettingsMenu/the
// viewer-role CSS hook below — no reason for each to hit the endpoint itself.

let _sessionPromise = null;
function fetchSession() {
  if (!_sessionPromise) {
    _sessionPromise = fetch("/api/session")
      .then((r) => r.json())
      .catch(() => ({ enabled: false, user: null, role: null, role_name: null, permissions: [] }));
  }
  return _sessionPromise;
}

// A role missing a given permission can look at everything but can't do
// whatever that permission covers — rather than thread a permission check
// through app.js/detail.js for every button, tag <body> with one class per
// permission the account actually has, once, and let style.css blanket-hide
// controls by selector (body:not(.can-manage-printers) .edit-toggle, etc).
function applyPermissionStyling() {
  fetchSession().then(({ permissions }) => {
    for (const permission of permissions || []) {
      document.body.classList.add(`can-${permission.replace(/_/g, "-")}`);
    }
  });
}

// --- header dropdowns ---------------------------------------------------
// Shared open/close/outside-click/Escape wiring for any toggle-button +
// panel pair in the header (Settings, Account). `menu` should already be
// inserted right after `toggle` inside its own .dropdown wrapper (see
// style.css) so it anchors under that specific button.

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
  // Clicking inside the menu itself shouldn't close it (it has its own
  // inputs/buttons); clicking anywhere else on the page should.
  menu.addEventListener("click", (event) => event.stopPropagation());
  document.addEventListener("click", close);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
  });
}

// --- settings menu -----------------------------------------------------------
// A small dropdown off the ⚙ button in the header. Not enough settings yet
// (just the theme, plus a link to the source) to earn its own page — every
// page that has a #settings-toggle button gets this wired up automatically.

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
// Off the 👤 button — who's signed in, their role, and Sign out. Hidden
// entirely when auth is off (there's no "account" to show).

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
    // An initial rather than a person icon — renders with the same plain,
    // monochrome text styling as the ⚙/+ buttons next to it (an emoji
    // glyph doesn't take the button's color and looks out of place), and
    // it's a bit more useful: which account, not just "some account".
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

// --- modal dialogs -------------------------------------------------------
// Stand-ins for confirm()/prompt() — those are native browser dialogs, and
// closing one hands focus back to whatever triggered it in a way that can
// yank the page's scroll position around when the DOM under that element
// changes right after (exactly what a delete-then-refresh does). A dialog
// we build ourselves doesn't have that problem, and looks like the rest of
// the site instead of an OS alert box.

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
    const onKey = (event) => {
      if (event.key === "Escape") finish(false);
      if (event.key === "Enter") finish(true);
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
      if (event.key === "Enter") submit();
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
// Click-to-enlarge for a small image (the print thumbnail) — same
// backdrop/Escape-to-close pattern as the other modals, just no title or
// buttons: the image itself, as big as it'll fit.

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

mountSettingsMenu();
mountAccountMenu();
applyPermissionStyling();
