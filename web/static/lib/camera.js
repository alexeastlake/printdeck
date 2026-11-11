// Camera over WebRTC. Offer made here, relayed via the backend, video
// peer-to-peer from the printer. `card` has .cam-frame and .cam-status.

import { api, printerUrl } from "./api.js";

// Must outlast the backend's 15s negotiation timeout, plus the encoder can
// take a while to send a keyframe.
const CAMERA_TIMEOUT_MS = 25000;

function setCamStatus(card, state, text) {
  const status = card.querySelector(".cam-status");
  status.dataset.state = state;
  status.textContent = text;
  status.hidden = !text;
}

// Every await below can outlive this attempt (camera hidden, or restarted),
// so each step checks `card._pc === pc` before touching the card. Otherwise a
// stale attempt's failure tears down the connection that replaced it.
export async function startCamera(card, id) {
  resetConnection(card);
  const video = card.querySelector(".cam-frame");
  setCamStatus(card, "loading", "Connecting…");

  // STUN even on a LAN: browsers mask host candidates as .local mDNS names,
  // which the printer's WebRTC server can't resolve.
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  });
  card._pc = pc;
  const current = () => card._pc === pc;
  const fail = (message) => {
    if (!current()) return;
    setCamStatus(card, "error", message);
    resetConnection(card);
  };

  card._camWatchdog = setTimeout(() => fail("Camera didn't respond. Click to retry."), CAMERA_TIMEOUT_MS);

  // The printer's server expects sendrecv, same as its own page sends.
  pc.addTransceiver("video", { direction: "sendrecv" });
  pc.ontrack = (event) => { if (current()) video.srcObject = event.streams[0]; };
  pc.addEventListener("connectionstatechange", () => {
    if (pc.connectionState === "failed") fail("Camera connection failed. Click to retry.");
  });
  // Clear the overlay only once a frame actually renders.
  card._camOnPlaying = () => {
    setCamStatus(card, "", "");
    clearTimeout(card._camWatchdog);
    card._camWatchdog = null;
  };
  video.addEventListener("playing", card._camOnPlaying, { once: true });

  try {
    await pc.setLocalDescription(await pc.createOffer());
    await usableCandidate(pc);
    if (!current()) return;
    const res = await api(printerUrl(id, "/camera/offer"), {
      method: "POST",
      json: { sdp: pc.localDescription.sdp, type: "offer" },
    });
    const answer = await res.json();
    if (!current()) return;
    await pc.setRemoteDescription(answer);
  } catch (err) {
    if (!current()) return;
    console.error("camera failed", err);
    fail("Couldn't reach the camera. Click to retry.");
  }
}

// Tear down but keep the status message (used on failure).
function resetConnection(card) {
  const video = card.querySelector(".cam-frame");
  if (card._camWatchdog) { clearTimeout(card._camWatchdog); card._camWatchdog = null; }
  if (card._camOnPlaying) { video.removeEventListener("playing", card._camOnPlaying); card._camOnPlaying = null; }
  if (card._pc) { card._pc.close(); card._pc = null; }
  video.srcObject = null;
}

export function stopCamera(card) {
  resetConnection(card);
  setCamStatus(card, "", "");
}

// Click the error overlay to retry; click the video for fullscreen.
export function wireCamera(card, id) {
  const video = card.querySelector(".cam-frame");
  card.querySelector(".cam-status").addEventListener("click", (event) => {
    if (event.currentTarget.dataset.state === "error") startCamera(card, id);
  });
  video.addEventListener("click", () => {
    if (video.srcObject && document.fullscreenEnabled) video.requestFullscreen();
  });
}

// No trickle ICE on the printer side, so the offer needs a dialable
// candidate. Waiting for "complete" gathering is slow (IPv6, quiescence
// timer); the first non-mDNS candidate is enough.
function usableCandidate(pc, timeoutMs = 3000) {
  const isUsable = (candidate) => candidate && !candidate.candidate.includes(".local");
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      pc.removeEventListener("icecandidate", onCandidate);
      pc.removeEventListener("icegatheringstatechange", onStateChange);
      clearTimeout(timer);
      resolve();
    };
    const onCandidate = (event) => {
      if (isUsable(event.candidate)) done();
    };
    const onStateChange = () => {
      if (pc.iceGatheringState === "complete") done();
    };
    const timer = setTimeout(done, timeoutMs);
    pc.addEventListener("icecandidate", onCandidate);
    pc.addEventListener("icegatheringstatechange", onStateChange);
  });
}
