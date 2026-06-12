import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve } from 'node:path';
import type { AudioStreamSnapshot, AudioVideoStreamSnapshot, JsonObject, StreamDelta, StreamRegistrySnapshot, TextStreamSnapshot, VideoStreamSnapshot, WebApiStreamConfig, SseStreamConfig } from './types.js';
import {
  BufferedStream,
  ClockStream,
  ErrorStream,
  InboxStream,
  TextFileStream,
  VideoFileStream,
  AudioFileStream,
  AudioVideoFileStream,
  UserNotesStream,
  clampChar,
  cleanStringArray,
  hasParentTraversal,
  isTextStreamSnapshot,
  isVideoStreamSnapshot,
  isAudioStreamSnapshot,
  isAudioVideoStreamSnapshot,
  getMediaDuration,
  readFileSyncUtf8,
  validCharsPerSounding,
  validMaxPayloads,
  type StreamPopContext,
  type WatchStream,
} from './stream-primitives.js';
import { WebApiStream } from './web-api-stream.js';
import { SseStream } from './sse-stream.js';
import { InMemoryMessageInbox, type MessageEntry, type MessageInbox, type StoredMessage } from './message-inbox.js';
import { EventLog } from './event-log.js';

export type { MessageEntry, MessageInbox, StoredMessage, StreamPopContext, WatchStream };

export class StreamRegistry {
  private readonly messages: MessageInbox;
  private readonly streams = new Map<string, WatchStream>();
  private readonly subscriptions = new Set<string>();
  private readonly configuredSubscriptions = new Set<string>();

  constructor(
    webApiStreams: WebApiStreamConfig[] = [],
    private readonly cwd = process.cwd(),
    initialState?: StreamRegistrySnapshot,
    private readonly onGazeChanged: (snapshot: StreamRegistrySnapshot) => void = () => {},
    userNotes?: { path: string; maxChars: number },
    inbox: MessageInbox = new InMemoryMessageInbox(),
    sseStreams: SseStreamConfig[] = [],
    private readonly log?: EventLog,
  ) {
    this.messages = inbox;
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

    for (const config of sseStreams) {
       if (!config.name.trim() || !config.url.trim()) continue;
       this.streams.set(config.name, new SseStream(config.name, config, this.log));
      if (config.subscribed !== false) {
        this.subscriptions.add(config.name);
        this.configuredSubscriptions.add(config.name);
      }
    }

    this.restore(initialState);
  }

  get inbox(): MessageInbox {
    return this.messages;
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

  async openVideoFileStream(input: {
    path: string;
    fps?: number;
    speed?: number;
    resumeAtSecond?: number;
    width?: number;
    height?: number;
  }): Promise<Record<string, unknown>> {
    const file = this.resolvePath(input.path);
    const fps = input.fps ?? 1;
    const speed = input.speed ?? 1;
    const startSecond = input.resumeAtSecond ?? 0;
    const duration = await getMediaDuration(file);

    const stream = new VideoFileStream(
      `video:${basename(file)}:${randomUUID().slice(0, 8)}`,
      file,
      this.displayPath(file),
      fps,
      speed,
      startSecond,
      duration,
      input.width,
      input.height,
    );

    const firstChunk = await stream.readInitialChunk();
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
      fps,
      speed,
      width: input.width,
      height: input.height,
      videoTime: startSecond,
      duration,
      subscribed: !stream.isDone(),
      firstChunk,
      next_actions: stream.isDone()
        ? ['Video stream reached duration end in the first chunk. Call video_stream_open with resumeAtSecond to read from another position.']
        : [`Future Soundings will include the next video frames. Call video_stream_close or unsubscribe_stream to stop.`],
    };
  }

  closeVideoFileStream(stream: string): Record<string, unknown> {
    const existing = this.streams.get(stream);
    const existed = existing instanceof VideoFileStream;
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

  async openAudioFileStream(input: {
    path: string;
    speed?: number;
    sampleRate?: number;
    channels?: number;
    format?: string;
    resumeAtSecond?: number;
  }): Promise<Record<string, unknown>> {
    const file = this.resolvePath(input.path);
    const speed = input.speed ?? 1;
    const sampleRate = input.sampleRate ?? 16000;
    const channels = input.channels ?? 1;
    const format = input.format ?? 'wav';
    const startSecond = input.resumeAtSecond ?? 0;
    const duration = await getMediaDuration(file);

    const stream = new AudioFileStream(
      `audio:${basename(file)}:${randomUUID().slice(0, 8)}`,
      file,
      this.displayPath(file),
      speed,
      sampleRate,
      channels,
      format,
      startSecond,
      duration,
    );

    const firstChunk = await stream.readInitialChunk();
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
      speed,
      sampleRate,
      channels,
      format,
      audioTime: startSecond,
      duration,
      subscribed: !stream.isDone(),
      firstChunk,
      next_actions: stream.isDone()
        ? ['Audio stream reached duration end in the first chunk. Call audio_stream_open with resumeAtSecond to read from another position.']
        : [`Future Soundings will include the next audio chunks. Call audio_stream_close or unsubscribe_stream to stop.`],
    };
  }

