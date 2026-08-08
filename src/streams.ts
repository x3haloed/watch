import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve } from 'node:path';
import type { AudioStreamSnapshot, AudioVideoStreamSnapshot, JsonObject, PersistedStreamConfig, StreamDelta, StreamRegistrySnapshot, TextStreamSnapshot, VideoStreamSnapshot, WebApiStreamConfig, SseStreamConfig } from './types.js';
import {
  BufferedStream,
  ClockStream,
  ErrorStream,
  InboxStream,
  TextFileStream,
  VideoFileStream,
  AudioFileStream,
  AudioVideoFileStream,
  DesktopCaptureBridge,
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
import { CameraStreamBridge } from './camera-streams.js';
import { updatePersistedStream } from './stream-config.js';

export type { MessageEntry, MessageInbox, StoredMessage, StreamPopContext, WatchStream };

type StreamOrigin = 'system' | 'config' | 'runtime' | 'integration';
type ConnectorState = 'not_applicable' | 'stopped' | 'connecting' | 'connected';
type ManagedConnector = {
  start(): void;
  stop(reason?: string): void;
  status(): Exclude<ConnectorState, 'not_applicable'>;
  startSegment?(): void;
  finishSegmentAndPush?(): Promise<void>;
};

export type StreamView = {
  name: string;
  kind: PersistedStreamConfig['kind'] | 'system' | 'text' | 'video' | 'audio' | 'av' | 'integration';
  origin: StreamOrigin;
  active: boolean;
  subscribed: boolean;
  waking: boolean;
  persistedToConfig: boolean;
  connectorState: ConnectorState;
  capabilities: {
    definable: boolean;
    removable: boolean;
    gazeMutable: boolean;
    wakingMutable: boolean;
    configPersistable: boolean;
    ephemeral: boolean;
  };
  definition?: Record<string, unknown>;
};

const DEFAULT_MEDIA_VIDEO_FPS = 5;
const DEFAULT_MEDIA_VIDEO_WIDTH = 640;
const DEFAULT_MEDIA_VIDEO_HEIGHT = 360;
const DEFAULT_MEDIA_AUDIO_SAMPLE_RATE = 16000;
const DEFAULT_MEDIA_AUDIO_CHANNELS = 1;
const DEFAULT_MEDIA_AUDIO_FORMAT = 'mp3';

export class StreamRegistry {
  private readonly messages: MessageInbox;
  private readonly streams = new Map<string, WatchStream>();
  private readonly subscriptions = new Set<string>();
  private readonly configuredSubscriptions = new Set<string>();
  private readonly definitions = new Map<string, PersistedStreamConfig>();
  private readonly origins = new Map<string, StreamOrigin>();
  private readonly wakingPolicies = new Map<string, boolean>();
  private readonly connectors = new Map<string, ManagedConnector>();
  private readonly runtimeDefinitions = new Map<string, PersistedStreamConfig>();
  private readonly removedConfigDefinitions = new Set<string>();
  private readonly gazeOverrides = new Map<string, { active?: boolean; waking?: boolean }>();
  private started = false;

  constructor(
    webApiStreams: WebApiStreamConfig[] = [],
    private readonly cwd = process.cwd(),
    initialState?: StreamRegistrySnapshot,
    private readonly onGazeChanged: (snapshot: StreamRegistrySnapshot) => void = () => {},
    userNotes?: { path: string; maxChars: number },
    inbox: MessageInbox = new InMemoryMessageInbox(),
    sseStreams: SseStreamConfig[] = [],
    private readonly log?: EventLog,
    definitions: PersistedStreamConfig[] = [],
  ) {
    this.messages = inbox;
    this.streams.set('clock', new ClockStream());
    this.streams.set('inbox', new InboxStream(this.messages));
    this.streams.set('errors', new ErrorStream());
    this.subscriptions.add('clock');
    this.subscriptions.add('inbox');
    this.subscriptions.add('errors');
    this.configuredSubscriptions.add('errors');
    for (const name of ['clock', 'inbox', 'errors']) {
      this.origins.set(name, 'system');
      this.wakingPolicies.set(name, this.streams.get(name)!.waking);
    }

    if (userNotes) {
      this.streams.set('user-notes', new UserNotesStream(userNotes.path, userNotes.maxChars));
      this.subscriptions.add('user-notes');
      this.configuredSubscriptions.add('user-notes');
      this.origins.set('user-notes', 'system');
      this.wakingPolicies.set('user-notes', this.streams.get('user-notes')!.waking);
    }

    for (const config of webApiStreams) {
      if (!config.name.trim() || !config.url.trim()) continue;
      this.installDefinition({
        ...config,
        kind: 'web_api',
        active: config.subscribed,
        format: config.kind,
      }, 'config');
    }

    for (const config of sseStreams) {
      if (!config.name.trim() || !config.url.trim()) continue;
      this.installDefinition({ kind: 'sse', ...config, active: config.subscribed }, 'config');
    }

    for (const definition of definitions) this.installDefinition(definition, 'config');

    this.restore(initialState);
  }

  get inbox(): MessageInbox {
    return this.messages;
  }

  subscribe(stream: string): boolean {
    const changed = !this.subscriptions.has(stream);
    if (!this.streams.has(stream)) {
      this.installDefinition({ kind: 'buffered', name: stream, active: true, waking: true }, 'runtime');
    }
    this.subscriptions.add(stream);
    this.gazeOverrides.set(stream, { ...this.gazeOverrides.get(stream), active: true });
    if (this.started) this.connectors.get(stream)?.start();
    if (changed) {
      this.emitGazeChanged();
    }
    return changed;
  }

  registerBufferedStream(stream: string, options: { subscribed?: boolean; waking?: boolean; maxPayloads?: number } = {}): void {
    if (!this.streams.has(stream)) {
      this.installDefinition({
        kind: 'buffered',
        name: stream,
        active: options.subscribed !== false,
        waking: options.waking ?? true,
        maxPayloads: validMaxPayloads(options.maxPayloads),
      }, 'integration');
    }
    this.configuredSubscriptions.add(stream);
    this.emitGazeChanged();
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    for (const name of this.subscriptions) this.connectors.get(name)?.start();
  }

  stop(reason = 'registry stopped'): void {
    this.started = false;
    for (const connector of this.connectors.values()) connector.stop(reason);
  }

  startDesktopSegments(): void {
    for (const [name, connector] of this.connectors) {
      if (this.subscriptions.has(name)) connector.startSegment?.();
    }
  }

  async finishDesktopSegments(): Promise<void> {
    await Promise.all([...this.connectors.entries()]
      .filter(([name]) => this.subscriptions.has(name))
      .map(([, connector]) => connector.finishSegmentAndPush?.())
      .filter((value): value is Promise<void> => Boolean(value)));
  }

  setDefinition(definition: PersistedStreamConfig, persistToConfig: boolean): Record<string, unknown> {
    const currentOrigin = this.origins.get(definition.name);
    if (currentOrigin === 'system' || currentOrigin === 'integration') {
      throw new Error(`stream definition cannot be replaced: ${definition.name}`);
    }
    this.disposeDefinition(definition.name);
    this.gazeOverrides.delete(definition.name);
    this.removedConfigDefinitions.delete(definition.name);
    this.installDefinition(definition, persistToConfig ? 'config' : 'runtime');
    if (persistToConfig) {
      updatePersistedStream(this.cwd, { type: 'set', stream: definition });
      this.runtimeDefinitions.delete(definition.name);
      this.removedConfigDefinitions.delete(definition.name);
      this.gazeOverrides.delete(definition.name);
    }
    if (this.started && this.subscriptions.has(definition.name)) this.connectors.get(definition.name)?.start();
    this.emitGazeChanged();
    return this.mutationResult(definition.name, persistToConfig);
  }

  removeDefinition(name: string, persistToConfig: boolean): Record<string, unknown> {
    const view = this.requireView(name);
    if (!view.capabilities.removable) throw new Error(`stream definition cannot be removed: ${name}`);
    this.disposeDefinition(name);
    if (persistToConfig) {
      updatePersistedStream(this.cwd, { type: 'remove', name });
      this.removedConfigDefinitions.delete(name);
    } else if (view.origin === 'config') {
      this.removedConfigDefinitions.add(name);
    }
    this.runtimeDefinitions.delete(name);
    this.gazeOverrides.delete(name);
    this.emitGazeChanged();
    return {
      ok: true,
      stream: name,
      removed: true,
      configPersisted: persistToConfig,
      storedInGazeState: !persistToConfig,
      willReturnOnRestart: false,
    };
  }

  setGaze(name: string, gaze: { active?: boolean; waking?: boolean }, persistToConfig: boolean): Record<string, unknown> {
    const view = this.requireView(name);
    if (gaze.active !== undefined && !view.capabilities.gazeMutable) throw new Error(`stream gaze cannot be changed: ${name}`);
    if (gaze.waking !== undefined && !view.capabilities.wakingMutable) throw new Error(`stream waking policy cannot be changed: ${name}`);
    if (persistToConfig && !view.capabilities.configPersistable) throw new Error(`stream gaze cannot be persisted to config: ${name}`);
    if (gaze.active !== undefined) {
      const wasActive = this.subscriptions.has(name);
      if (gaze.active) {
        this.subscriptions.add(name);
        if (!wasActive && this.started) this.connectors.get(name)?.start();
      } else {
        this.subscriptions.delete(name);
        this.connectors.get(name)?.stop('gaze deactivated');
      }
    }
    if (gaze.waking !== undefined) this.wakingPolicies.set(name, gaze.waking);
    if (persistToConfig) {
      const definition = this.definitions.get(name);
      if (!definition) throw new Error(`stream definition cannot be persisted: ${name}`);
      const updated = { ...definition, ...gaze } as PersistedStreamConfig;
      updatePersistedStream(this.cwd, view.origin === 'config'
        ? { type: 'gaze', name, ...gaze }
        : { type: 'set', stream: updated });
      this.definitions.set(name, updated);
      this.runtimeDefinitions.delete(name);
      this.gazeOverrides.delete(name);
      this.origins.set(name, 'config');
    } else {
      this.gazeOverrides.set(name, { ...this.gazeOverrides.get(name), ...gaze });
    }
    this.emitGazeChanged();
    return this.mutationResult(name, persistToConfig);
  }

  list(filter: { name?: string; active?: boolean; waking?: boolean } = {}): StreamView[] {
    return [...this.streams.keys()]
      .map(name => this.view(name))
      .filter((entry): entry is StreamView => Boolean(entry))
      .filter(entry => filter.name === undefined || entry.name === filter.name)
      .filter(entry => filter.active === undefined || entry.active === filter.active)
      .filter(entry => filter.waking === undefined || entry.waking === filter.waking)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  listDefinitions(filter: { name?: string } = {}): StreamView[] {
    return this.list({ name: filter.name });
  }

  unsubscribe(stream: string): boolean {
    if (stream === 'clock' || stream === 'inbox' || stream === 'errors') {
      return false;
    }
    const changed = this.subscriptions.delete(stream);
    this.gazeOverrides.set(stream, { ...this.gazeOverrides.get(stream), active: false });
    this.connectors.get(stream)?.stop('gaze deactivated');
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
    this.origins.set(stream.name, 'runtime');
    this.wakingPolicies.set(stream.name, stream.waking);
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
        ? ['Text stream reached EOF in the first chunk. text_stream_open accepts resumeAtChar for another position.']
        : [`Future Soundings will include the next chunk. text_stream_close with stream "${stream.name}" ends it.`],
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
    preferVideo?: boolean;
  }): Promise<Record<string, unknown>> {
    const file = this.resolvePath(input.path);
    const fps = input.fps ?? DEFAULT_MEDIA_VIDEO_FPS;
    const speed = input.speed ?? 1;
    const width = input.width ?? DEFAULT_MEDIA_VIDEO_WIDTH;
    const height = input.height ?? DEFAULT_MEDIA_VIDEO_HEIGHT;
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
      width,
      height,
      input.preferVideo ?? false,
    );

    const firstChunk = await stream.readInitialChunk();
    this.streams.set(stream.name, stream);
    this.origins.set(stream.name, 'runtime');
    this.wakingPolicies.set(stream.name, stream.waking);
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
      width,
      height,
      videoTime: startSecond,
      duration,
      subscribed: !stream.isDone(),
      firstChunk,
      next_actions: stream.isDone()
        ? ['Video stream reached duration end in the first chunk. video_stream_open accepts resumeAtSecond for another position.']
        : ['Future Soundings will include the next video chunks. video_stream_close and gaze_remove end the stream.'],
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
    const sampleRate = input.sampleRate ?? DEFAULT_MEDIA_AUDIO_SAMPLE_RATE;
    const channels = input.channels ?? DEFAULT_MEDIA_AUDIO_CHANNELS;
    const format = input.format ?? DEFAULT_MEDIA_AUDIO_FORMAT;
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
    this.origins.set(stream.name, 'runtime');
    this.wakingPolicies.set(stream.name, stream.waking);
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
        ? ['Audio stream reached duration end in the first chunk. audio_stream_open accepts resumeAtSecond for another position.']
        : ['Future Soundings will include the next audio chunks. audio_stream_close and gaze_remove end the stream.'],
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
    preferVideo?: boolean;
  }): Promise<Record<string, unknown>> {
    const file = this.resolvePath(input.path);
    const fps = input.fps ?? DEFAULT_MEDIA_VIDEO_FPS;
    const speed = input.speed ?? 1;
    const sampleRate = input.sampleRate ?? DEFAULT_MEDIA_AUDIO_SAMPLE_RATE;
    const channels = input.channels ?? DEFAULT_MEDIA_AUDIO_CHANNELS;
    const format = input.format ?? DEFAULT_MEDIA_AUDIO_FORMAT;
    const width = input.width ?? DEFAULT_MEDIA_VIDEO_WIDTH;
    const height = input.height ?? DEFAULT_MEDIA_VIDEO_HEIGHT;
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
      width,
      height,
      input.preferVideo ?? false,
    );

    const firstChunk = await stream.readInitialChunk();
    this.streams.set(stream.name, stream);
    this.origins.set(stream.name, 'runtime');
    this.wakingPolicies.set(stream.name, stream.waking);
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
      width,
      height,
      sampleRate,
      channels,
      format,
      mediaTime: startSecond,
      duration,
      subscribed: !stream.isDone(),
      firstChunk,
      next_actions: stream.isDone()
        ? ['Audio/video stream reached duration end in the first chunk. av_stream_open accepts resumeAtSecond for another position.']
        : ['Future Soundings will include the next audio chunks and video chunks. av_stream_close and gaze_remove end the stream.'],
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
    return this.popMatchingDeltas(context, () => true);
  }

  async popWakingDeltas(context: StreamPopContext): Promise<StreamDelta[]> {
    return this.popMatchingDeltas(context, stream => this.wakingPolicies.get(stream.name) ?? stream.waking);
  }

  private async popMatchingDeltas(context: StreamPopContext, matches: (stream: WatchStream) => boolean): Promise<StreamDelta[]> {
    const deltas: StreamDelta[] = [];
    for (const stream of this.streams.values()) {
      if (!this.isSubscribed(stream.name) || !matches(stream)) {
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
        this.origins.delete(stream.name);
        this.wakingPolicies.delete(stream.name);
        this.gazeOverrides.delete(stream.name);
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
    return [...this.streams.values()].some(stream => this.isSubscribed(stream.name) && (this.wakingPolicies.get(stream.name) ?? stream.waking) && stream.hasDelta(now));
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
      version: 2,
      subscriptions: this.listSubscriptions(),
      knownStreams: this.listStreams(),
      gazeOverrides: Object.fromEntries(this.gazeOverrides),
      runtimeDefinitions: [...this.runtimeDefinitions.values()],
      removedConfigDefinitions: [...this.removedConfigDefinitions].sort(),
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

    for (const definition of Array.isArray(state.runtimeDefinitions) ? state.runtimeDefinitions : []) {
      if (definition && typeof definition === 'object' && typeof definition.name === 'string') {
        this.installDefinition(definition, 'runtime');
      }
    }
    for (const name of cleanStringArray(state.removedConfigDefinitions)) {
      this.removedConfigDefinitions.add(name);
      if (this.origins.get(name) === 'config') this.disposeDefinition(name);
    }

    const restoredSubscriptions = new Set(cleanStringArray(state.subscriptions));
    if (state.version !== 2) {
      this.subscriptions.clear();
      for (const stream of restoredSubscriptions) {
        if (!this.streams.has(stream)) {
          this.installDefinition({ kind: 'buffered', name: stream, active: true, waking: true }, 'runtime');
        }
        this.subscriptions.add(stream);
      }
      const knownStreams = new Set(cleanStringArray(state.knownStreams));
      for (const stream of this.configuredSubscriptions) {
        if (!knownStreams.has(stream)) {
          this.subscriptions.add(stream);
        }
      }
    }
    this.subscriptions.add('clock');
    this.subscriptions.add('inbox');
    this.subscriptions.add('errors');

    if (state.gazeOverrides && typeof state.gazeOverrides === 'object') {
      for (const [name, gaze] of Object.entries(state.gazeOverrides)) {
        if (!gaze || typeof gaze !== 'object') continue;
        const clean = {
          ...(typeof gaze.active === 'boolean' ? { active: gaze.active } : {}),
          ...(typeof gaze.waking === 'boolean' ? { waking: gaze.waking } : {}),
        };
        this.gazeOverrides.set(name, clean);
        if (!this.streams.has(name)) continue;
        if (clean.active === true) this.subscriptions.add(name);
        if (clean.active === false && !isProtectedSystem(name)) this.subscriptions.delete(name);
        if (clean.waking !== undefined) this.wakingPolicies.set(name, clean.waking);
      }
    }

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
        this.origins.set(text.name, 'runtime');
        this.wakingPolicies.set(text.name, this.gazeOverrides.get(text.name)?.waking ?? false);
        if (restoredSubscriptions.has(text.name)) this.subscriptions.add(text.name);
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
      this.origins.set(video.name, 'runtime');
      this.wakingPolicies.set(video.name, this.gazeOverrides.get(video.name)?.waking ?? false);
      if (restoredSubscriptions.has(video.name)) this.subscriptions.add(video.name);
    }

    for (const audio of Array.isArray(state.audioStreams) ? state.audioStreams : []) {
      if (!isAudioStreamSnapshot(audio)) {
        continue;
      }
      this.streams.set(
        audio.name,
        new AudioFileStream(audio.name, audio.file, this.displayPath(audio.file), audio.speed, audio.sampleRate, audio.channels, audio.format, audio.audioTime, audio.duration),
      );
      this.origins.set(audio.name, 'runtime');
      this.wakingPolicies.set(audio.name, this.gazeOverrides.get(audio.name)?.waking ?? false);
      if (restoredSubscriptions.has(audio.name)) this.subscriptions.add(audio.name);
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
      this.origins.set(av.name, 'runtime');
      this.wakingPolicies.set(av.name, this.gazeOverrides.get(av.name)?.waking ?? false);
      if (restoredSubscriptions.has(av.name)) this.subscriptions.add(av.name);
    }
  }

  private installDefinition(definition: PersistedStreamConfig, origin: StreamOrigin): void {
    if (!definition.name.trim()) throw new Error('stream name is required');
    if (this.streams.has(definition.name)) this.disposeDefinition(definition.name);
    let stream: WatchStream;
    let connector: ManagedConnector | undefined;
    if (definition.kind === 'sse') {
      const sse = new SseStream(definition.name, {
        name: definition.name,
        url: definition.url,
        headers: definition.headers,
        waking: definition.waking,
        subscribed: definition.active,
        maxPayloads: definition.maxPayloads,
      }, this.log);
      stream = sse;
      connector = { start: () => sse.start(), stop: () => sse.close(), status: () => sse.status() };
    } else if (definition.kind === 'web_api') {
      stream = new WebApiStream(definition.name, {
        name: definition.name,
        url: definition.url,
        headers: definition.headers,
        intervalMs: definition.intervalMs,
        waking: definition.waking,
        subscribed: definition.active,
        emitUnchanged: definition.emitUnchanged,
        ignorePaths: definition.ignorePaths,
        kind: definition.format,
      });
    } else if (definition.kind === 'camera') {
      stream = new BufferedStream(definition.name, definition.waking ?? true, validMaxPayloads(definition.maxBufferedChunks));
      const bridge = new CameraStreamBridge({
        ...definition,
        subscribed: definition.active,
      }, this, this.log ?? new EventLog(this.cwd));
      connector = { start: () => bridge.start(), stop: reason => bridge.stop(reason), status: () => bridge.status() };
    } else if (definition.kind === 'desktop_capture') {
      stream = new BufferedStream(definition.name, definition.waking ?? false, validMaxPayloads(definition.maxBufferedChunks));
      const bridge = new DesktopCaptureBridge({
        ...definition,
        enabled: true,
        subscribed: definition.active,
      }, this, this.log ?? new EventLog(this.cwd));
      connector = {
        start: () => bridge.start(),
        stop: () => bridge.stop(),
        status: () => bridge.status(),
        startSegment: () => bridge.startSegment(),
        finishSegmentAndPush: () => bridge.finishSegmentAndPush(),
      };
    } else {
      stream = new BufferedStream(definition.name, definition.waking ?? true, validMaxPayloads(definition.maxPayloads));
    }
    this.streams.set(definition.name, stream);
    this.definitions.set(definition.name, { ...definition });
    this.origins.set(definition.name, origin);
    this.wakingPolicies.set(definition.name, definition.waking ?? defaultWaking(definition.kind));
    if (connector) this.connectors.set(definition.name, connector);
    if (definition.active !== false) this.subscriptions.add(definition.name);
    else this.subscriptions.delete(definition.name);
    const override = this.gazeOverrides.get(definition.name);
    if (override?.active === true) this.subscriptions.add(definition.name);
    if (override?.active === false && !isProtectedSystem(definition.name)) this.subscriptions.delete(definition.name);
    if (override?.waking !== undefined) this.wakingPolicies.set(definition.name, override.waking);
    if ((origin === 'config' || origin === 'integration') && definition.active !== false) this.configuredSubscriptions.add(definition.name);
    if (origin === 'runtime') this.runtimeDefinitions.set(definition.name, { ...definition });
  }

  private disposeDefinition(name: string): void {
    this.connectors.get(name)?.stop('stream definition removed');
    const stream = this.streams.get(name);
    if (stream instanceof SseStream) stream.close();
    this.connectors.delete(name);
    this.streams.delete(name);
    this.definitions.delete(name);
    this.origins.delete(name);
    this.wakingPolicies.delete(name);
    this.subscriptions.delete(name);
    this.configuredSubscriptions.delete(name);
  }

  private view(name: string): StreamView | undefined {
    const stream = this.streams.get(name);
    if (!stream) return undefined;
    const definition = this.definitions.get(name);
    const origin = this.origins.get(name) ?? 'runtime';
    const kind = definition?.kind ?? kindForStream(stream, origin);
    const active = this.subscriptions.has(name);
    const waking = this.wakingPolicies.get(name) ?? stream.waking;
    const capabilities = capabilitiesFor(kind, origin, name);
    const persistedToConfig = origin === 'config'
      && (definition?.active ?? true) === active
      && (definition?.waking ?? defaultWaking(definition?.kind)) === waking
      && !this.gazeOverrides.has(name);
    return {
      name,
      kind,
      origin,
      active,
      subscribed: active,
      waking,
      persistedToConfig,
      connectorState: this.connectors.get(name)?.status() ?? 'not_applicable',
      capabilities,
      definition: publicDefinition(definition),
    };
  }

  private requireView(name: string): StreamView {
    const view = this.view(name);
    if (!view) throw new Error(`stream is not defined: ${name}`);
    return view;
  }

  private mutationResult(name: string, configPersisted: boolean): Record<string, unknown> {
    return {
      ok: true,
      stream: name,
      liveApplied: true,
      configPersisted,
      storedInGazeState: !configPersisted,
      view: this.view(name),
    };
  }

  private emitGazeChanged(): void {
    this.onGazeChanged(this.snapshot());
  }
}

