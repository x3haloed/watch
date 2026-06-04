import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import type { JsonObject, ModelCapabilities, StreamDelta, StreamRegistrySnapshot, TextStreamSnapshot, WebApiStreamConfig } from './types.js';

export type StoredMessage = {
  id: number;
  medium: string;
  source: string;
  subject: string;
  content: string;
  receivedAt: string;
  metadata?: JsonObject;
};

export type StreamPopContext = {
  now: Date;
  capabilities: ModelCapabilities;
};

const DEFAULT_WEB_API_INTERVAL_MS = 15 * 60 * 1000;
const DEFAULT_TEXT_STREAM_CHARS = 4000;
const INBOX_PREVIEW_CHARS = 240;

export interface WatchStream {
  readonly name: string;
  readonly waking: boolean;
  readonly sampled?: boolean;
  push(payload: JsonObject): void;
  hasDelta(now: Date): boolean;
  popDelta(context: StreamPopContext): StreamDelta | undefined | Promise<StreamDelta | undefined>;
}

class ClockStream implements WatchStream {
  readonly name = 'clock';
  readonly waking = false;
  private current: JsonObject | undefined;
  private lastPoppedSecond = '';

  push(payload: JsonObject): void {
    this.current = payload;
  }

  hasDelta(now: Date): boolean {
    return now.toISOString().slice(0, 19) !== this.lastPoppedSecond;
  }

  popDelta({ now }: StreamPopContext): StreamDelta {
    const iso = now.toISOString();
    this.lastPoppedSecond = iso.slice(0, 19);
    return {
      stream: this.name,
      at: iso,
      payload: {
        ...this.current,
        iso,
        epochMs: now.getTime(),
      },
    };
  }
}

class InboxStream implements WatchStream {
  readonly name = 'inbox';
  readonly waking = true;
  private pendingIds: number[] = [];

  constructor(private readonly messages: MessageStore) {}

  push(payload: JsonObject): void {
    const message = this.messages.add({
      medium: String(payload.medium ?? payload.source ?? 'cli'),
      source: String(payload.source ?? payload.medium ?? 'cli'),
      subject: typeof payload.subject === 'string' ? payload.subject : undefined,
      content: String(payload.message ?? payload.content ?? ''),
      metadata: isJsonObject(payload.metadata) ? payload.metadata : undefined,
    });
    this.pendingIds.push(message.id);
  }

  hasDelta(): boolean {
    return this.pendingIds.length > 0;
  }

  popDelta({ now }: StreamPopContext): StreamDelta | undefined {
    if (this.pendingIds.length === 0) {
      return undefined;
    }

    const ids = this.pendingIds;
    this.pendingIds = [];
    const entries = ids.flatMap(id => {
      const message = this.messages.get(id);
      return message
        ? [
            compactJsonObject({
              id: message.id,
              medium: message.medium,
              source: message.source,
              subject: message.subject,
              receivedAt: message.receivedAt,
              preview: inboxDeltaPreview(message),
              hint: `Call open_message with id ${message.id} to read the full message. To reply after reading, call send_message with medium "${message.medium}" and replyToId ${message.id}.`,
            }),
          ]
        : [];
    });

    return {
      stream: this.name,
      at: now.toISOString(),
      payload: {
        count: entries.length,
        entries,
      },
    };
  }
}

class BufferedStream implements WatchStream {
  readonly waking = true;
  private payloads: JsonObject[] = [];

  constructor(readonly name: string) {}

  push(payload: JsonObject): void {
    this.payloads.push({ ...payload, receivedAt: new Date().toISOString() });
  }

  hasDelta(): boolean {
    return this.payloads.length > 0;
  }

  popDelta({ now, capabilities }: StreamPopContext): StreamDelta | undefined {
    if (this.payloads.length === 0) {
      return undefined;
    }

    const payloads = this.payloads;
    this.payloads = [];

    return {
      stream: this.name,
      at: now.toISOString(),
      payload: {
        count: payloads.length,
        delivery: deliveryModeFor(this.name, capabilities),
        items: payloads,
      },
    };
  }
}

class UserNotesStream implements WatchStream {
  readonly name = 'user-notes';
  readonly waking = false;
  readonly sampled = true;
  private lastContent: string | undefined;

