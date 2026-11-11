// The printer settings editor (dashboard card or detail page) and the
// "scan for a moved printer" dialog it opens.

import { api, printerUrl } from "./api.js";
import { confirmDialog, openModal, submitOnEnter } from "./dialogs.js";

const API_KEY_UNCHANGED = "••••••••";  // the key is never sent to the browser

// `root` is the card or #detail-card; current values come from its dataset
// (see renderCardHeader).
export function wirePrinterEditor(root, id) {
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

  const showError = (message) => {
    error.textContent = message;
    error.hidden = !message;
  };

  root.querySelector(".edit-toggle").addEventListener("click", () => {
    const opening = editor.hidden;
    editor.hidden = !opening;
    if (opening) {
      showError("");
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

  // Fills the form only; nothing changes until Save.
  root.querySelector(".btn-scan").addEventListener("click", async () => {
    const oldHost = hostInput.value.trim();
    const host = await scanDialog(id, oldHost);
    if (!host || host === oldHost) return;
    hostInput.value = host;
    // Save sends the camera URL explicitly, so the server won't move it for us.
    try {
      const camera = new URL(cameraUrlInput.value.trim());
      if (camera.hostname === oldHost) {
        camera.hostname = host;
        cameraUrlInput.value = camera.href;
      }
    } catch { /* empty or not a URL: leave it */ }
  });

  editor.addEventListener("submit", async (event) => {
    event.preventDefault();
    showError("");
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
      await api(printerUrl(id), { method: "PATCH", json: body });
      editor.hidden = true;  // the live feed repaints
    } catch (err) {
      showError(err.message);
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
      await api(printerUrl(id), { method: "DELETE" });
      // Dashboard cards remove themselves on the "removed" event.
      if (root.id === "detail-card") location.href = "/";
    } catch (err) {
      showError(err.message);
      deleteBtn.disabled = false;
    }
  });
}

// --- scan for a moved printer -----------------------------------------------------
// For printers that get a new DHCP address every boot. The server probes the
// range for Moonraker; resolves with the picked IP, or null.

const SCAN_SPREAD = 15;  // default range: this many either side of the last IP

export function defaultScanRange(host) {
  const match = /^(\d{1,3}\.\d{1,3}\.\d{1,3})\.(\d{1,3})$/.exec(host || "");
  if (!match) return ["", ""];
  const last = Number(match[2]);
  return [`${match[1]}.${Math.max(1, last - SCAN_SPREAD)}`, `${match[1]}.${Math.min(254, last + SCAN_SPREAD)}`];
}

function scanDialog(id, currentHost) {
  return new Promise((resolve) => {
    const { body, close } = openModal("Scan for printer", { onDismiss: () => resolve(null) });
    body.innerHTML = `
      <p class="modal-message">Looks for Moonraker on each IP in the range, using this printer's port and API key.</p>
      <div class="scan-range">
        <label class="modal-field">
          <span>From</span>
          <input type="text" class="modal-input scan-start" inputmode="decimal" autocomplete="off" spellcheck="false" placeholder="192.168.1.100">
        </label>
        <label class="modal-field">
          <span>To</span>
          <input type="text" class="modal-input scan-end" inputmode="decimal" autocomplete="off" spellcheck="false" placeholder="192.168.1.130">
        </label>
      </div>
      <p class="modal-message scan-status" hidden></p>
      <ul class="scan-results" hidden></ul>
      <div class="modal-actions">
        <button type="button" class="modal-cancel">Cancel</button>
        <button type="button" class="modal-confirm">Scan</button>
      </div>
    `;
    const startInput = body.querySelector(".scan-start");
    const endInput = body.querySelector(".scan-end");
    const statusEl = body.querySelector(".scan-status");
    const resultsEl = body.querySelector(".scan-results");
    const scanBtn = body.querySelector(".modal-confirm");
    [startInput.value, endInput.value] = defaultScanRange(currentHost);

    const finish = (result) => {
      close();
      resolve(result);
    };

    const scan = async () => {
      if (scanBtn.disabled) return;  // Enter while a scan is running
      scanBtn.disabled = true;
      resultsEl.hidden = true;
      resultsEl.replaceChildren();
      statusEl.textContent = "Scanning…";
      statusEl.hidden = false;
      try {
        const res = await api(printerUrl(id, "/scan"), {
          method: "POST",
          json: { start: startInput.value.trim(), end: endInput.value.trim() },
        });
        const found = await res.json();
        statusEl.textContent = found.length
          ? "Pick one, then Save the printer settings."
          : "No Moonraker found in that range. Is the printer on?";
        for (const { host, hostname } of found) {
          const item = document.createElement("li");
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "scan-result";
          btn.textContent = [host, hostname, host === currentHost ? "(current)" : ""].filter(Boolean).join(" · ");
          btn.addEventListener("click", () => finish(host));
          item.append(btn);
          resultsEl.append(item);
        }
        resultsEl.hidden = !found.length;
      } catch (err) {
        statusEl.textContent = err.message;
      } finally {
        scanBtn.disabled = false;
      }
    };

    body.querySelector(".modal-cancel").addEventListener("click", () => finish(null));
    scanBtn.addEventListener("click", scan);
    submitOnEnter([startInput, endInput], scan);
    startInput.focus();
  });
}
