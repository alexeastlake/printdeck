// PrintDeck frontend. No framework: open the websocket, keep one card per
// printer in sync, and fall back to polling if the socket goes away.

const fleet = document.getElementById("fleet");
const emptyNote = document.getElementById("empty");
const connLabel = document.getElementById("conn");
const cardTemplate = document.getElementById("card-template");

const STATE_COLOR = {
  idle: "var(--idle)",
  printing: "var(--printing)",
  paused: "var(--paused)",
  error: "var(--error)",
  offline: "var(--offline)",
};

// Keep references to each card so updates are a cheap lookup, not a re-render.
const cards = new Map();

// --- rendering -------------------------------------------------------------

function cardFor(id) {
  let card = cards.get(id);
  if (card) return card;

  card = cardTemplate.content.firstElementChild.cloneNode(true);
  cards.set(id, card);
  fleet.append(card);

  const toggle = card.querySelector(".cam-toggle");
  const camera = card.querySelector(".camera");
  const video = card.querySelector(".cam-frame");
  toggle.addEventListener("click", () => {
    const showing = !camera.hidden;
    camera.hidden = showing;
    toggle.textContent = showing ? "Show camera" : "Hide camera";
    // Open the WebRTC connection only on reveal; tear it down when hidden.
    if (showing) stopCamera(card);
    else startCamera(card, id);
  });
  // The preview fills the card; click it to see the whole frame fullscreen.
  video.addEventListener("click", () => {
    if (video.srcObject && document.fullscreenEnabled) video.requestFullscreen();
  });

  return card;
}

function render(status) {
  emptyNote.hidden = true;
  const card = cardFor(status.id);
  card.style.setProperty("--state", STATE_COLOR[status.state] || STATE_COLOR.offline);

  card.querySelector(".name").textContent = status.name;

  const badge = card.querySelector(".badge");
  badge.textContent = status.online ? status.state : "offline";

  card.querySelector(".nozzle").innerHTML = temp(status.extruder_temp, status.extruder_target);
  card.querySelector(".bed").innerHTML = temp(status.bed_temp, status.bed_target);

  renderJob(card, status);
  renderCamera(card, status);
}

function renderJob(card, status) {
  const job = card.querySelector(".job");
  const active = status.state === "printing" || status.state === "paused";
  job.hidden = !active;
  if (!active) return;

  card.querySelector(".progress-bar").style.width = `${Math.round((status.progress || 0) * 100)}%`;
  card.querySelector(".filename").textContent = status.filename || "—";
  card.querySelector(".eta").textContent = eta(status.eta_seconds);
}

function renderCamera(card, status) {
  const toggle = card.querySelector(".cam-toggle");
  if (status.camera_url && status.online) {
    toggle.hidden = false;
  } else {
    // No camera, or the printer dropped off — hide and tear down any stream.
    toggle.hidden = true;
    card.querySelector(".camera").hidden = true;
    toggle.textContent = "Show camera";
    stopCamera(card);
  }
}

// --- camera (WebRTC) -------------------------------------------------------
// The printer runs a tiny WebRTC server. We make the offer here, relay it
// through our backend (which forwards it to the printer), and the video then
// streams peer-to-peer straight from the printer to this page.

async function startCamera(card, id) {
  const video = card.querySelector(".cam-frame");
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  });
  card._pc = pc;
  // Mirror the printer page's own handshake (it offers sendrecv even though we
  // only ever receive); its minimal server expects exactly this.
  pc.addTransceiver("video", { direction: "sendrecv" });
  pc.ontrack = (event) => { video.srcObject = event.streams[0]; };

  try {
    await pc.setLocalDescription(await pc.createOffer());
    await iceGatheringComplete(pc);
    const res = await fetch(`/api/printers/${id}/camera/offer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sdp: pc.localDescription.sdp, type: "offer" }),
    });
    if (!res.ok) throw new Error(`signaling ${res.status}`);
    await pc.setRemoteDescription(await res.json());
  } catch (err) {
    console.error("camera failed", err);
    stopCamera(card);
  }
}

function stopCamera(card) {
  const video = card.querySelector(".cam-frame");
  if (card._pc) { card._pc.close(); card._pc = null; }
  video.srcObject = null;
}

// The printer's server expects a complete offer (no trickle ICE), so wait for
// candidate gathering to finish before we send it.
function iceGatheringComplete(pc) {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const check = () => {
      if (pc.iceGatheringState === "complete") {
        pc.removeEventListener("icegatheringstatechange", check);
        resolve();
      }
    };
    pc.addEventListener("icegatheringstatechange", check);
  });
}

// --- small formatters ------------------------------------------------------

function temp(current, target) {
  const now = `${current.toFixed(1)}°`;
  return target > 0 ? `${now} <span class="target">→ ${Math.round(target)}°</span>` : now;
}

function eta(seconds) {
  if (seconds == null) return "";
  const m = Math.round(seconds / 60);
  if (m < 60) return `~${m}m left`;
  const h = Math.floor(m / 60);
  return `~${h}h ${m % 60}m left`;
}

// --- live connection -------------------------------------------------------

let pollTimer = null;

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${proto}://${location.host}/ws`);

  socket.addEventListener("open", () => {
    setConn("open", "live");
    stopPolling();
  });

  socket.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === "snapshot") {
      if (msg.printers.length === 0) emptyNote.hidden = false;
      msg.printers.forEach(render);
    } else if (msg.type === "update") {
      render(msg.printer);
    }
  });

  socket.addEventListener("close", () => {
    setConn("closed", "reconnecting…");
    startPolling();
    setTimeout(connect, 3000);
  });

  socket.addEventListener("error", () => socket.close());
}

// While the socket is down, keep the cards roughly current over plain REST.
function startPolling() {
  if (pollTimer) return;
  const tick = async () => {
    try {
      const res = await fetch("/api/printers");
      (await res.json()).forEach(render);
    } catch { /* still offline; the next tick will try again */ }
  };
  tick();
  pollTimer = setInterval(tick, 5000);
}

function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
}

function setConn(state, label) {
  connLabel.dataset.state = state;
  connLabel.textContent = label;
}

connect();