  constructor(
    private readonly file: string,
    private readonly maxChars: number,
  ) {}

  push(): void {
    // User notes are sampled from disk during Sounding construction.
  }

  hasDelta(): boolean {
    return false;
  }

  popDelta({ now }: StreamPopContext): StreamDelta | undefined {
    const current = truncateText(readFileIfExists(this.file).trim(), this.maxChars);
    if (this.lastContent === undefined) {
      this.lastContent = current;
      return {
        stream: this.name,
        at: now.toISOString(),
        payload: {
          kind: 'user_notes_snapshot',
          file: this.file,
          text: `[user-notes]\n${current || '(empty)'}\n[/user-notes]`,
        },
      };
    }

    if (current === this.lastContent) {
      return undefined;
    }

    const patch = lineDiff(this.lastContent, current);
    this.lastContent = current;
    return {
      stream: this.name,
      at: now.toISOString(),
      payload: {
        kind: 'user_notes_patch',
        file: this.file,
        text: `[user-notes]\n${patch || '(changed, no line diff)'}\n[/user-notes]`,
      },
    };
  }
}

class WebApiStream implements WatchStream {
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

class TextFileStream implements WatchStream {
  readonly waking = false;
  private nextChar: number;

  constructor(
    readonly name: string,
    private readonly file: string,
    private readonly displayPath: string,
    private readonly content: string,
    private readonly charsPerSounding: number,
    startChar: number,
  ) {
    this.nextChar = clampChar(startChar, content.length);
  }

  push(): void {
    // Text file streams advance only when sampled into a Sounding.
  }

  hasDelta(): boolean {
    return this.nextChar < this.content.length;
  }

  popDelta({ now }: StreamPopContext): StreamDelta | undefined {
    const chunk = this.readChunk();
    if (!chunk) {
      return undefined;
    }
    return {
      stream: this.name,
      at: now.toISOString(),
      payload: chunk,
    };
  }

  readChunk(): JsonObject | undefined {
    if (!this.hasDelta()) {
      return undefined;
    }
    const startChar = this.nextChar;
    const endChar = Math.min(this.content.length, startChar + this.charsPerSounding);
    const chunk = this.content.slice(startChar, endChar);
    this.nextChar = endChar;
    const done = this.nextChar >= this.content.length;
    return {
      kind: 'text_file_chunk',
      stream: this.name,
      file: this.displayPath,
      filename: basename(this.file),
      totalChars: this.content.length,
      charsPerSounding: this.charsPerSounding,
      startChar,
      endChar,
      nextChar: this.nextChar,
      done,
      chunk,
      hint: done
        ? 'Text stream reached EOF and will be removed from gaze.'
        : `Next Sounding will include chars ${this.nextChar}-${Math.min(this.content.length, this.nextChar + this.charsPerSounding)}. Call text_stream_close or unsubscribe_stream to stop.`,
    };
  }

  isDone(): boolean {
    return !this.hasDelta();
  }

  snapshot(): TextStreamSnapshot {
    return {
      name: this.name,
      file: this.file,
      charsPerSounding: this.charsPerSounding,
      nextChar: this.nextChar,
    };
  }
}

function validIntervalMs(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_WEB_API_INTERVAL_MS;
  }
  return value;
}

function inboxDeltaPreview(message: StoredMessage): string | undefined {
  if (!shouldPreviewInboxDelta(message)) {
    return undefined;
  }
  return truncatePreview(message.content.replace(/\s+/g, ' ').trim());
}

function shouldPreviewInboxDelta(message: StoredMessage): boolean {
  const discord = message.metadata?.discord;
  if (!isJsonObject(discord)) {
    return false;
  }
  const reason = discord.reason;
  return reason === 'dm' || reason === 'mention' || reason === 'reply';
}

function truncatePreview(content: string): string | undefined {
  if (!content) {
    return undefined;
  }
  return content.length > INBOX_PREVIEW_CHARS ? `${content.slice(0, INBOX_PREVIEW_CHARS - 3)}...` : content;
}

function compactJsonObject(value: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function validCharsPerSounding(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_TEXT_STREAM_CHARS;
  }
  return Math.max(1, Math.min(100_000, Math.floor(value)));
}

