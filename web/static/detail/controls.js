// Temperatures, fans, lights, and jogging. Everything except the Creality
// light builds a G-code string and POSTs it to the relay.

import { api } from "../lib/api.js";
import { statusLine } from "./list.js";
import { live, printerApiUrl } from "./page.js";

const controlsSection = document.querySelector(".controls-section");
const extruderTargetInput = document.querySelector(".extruder-target-input");
const bedTargetInput = document.querySelector(".bed-target-input");
const fanRowsContainer = document.querySelector(".fan-rows");
const fanRowTemplate = document.getElementById("fan-row-template");
const lightBlock = document.querySelector(".light-block");
const lightRowsContainer = document.querySelector(".light-rows");
const lightRowTemplate = document.getElementById("light-row-template");
const posX = document.querySelector(".pos-x");
const posY = document.querySelector(".pos-y");
const posZ = document.querySelector(".pos-z");
const moveDisabledNote = document.querySelector(".move-disabled-note");
const jogButtons = document.querySelectorAll(".jog-btn");
const jogHomeBtn = document.querySelector(".jog-home");
const stepButtons = document.querySelectorAll(".step-btn");

const setControlsStatus = statusLine(document.querySelector(".controls-status"), "controls-error");

// Fallbacks if the printer didn't report max_temp. Klipper enforces the real one.
const DEFAULT_EXTRUDER_MAX = 300;
const DEFAULT_BED_MAX = 130;

let jogStep = 1;
let jogBusy = false;  // a jog/home request is in flight
let fanIds = [];      // built once, the first time a fan list arrives
let lightIds = [];    // rebuilt if the light list changes

const extruderMax = () => live.status?.extruder_max_temp || DEFAULT_EXTRUDER_MAX;
const bedMax = () => live.status?.bed_max_temp || DEFAULT_BED_MAX;

async function sendGcode(script) {
  try {
    await api(printerApiUrl("/gcode"), { method: "POST", json: { script } });
    setControlsStatus("");
  } catch (err) {
    setControlsStatus(err.message, true);
  }
}

export function renderControls(status) {
  controlsSection.hidden = !status.online;
  if (!status.online) return;

  extruderTargetInput.max = String(extruderMax());
  bedTargetInput.max = String(bedMax());

  updateJogEnabled();
  updateMoveNote(status);
  posX.textContent = status.x.toFixed(1);
  posY.textContent = status.y.toFixed(1);
  posZ.textContent = status.z.toFixed(1);

  // Don't overwrite a field the user is typing in.
  if (document.activeElement !== extruderTargetInput) {
    extruderTargetInput.value = Math.round(status.extruder_target);
  }
  if (document.activeElement !== bedTargetInput) {
    bedTargetInput.value = Math.round(status.bed_target);
  }

  renderLights(status.lights || []);

  buildFanRows(status.fans);
  for (const fan of status.fans) {
    const input = fanRowsContainer.querySelector(`[data-fan-id="${CSS.escape(fan.id)}"]`);
    if (input && document.activeElement !== input) input.value = Math.round(fan.speed * 100);
  }
}

// --- temperatures ----------------------------------------------------------------

function wireTemperature(input, setBtn, offBtn, { label, command, max }) {
  setBtn.addEventListener("click", () => {
    const v = Number(input.value);
    if (!Number.isFinite(v) || v < 0 || v > max()) {
      return setControlsStatus(`Enter a ${label} between 0 and ${max()}.`, true);
    }
    sendGcode(`${command} S${v}`);
  });
  offBtn.addEventListener("click", () => {
    input.value = "0";
    sendGcode(`${command} S0`);
  });
}

wireTemperature(
  extruderTargetInput,
  document.querySelector(".extruder-set-btn"),
  document.querySelector(".extruder-off-btn"),
  { label: "nozzle temp", command: "M104", max: extruderMax },
);
wireTemperature(
  bedTargetInput,
  document.querySelector(".bed-set-btn"),
  document.querySelector(".bed-off-btn"),
  { label: "bed temp", command: "M140", max: bedMax },
);

// --- fans ------------------------------------------------------------------------

// [fan] is M106/M107; [fan_generic X] is SET_FAN_SPEED.
function fanSetScript(id, percent) {
  if (id === "fan") return percent > 0 ? `M106 S${Math.round((percent / 100) * 255)}` : "M107";
  const name = id.slice("fan_generic ".length);
  return `SET_FAN_SPEED FAN=${name} SPEED=${(percent / 100).toFixed(2)}`;
}

// Fan list doesn't change at runtime, so this builds once.
function buildFanRows(fans) {
  if (fanIds.length || fans.length === 0) return;
  fanIds = fans.map((f) => f.id);
  fanRowsContainer.innerHTML = "";
  for (const fan of fans) {
    const row = fanRowTemplate.content.firstElementChild.cloneNode(true);
    row.querySelector(".control-label").textContent = fan.name;
    const input = row.querySelector(".fan-target-input");
    input.dataset.fanId = fan.id;
    row.querySelector(".fan-set-btn").addEventListener("click", () => {
      const v = Number(input.value);
      if (!Number.isFinite(v) || v < 0 || v > 100) {
        return setControlsStatus("Enter a fan speed between 0 and 100.", true);
      }
      sendGcode(fanSetScript(fan.id, v));
    });
    row.querySelector(".fan-off-btn").addEventListener("click", () => {
      input.value = "0";
      sendGcode(fanSetScript(fan.id, 0));
    });
    fanRowsContainer.append(row);
  }
}

