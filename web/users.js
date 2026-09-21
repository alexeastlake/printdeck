// PrintDeck user management (needs the manage_users permission). The page
// itself is also server-side gated (see app/main.py's /users route), but
// bounce accounts without it client-side too rather than showing a page
// that'll just 403 on every call.

const usersList = document.querySelector(".users-list");
const userRowTemplate = document.getElementById("user-row-template");
const usersStatus = document.querySelector(".users-status");
const addForm = document.querySelector(".users-add");
const addError = document.querySelector(".users-add-error");
const addBtn = document.querySelector(".users-add-btn");

let currentUsername = null;
let roles = [];  // fetched once — every role <select> on this page is built from this

function setStatus(text, isError = false) {
  usersStatus.textContent = text;
  usersStatus.hidden = !text;
  usersStatus.classList.toggle("users-error", isError);
}

async function loadRoles() {
  const res = await fetch("/api/roles");
  if (!res.ok) throw new Error(`error ${res.status}`);
  roles = await res.json();
}

function populateRoleSelect(select) {
  select.innerHTML = roles.map((r) => `<option value="${r.id}">${r.name}</option>`).join("");
}

async function loadUsers() {
  setStatus("Loading…");
  try {
    const res = await fetch("/api/users");
    if (res.status === 401) return void (location.href = "/login");
    if (res.status === 403) return void (location.href = "/");
    if (!res.ok) throw new Error(`error ${res.status}`);
    const users = await res.json();
    usersList.innerHTML = "";
    for (const user of users) usersList.append(userRow(user));
    setStatus("");
  } catch (err) {
    setStatus(`Couldn't load users: ${err.message}`, true);
  }
}

function userRow(user) {
  const li = userRowTemplate.content.firstElementChild.cloneNode(true);
  li.querySelector(".user-name").textContent = user.username;
  const roleSelect = li.querySelector(".user-role-select");
  populateRoleSelect(roleSelect);
  roleSelect.value = user.role;

  roleSelect.addEventListener("change", async () => {
    const previous = user.role;
    try {
      const res = await fetch(`/api/users/${encodeURIComponent(user.username)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: roleSelect.value }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || `error ${res.status}`);
      user.role = roleSelect.value;
      setStatus("");
    } catch (err) {
      roleSelect.value = previous;
      setStatus(`Couldn't change role: ${err.message}`, true);
    }
  });

  li.querySelector(".user-reset-password").addEventListener("click", async () => {
    const password = await promptDialog({
      title: `Reset password for ${user.username}`,
      label: "New password",
      confirmLabel: "Save",
    });
    if (!password) return;
    if (password.length < 8) return setStatus("Password needs to be at least 8 characters.", true);
    try {
      const res = await fetch(`/api/users/${encodeURIComponent(user.username)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || `error ${res.status}`);
      setStatus(`Password updated for ${user.username}.`);
    } catch (err) {
      setStatus(`Couldn't reset password: ${err.message}`, true);
    }
  });

  li.querySelector(".user-delete").addEventListener("click", async () => {
    const ok = await confirmDialog({
      title: "Delete user",
      message: `Delete "${user.username}"? This can't be undone.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await fetch(`/api/users/${encodeURIComponent(user.username)}`, { method: "DELETE" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || `error ${res.status}`);
      if (user.username === currentUsername) return void (location.href = "/login");
      loadUsers();
    } catch (err) {
      setStatus(`Couldn't delete user: ${err.message}`, true);
    }
  });

  return li;
}

addForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  addError.hidden = true;
  addBtn.disabled = true;
  try {
    const username = addForm.querySelector(".add-username").value.trim();
    const password = addForm.querySelector(".add-password").value;
    const role = addForm.querySelector(".add-role").value;
    const res = await fetch("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password, role }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || `error ${res.status}`);
    addForm.reset();
    loadUsers();
  } catch (err) {
    addError.textContent = err.message;
    addError.hidden = false;
  } finally {
    addBtn.disabled = false;
  }
});

fetchSession().then(async ({ permissions, user }) => {
  if (!(permissions || []).includes("manage_users")) return void (location.href = "/");
  currentUsername = user;
  try {
    await loadRoles();
  } catch (err) {
    setStatus(`Couldn't load roles: ${err.message}`, true);
    return;
  }
  populateRoleSelect(addForm.querySelector(".add-role"));
  loadUsers();
});
