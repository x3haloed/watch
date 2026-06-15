const { app, BrowserWindow, Tray, Menu, ipcMain, desktopCapturer, nativeImage, screen } = require("electron");
const path = require("node:path");

const daemonBaseUrl = process.env.WATCH_DAEMON_URL || "http://127.0.0.1:4478";

let tray;
let window;
let eventStreamAbort;
let visualizationStreamAbort;

function createWindow() {
  window = new BrowserWindow({
    width: 380,
    height: 520,
    minWidth: 380,
    minHeight: 520,
    show: true,
    resizable: true,
    fullscreenable: false,
    title: "Watch",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  window.loadFile(path.join(__dirname, "index.html"));
  window.webContents.once("did-finish-load", () => {
    connectEventStream();
  });
}

function createTray() {
  const icon = nativeImage.createFromDataURL(
    "data:image/svg+xml;utf8," +
      encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18">
        <rect width="18" height="18" rx="4" fill="black"/>
        <path d="M4 5h10v2H4zm0 3h7v2H4zm0 3h10v2H4z" fill="white"/>
      </svg>`),
  );
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setTitle("W");
  tray.setToolTip("Watch");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open Watch", click: toggleWindow },
      { type: "separator" },
      { label: "Quit", click: () => app.quit() },
    ]),
  );
  tray.on("click", toggleWindow);
}

function toggleWindow() {
  if (!window) return;
  if (window.isVisible()) {
    window.hide();
    return;
  }
  const bounds = tray.getBounds();
  const windowBounds = window.getBounds();
  window.setPosition(
    Math.round(bounds.x + bounds.width / 2 - windowBounds.width / 2),
    Math.round(bounds.y + bounds.height + 6),
    false,
  );
  window.show();
  window.focus();
}

ipcMain.handle("watch:send", async (_event, payload) => {
  return safeRequest(() =>
    postJson("/api/send", {
      message: String(payload?.message ?? ""),
      source: "desktop-companion",
    }),
  );
});

ipcMain.handle("watch:sendWithScreenshot", async (_event, payload) => {
  return safeRequest(async () => {
    const screenshot = await capturePrimaryDisplay();
    return postJson("/api/send-with-attachments", {
      message: String(payload?.message ?? ""),
      source: "desktop-companion",
      attachments: [screenshot],
    });
  });
});

ipcMain.handle("watch:getConversation", async () => {
  return safeRequest(() => getJson("/api/conversation"));
});

ipcMain.handle("watch:getStatus", async () => {
  return safeRequest(() => getJson("/api/status"));
});

ipcMain.handle("watch:setVisualizationEnabled", async (_event, payload) => {
  const enabled = Boolean(payload?.enabled);
  if (enabled) {
    connectVisualizationStream();
    return { ok: true, enabled: true };
  }
  visualizationStreamAbort?.abort();
  visualizationStreamAbort = undefined;
  return { ok: true, enabled: false };
});

async function capturePrimaryDisplay() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.size;
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width, height },
  });
  const primarySource = sources[0];
  if (!primarySource) {
    throw new Error("No screen source is available");
  }
  return {
    kind: "screenshot",
    name: `screenshot-${new Date().toISOString().replace(/[:.]/g, "-")}.png`,
    mimeType: "image/png",
    dataBase64: primarySource.thumbnail.toPNG().toString("base64"),
    metadata: {
      sourceName: primarySource.name,
      displayId: primaryDisplay.id,
      width,
      height,
    },
  };
}

async function postJson(route, body) {
  const response = await fetch(`${daemonBaseUrl}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || json.ok === false) {
    throw new Error(json.error || `Watch request failed with ${response.status}`);
  }
  return json;
}

async function getJson(route) {
  const response = await fetch(`${daemonBaseUrl}${route}`);
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(json.error || `Watch request failed with ${response.status}`);
  }
  return json;
}

async function safeRequest(request) {
  try {
    return await request();
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function connectEventStream() {
  eventStreamAbort?.abort();
  eventStreamAbort = new AbortController();
  void readEventStream(eventStreamAbort.signal).catch((error) => {
    if (error?.name === "AbortError") return;
    window?.webContents.send("watch:event", {
      type: "connection.error",
      data: { error: error instanceof Error ? error.message : String(error) },
    });
    setTimeout(() => {
      if (!eventStreamAbort?.signal.aborted) {
        connectEventStream();
      }
    }, 2000);
  });
}

function connectVisualizationStream() {
  if (visualizationStreamAbort && !visualizationStreamAbort.signal.aborted) {
    return;
  }
  visualizationStreamAbort = new AbortController();
  void readVisualizationStream(visualizationStreamAbort.signal).catch((error) => {
    if (error?.name === "AbortError") return;
    window?.webContents.send("watch:visualization-event", {
      type: "connection.error",
      data: { error: error instanceof Error ? error.message : String(error) },
    });
    setTimeout(() => {
      if (visualizationStreamAbort && !visualizationStreamAbort.signal.aborted) {
        visualizationStreamAbort = undefined;
        connectVisualizationStream();
      }
    }, 2000);
  });
}

async function readEventStream(signal) {
  const response = await fetch(`${daemonBaseUrl}/api/events/stream`, { signal });
  if (!response.ok || !response.body) {
    throw new Error(`Watch event stream failed with ${response.status}`);
  }
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() || "";
    for (const part of parts) {
      const event = parseSseEvent(part);
      if (event) {
        window?.webContents.send("watch:event", event);
      }
    }
  }
}

async function readVisualizationStream(signal) {
  const response = await fetch(`${daemonBaseUrl}/api/visualization/stream`, { signal });
  if (!response.ok || !response.body) {
    throw new Error(`Watch visualization stream failed with ${response.status}`);
  }
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() || "";
    for (const part of parts) {
      const event = parseSseEvent(part);
      if (event) {
        window?.webContents.send("watch:visualization-event", event);
      }
    }
  }
}

function parseSseEvent(raw) {
  const eventLine = raw.split("\n").find((line) => line.startsWith("event: "));
  const dataLine = raw.split("\n").find((line) => line.startsWith("data: "));
  if (!eventLine || !dataLine) return undefined;
  const type = eventLine.slice("event: ".length);
  try {
    return { type, data: JSON.parse(dataLine.slice("data: ".length)) };
  } catch {
    return undefined;
  }
}

app.whenReady().then(() => {
  createWindow();
  createTray();
});

app.on("window-all-closed", (event) => {
  event.preventDefault();
});

app.on("before-quit", () => {
  eventStreamAbort?.abort();
  visualizationStreamAbort?.abort();
});
