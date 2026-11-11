// Modals. Not confirm()/prompt(): native dialogs restore focus in a way that
// jumps the scroll position when the DOM under the trigger changes right
// after (delete-then-refresh).

// A titled panel over a backdrop. Escape or a click on the backdrop
// dismisses it (and calls `onDismiss`); `close()` removes it quietly.
export function openModal(title, { onDismiss } = {}) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal-panel" role="dialog" aria-modal="true">
      <p class="modal-title"></p>
      <div class="modal-body"></div>
    </div>
  `;
  overlay.querySelector(".modal-title").textContent = title;

  const onKey = (event) => { if (event.key === "Escape") dismiss(); };
  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  };
  const dismiss = () => {
    close();
    onDismiss?.();
  };
  overlay.addEventListener("click", (event) => { if (event.target === overlay) dismiss(); });
  document.addEventListener("keydown", onKey);
  document.body.append(overlay);
  return { overlay, body: overlay.querySelector(".modal-body"), close, dismiss };
}

// Enter in a text field submits. Listening on the fields, not the document,
// so Enter on a focused Cancel still means Cancel.
export function submitOnEnter(fields, submit) {
  for (const field of fields) {
    field.addEventListener("keydown", (event) => { if (event.key === "Enter") submit(); });
  }
}

export function confirmDialog({ title = "Are you sure?", message = "", confirmLabel = "Confirm", danger = false } = {}) {
  return new Promise((resolve) => {
    const { body, close } = openModal(title, { onDismiss: () => resolve(false) });
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
      close();
      resolve(result);
    };
    // Confirm is focused, so Enter already clicks it.
    body.querySelector(".modal-cancel").addEventListener("click", () => finish(false));
    confirmBtn.addEventListener("click", () => finish(true));
    confirmBtn.focus();
  });
}

export function promptDialog({ title = "Enter a value", label = "", value = "", confirmLabel = "Save" } = {}) {
  return new Promise((resolve) => {
    const { body, close } = openModal(title, { onDismiss: () => resolve(null) });
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
      close();
      resolve(result);
    };
    const submit = () => finish(input.value.trim() || null);
    body.querySelector(".modal-cancel").addEventListener("click", () => finish(null));
    confirmBtn.addEventListener("click", submit);
    submitOnEnter([input], submit);
    input.focus();
    input.select();
  });
}

export function openImageLightbox(src, alt = "") {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay lightbox-overlay";
  const img = document.createElement("img");
  img.className = "lightbox-image";
  img.src = src;
  img.alt = alt;
  overlay.append(img);
  document.body.append(overlay);

  const onKey = (event) => { if (event.key === "Escape") close(); };
  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  };
  overlay.addEventListener("click", close);
  document.addEventListener("keydown", onKey);
}
