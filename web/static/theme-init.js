// Blocking <script> in <head>: applies the saved theme before first paint.
// Modules load too late for that. Not inline, so CSP needs no hashes.
try {
  var t = localStorage.getItem("printdeck-theme");
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
} catch (e) { /* no storage: system theme */ }
