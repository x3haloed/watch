import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve } from 'node:path';
import type { JsonObject, StreamDelta, StreamRegistrySnapshot, TextStreamSnapshot, WebApiStreamConfig } from './types.js';
import {
  BufferedStream,
  ClockStream,
  ErrorStream,
  InboxStream,
  MessageStore,
  TextFileStream,
  UserNotesStream,
  clampChar,
  cleanStringArray,
  hasParentTraversal,
  isTextStreamSnapshot,
  readFileSyncUtf8,
  validCharsPerSounding,
  validMaxPayloads,
  type MessageEntry,
  type StoredMessage,
  type StreamPopContext,
  type WatchStream,
} from './stream-primitives.js';
import { WebApiStream } from './web-api-stream.js';

export type { MessageEntry, StoredMessage, StreamPopContext, WatchStream } from './stream-primitives.js';

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
    this.streams.set('errors', new ErrorStream());
    this.subscriptions.add('clock');
    this.subscriptions.add('inbox');
    this.subscriptions.add('errors');
    this.configuredSubscriptions.add('errors');

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

  registerBufferedStream(stream: string, options: { subscribed?: boolean; waking?: boolean; maxPayloads?: number } = {}): void {
    if (!this.streams.has(stream)) {
      this.streams.set(stream, new BufferedStream(stream, options.waking ?? true, validMaxPayloads(options.maxPayloads)));
    }
    if (options.subscribed !== false) {
      this.subscriptions.add(stream);
    }
    this.configuredSubscriptions.add(stream);
    this.emitGazeChanged();
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
