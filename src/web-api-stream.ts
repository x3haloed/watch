import type { JsonObject, StreamDelta, WebApiStreamConfig } from './types.js';
import { cleanStringArray, compactJsonObject, isJsonObject, type StreamPopContext, type WatchStream } from './stream-primitives.js';

const DEFAULT_WEB_API_INTERVAL_MS = 15 * 60 * 1000;

export class WebApiStream implements WatchStream {
  readonly sampled = true;
  readonly waking: boolean;
  private lastFingerprint = '';
  private lastBody: unknown;
  private lastSampleAtMs = 0;
  private readonly intervalMs: number;

  constructor(
    readonly name: string,
    private readonly config: WebApiStreamConfig,
  ) {
    this.waking = config.waking === true;
    this.intervalMs = validIntervalMs(config.intervalMs);
  }

  push(): void {
    // Web API streams are sampled during Sounding construction.
  }

  hasDelta(): boolean {
    return false;
  }

  async popDelta({ now }: StreamPopContext): Promise<StreamDelta | undefined> {
    const nowMs = now.getTime();
    if (this.lastSampleAtMs && nowMs - this.lastSampleAtMs < this.intervalMs) {
      return undefined;
    }
    this.lastSampleAtMs = nowMs;

    const sampledAt = now.toISOString();
    const result = await this.fetchCurrent(sampledAt);
    const changed = result.fingerprint !== this.lastFingerprint;
    if (!changed && this.config.emitUnchanged !== true) {
      return undefined;
    }
    const previousBody = this.lastBody;
    this.lastFingerprint = result.fingerprint;
    this.lastBody = result.body;
    return {
      stream: this.name,
      at: sampledAt,
      payload: this.formatPayload(result.payload, previousBody, result.body, changed),
    };
  }

  private async fetchCurrent(sampledAt: string): Promise<{ fingerprint: string; body: unknown; payload: JsonObject }> {
    try {
      const response = await fetch(this.config.url, {
        method: 'GET',
        headers: this.config.headers,
        signal: AbortSignal.timeout(10_000),
      });
      const contentType = response.headers.get('content-type') ?? '';
      const text = await response.text();
      const parsed = contentType.includes('application/json') ? parseJson(text) : undefined;
      const body = parsed ?? text;
      const fingerprint = JSON.stringify({
        ok: response.ok,
        status: response.status,
        body: normalizeForFingerprint(body, this.config.ignorePaths),
      });
      return {
        fingerprint,
        body,
        payload: {
          ok: response.ok,
          url: this.config.url,
          status: response.status,
          statusText: response.statusText,
          contentType,
          sampledAt,
          body,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        fingerprint: JSON.stringify({ error: message }),
        body: undefined,
        payload: {
          ok: false,
          url: this.config.url,
          sampledAt,
          error: message,
        },
      };
    }
  }

  private formatPayload(payload: JsonObject, previousBody: unknown, currentBody: unknown, changed: boolean): JsonObject {
    const base = {
      ...payload,
      changed,
      emitUnchanged: this.config.emitUnchanged === true,
      ignoredPaths: cleanStringArray(this.config.ignorePaths),
    };

    if (this.config.kind === 'tinyplace_canvas') {
      return formatTinyplacePayload(base, this.config.url, previousBody, currentBody, changed);
    }

    return base;
  }
}


function validIntervalMs(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_WEB_API_INTERVAL_MS;
  }
  return value;
}


function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function normalizeForFingerprint(value: unknown, ignorePaths: string[] | undefined): unknown {
  return sortJsonValue(removeIgnoredPaths(value, new Set(cleanStringArray(ignorePaths))));
}

function removeIgnoredPaths(value: unknown, ignorePaths: Set<string>, path = ''): unknown {
  if (ignorePaths.has(path)) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => removeIgnoredPaths(item, ignorePaths, path ? `${path}.${index}` : String(index)));
  }
  if (!isJsonObject(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !ignorePaths.has(path ? `${path}.${key}` : key))
      .map(([key, item]) => [key, removeIgnoredPaths(item, ignorePaths, path ? `${path}.${key}` : key)])
      .filter(([, item]) => item !== undefined),
  );
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (!isJsonObject(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map(key => [key, sortJsonValue(value[key])]),
  );
}

function formatTinyplacePayload(base: JsonObject, url: string, previousBody: unknown, currentBody: unknown, changed: boolean): JsonObject {
  const current = isTinyplaceCanvas(currentBody) ? currentBody : undefined;
  const previous = isTinyplaceCanvas(previousBody) ? previousBody : undefined;
  const canvasUrl = url;
  const canvasPngUrl = canvasUrl.endsWith('/canvas') ? `${canvasUrl.slice(0, -'/canvas'.length)}/canvas.png` : undefined;

  if (!current) {
    return {
      ...base,
      kind: 'tinyplace_canvas_error',
      error: 'Tinyplace response was not a 64x64 canvas array.',
    };
  }

  const diff = previous ? diffTinyplaceCanvas(previous, current) : [];
  return compactJsonObject({
    ok: base.ok,
    kind: 'tinyplace_canvas_delta',
    changed,
    initial: !previous,
    url,
    canvasUrl,
    canvasPngUrl,
    sampledAt: base.sampledAt,
    size: current.length,
    filledPixels: countFilledPixels(current),
    changedCount: previous ? diff.length : undefined,
    changedPixels: previous ? diff : undefined,
    hint: previous
      ? 'Tinyplace changed pixels are listed as x/y/from/to. open_media can attach the canvas PNG URL for visual inspection on an image-capable model.'
      : 'Initial Tinyplace baseline captured. Future deltas will list changed pixels.',
  });
}

function isTinyplaceCanvas(value: unknown): value is (string | null)[][] {
  return Array.isArray(value)
    && value.length > 0
    && value.every(row =>
      Array.isArray(row)
      && row.length === value.length
      && row.every(cell => cell === null || typeof cell === 'string'),
    );
}

function diffTinyplaceCanvas(previous: (string | null)[][], current: (string | null)[][]): JsonObject[] {
  const changes: JsonObject[] = [];
  const height = Math.max(previous.length, current.length);
  for (let y = 0; y < height; y += 1) {
    const width = Math.max(previous[y]?.length ?? 0, current[y]?.length ?? 0);
    for (let x = 0; x < width; x += 1) {
      const from = previous[y]?.[x] ?? null;
      const to = current[y]?.[x] ?? null;
      if (from !== to) {
        changes.push({ x, y, from, to });
      }
    }
  }
  return changes;
}

function countFilledPixels(canvas: (string | null)[][]): number {
  return canvas.reduce((count, row) => count + row.filter(Boolean).length, 0);
}
