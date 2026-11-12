// The printer camera. `card` has canvas.cam-frame and .cam-status.
//
// The browser never talks to the printer: the server watches the camera and
// passes it down /ws/camera/<id>, one binary message per frame. Same path
// on the LAN and through a reverse proxy or tunnel. Two formats:
//
// - h264: the printer's own 1080p video, untouched, decoded here with
//   WebCodecs. Each message is a flag byte (1 = keyframe) + an Annex B frame.
// - jpeg: the server transcodes to 720p JPEGs. For browsers without
//   WebCodecs, which includes every browser on a plain-HTTP origin other
//   than localhost.

// Must outlast the server's own wait for the printer (15s to negotiate,
// then up to 20s for a first keyframe); normally it closes the socket with
// a reason well before this.
const CAMERA_TIMEOUT_MS = 40000;
// The server gives up on a silent camera after 15s and closes the socket;
// this only catches a connection that died without a close.
const STALL_MS = 20000;
// Frames queued in the decoder before we skip ahead to the next keyframe
// (~2s; a device that can't decode 1080p in real time).
const MAX_DECODE_QUEUE = 30;

// Cleared for the rest of the page's life if this browser turns out not to
// decode the camera's stream.
let h264Usable = typeof VideoDecoder === "function";

function setCamStatus(card, state, text) {
  const status = card.querySelector(".cam-status");
  status.dataset.state = state;
  status.textContent = text;
  status.hidden = !text;
}

function armWatchdog(card, ms, onExpire) {
  clearTimeout(card._camWatchdog);
  card._camWatchdog = setTimeout(onExpire, ms);
}

// "avc1.4d0029" from the SPS (NAL type 7) in a keyframe: profile,
// constraint flags, level. The SDP's profile-level-id isn't the truth.
function codecFromKeyframe(data) {
  for (let i = 0; i + 6 < data.length && i < 512; i++) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1 && (data[i + 3] & 0x1f) === 7) {
      const hex = (byte) => byte.toString(16).padStart(2, "0");
      return `avc1.${hex(data[i + 4])}${hex(data[i + 5])}${hex(data[i + 6])}`;
    }
  }
  return null;
}

// Every callback below can outlive its attempt (camera hidden, or
// restarted), so each checks current() before touching the card. Otherwise
// a stale attempt's failure tears down the one that replaced it.
export function startCamera(card, id) {
  resetConnection(card);
  setCamStatus(card, "loading", "Connecting…");
  const canvas = card.querySelector(".cam-frame");
  const context = canvas.getContext("2d");
  const token = {};
  card._camAttempt = token;
  const current = () => card._camAttempt === token;
  const fail = (message) => {
    if (!current()) return;
    setCamStatus(card, "error", message);
    resetConnection(card);
  };
  armWatchdog(card, CAMERA_TIMEOUT_MS, () => fail("Camera didn't respond. Click to retry."));

  // `picture` is a VideoFrame or an ImageBitmap.
  const paint = (picture, width, height) => {
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    context.drawImage(picture, 0, 0);
    if (!card._camLive) {
      card._camLive = true;
      setCamStatus(card, "", "");
    }
    armWatchdog(card, STALL_MS, () => fail("Camera stopped. Click to retry."));
  };

  const format = h264Usable ? "h264" : "jpeg";
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(
    `${proto}://${location.host}/ws/camera/${encodeURIComponent(id)}?format=${format}`,
  );
  socket.binaryType = "arraybuffer";
  card._camSocket = socket;
  socket.addEventListener("close", (event) => {
    fail(`${event.reason || "Camera connection lost."} Click to retry.`);
  });

  if (format === "h264") {
    const useJpegInstead = (why) => {
      if (!current()) return;
      console.warn("camera: can't decode H.264 here, using JPEG frames", why);
      h264Usable = false;
      startCamera(card, id);
    };
    let decoder = null;
    let skipToKeyframe = false;
    socket.addEventListener("message", (event) => {
      if (!current()) return;
      const message = new Uint8Array(event.data);
      const keyframe = message[0] === 1;
      const data = message.subarray(1);
      try {
        if (!decoder) {
          const codec = codecFromKeyframe(data);  // the stream always opens on a keyframe
          if (!codec) throw new Error("no SPS in the first frame");
          decoder = new VideoDecoder({
            output: (frame) => {
              if (current()) paint(frame, frame.displayWidth, frame.displayHeight);
              frame.close();
            },
            error: useJpegInstead,
          });
          // No `description`: that's what tells it the data is Annex B.
          decoder.configure({ codec, optimizeForLatency: true });
          card._camDecoder = decoder;
        }
        if (decoder.decodeQueueSize > MAX_DECODE_QUEUE) skipToKeyframe = true;
        if (skipToKeyframe && !keyframe) return;
        skipToKeyframe = false;
        decoder.decode(new EncodedVideoChunk({
          type: keyframe ? "key" : "delta",
          timestamp: performance.now() * 1000,
          data,
        }));
      } catch (err) {
        useJpegInstead(err);
      }
    });
  } else {
    // One decode at a time, newest frame wins: on a slow link the picture
    // lags by one frame instead of by a growing queue.
    let decoding = false;
    let waiting = null;
    const show = async (buffer) => {
      decoding = true;
      try {
        const bitmap = await createImageBitmap(new Blob([buffer], { type: "image/jpeg" }));
        if (current()) paint(bitmap, bitmap.width, bitmap.height);
        bitmap.close();
      } catch { /* a bad frame; the next one replaces it */ }
      decoding = false;
      if (waiting && current()) {
        const next = waiting;
        waiting = null;
        show(next);
      }
    };
    socket.addEventListener("message", (event) => {
      if (!current()) return;
      if (decoding) waiting = event.data;
      else show(event.data);
    });
  }
}

// Tear down but keep the status message (used on failure).
function resetConnection(card) {
  const canvas = card.querySelector(".cam-frame");
  card._camAttempt = null;
  card._camLive = false;
  if (card._camWatchdog) { clearTimeout(card._camWatchdog); card._camWatchdog = null; }
  if (card._camSocket) { card._camSocket.close(); card._camSocket = null; }
  if (card._camDecoder) {
    if (card._camDecoder.state !== "closed") card._camDecoder.close();
    card._camDecoder = null;
  }
  // Resizing clears it, back to the black box.
  canvas.width = 300;
  canvas.height = 150;
}

export function stopCamera(card) {
  resetConnection(card);
  setCamStatus(card, "", "");
}

// Click the error overlay to retry; click the picture for fullscreen.
export function wireCamera(card, id) {
  const canvas = card.querySelector(".cam-frame");
  card.querySelector(".cam-status").addEventListener("click", (event) => {
    if (event.currentTarget.dataset.state === "error") startCamera(card, id);
  });
  canvas.addEventListener("click", () => {
    if (card._camLive && document.fullscreenEnabled) canvas.requestFullscreen();
  });
}