  closeAudioFileStream(stream: string): Record<string, unknown> {
    const existing = this.streams.get(stream);
    const existed = existing instanceof AudioFileStream;
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

  async openAudioVideoFileStream(input: {
    path: string;
    fps?: number;
    speed?: number;
    sampleRate?: number;
    channels?: number;
    format?: string;
    resumeAtSecond?: number;
    width?: number;
    height?: number;
  }): Promise<Record<string, unknown>> {
    const file = this.resolvePath(input.path);
    const fps = input.fps ?? 1;
    const speed = input.speed ?? 1;
    const sampleRate = input.sampleRate ?? 16000;
    const channels = input.channels ?? 1;
    const format = input.format ?? 'wav';
    const startSecond = input.resumeAtSecond ?? 0;
    const duration = await getMediaDuration(file);

    const stream = new AudioVideoFileStream(
      `av:${basename(file)}:${randomUUID().slice(0, 8)}`,
      file,
      this.displayPath(file),
      fps,
      speed,
      startSecond,
      duration,
      sampleRate,
      channels,
      format,
      input.width,
      input.height,
    );

    const firstChunk = await stream.readInitialChunk();
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
      fps,
      speed,
      width: input.width,
      height: input.height,
      sampleRate,
      channels,
      format,
      mediaTime: startSecond,
      duration,
      subscribed: !stream.isDone(),
      firstChunk,
      next_actions: stream.isDone()
        ? ['Audio/video stream reached duration end in the first chunk. Call av_stream_open with resumeAtSecond to read from another position.']
        : [`Future Soundings will include the next audio chunks and video frames. Call av_stream_close or unsubscribe_stream to stop.`],
    };
  }

  closeAudioVideoFileStream(stream: string): Record<string, unknown> {
    const existing = this.streams.get(stream);
    const existed = existing instanceof AudioVideoFileStream;
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
      if (isFileBackedStream(stream) && stream.isDone()) {
        this.subscriptions.delete(stream.name);
        this.streams.delete(stream.name);
        this.emitGazeChanged();
      } else if (isFileBackedStream(stream)) {
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
      videoStreams: [...this.streams.values()]
        .filter((stream): stream is VideoFileStream => stream instanceof VideoFileStream)
        .map(stream => stream.snapshot()),
      audioStreams: [...this.streams.values()]
        .filter((stream): stream is AudioFileStream => stream instanceof AudioFileStream)
        .map(stream => stream.snapshot()),
      avStreams: [...this.streams.values()]
        .filter((stream): stream is AudioVideoFileStream => stream instanceof AudioVideoFileStream)
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

    for (const video of Array.isArray(state.videoStreams) ? state.videoStreams : []) {
      if (!isVideoStreamSnapshot(video)) {
        continue;
      }
      this.streams.set(
        video.name,
        new VideoFileStream(video.name, video.file, this.displayPath(video.file), video.fps, video.speed, video.videoTime, video.duration, video.width, video.height),
      );
    }

    for (const audio of Array.isArray(state.audioStreams) ? state.audioStreams : []) {
      if (!isAudioStreamSnapshot(audio)) {
        continue;
      }
      this.streams.set(
        audio.name,
        new AudioFileStream(audio.name, audio.file, this.displayPath(audio.file), audio.speed, audio.sampleRate, audio.channels, audio.format, audio.audioTime, audio.duration),
      );
    }

    for (const av of Array.isArray(state.avStreams) ? state.avStreams : []) {
      if (!isAudioVideoStreamSnapshot(av)) {
        continue;
      }
      this.streams.set(
        av.name,
        new AudioVideoFileStream(
          av.name,
          av.file,
          this.displayPath(av.file),
          av.fps,
          av.speed,
          av.mediaTime,
          av.duration,
          av.sampleRate,
          av.channels,
          av.format,
          av.width,
          av.height,
        ),
      );
    }
  }

  private emitGazeChanged(): void {
    this.onGazeChanged(this.snapshot());
  }
}

function isFileBackedStream(stream: WatchStream): stream is TextFileStream | VideoFileStream | AudioFileStream | AudioVideoFileStream {
  return stream instanceof TextFileStream
    || stream instanceof VideoFileStream
    || stream instanceof AudioFileStream
    || stream instanceof AudioVideoFileStream;
}
