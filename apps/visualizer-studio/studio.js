import { visualizations } from "../desktop-companion/visualization-registry.js";

const presetSelect = document.getElementById("preset-select");
const modulePathInput = document.getElementById("module-path");
const exportNameInput = document.getElementById("export-name");
const loadModuleButton = document.getElementById("load-module");
const remountButton = document.getElementById("remount");
const host = document.getElementById("visualization-host");
const loadedName = document.getElementById("loaded-name");
const loadedTheme = document.getElementById("loaded-theme");
const eventLog = document.getElementById("event-log");
const modeInput = document.getElementById("mode");
const pressureInput = document.getElementById("pressure");
const outputInput = document.getElementById("output");
const toolInput = document.getElementById("tool");
const callInput = document.getElementById("call");
const ratioOptions = [...document.querySelectorAll(".ratio-option")];

const builtInModules = [
  { id: "aster", exportName: "asterVisualization", path: "../desktop-companion/aster.js" },
  { id: "buzz", exportName: "buzzVisualization", path: "../desktop-companion/buzz.js" },
  { id: "terminus", exportName: "terminusVisualization", path: "../desktop-companion/terminus.js" },
  { id: "ribbed-sphere-dark", exportName: "darkRibbedSphereVisualization", path: "../desktop-companion/ribbed-sphere.js" },
  { id: "ribbed-sphere-light", exportName: "lightRibbedSphereVisualization", path: "../desktop-companion/ribbed-sphere.js" },
  { id: "ribbed-sphere-purple", exportName: "purpleRibbedSphereVisualization", path: "../desktop-companion/ribbed-sphere.js" },
];

let activeVisualization;
let loadedVisualization;
let activeSoundingId = makeId("studio-sounding");
let sequence = 0;
let startedAtMs = Date.now();
const impacts = [];
const outputPackets = [];
const logLines = [];

for (const registration of visualizations) {
  const preset = builtInModules.find((item) => item.id === registration.id);
  const option = document.createElement("option");
  option.value = registration.id;
  option.textContent = registration.name;
  option.dataset.path = preset?.path || "";
  option.dataset.exportName = preset?.exportName || "";
  presetSelect.append(option);
}

presetSelect.addEventListener("change", applyPreset);
loadModuleButton.addEventListener("click", () => void loadSelectedModule());
remountButton.addEventListener("click", () => remountActiveVisualization());
document.getElementById("send-snapshot").addEventListener("click", () => sendSnapshot());
document.getElementById("send-reset").addEventListener("click", () => sendReset());
document.getElementById("send-started").addEventListener("click", () => sendImpact("started"));
document.getElementById("send-updated").addEventListener("click", () => sendImpact("updated"));
document.getElementById("send-finished").addEventListener("click", () => sendImpact("finished"));
document.getElementById("send-failed").addEventListener("click", () => sendImpact("failed"));
document.getElementById("send-assistant").addEventListener("click", () => sendPacket("assistant_output"));
document.getElementById("send-tool-call").addEventListener("click", () => sendPacket("tool_call"));
document.getElementById("send-tool-result").addEventListener("click", () => sendPacket("tool_result"));
document.getElementById("send-error").addEventListener("click", () => sendPacket("error"));
document.getElementById("send-state").addEventListener("click", () => sendState());
for (const option of ratioOptions) {
  option.addEventListener("click", () => setPreviewRatio(option.dataset.ratio || "canonical"));
}

applyPreset();
setPreviewRatio("canonical");
void loadSelectedModule();

function applyPreset() {
  const option = presetSelect.selectedOptions[0];
  modulePathInput.value = option?.dataset.path || "";
  exportNameInput.value = option?.dataset.exportName || "default";
}

async function loadSelectedModule() {
  disposeActiveVisualization();
  const modulePath = modulePathInput.value.trim();
  const exportName = exportNameInput.value.trim() || "default";
  if (!modulePath) {
    setLoadedStatus("No module path", "");
    return;
  }

  try {
    const module = await import(cacheBust(modulePath));
    const visualization = module[exportName];
    if (!visualization?.mount) {
      throw new Error(`Export "${exportName}" does not look like a visualizer.`);
    }
    loadedVisualization = visualization;
    remountActiveVisualization();
    sendSnapshot();
  } catch (error) {
    loadedVisualization = undefined;
    host.replaceChildren();
    setLoadedStatus("Load failed", error instanceof Error ? error.message : String(error));
    logEvent("studio.error", { error: error instanceof Error ? error.message : String(error) });
  }
}

function remountActiveVisualization() {
  disposeActiveVisualization();
  if (!loadedVisualization) return;
  host.dataset.visualization = loadedVisualization.id || "custom";
  host.dataset.visualizationTheme = loadedVisualization.theme || "dark";
  activeVisualization = loadedVisualization.mount(host);
  setLoadedStatus(loadedVisualization.name || loadedVisualization.id || "Custom visualizer", loadedVisualization.theme || "");
}

function disposeActiveVisualization() {
  activeVisualization?.dispose?.();
  activeVisualization = undefined;
  host.replaceChildren();
  delete host.dataset.visualization;
  delete host.dataset.visualizationTheme;
}

