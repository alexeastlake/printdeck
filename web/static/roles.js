// Roles page. Server-gated on manage_roles; also bounces client-side so a
// stale tab doesn't just 403 on every call.

const rolesList = document.querySelector(".roles-list");
const roleRowTemplate = document.getElementById("role-row-template");
const rolesStatus = document.querySelector(".roles-status");
const addForm = document.querySelector(".roles-add");
const addPermissionsField = document.querySelector(".add-permissions");
const addError = document.querySelector(".roles-add-error");
const addBtn = document.querySelector(".roles-add-btn");

let permissionCatalog = [];  // fetched once; {id, label, description}[]

function setStatus(text, isError = false) {
  rolesStatus.textContent = text;
  rolesStatus.hidden = !text;
  rolesStatus.classList.toggle("users-error", isError);
}

async function loadPermissionCatalog() {
  const res = await fetch("/api/permissions");
  if (!res.ok) throw new Error(`error ${res.status}`);
  permissionCatalog = await res.json();
}

// Catalog comes from the backend (trusted), so an HTML string is fine here.
function permissionCheckboxesHtml(checkedIds, namePrefix) {
  return permissionCatalog.map((p) => `
    <label class="permission-option" title="${p.description}">
      <input type="checkbox" name="${namePrefix}" value="${p.id}" ${checkedIds.includes(p.id) ? "checked" : ""}>
      ${p.label}
    </label>
  `).join("");
}

function checkedPermissions(container) {
  return [...container.querySelectorAll("input[type=checkbox]:checked")].map((el) => el.value);
}

function permissionLabels(ids) {
  const byId = Object.fromEntries(permissionCatalog.map((p) => [p.id, p.label]));
  return ids.length ? ids.map((id) => byId[id] || id).join(", ") : "None (read-only)";
}

async function loadRoles() {
  setStatus("Loading…");
  try {
    const res = await fetch("/api/roles");
    if (res.status === 401) return void (location.href = "/login");
    if (res.status === 403) return void (location.href = "/");
    if (!res.ok) throw new Error(`error ${res.status}`);
    const roles = await res.json();
    rolesList.innerHTML = "";
    for (const role of roles) rolesList.append(roleRow(role));
    setStatus("");
  } catch (err) {
    setStatus(`Couldn't load roles: ${err.message}`, true);
  }
}

function roleRow(role) {
  const li = roleRowTemplate.content.firstElementChild.cloneNode(true);
  li.querySelector(".role-name").textContent = role.name;
  li.querySelector(".role-permissions").textContent = permissionLabels(role.permissions);

  li.querySelector(".role-edit").addEventListener("click", () => openEditRoleDialog(role));

  li.querySelector(".role-delete").addEventListener("click", async () => {
    const ok = await confirmDialog({
      title: "Delete role",
      message: `Delete "${role.name}"? This can't be undone.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await api(`/api/roles/${encodeURIComponent(role.id)}`, { method: "DELETE" });
      loadRoles();
    } catch (err) {
      setStatus(`Couldn't delete role: ${err.message}`, true);
    }
  });

  return li;
}

function openEditRoleDialog(role) {
  const { overlay, body } = openModal(`Edit "${role.name}"`);
  body.innerHTML = `
    <label class="modal-field">
      <span>Name</span>
      <input type="text" class="modal-input edit-role-name" autocomplete="off">
    </label>
    <fieldset class="roles-permissions edit-role-permissions">
      <legend>Permissions</legend>
      ${permissionCheckboxesHtml(role.permissions, "edit-permission")}
    </fieldset>
    <div class="modal-actions">
      <button type="button" class="modal-cancel">Cancel</button>
      <button type="button" class="modal-confirm">Save</button>
    </div>
    <p class="modal-message edit-role-error" hidden></p>
  `;
  const nameInput = body.querySelector(".edit-role-name");
  const permissionsField = body.querySelector(".edit-role-permissions");
  const errorEl = body.querySelector(".edit-role-error");
  const confirmBtn = body.querySelector(".modal-confirm");
  nameInput.value = role.name;

  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  };

  const submit = async () => {
    errorEl.hidden = true;
    const name = nameInput.value.trim();
    if (!name) {
      errorEl.textContent = "Name can't be empty.";
      errorEl.hidden = false;
      return;
    }
    confirmBtn.disabled = true;
    try {
      await api(`/api/roles/${encodeURIComponent(role.id)}`, { method: "PATCH", json: { name, permissions: checkedPermissions(permissionsField) } });
      close();
      loadRoles();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
      confirmBtn.disabled = false;
    }
  };

  const onKey = (event) => { if (event.key === "Escape") close(); };
  overlay.addEventListener("click", (event) => { if (event.target === overlay) close(); });
  body.querySelector(".modal-cancel").addEventListener("click", close);
  confirmBtn.addEventListener("click", submit);
  document.addEventListener("keydown", onKey);
  nameInput.focus();
}

addForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  addError.hidden = true;
  addBtn.disabled = true;
  try {
    const name = addForm.querySelector(".add-role-name").value.trim();
    await api("/api/roles", { method: "POST", json: { name, permissions: checkedPermissions(addPermissionsField) } });
    addForm.reset();
    loadRoles();
  } catch (err) {
    addError.textContent = err.message;
    addError.hidden = false;
  } finally {
    addBtn.disabled = false;
  }
});

fetchSession().then(async ({ permissions }) => {
  if (!(permissions || []).includes("manage_roles")) return void (location.href = "/");
  try {
    await loadPermissionCatalog();
  } catch (err) {
    setStatus(`Couldn't load permissions: ${err.message}`, true);
    return;
  }
  addPermissionsField.innerHTML = permissionCheckboxesHtml([], "add-permission");
  loadRoles();
});
