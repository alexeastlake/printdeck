// What every detail-page module shares: which printer, its root element, and
// the latest status.

import { printerUrl } from "../lib/api.js";

export const printerId = decodeURIComponent(location.pathname.split("/").pop());
export const card = document.getElementById("detail-card");

// Most recent status. main.js sets it before rendering, for handlers that
// run between updates (a jog needs the current position).
export const live = { status: null };

export function printerApiUrl(suffix = "") {
  return printerUrl(printerId, suffix);
}

export function thumbnailUrl(path) {
  return printerApiUrl(`/files/thumbnail?filename=${encodeURIComponent(path)}`);
}

// A small preview that only appears once it has actually loaded; `fallback`
// (an icon) stays until then, and for files with no thumbnail.
export function wireThumb(img, fallback, path) {
  img.loading = "lazy";
  img.addEventListener("load", () => { img.hidden = false; if (fallback) fallback.hidden = true; });
  img.addEventListener("error", () => { img.hidden = true; });
  img.src = thumbnailUrl(path);
}
