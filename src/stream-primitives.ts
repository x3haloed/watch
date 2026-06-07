import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { JsonObject, ModelCapabilities, StreamDelta, TextStreamSnapshot } from './types.js';

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

const DEFAULT_TEXT_STREAM_CHARS = 4000;
const INBOX_PREVIEW_CHARS = 240;
const ERROR_STREAM_MAX_ITEMS = 20;

export interface WatchStream {
  readonly name: string;
  readonly waking: boolean;
  readonly sampled?: boolean;
  push(payload: JsonObject): void;
  hasDelta(now: Date): boolean;
  popDelta(context: StreamPopContext): StreamDelta | undefined | Promise<StreamDelta | undefined>;
}

export class ClockStream implements WatchStream {
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

export class InboxStream implements WatchStream {
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

export class BufferedStream implements WatchStream {
  private payloads: JsonObject[] = [];

  constructor(
    readonly name: string,
    readonly waking = true,
    private readonly maxPayloads = Infinity,
  ) {}

  push(payload: JsonObject): void {
    this.payloads.push({ ...payload, receivedAt: new Date().toISOString() });
    if (this.payloads.length > this.maxPayloads) {
      this.payloads = this.payloads.slice(-this.maxPayloads);
    }
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

export class ErrorStream implements WatchStream {
  readonly name = 'errors';
  readonly waking = true;
  private pending: JsonObject[] = [];
  private activeRepeat: JsonObject | undefined;

  push(payload: JsonObject): void {
    const now = new Date().toISOString();
    const item = compactJsonObject({
      ...payload,
      severity: typeof payload.severity === 'string' ? payload.severity : 'error',
      receivedAt: now,
    });
    const key = errorFingerprint(item);
    if (this.activeRepeat && this.activeRepeat.fingerprint === key) {
      this.activeRepeat.count = Number(this.activeRepeat.count ?? 1) + 1;
      this.activeRepeat.lastAt = now;
      return;
    }
    this.flushRepeat();
    this.activeRepeat = {
      ...item,
      fingerprint: key,
      count: 1,
      firstAt: now,
      lastAt: now,
    };
  }

  hasDelta(): boolean {
    return !!this.activeRepeat || this.pending.length > 0;
  }

  popDelta({ now }: StreamPopContext): StreamDelta | undefined {
    this.flushRepeat();
    if (this.pending.length === 0) {
      return undefined;
    }
    const items = this.pending.splice(0, ERROR_STREAM_MAX_ITEMS);
    const remaining = this.pending.length;
    return {
      stream: this.name,
      at: now.toISOString(),
      payload: {
        count: items.length,
        remaining,
        items: items.map(item => compactJsonObject({
          ...item,
          fingerprint: undefined,
          repeated: Number(item.count ?? 1) > 1 ? item.count : undefined,
          hint: errorHint(item),
        })),
      },
    };
  }

  private flushRepeat(): void {
    if (!this.activeRepeat) {
      return;
    }
    this.pending.push(this.activeRepeat);
    this.activeRepeat = undefined;
  }
}

export class UserNotesStream implements WatchStream {
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

export class TextFileStream implements WatchStream {
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

export function compactJsonObject(value: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function errorFingerprint(item: JsonObject): string {
  return JSON.stringify({
    severity: item.severity,
    source: item.source,
    kind: item.kind,
    modelId: item.modelId,
    message: item.message ?? item.reason ?? item.error,
  });
}

function errorHint(item: JsonObject): string | undefined {
  const source = typeof item.source === 'string' ? item.source : '';
  const kind = typeof item.kind === 'string' ? item.kind : '';
  if (source === 'inference' || kind.startsWith('model_')) {
    return 'Provider/model trouble is part of the operating environment. Consider handle_with_model, curl, or waiting if the provider is unstable.';
  }
  if (source === 'discord') {
    return 'Discord bridge reported an internal error. If it repeats, inspect discord_attention or ask the operator to restart Watch.';
  }
  if (source === 'runtime') {
    return 'Watch runtime reported an internal warning/error. If it blocks action, preserve context with curl or ask the operator to inspect logs.';
  }
  return undefined;
}

export function validCharsPerSounding(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_TEXT_STREAM_CHARS;
  }
  return Math.max(1, Math.min(100_000, Math.floor(value)));
}

export function validMaxPayloads(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return Infinity;
  }
  return Math.max(1, Math.min(100, Math.floor(value)));
}

export function clampChar(value: number, totalChars: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(totalChars, Math.floor(value)));
}

export type MessageEntry = {
  id: number;
  medium: string;
  source: string;
  subject: string;
  receivedAt: string;
};

export class MessageStore {
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

export function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function preview(content: string): string {
  const text = content.replace(/\s+/g, ' ').trim();
  if (!text) return '(empty message)';
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

export function hasParentTraversal(path: string): boolean {
  return path.split(/[\\/]+/).includes('..');
}

export function cleanStringArray(values: unknown): string[] {
  return Array.isArray(values) ? values.filter((value): value is string => typeof value === 'string' && value.trim().length > 0) : [];
}

export function isTextStreamSnapshot(value: unknown): value is TextStreamSnapshot {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const item = value as Partial<TextStreamSnapshot>;
  return typeof item.name === 'string'
    && typeof item.file === 'string'
    && typeof item.charsPerSounding === 'number'
    && typeof item.nextChar === 'number';
}

export function readFileSyncUtf8(path: string): string {
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
