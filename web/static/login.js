// Sign-in form. Separate file so CSP can stay script-src 'self'.

import { api } from "./lib/api.js";

const form = document.getElementById("login");
const error = form.querySelector(".login-error");
const button = form.querySelector(".login-btn");

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  error.hidden = true;
  button.disabled = true;
  try {
    await api("/auth/login", {
      method: "POST",
      json: { username: form.username.value, password: form.password.value },
    });
    location.href = "/";
  } catch (err) {
    error.textContent = err.message;
    error.hidden = false;
  } finally {
    button.disabled = false;
  }
});
