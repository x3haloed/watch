import { getVisualization, visualizations } from "./visualization-registry.js";

const messages = document.getElementById("messages");
const message = document.getElementById("message");
const send = document.getElementById("send");
const sendScreenshot = document.getElementById("send-screenshot");
const status = document.getElementById("status");
const presenceToggle = document.getElementById("presence-toggle");
const visualizationSelect = document.getElementById("visualization-select");
const visualizationHost = document.getElementById("visualization-host");

const renderedMessageIds = new Set();
let currentRuntimeStatus;
let transientToolTimer;
let richPresenceEnabled = false;
let activeVisualization;
let removeVisualizationListener;
let latestVisualizationSnapshot;
let visualizationMountSequence = 0;

for (const visualization of visualizations) {
  let option = visualizationSelect.querySelector(`option[value="${visualization.id}"]`);
  if (!option) {
    option = document.createElement("option");
    option.value = visualization.id;
    visualizationSelect.append(option);
  }
  option.textContent = visualization.name;
}

send.addEventListener("click", () => submit(false));
sendScreenshot.addEventListener("click", () => submit(true));
presenceToggle.addEventListener("click", () => setRichPresenceEnabled(!richPresenceEnabled));
visualizationSelect.addEventListener("change", () => {
  if (richPresenceEnabled) {
    void mountSelectedVisualization();
  }
});

message.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    submit(false);
  }
});

loadInitialState();
window.watch.onEvent((event) => {
  if (event.type === "conversation.message.created") {
    renderMessage(event.data.message);
    scrollToLatest();
    return;
  }
  if (event.type === "runtime.status_changed") {
    currentRuntimeStatus = event.data.status;
    renderRuntimeStatus();
    return;
  }
  if (event.type === "audit.event_appended" && isToolActivity(event.data.event)) {
    showTransientToolStatus();
    return;
  }
  if (event.type === "connection.error") {
    setStatus("Offline", "error", event.data.error || "Disconnected from Watch");
    return;
  }
  if (event.type === "ready") {
    renderRuntimeStatus();
  }
});

async function loadInitialState() {
  await Promise.all([loadConversation(), loadRuntimeStatus()]);
}

async function setRichPresenceEnabled(enabled) {
  richPresenceEnabled = enabled;
  presenceToggle.setAttribute("aria-pressed", String(enabled));
  presenceToggle.textContent = enabled ? "Compact" : "Rich";
  document.body.classList.toggle("rich-presence", enabled);
  visualizationHost.hidden = !enabled;

  if (enabled) {
    await mountSelectedVisualization();
    removeVisualizationListener = window.watch.onVisualizationEvent((event) => {
      if (event.type === "connection.error") {
        setStatus("Viz offline", "error", event.data?.error || "Visualization stream disconnected");
        return;
      }
      if (event.type === "visualization.snapshot") {
        latestVisualizationSnapshot = event;
      }
      activeVisualization?.handleEvent(event);
    });
    const result = await window.watch.setVisualizationEnabled(true);
    if (!result?.ok) {
      setStatus("Viz offline", "error", result?.error || "Visualization stream failed");
    }
    return;
  }

  await window.watch.setVisualizationEnabled(false);
  removeVisualizationListener?.();
  removeVisualizationListener = undefined;
  visualizationMountSequence += 1;
  disposeActiveVisualization();
  renderRuntimeStatus();
}

async function mountSelectedVisualization() {
  const mountSequence = ++visualizationMountSequence;
  disposeActiveVisualization();
  const visualizationRegistration = getVisualization(visualizationSelect.value);
  visualizationHost.dataset.visualization = visualizationRegistration.id;
  visualizationHost.dataset.visualizationTheme = visualizationRegistration.theme;
  try {
    const visualization = await visualizationRegistration.load();
    if (mountSequence !== visualizationMountSequence) {
      return;
    }
    activeVisualization = visualization.mount(visualizationHost);
    if (latestVisualizationSnapshot) {
      activeVisualization.handleEvent(latestVisualizationSnapshot);
    }
  } catch (error) {
    activeVisualization = undefined;
    visualizationHost.replaceChildren();
    setStatus("Viz failed", "error", error instanceof Error ? error.message : String(error));
  }
}

function disposeActiveVisualization() {
  activeVisualization?.dispose();
  activeVisualization = undefined;
  visualizationHost.replaceChildren();
  delete visualizationHost.dataset.visualization;
  delete visualizationHost.dataset.visualizationTheme;
}

