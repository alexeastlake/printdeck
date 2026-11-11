// fetch() wrappers for PrintDeck's own API.

// fetch() that throws Error(detail) on a non-2xx, with the HTTP code on
// err.status. Returns the Response for callers that need the body. `json`
// sets the body and content-type.
export async function api(url, { method = "GET", json, body, headers } = {}) {
  const init = { method, headers: { ...(headers || {}) } };
  if (json !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(json);
  } else if (body !== undefined) {
    init.body = body;
  }
  const res = await fetch(url, init);
  if (!res.ok) {
    const err = new Error(errorDetail(await res.json().catch(() => ({})), res.status));
    err.status = res.status;
    throw err;
  }
  return res;
}

// Our HTTPExceptions carry a string; FastAPI's own validation errors (422)
// carry a list of {loc, msg}.
export function errorDetail(body, status) {
  const detail = body?.detail;
  if (typeof detail === "string" && detail) return detail;
  if (Array.isArray(detail) && detail.length) {
    return detail.map((d) => (d.loc?.length ? `${d.loc.at(-1)}: ${d.msg}` : d.msg)).join("; ");
  }
  return `error ${status}`;
}

export function printerUrl(id, suffix = "") {
  return `/api/printers/${encodeURIComponent(id)}${suffix}`;
}

// Fetched once per page; everything that needs it shares the promise.
let sessionPromise = null;
export function fetchSession() {
  if (!sessionPromise) {
    sessionPromise = fetch("/api/session")
      .then((r) => r.json())
      .catch(() => ({ enabled: false, user: null, role: null, role_name: null, permissions: [] }));
  }
  return sessionPromise;
}