function setPreviewRatio(ratio) {
  host.dataset.previewRatio = ratio;
  for (const option of ratioOptions) {
    option.setAttribute("aria-pressed", String(option.dataset.ratio === ratio));
  }
}

function sendSnapshot() {
  emit({
    type: "visualization.snapshot",
    at: nowIso(),
    snapshot: {
      meta: {
        startedAt: new Date(startedAtMs).toISOString(),
        lastAt: nowIso(),
        impactCount: impacts.length,
        packetCount: outputPackets.length,
      },
      impacts: [...impacts],
      outputPackets: [...outputPackets],
      state: currentState(),
    },
  });
}

function sendReset() {
  activeSoundingId = makeId("studio-sounding");
  startedAtMs = Date.now();
  impacts.splice(0);
  outputPackets.splice(0);
  emit({ type: "visualization.reset", at: nowIso(), reason: "studio" });
  sendState();
}

function sendImpact(status) {
  if (status === "started") {
    activeSoundingId = makeId("studio-sounding");
    startedAtMs = Date.now();
  }
  const impact = {
    id: `${activeSoundingId}:${status}:${sequence++}`,
    soundingId: activeSoundingId,
    at: nowIso(),
    p: elapsedSeconds(),
    finishP: elapsedSeconds(),
    inputMass: randomMass(0.16, 0.62),
    replayMass: randomMass(0.02, 0.22),
    userMass: randomMass(0.08, 0.35),
    toolResultMass: status === "updated" ? randomMass(0.1, 0.7) : randomMass(0, 0.16),
    toolCallMass: status === "updated" ? randomMass(0.08, 0.55) : randomMass(0, 0.14),
    assistantMass: status === "finished" ? randomMass(0.32, 0.85) : randomMass(0, 0.28),
    newShare: randomMass(0.38, 1),
    outputMass: status === "failed" ? 0 : randomMass(0.08, 0.72),
    status,
  };
  pushCapped(impacts, impact, 240);
  emit({ type: "visualization.impact", at: impact.at, impact });

  if (status === "finished" || status === "failed") {
    modeInput.value = status === "failed" ? "error" : "output";
    sendState();
  }
}

function sendPacket(kind) {
  const packet = {
    id: `${activeSoundingId}:${kind}:${sequence++}`,
    soundingId: activeSoundingId,
    at: nowIso(),
    p: elapsedSeconds(),
    amp: massForPacket(kind),
    mass: massForPacket(kind),
    kind,
  };
  pushCapped(outputPackets, packet, 600);
  modeInput.value = modeForPacket(kind);
  emit({ type: "visualization.output_packet", at: packet.at, packet });
  sendState();
}

function sendState() {
  emit({ type: "visualization.state", at: nowIso(), state: currentState() });
}

function emit(event) {
  activeVisualization?.handleEvent?.(event);
  logEvent(event.type, payloadForLog(event));
}

function currentState() {
  const mode = modeInput.value;
  return {
    activeSoundings: mode === "thinking" || mode === "tool_call" || mode === "tool_result" || mode === "output" ? 1 : 0,
    subscriberCount: 1,
    mode,
    queued: mode === "queued" ? 1 : 0,
    digestion: mode === "digesting" ? 1 : 0,
    thinking: mode === "thinking" ? 1 : 0,
    pressure: Number(pressureInput.value),
    output: Number(outputInput.value),
    tool: Number(toolInput.value),
    call: Number(callInput.value),
  };
}

function logEvent(type, payload) {
  logLines.unshift(`${new Date().toLocaleTimeString()} ${type}\n${JSON.stringify(payload, null, 2)}`);
  while (logLines.length > 24) logLines.pop();
  eventLog.textContent = logLines.join("\n\n");
}

function setLoadedStatus(name, detail) {
  loadedName.textContent = name;
  loadedTheme.textContent = detail;
  loadedTheme.title = detail;
}

function payloadForLog(event) {
  if (event.type === "visualization.snapshot") {
    return event.snapshot.meta;
  }
  return event.impact || event.packet || event.state || { reason: event.reason };
}

function cacheBust(path) {
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}studio=${Date.now()}`;
}

function modeForPacket(kind) {
  if (kind === "tool_call") return "tool_call";
  if (kind === "tool_result") return "tool_result";
  if (kind === "error") return "error";
  return "output";
}

function massForPacket(kind) {
  if (kind === "error") return randomMass(0.44, 0.88);
  if (kind === "tool_call") return randomMass(0.18, 0.52);
  if (kind === "tool_result") return randomMass(0.26, 0.7);
  return randomMass(0.2, 0.78);
}

function randomMass(min, max) {
  return Math.round((min + Math.random() * (max - min)) * 1000) / 1000;
}

function elapsedSeconds() {
  return Math.max(0, (Date.now() - startedAtMs) / 1000);
}

function pushCapped(items, item, limit) {
  items.push(item);
  while (items.length > limit) items.shift();
}

function makeId(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
}

function nowIso() {
  return new Date().toISOString();
}