function defaultWaking(kind: PersistedStreamConfig['kind'] | undefined): boolean {
  return kind === 'sse' || kind === 'camera' || kind === 'buffered';
}

function kindForStream(stream: WatchStream, origin: StreamOrigin): StreamView['kind'] {
  if (stream instanceof TextFileStream) return 'text';
  if (stream instanceof VideoFileStream) return 'video';
  if (stream instanceof AudioFileStream) return 'audio';
  if (stream instanceof AudioVideoFileStream) return 'av';
  return origin === 'integration' ? 'integration' : 'system';
}

function capabilitiesFor(kind: StreamView['kind'], origin: StreamOrigin, name: string): StreamView['capabilities'] {
  if (origin === 'system') {
    return {
      definable: false,
      removable: false,
      gazeMutable: !isProtectedSystem(name),
      wakingMutable: !isProtectedSystem(name),
      configPersistable: false,
      ephemeral: false,
    };
  }
  if (origin === 'integration') {
    return { definable: false, removable: false, gazeMutable: true, wakingMutable: true, configPersistable: false, ephemeral: false };
  }
  if (kind === 'text' || kind === 'video' || kind === 'audio' || kind === 'av') {
    return { definable: false, removable: true, gazeMutable: true, wakingMutable: true, configPersistable: false, ephemeral: true };
  }
  return { definable: true, removable: true, gazeMutable: true, wakingMutable: true, configPersistable: true, ephemeral: false };
}

function publicDefinition(definition: PersistedStreamConfig | undefined): Record<string, unknown> | undefined {
  if (!definition) return undefined;
  const output = { ...definition } as Record<string, unknown>;
  if ('headers' in definition && definition.headers) {
    output.headers = { redacted: true, count: Object.keys(definition.headers).length };
  }
  return output;
}

function isProtectedSystem(name: string): boolean {
  return name === 'clock' || name === 'inbox' || name === 'errors';
}

function isFileBackedStream(stream: WatchStream): stream is TextFileStream | VideoFileStream | AudioFileStream | AudioVideoFileStream {
  return stream instanceof TextFileStream
    || stream instanceof VideoFileStream
    || stream instanceof AudioFileStream
    || stream instanceof AudioVideoFileStream;
}
