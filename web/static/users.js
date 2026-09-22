// Users page. Server-gated on manage_users; also bounces client-side so a
// stale tab doesn't just 403 on every call.

const usersList = document.querySelector(".users-list");
const userRowTemplate = document.getElementById("user-row-template");
const usersStatus = document.querySelector(".users-status");
const addForm = document.querySelector(".users-add");
const addError = document.querySelector(".users-add-error");
const addBtn = document.querySelector(".users-add-btn");

let currentUsername = null;
let roles = [];  // fetched once; every role <select> on this page is built from this

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
  // Role names are user input, so no innerHTML.
  select.replaceChildren(...roles.map((r) => new Option(r.name, r.id)));
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
      await api(`/api/users/${encodeURIComponent(user.username)}`, { method: "PATCH", json: { role: roleSelect.value } });
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
      await api(`/api/users/${encodeURIComponent(user.username)}`, { method: "PATCH", json: { password } });
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
      await api(`/api/users/${encodeURIComponent(user.username)}`, { method: "DELETE" });
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
    await api("/api/users", { method: "POST", json: { username, password, role } });
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
