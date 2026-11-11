// The live feed: /ws, falling back to polling /api/printers while it's down.
//
// onFull gets every printer (the ws snapshot or a poll), so it should drop
// any it already shows that aren't in the list. onUpdate gets one printer,
// onRemoved an id. Reports connection state in #conn (see chrome.js).

import { api } from "./api.js";

const RECONNECT_MS = 3000;
const POLL_MS = 5000;

export function connectLive({ onFull, onUpdate, onRemoved }) {
  const connLabel = document.getElementById("conn");
  let pollTimer = null;

  const setConn = (state, label) => {
    connLabel.dataset.state = state;
    connLabel.textContent = label;
  };

  const poll = async () => {
    try {
      onFull(await (await api("/api/printers")).json());
    } catch (err) {
      if (err.status === 401) location.href = "/login";  // session expired
      /* otherwise still offline; the next tick will try again */
    }
  };

  const startPolling = () => {
    if (pollTimer) return;
    poll();
    pollTimer = setInterval(poll, POLL_MS);
  };

  const stopPolling = () => {
    clearInterval(pollTimer);
    pollTimer = null;
  };

  const connect = () => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${proto}://${location.host}/ws`);

    socket.addEventListener("open", () => {
      setConn("open", "Connected to server");
      stopPolling();
    });

    socket.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === "snapshot") onFull(msg.printers);
      else if (msg.type === "update") onUpdate(msg.printer);
      else if (msg.type === "removed") onRemoved(msg.id);
    });

    socket.addEventListener("close", () => {
      setConn("closed", "Reconnecting to server…");
      startPolling();
      setTimeout(connect, RECONNECT_MS);
    });

    socket.addEventListener("error", () => socket.close());
  };

  connect();
}