function clampChar(value: number, totalChars: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(totalChars, Math.floor(value)));
}

export class StreamRegistry {
  private readonly messages = new MessageStore();
  private readonly streams = new Map<string, WatchStream>();
  private readonly subscriptions = new Set<string>();
  private readonly configuredSubscriptions = new Set<string>();

  constructor(
    webApiStreams: WebApiStreamConfig[] = [],
    private readonly cwd = process.cwd(),
    initialState?: StreamRegistrySnapshot,
    private readonly onGazeChanged: (snapshot: StreamRegistrySnapshot) => void = () => {},
    userNotes?: { path: string; maxChars: number },
  ) {
    this.streams.set('clock', new ClockStream());
    this.streams.set('inbox', new InboxStream(this.messages));
    this.subscriptions.add('clock');
    this.subscriptions.add('inbox');

    if (userNotes) {
      this.streams.set('user-notes', new UserNotesStream(userNotes.path, userNotes.maxChars));
      this.subscriptions.add('user-notes');
      this.configuredSubscriptions.add('user-notes');
    }

    for (const config of webApiStreams) {
      if (!config.name.trim() || !config.url.trim()) continue;
      this.streams.set(config.name, new WebApiStream(config.name, config));
      if (config.subscribed !== false) {
        this.subscriptions.add(config.name);
        this.configuredSubscriptions.add(config.name);
      }
    }

    this.restore(initialState);
  }

  subscribe(stream: string): boolean {
    const changed = !this.subscriptions.has(stream);
    if (!this.streams.has(stream)) {
      this.streams.set(stream, new BufferedStream(stream));
    }
    this.subscriptions.add(stream);
    if (changed) {
      this.emitGazeChanged();
    }
    return changed;
  }

  unsubscribe(stream: string): boolean {
    if (stream === 'clock') {
      return false;
    }
    const changed = this.subscriptions.delete(stream);
    if (changed) {
      this.emitGazeChanged();
    }
    return changed;
  }

  async openTextFileStream(input: {
    path: string;
    charsPerSounding?: number;
    resumeAtChar?: number;
  }): Promise<Record<string, unknown>> {
    const file = this.resolvePath(input.path);
    const content = await readFile(file, 'utf8');
    const charsPerSounding = validCharsPerSounding(input.charsPerSounding);
    const startChar = clampChar(input.resumeAtChar ?? 0, content.length);
    const stream = new TextFileStream(
      `text:${basename(file)}:${randomUUID().slice(0, 8)}`,
      file,
      this.displayPath(file),
      content,
      charsPerSounding,
      startChar,
    );
    const firstChunk = stream.readChunk();
    this.streams.set(stream.name, stream);
    if (!stream.isDone()) {
      this.subscriptions.add(stream.name);
    }
    this.emitGazeChanged();
    return {
      ok: true,
      stream: stream.name,
      file: this.displayPath(file),
      filename: basename(file),
      totalChars: content.length,
      charsPerSounding,
      startChar,
      subscribed: !stream.isDone(),
      message: `text stream for file ${basename(file)} successful. total of ${content.length} chars. ${charsPerSounding} chars per sounding. First chapter starts now:`,
      text: `text stream for file ${basename(file)} successful. total of ${content.length} chars. ${charsPerSounding} chars per sounding. First chapter starts now:\n\n${typeof firstChunk?.chunk === 'string' ? firstChunk.chunk : ''}`,
      firstChunk,
      next_actions: stream.isDone()
        ? ['Text stream reached EOF in the first chunk. Call text_stream_open with resumeAtChar to reread from another position.']
        : [`Future Soundings will include the next chunk. Call text_stream_close with stream "${stream.name}" to stop.`],
    };
  }

  closeTextFileStream(stream: string): Record<string, unknown> {
    const existing = this.streams.get(stream);
    const existed = existing instanceof TextFileStream;
    const unsubscribed = this.unsubscribe(stream);
    if (existed) {
      this.streams.delete(stream);
    }
    if (existed || unsubscribed) {
      this.emitGazeChanged();
    }
    return {
      ok: true,
      stream,
      closed: existed,
      unsubscribed,
      subscriptions: this.listSubscriptions(),
    };
  }

