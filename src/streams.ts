import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import type { JsonObject, ModelCapabilities, StreamDelta, WebApiStreamConfig } from './types.js';

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

class WebApiStream implements WatchStream {
  readonly sampled = true;
  readonly waking: boolean;
  private lastFingerprint = '';
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
    if (result.fingerprint === this.lastFingerprint) {
      return undefined;
    }
    this.lastFingerprint = result.fingerprint;
    return {
      stream: this.name,
      at: sampledAt,
      payload: result.payload,
    };
  }

  private async fetchCurrent(sampledAt: string): Promise<{ fingerprint: string; payload: JsonObject }> {
    try {
      const response = await fetch(this.config.url, {
        method: 'GET',
        headers: this.config.headers,
        signal: AbortSignal.timeout(10_000),
      });
      const contentType = response.headers.get('content-type') ?? '';
      const text = await response.text();
      const parsed = contentType.includes('application/json') ? parseJson(text) : undefined;
      const fingerprint = JSON.stringify({
        ok: response.ok,
        status: response.status,
        body: text,
      });
      return {
        fingerprint,
        payload: {
          ok: response.ok,
          url: this.config.url,
          status: response.status,
          statusText: response.statusText,
          contentType,
          sampledAt,
          body: parsed ?? text,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        fingerprint: JSON.stringify({ error: message }),
        payload: {
          ok: false,
          url: this.config.url,
          sampledAt,
          error: message,
        },
      };
    }
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

  constructor(webApiStreams: WebApiStreamConfig[] = [], private readonly cwd = process.cwd()) {
    this.streams.set('clock', new ClockStream());
    this.streams.set('inbox', new InboxStream(this.messages));
    this.subscriptions.add('clock');
    this.subscriptions.add('inbox');

    for (const config of webApiStreams) {
      if (!config.name.trim() || !config.url.trim()) continue;
      this.streams.set(config.name, new WebApiStream(config.name, config));
      if (config.subscribed !== false) {
        this.subscriptions.add(config.name);
      }
    }
  }

  subscribe(stream: string): boolean {
    const changed = !this.subscriptions.has(stream);
    if (!this.streams.has(stream)) {
      this.streams.set(stream, new BufferedStream(stream));
    }
    this.subscriptions.add(stream);
    return changed;
  }

  unsubscribe(stream: string): boolean {
    if (stream === 'clock') {
      return false;
    }
    return this.subscriptions.delete(stream);
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

function hasParentTraversal(path: string): boolean {
  return path.split(/[\\/]+/).includes('..');
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
