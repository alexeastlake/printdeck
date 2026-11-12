"""Server-side camera viewer.

The printer's camera only speaks WebRTC and only offers its LAN address, so
a browser outside the LAN (reverse proxy, Cloudflare tunnel) could never
watch it directly. PrintDeck is the WebRTC peer instead: it sits on the LAN,
receives the H.264, and passes it on over a websocket (routes/camera.py),
which any HTTP proxy carries. Every viewer gets the picture this way, LAN
or not.

Two formats, the viewer picks:

- "h264": the printer's own video, untouched (1080p, ~15 fps, ~140 KB/s).
  Nothing is decoded here. Needs WebCodecs in the browser, which browsers
  only offer on HTTPS or localhost.
- "jpeg": for everyone else. Decoded and re-encoded here as 720p JPEGs, up
  to 10 fps (~400 KB/s), and only while somebody is asking for it.

One upstream connection per printer, shared by every viewer and dropped
when the last one leaves.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress
from fractions import Fraction

import aiortc.rtcrtpreceiver as _aiortc_receiver
import av
import httpx
from aiortc import RTCConfiguration, RTCPeerConnection, RTCSessionDescription
from aiortc.rtcdtlstransport import RTCCertificate

log = logging.getLogger("printdeck.camera")
# aioice narrates every candidate pair at INFO; aiortc warns about each
# packet it has to ask for again.
logging.getLogger("aioice").setLevel(logging.WARNING)
logging.getLogger("aiortc").setLevel(logging.ERROR)

SIGNALING_TIMEOUT = 15   # includes DNS; a cold .local lookup on Windows can take ~10s
FIRST_FRAME_TIMEOUT = 20  # ICE + DTLS + waiting for a keyframe
STALL_TIMEOUT = 15

# An h264 viewer this many frames behind (~6s) is skipped ahead to the next
# keyframe; H.264 can't drop single frames, only restart from one.
MAX_BACKLOG = 90
# The camera sends a keyframe every second. If that ever stops, don't hoard.
MAX_GOP_FRAMES = 600

# JPEG fallback only.
JPEG_MAX_FPS = 10
JPEG_MAX_HEIGHT = 720
JPEG_QUALITY = 6          # ffmpeg qscale: 2 (best) .. 31

# aiortc offers ECDSA suites only; the printer's certificate is RSA.
DTLS_CIPHERS = (
    b"ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:"
    b"ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:"
    b"ECDHE-ECDSA-AES128-SHA:ECDHE-RSA-AES128-SHA:"
    b"ECDHE-ECDSA-AES256-SHA:ECDHE-RSA-AES256-SHA"
)

FORMATS = ("h264", "jpeg")


class CameraError(Exception):
    """Message is shown to the viewer."""


class _RsaFriendlyCertificate(RTCCertificate):
    def _create_ssl_context(self, srtp_profiles):
        ctx = super()._create_ssl_context(srtp_profiles)
        ctx.set_cipher_list(DTLS_CIPHERS)
        return ctx


class _H264Passthrough:
    """In place of aiortc's H.264 decoder: track.recv() then yields the
    reassembled, still-encoded frame (.data is Annex B, .timestamp is RTP's)."""

    def decode(self, encoded_frame):
        return [encoded_frame]


_aiortc_get_decoder = _aiortc_receiver.get_decoder


def _get_decoder(codec):
    if codec.mimeType.lower() == "video/h264":
        return _H264Passthrough()
    return _aiortc_get_decoder(codec)


# No public hook for this either. Nothing else in PrintDeck uses aiortc.
_aiortc_receiver.get_decoder = _get_decoder


def offer_for_printer(sdp: str) -> str:
    """The printer splits the SDP on "\\n" and chokes on a candidate line
    ending "typ host\\r", then silently ignores every candidate. Browsers
    never end a line that way (they append "generation 0 ..."), so do the same."""
    lines = [
        line + " generation 0" if line.startswith("a=candidate:") else line
        for line in sdp.splitlines()
    ]
    return "\r\n".join(lines) + "\r\n"


def answer_from_printer(sdp: str) -> str:
    """The printer sends two a=fmtp lines for one payload type; the second
    (x-google bitrate hints) replaces the first in aiortc's parser, losing
    packetization-mode, and then no codec matches."""
    return "".join(line for line in sdp.splitlines(keepends=True) if "x-google" not in line)


async def exchange_sdp(http: httpx.AsyncClient, signaling_url: str, sdp: str) -> dict:
    """POST an offer to the printer's WebRTC server, return its answer."""
    payload = base64.b64encode(json.dumps({"type": "offer", "sdp": sdp}).encode())
    resp = await http.post(
        signaling_url, content=payload, headers={"Content-Type": "plain/text"}, timeout=SIGNALING_TIMEOUT
    )
    resp.raise_for_status()
    return json.loads(base64.b64decode(resp.content))


def starts_with_keyframe(data: bytes) -> bool:
    """True if this Annex B frame opens with SPS/PPS/IDR, i.e. a decoder can
    start here. The printer sends all three in-band with every keyframe. The
    very first frame after connecting is a jumble with the keyframe buried in
    the middle; that one doesn't count."""
    start = data.find(b"\x00\x00\x01")
    return start >= 0 and start + 3 < len(data) and data[start + 3] & 0x1F in (5, 7, 8)


class _JpegEncoder:
    """Recreated when the frame size changes; MJPEG contexts are fixed-size."""

    def __init__(self) -> None:
        self._ctx: av.CodecContext | None = None
        self._count = 0

    def encode(self, frame: av.VideoFrame) -> bytes:
        height = min(frame.height, JPEG_MAX_HEIGHT)
        width = round(frame.width * height / frame.height) & ~1
        height &= ~1
        if (frame.width, frame.height, frame.format.name) != (width, height, "yuvj420p"):
            frame = frame.reformat(width=width, height=height, format="yuvj420p")
        if self._ctx is None or (self._ctx.width, self._ctx.height) != (width, height):
            ctx = av.CodecContext.create("mjpeg", "w")
            ctx.width, ctx.height, ctx.pix_fmt = width, height, "yuvj420p"
            ctx.time_base = Fraction(1, JPEG_MAX_FPS)
            ctx.options = {"qmin": str(JPEG_QUALITY), "qmax": str(JPEG_QUALITY)}
            ctx.open()
            self._ctx = ctx
        # Our own clock: the frame arrives with RTP's 90 kHz time base, and
        # the encoder rejects timestamps that don't advance in its own.
        frame.time_base = self._ctx.time_base
        frame.pts = self._count
        self._count += 1
        return b"".join(bytes(packet) for packet in self._ctx.encode(frame))


class _JpegTranscoder:
    """H.264 frames in, the occasional JPEG out. Must be fed from a keyframe
    and then every frame after it, whether or not a JPEG is due."""

    def __init__(self) -> None:
        self._decoder = av.CodecContext.create("h264", "r")
        self._decoder.thread_type = "SLICE"  # frame threading would hold pictures back
        self._encoder = _JpegEncoder()
        self._next_at = 0.0

    def feed(self, frames: list[bytes]) -> bytes | None:
        picture = None
        for data in frames:
            for decoded in self._decoder.decode(av.Packet(data)):
                picture = decoded
        now = time.monotonic()
        if picture is None or now < self._next_at:
            return None
        self._next_at = now + 1 / JPEG_MAX_FPS
        return self._encoder.encode(picture)


class _Viewer:
    def __init__(self, fmt: str) -> None:
        self.format = fmt
        self.queue: asyncio.Queue[bytes | CameraError] = asyncio.Queue()
        self.needs_keyframe = True

    def clear(self) -> None:
        while not self.queue.empty():
            self.queue.get_nowait()


class CameraRelay:
    """One printer's camera: a WebRTC connection in, frames out to viewers."""

    def __init__(self, http: httpx.AsyncClient, signaling_url: str) -> None:
        self._http = http
        self._signaling_url = signaling_url
        self._viewers: set[_Viewer] = set()
        # Every h264 message since the last keyframe, so a new viewer starts
        # with a picture instead of waiting for the next one.
        self._gop: list[bytes] = []
        self._transcoder: _JpegTranscoder | None = None
        self._error: CameraError | None = None
        self._task: asyncio.Task | None = None
        self.viewers = 0  # sockets holding this relay open (CameraRelays.watch)

    def start(self) -> None:
        self._task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            with suppress(asyncio.CancelledError):
                await self._task

    @property
    def finished(self) -> bool:
        return self._error is not None

    async def frames(self, fmt: str = "jpeg") -> AsyncIterator[bytes]:
        """Messages for one viewer; raises CameraError when the camera stops.

        "h264": every frame in order, one flag byte (1 = keyframe, 0 = not)
        then the Annex B frame, always starting at a keyframe.
        "jpeg": the newest JPEG; a slow reader skips frames rather than queueing them."""
        if self._error is not None:
            raise self._error
        viewer = _Viewer(fmt)
        if fmt == "h264" and self._gop:
            for message in self._gop:
                viewer.queue.put_nowait(message)
            viewer.needs_keyframe = False
        self._viewers.add(viewer)
        try:
            while True:
                item = await viewer.queue.get()
                if isinstance(item, CameraError):
                    raise item
                yield item
        finally:
            self._viewers.discard(viewer)

    def _publish_h264(self, keyframe: bool, data: bytes) -> None:
        message = (b"\x01" if keyframe else b"\x00") + data
        if keyframe:
            self._gop = [message]
        elif len(self._gop) < MAX_GOP_FRAMES:
            self._gop.append(message)
        else:
            self._gop = []
        for viewer in self._viewers:
            if viewer.format != "h264":
                continue
            if viewer.queue.qsize() >= MAX_BACKLOG:
                viewer.clear()
                viewer.needs_keyframe = True
            if viewer.needs_keyframe and not keyframe:
                continue
            viewer.needs_keyframe = False
            viewer.queue.put_nowait(message)

    def _publish_jpeg(self, jpeg: bytes) -> None:
        for viewer in self._viewers:
            if viewer.format == "jpeg":
                viewer.clear()
                viewer.queue.put_nowait(jpeg)

    async def _transcode(self, data: bytes) -> None:
        if not any(viewer.format == "jpeg" for viewer in self._viewers):
            self._transcoder = None
            return
        if self._transcoder is None:
            if not self._gop:
                return
            # Catch the new decoder up from the last keyframe (data included).
            self._transcoder = _JpegTranscoder()
            pending = [message[1:] for message in self._gop]
        else:
            pending = [data]
        try:
            # Off the event loop: decoding + scaling + encoding is real CPU.
            jpeg = await asyncio.to_thread(self._transcoder.feed, pending)
        except av.FFmpegError as exc:
            log.debug("camera relay couldn't decode a frame: %s", exc)
            self._transcoder = None  # start over from the next frame's GOP
            return
        if jpeg is not None:
            self._publish_jpeg(jpeg)

    async def _run(self) -> None:
        pc = RTCPeerConnection(RTCConfiguration(iceServers=[]))  # same LAN: host candidates are enough
        try:
            # No public hook for the DTLS ciphers; this has to be in place
            # before the first transceiver creates the transport.
            pc._RTCPeerConnection__certificates = [_RsaFriendlyCertificate.generateCertificate()]
            await self._receive(pc)
        except asyncio.CancelledError:
            self._error = CameraError("Camera closed.")
            raise
        except CameraError as exc:
            self._error = exc
        except Exception as exc:
            log.warning("camera relay for %s failed: %r", self._signaling_url, exc)
            self._error = CameraError("Couldn't reach the camera.")
        finally:
            for viewer in self._viewers:
                viewer.queue.put_nowait(self._error)
            with suppress(Exception):
                await pc.close()

    async def _receive(self, pc: RTCPeerConnection) -> None:
        tracks: asyncio.Queue = asyncio.Queue()
        pc.on("track", tracks.put_nowait)
        # The printer's server expects sendrecv, same as its own page sends.
        pc.addTransceiver("video", direction="sendrecv")
        await pc.setLocalDescription(await pc.createOffer())
        answer = await exchange_sdp(self._http, self._signaling_url, offer_for_printer(pc.localDescription.sdp))
        await pc.setRemoteDescription(
            RTCSessionDescription(sdp=answer_from_printer(answer["sdp"]), type="answer")
        )
        track = await asyncio.wait_for(tracks.get(), FIRST_FRAME_TIMEOUT)

        started = False
        timeout = FIRST_FRAME_TIMEOUT
        while True:
            try:
                frame = await asyncio.wait_for(track.recv(), timeout)
            except TimeoutError:
                raise CameraError("Camera stopped sending video." if started else "Camera didn't respond.")
            keyframe = starts_with_keyframe(frame.data)
            if not started and not keyframe:
                continue
            started = True
            timeout = STALL_TIMEOUT
            self._publish_h264(keyframe, frame.data)
            await self._transcode(frame.data)


class CameraRelays:
    """Relays by printer, started on the first viewer and stopped on the last."""

    def __init__(self) -> None:
        self._relays: dict[tuple[str, str], CameraRelay] = {}

    @asynccontextmanager
    async def watch(
        self, http: httpx.AsyncClient, printer_id: str, signaling_url: str
    ) -> AsyncIterator[CameraRelay]:
        # Keyed on the URL too, so editing a printer's camera gets a fresh connection.
        key = (printer_id, signaling_url)
        relay = self._relays.get(key)
        if relay is None or relay.finished:
            relay = CameraRelay(http, signaling_url)
            self._relays[key] = relay
            relay.start()
        relay.viewers += 1
        try:
            yield relay
        finally:
            relay.viewers -= 1
            if relay.viewers == 0:
                if self._relays.get(key) is relay:
                    del self._relays[key]
                await relay.stop()

    async def close(self) -> None:
        relays, self._relays = list(self._relays.values()), {}
        for relay in relays:
            await relay.stop()