  isSubscribed(stream: string): boolean {
    return this.subscriptions.has(stream);
  }

  listSubscriptions(): string[] {
    return [...this.subscriptions].sort();
  }

  listStreams(): string[] {
    return [...this.streams.keys()].sort();
  }

  listNotSubscribed(): string[] {
    return this.listStreams().filter(stream => !this.subscriptions.has(stream));
  }

  push(stream: string, payload: JsonObject): boolean {
    if (!this.isSubscribed(stream)) {
      return false;
    }

    const watchStream = this.streams.get(stream) ?? new BufferedStream(stream);
    this.streams.set(stream, watchStream);
    watchStream.push(payload);
    return true;
  }

  async popDeltas(context: StreamPopContext): Promise<StreamDelta[]> {
    const deltas: StreamDelta[] = [];
    for (const stream of this.streams.values()) {
      if (!this.isSubscribed(stream.name)) {
        continue;
      }
      if (!stream.sampled && !stream.hasDelta(context.now)) {
        continue;
      }
      const delta = await stream.popDelta(context);
      if (delta) {
        deltas.push(delta);
      }
      if (stream instanceof TextFileStream && stream.isDone()) {
        this.subscriptions.delete(stream.name);
        this.streams.delete(stream.name);
        this.emitGazeChanged();
      } else if (stream instanceof TextFileStream) {
        this.emitGazeChanged();
      }
    }
    return deltas;
  }

  hasPending(now = new Date()): boolean {
    return [...this.streams.values()].some(stream => this.isSubscribed(stream.name) && stream.hasDelta(now));
  }

  hasWakingPending(now = new Date()): boolean {
    return [...this.streams.values()].some(stream => this.isSubscribed(stream.name) && stream.waking && stream.hasDelta(now));
  }

  getMessage(id: number): StoredMessage | undefined {
    return this.messages.get(id);
  }

  listMessages(medium: string, page = 1, pageSize = 10): { entries: MessageEntry[]; page: number; pageSize: number; total: number; totalPages: number } {
    return this.messages.list(medium, page, pageSize);
  }

  private resolvePath(path: string): string {
    if (hasParentTraversal(path)) {
      throw new Error(`Refusing path with parent traversal (..): ${path}. cwd=${this.cwd}`);
    }
    return isAbsolute(path) ? resolve(path) : resolve(this.cwd, path);
  }

  private displayPath(path: string): string {
    const rel = relative(resolve(this.cwd), path);
    if (!rel) return '.';
    return rel.startsWith('..') ? path : rel;
  }

  snapshot(): StreamRegistrySnapshot {
    return {
      subscriptions: this.listSubscriptions(),
      knownStreams: this.listStreams(),
      textStreams: [...this.streams.values()]
        .filter((stream): stream is TextFileStream => stream instanceof TextFileStream)
        .map(stream => stream.snapshot()),
    };
  }

  private restore(state: StreamRegistrySnapshot | undefined): void {
    if (!state) {
      return;
    }

    this.subscriptions.clear();
    for (const stream of cleanStringArray(state.subscriptions)) {
      if (!this.streams.has(stream)) {
        this.streams.set(stream, new BufferedStream(stream));
      }
      this.subscriptions.add(stream);
    }
    const knownStreams = new Set(cleanStringArray(state.knownStreams));
    for (const stream of this.configuredSubscriptions) {
      if (!knownStreams.has(stream)) {
        this.subscriptions.add(stream);
      }
    }
    this.subscriptions.add('clock');

    for (const text of Array.isArray(state.textStreams) ? state.textStreams : []) {
      if (!isTextStreamSnapshot(text)) {
        continue;
      }
      try {
        const content = readFileSyncUtf8(text.file);
        this.streams.set(
          text.name,
          new TextFileStream(text.name, text.file, this.displayPath(text.file), content, validCharsPerSounding(text.charsPerSounding), text.nextChar),
        );
      } catch {
        this.subscriptions.delete(text.name);
      }
    }
  }

  private emitGazeChanged(): void {
    this.onGazeChanged(this.snapshot());
  }
}

