// Page chrome every logged-in page shares: the topbar, its settings and
// account menus, the theme switch, and the body.can-* permission classes.
// Each page's entry module calls mountChrome() before anything else.

import { fetchSession } from "./api.js";

const GITHUB_USER = "alexeastlake";
const GITHUB_URL = `https://github.com/${GITHUB_USER}/printdeck`;
const THEME_KEY = "printdeck-theme";

export function mountChrome() {
  mountTopbar();
  mountSettingsMenu();
  mountAccountMenu();
  applyPermissionStyling();
}

// --- theme --------------------------------------------------------------------
// "system" = no override. First paint is handled by theme-init.js; modules
// load too late for that.

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

// One body.can-<permission> class per permission; style.css hides controls
// by selector instead of every page checking.
function applyPermissionStyling() {
  fetchSession().then(({ permissions }) => {
    for (const permission of permissions || []) {
      document.body.classList.add(`can-${permission.replace(/_/g, "-")}`);
    }
  });
}

// --- topbar --------------------------------------------------------------------
// Pages ship an empty <header class="topbar">; data-conn adds #conn (see
// live.js), data-add-printer adds the + button. Static markup only.

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