async function loadConversation() {
  const result = await window.watch.getConversation();
  if (!result?.ok && result?.error) {
    setStatus("Offline", "error", result.error);
    return;
  }
  messages.textContent = "";
  for (const item of result.messages || []) {
    renderMessage(item);
  }
  scrollToLatest();
}

async function loadRuntimeStatus() {
  const result = await window.watch.getStatus();
  if (!result?.ok && result?.error) {
    setStatus("Offline", "error", result.error);
    return;
  }
  currentRuntimeStatus = result;
  renderRuntimeStatus();
}

async function submit(includeScreenshot) {
  const text = message.value.trim();
  if (!text) {
    setStatus("Write a message first", "warn");
    message.focus();
    return;
  }
  setBusy(true);
  setStatus(includeScreenshot ? "Capturing screenshot..." : "Sending...", "pending");
  try {
    let result;
    if (includeScreenshot) {
      result = await window.watch.sendWithScreenshot(text);
    } else {
      result = await window.watch.send(text);
    }
    if (!result?.ok) {
      throw new Error(result?.error || "Watch request failed");
    }
    message.value = "";
    setStatus(includeScreenshot ? "Sent with screenshot" : "Sent", "ok");
    setTimeout(renderRuntimeStatus, 1200);
    message.focus();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), "error");
  } finally {
    setBusy(false);
  }
}

function renderMessage(item) {
  if (!item || renderedMessageIds.has(item.id)) return;
  renderedMessageIds.add(item.id);
  if (messages.children.length === 0) {
    messages.textContent = "";
  }

  const wrapper = document.createElement("article");
  wrapper.className = `message ${item.direction === "in" ? "agent" : "user"}`;
  wrapper.dataset.messageId = item.id;

  const meta = document.createElement("div");
  meta.className = "message-meta";
  const speaker = item.direction === "in" ? "AI" : labelForSource(item.source);
  meta.textContent = `${speaker} · ${formatTime(item.at)}`;

  const bubble = document.createElement("div");
  bubble.className = "message-bubble";
  bubble.textContent = item.text;

  wrapper.append(meta, bubble);

  const attachments = item.metadata?.attachments;
  if (Array.isArray(attachments) && attachments.length) {
    const attachmentList = document.createElement("div");
    attachmentList.className = "attachments";
    attachmentList.textContent = attachments.map((attachment) => attachment.kind || "attachment").join(", ");
    wrapper.append(attachmentList);
  }

  messages.append(wrapper);
  while (messages.children.length > 100) {
    const first = messages.firstElementChild;
    if (first) renderedMessageIds.delete(first.dataset.messageId);
    first?.remove();
  }
}

function labelForSource(source) {
  if (source === "desktop-companion") return "You";
  if (source === "web") return "You";
  return source || "You";
}

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function scrollToLatest() {
  messages.scrollTop = messages.scrollHeight;
}

function renderRuntimeStatus() {
  if (!currentRuntimeStatus) {
    setStatus("Connecting", "pending");
    return;
  }
  if (!currentRuntimeStatus.running) {
    setStatus("Offline", "error");
    return;
  }
  if (currentRuntimeStatus.soundingActive) {
    if (currentRuntimeStatus.currentSounding?.digestion) {
      setStatus("Digesting", "digesting");
      return;
    }
    setStatus("Thinking", "thinking");
    return;
  }
  if (currentRuntimeStatus.soundQueued) {
    setStatus("Queued", "pending");
    return;
  }
  setStatus("Ready", "ok");
}

function isToolActivity(event) {
  if (!event || typeof event !== "object") return false;
  if (event.type === "tool_call") return true;
  if (event.type !== "codex_event" && event.type !== "codex_item") return false;
  const item = event.event?.item || event.item;
  return item?.type === "function_call" || item?.type === "tool_call";
}

function showTransientToolStatus() {
  if (!currentRuntimeStatus?.soundingActive) return;
  setStatus("Using tools", "tool");
  clearTimeout(transientToolTimer);
  transientToolTimer = setTimeout(renderRuntimeStatus, 3500);
}

function setBusy(value) {
  send.disabled = value;
  sendScreenshot.disabled = value;
}

function setStatus(text, tone, title = "") {
  status.textContent = text;
  status.dataset.tone = tone;
  status.title = title;
}