export type MessageEntry = {
  id: number;
  medium: string;
  source: string;
  subject: string;
  receivedAt: string;
};

class MessageStore {
  private nextId = 1;
  private readonly messages = new Map<number, StoredMessage>();

  add(input: { medium: string; source: string; subject?: string; content: string; metadata?: JsonObject }): StoredMessage {
    const id = this.nextId++;
    const content = input.content;
    const message: StoredMessage = {
      id,
      medium: input.medium,
      source: input.source,
      subject: input.subject?.trim() || preview(content),
      content,
      receivedAt: new Date().toISOString(),
      metadata: input.metadata,
    };
    this.messages.set(id, message);
    return message;
  }

  get(id: number): StoredMessage | undefined {
    return this.messages.get(id);
  }

  list(medium: string, page: number, pageSize: number): { entries: MessageEntry[]; page: number; pageSize: number; total: number; totalPages: number } {
    const safePageSize = Math.max(1, Math.min(50, Math.floor(pageSize)));
    const all = [...this.messages.values()]
      .filter(message => message.medium === medium)
      .sort((a, b) => b.id - a.id);
    const totalPages = Math.max(1, Math.ceil(all.length / safePageSize));
    const safePage = Math.max(1, Math.min(totalPages, Math.floor(page)));
    const start = (safePage - 1) * safePageSize;
    return {
      entries: all.slice(start, start + safePageSize).map(message => ({
        id: message.id,
        medium: message.medium,
        source: message.source,
        subject: message.subject,
        receivedAt: message.receivedAt,
      })),
      page: safePage,
      pageSize: safePageSize,
      total: all.length,
      totalPages,
    };
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function preview(content: string): string {
  const text = content.replace(/\s+/g, ' ').trim();
  if (!text) return '(empty message)';
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
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
      ? 'Tinyplace changed pixels are listed as x/y/from/to. Call open_media with the canvas PNG URL on an image-capable model to inspect the full board visually.'
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

function hasParentTraversal(path: string): boolean {
  return path.split(/[\\/]+/).includes('..');
}

function cleanStringArray(values: unknown): string[] {
  return Array.isArray(values) ? values.filter((value): value is string => typeof value === 'string' && value.trim().length > 0) : [];
}

function isTextStreamSnapshot(value: unknown): value is TextStreamSnapshot {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const item = value as Partial<TextStreamSnapshot>;
  return typeof item.name === 'string'
    && typeof item.file === 'string'
    && typeof item.charsPerSounding === 'number'
    && typeof item.nextChar === 'number';
}

function readFileSyncUtf8(path: string): string {
  return readFileSync(path, 'utf8');
}

function readFileIfExists(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function truncateText(content: string, maxChars: number): string {
  if (content.length <= maxChars) {
    return content;
  }
  return `${content.slice(0, maxChars)}\n[...truncated user-notes at ${maxChars}/${content.length} chars]`;
}

function lineDiff(previous: string, current: string): string {
  const previousLines = previous.split('\n');
  const currentLines = current.split('\n');
  const prefix = commonPrefixLength(previousLines, currentLines);
  const suffix = commonSuffixLength(previousLines.slice(prefix), currentLines.slice(prefix));
  const removed = previousLines.slice(prefix, previousLines.length - suffix).map(line => `- ${line}`);
  const added = currentLines.slice(prefix, currentLines.length - suffix).map(line => `+ ${line}`);
  return [...removed, ...added].join('\n');
}

function commonPrefixLength(a: string[], b: string[]): number {
  let index = 0;
  while (index < a.length && index < b.length && a[index] === b[index]) {
    index += 1;
  }
  return index;
}

function commonSuffixLength(a: string[], b: string[]): number {
  let count = 0;
  while (count < a.length && count < b.length && a[a.length - 1 - count] === b[b.length - 1 - count]) {
    count += 1;
  }
  return count;
}

function deliveryModeFor(stream: string, capabilities: ModelCapabilities): string {
  if (stream === 'video') {
    if (capabilities.video) return 'video';
    if (capabilities.images) return 'sampled-frames';
    return 'metadata-only';
  }
  if (stream === 'audio') {
    return capabilities.audio ? 'audio' : 'metadata-only';
  }
  return 'raw-buffer';
}