// --- lights ----------------------------------------------------------------------
// output_pin: SET_PIN VALUE is 0..scale (1 unless printer.cfg says otherwise).
// LED strips: SET_LED with every channel at the same level = white at that
// brightness. An unconfigured strip left at a colour keeps it until "Off".

function lightScript(light, level) {
  if (light.kind === "pin") return `SET_PIN PIN=${light.id.slice("output_pin ".length)} VALUE=${(level * light.scale).toFixed(3)}`;
  const name = light.id.split(" ", 2)[1];
  const v = level.toFixed(3);
  return `SET_LED LED=${name} RED=${v} GREEN=${v} BLUE=${v}${light.white ? ` WHITE=${v}` : ""}`;
}

async function setCrealityLight(on) {
  try {
    await api(printerApiUrl("/creality/light"), { method: "POST", json: { on } });
    setControlsStatus("");
  } catch (err) {
    setControlsStatus(err.message, true);
  }
}

function buildLightRows(lights) {
  const ids = lights.map((l) => l.id);
  if (ids.join("|") === lightIds.join("|")) return;
  lightIds = ids;
  lightRowsContainer.innerHTML = "";
  for (const light of lights) {
    const row = lightRowTemplate.content.firstElementChild.cloneNode(true);
    row.dataset.lightId = light.id;
    row.querySelector(".control-label").textContent = light.name;
    const slider = row.querySelector(".light-level");
    const value = row.querySelector(".light-value");
    if (light.dimmable) {
      slider.hidden = false;
      slider.addEventListener("change", () => sendGcode(lightScript(light, Number(slider.value) / 100)));
      slider.addEventListener("input", () => { value.textContent = `${slider.value}%`; });
    } else {
      value.hidden = true;
      row.classList.add("light-row-switch");
    }
    // Creality's light isn't G-code; it has its own endpoint.
    const turn = light.kind === "creality"
      ? (on) => setCrealityLight(on)
      : (on) => sendGcode(lightScript(light, on ? 1 : 0));
    row.querySelector(".light-on-btn").addEventListener("click", () => turn(true));
    row.querySelector(".light-off-btn").addEventListener("click", () => turn(false));
    lightRowsContainer.append(row);
  }
}

function renderLights(lights) {
  lightBlock.hidden = lights.length === 0;
  buildLightRows(lights);
  for (const light of lights) {
    const row = lightRowsContainer.querySelector(`[data-light-id="${CSS.escape(light.id)}"]`);
    if (!row) continue;
    const pct = Math.round(light.value * 100);
    const slider = row.querySelector(".light-level");
    if (light.dimmable && document.activeElement !== slider) {
      slider.value = String(pct);
      row.querySelector(".light-value").textContent = `${pct}%`;
    }
    row.querySelector(".light-on-btn").classList.toggle("active", light.value > 0);
  }
}

// --- jogging ---------------------------------------------------------------------

function updateJogEnabled() {
  const status = live.status;
  if (!status?.online) {
    for (const btn of jogButtons) btn.disabled = true;
    jogHomeBtn.disabled = true;
    return;
  }
  // Idle only, per-axis once homed, and not while a move is in flight
  // (the next target is computed from the current position).
  const canMove = ["idle", "complete", "error"].includes(status.state) && !jogBusy;
  const homed = new Set((status.homed_axes || "").split(""));
  for (const btn of jogButtons) {
    btn.disabled = !canMove || !homed.has(btn.dataset.axis.toLowerCase());
  }
  jogHomeBtn.disabled = !canMove;
}

// Say why the jog buttons are disabled.
function updateMoveNote(status) {
  let reason = "";
  if (status.state === "printing" || status.state === "paused") {
    reason = "Manual moves are disabled while printing.";
  } else {
    const homed = new Set((status.homed_axes || "").split(""));
    if (!["x", "y", "z"].every((a) => homed.has(a))) {
      reason = "Home the printer (⌂) before moving it manually.";
    }
  }
  moveDisabledNote.textContent = reason;
  moveDisabledNote.hidden = !reason;
}

async function jog(script) {
  if (jogBusy) return;
  jogBusy = true;
  updateJogEnabled();
  await sendGcode(script);
  jogBusy = false;
  updateJogEnabled();
}

for (const btn of stepButtons) {
  btn.addEventListener("click", () => {
    jogStep = Number(btn.dataset.step);
    for (const b of stepButtons) b.classList.toggle("active", b === btn);
  });
}

for (const btn of jogButtons) {
  btn.addEventListener("click", () => {
    const status = live.status;
    if (jogBusy || !status) return;
    const axis = btn.dataset.axis;
    const current = { X: status.x, Y: status.y, Z: status.z }[axis];
    const target = (current + Number(btn.dataset.dir) * jogStep).toFixed(3);
    const feedrate = axis === "Z" ? 600 : 3000;
    // Absolute, not G91: a rejected relative move leaves the printer stuck
    // in relative mode for whatever comes next.
    jog(`G90\nG1 ${axis}${target} F${feedrate}`);
  });
}

jogHomeBtn.addEventListener("click", () => jog("G28"));
