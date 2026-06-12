import { readFileSync, unlinkSync } from 'node:fs';
import { basename } from 'node:path';
import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promisify } from 'node:util';
import type { AudioStreamSnapshot, AudioVideoStreamSnapshot, DesktopCaptureConfig, JsonObject, ModelCapabilities, StreamDelta, TextStreamSnapshot, VideoStreamSnapshot } from './types.js';
import type { MessageInbox, StoredMessage } from './message-inbox.js';

export type StreamPopContext = {
  now: Date;
  capabilities: ModelCapabilities;
};

const DEFAULT_TEXT_STREAM_CHARS = 4000;
const INBOX_PREVIEW_CHARS = 240;
const ERROR_STREAM_MAX_ITEMS = 20;
const DESKTOP_CAPTURE_SIGINT_TIMEOUT_MS = 5_000;
const DESKTOP_CAPTURE_SIGTERM_TIMEOUT_MS = 2_000;
const DESKTOP_CAPTURE_SIGKILL_TIMEOUT_MS = 2_000;

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

  constructor(private readonly messages: MessageInbox) {}

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
              hint: `Call open_message with id ${message.id} to read the full message. To reply after reading, call send_message with medium "${message.medium}" and replyToId ${message.id}. For proactive Discord posting, use send_message with medium "discord" and a channelId.`,
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

export function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
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
  if (stream === 'video' || stream.startsWith('video:') || stream.startsWith('camera:') || stream.startsWith('desktop:')) {
    if (capabilities.video) return 'video';
    if (capabilities.images) return 'sampled-frames';
    return 'metadata-only';
  }
  if (stream === 'audio' || stream.startsWith('audio:')) {
    return capabilities.audio ? 'audio' : 'metadata-only';
  }
  return 'raw-buffer';
}

const execFileAsync = promisify(execFile);

export async function getMediaDuration(filePath: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath,
    ]);
    const duration = parseFloat(stdout.trim());
    return Number.isFinite(duration) ? duration : Infinity;
  } catch {
    return Infinity;
  }
}

export function extractAudioSlice(
  filePath: string,
  startSecond: number,
  durationSeconds: number,
  sampleRate?: number,
  channels?: number,
  format?: string,
): Promise<string | null> {
  return new Promise((resolve) => {
    const targetFormat = format || 'wav';
    const args = [
      '-ss', startSecond.toFixed(3),
      '-t', durationSeconds.toFixed(3),
      '-i', filePath,
      ...(sampleRate ? ['-ar', sampleRate.toString()] : []),
      ...(channels ? ['-ac', channels.toString()] : []),
      ...audioEncodingArgs(targetFormat),
      '-f', targetFormat,
      'pipe:1',
    ];
    const proc = spawn('ffmpeg', args);

    const chunks: Buffer[] = [];
    proc.stdout.on('data', (chunk) => {
      chunks.push(chunk);
    });

    proc.on('close', (code) => {
      if (code === 0 && chunks.length > 0) {
        resolve(Buffer.concat(chunks).toString('base64'));
      } else {
        resolve(null);
      }
    });

    proc.on('error', () => {
      resolve(null);
    });
  });
}

function audioEncodingArgs(format: string): string[] {
  if (format === 'mp3') {
    return ['-codec:a', 'libmp3lame', '-b:a', '32k'];
  }
  if (format === 'ogg') {
    return ['-codec:a', 'libvorbis', '-b:a', '32k'];
  }
  if (format === 'm4a') {
    return ['-codec:a', 'aac', '-b:a', '48k', '-movflags', 'frag_keyframe+empty_moov'];
  }
  if (format === 'aac') {
    return ['-codec:a', 'aac', '-b:a', '48k'];
  }
  if (format === 'flac') {
    return ['-codec:a', 'flac', '-compression_level', '8'];
  }
  return [];
}

export function extractVideoFrame(
  filePath: string,
  timeSeconds: number,
  width?: number,
  height?: number,
): Promise<string | null> {
  return new Promise((resolve) => {
    const scaleFilter = (width && height) ? `scale=${width}:${height}:force_original_aspect_ratio=decrease` : undefined;
    const args = [
      '-ss', timeSeconds.toFixed(3),
      '-i', filePath,
      ...(scaleFilter ? ['-vf', scaleFilter] : []),
      '-vframes', '1',
      '-f', 'image2pipe',
      '-vcodec', 'mjpeg',
      '-',
    ];
    const proc = spawn('ffmpeg', args);

    const chunks: Buffer[] = [];
    proc.stdout.on('data', (chunk) => {
      chunks.push(chunk);
    });

    proc.on('close', (code) => {
      if (code === 0 && chunks.length > 0) {
        const buffer = Buffer.concat(chunks);
        resolve(buffer.toString('base64'));
      } else {
        resolve(null);
      }
    });

    proc.on('error', () => {
      resolve(null);
    });
  });
}

export function extractVideoSlice(
  filePath: string,
  startSecond: number,
  durationSeconds: number,
  fps?: number,
  width?: number,
  height?: number,
): Promise<string | null> {
  return new Promise((resolve) => {
    if (durationSeconds <= 0) {
      resolve(null);
      return;
    }

    const filters = [
      (width && height) ? `scale=${width}:${height}:force_original_aspect_ratio=decrease` : undefined,
      fps ? `fps=${fps}` : undefined,
    ].filter((filter): filter is string => typeof filter === 'string');
    const args = [
      '-ss', startSecond.toFixed(3),
      '-t', durationSeconds.toFixed(3),
      '-i', filePath,
      ...(filters.length > 0 ? ['-vf', filters.join(',')] : []),
      '-an',
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-preset', 'veryfast',
      '-crf', '32',
      '-movflags', 'frag_keyframe+empty_moov',
      '-f', 'mp4',
      'pipe:1',
    ];
    const proc = spawn('ffmpeg', args);

    const chunks: Buffer[] = [];
    proc.stdout.on('data', (chunk) => {
      chunks.push(chunk);
    });

    proc.on('close', (code) => {
      if (code === 0 && chunks.length > 0) {
        resolve(Buffer.concat(chunks).toString('base64'));
      } else {
        resolve(null);
      }
    });

    proc.on('error', () => {
      resolve(null);
    });
  });
}

function audioMimeType(format: string): string {
  if (format === 'mp3') {
    return 'audio/mp3';
  }
  if (format === 'm4a') {
    return 'audio/m4a';
  }
  return `audio/${format}`;
}

function elapsedSecondsSince(lastPopTime: Date | undefined, now: Date): number {
  return lastPopTime ? (now.getTime() - lastPopTime.getTime()) / 1000 : 0;
}

function nextMediaWindow(mediaTime: number, duration: number, speed: number, elapsedSeconds: number): {
  startOffset: number;
  endOffset: number;
  deltaSeconds: number;
} {
  const startOffset = mediaTime;
  const deltaSeconds = elapsedSeconds * speed;
  const endOffset = Math.min(duration, startOffset + deltaSeconds);
  return { startOffset, endOffset, deltaSeconds };
}

async function readAudioChunk(input: {
  file: string;
  stream: string;
  startOffset: number;
  endOffset: number;
  sampleRate: number;
  channels: number;
  format: string;
}): Promise<JsonObject | undefined> {
  const durationSeconds = input.endOffset - input.startOffset;
  if (durationSeconds <= 0) {
    return undefined;
  }

  // TODO: At tight Sounding cadences (e.g., <5s), spawning ffmpeg per Sounding may introduce
  // seek + encode overhead. Consider pre-transcoding or using a persistent process.
  const base64 = await extractAudioSlice(
    input.file,
    input.startOffset,
    durationSeconds,
    input.sampleRate,
    input.channels,
    input.format,
  );
  if (!base64) {
    return undefined;
  }

  return {
    kind: 'audio_file_chunk',
    stream: input.stream,
    startOffset: input.startOffset,
    endOffset: input.endOffset,
    dataBase64: base64,
    mediaType: audioMimeType(input.format),
  };
}

function videoFrameTimestamps(startOffset: number, endOffset: number, deltaSeconds: number, fps: number): number[] {
  if (deltaSeconds === 0) {
    return [startOffset];
  }

  const timestamps: number[] = [];
  const step = 1 / fps;
  for (let t = startOffset + step; t <= endOffset; t += step) {
    timestamps.push(t);
  }
  if (timestamps.length === 0 && deltaSeconds > 0) {
    timestamps.push(endOffset);
  }
  return timestamps;
}

async function readVideoFrames(input: {
  file: string;
  startOffset: number;
  endOffset: number;
  deltaSeconds: number;
  fps: number;
  width?: number;
  height?: number;
}): Promise<Array<{ dataBase64: string; mediaType: string; timestamp: number }>> {
  const frames: Array<{ dataBase64: string; mediaType: string; timestamp: number }> = [];
  for (const t of videoFrameTimestamps(input.startOffset, input.endOffset, input.deltaSeconds, input.fps)) {
    // TODO: Spawning ffmpeg per frame/Sounding has spawn overhead. Consider persistent ffmpeg or pre-transcoding.
    const base64 = await extractVideoFrame(input.file, t, input.width, input.height);
    if (base64) {
      frames.push({
        dataBase64: base64,
        mediaType: 'image/jpeg',
        timestamp: t,
      });
    }
  }
  return frames;
}

async function readVideoChunk(input: {
  file: string;
  stream: string;
  startOffset: number;
  endOffset: number;
  deltaSeconds: number;
  fps: number;
  width?: number;
  height?: number;
  preferVideo: boolean;
}): Promise<JsonObject | undefined> {
  if (input.preferVideo) {
    const dataBase64 = await extractVideoSlice(input.file, input.startOffset, input.endOffset - input.startOffset, input.fps, input.width, input.height);
    if (dataBase64) {
      return {
        kind: 'video_file_chunk',
        stream: input.stream,
        startOffset: input.startOffset,
        endOffset: input.endOffset,
        dataBase64,
        mediaType: 'video/mp4',
      };
    }
  }

  const frames = await readVideoFrames({
    file: input.file,
    startOffset: input.startOffset,
    endOffset: input.endOffset,
    deltaSeconds: input.deltaSeconds,
    fps: input.fps,
    width: input.width,
    height: input.height,
  });
  if (frames.length === 0) {
    return undefined;
  }

  return {
    kind: 'video_frame_chunk',
    stream: input.stream,
    count: frames.length,
    items: frames,
  };
}

export function isVideoStreamSnapshot(value: unknown): value is VideoStreamSnapshot {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const item = value as Partial<VideoStreamSnapshot>;
  return typeof item.name === 'string'
    && typeof item.file === 'string'
    && typeof item.fps === 'number'
    && typeof item.speed === 'number'
    && typeof item.videoTime === 'number'
    && typeof item.duration === 'number';
}

export function isAudioStreamSnapshot(value: unknown): value is AudioStreamSnapshot {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const item = value as Partial<AudioStreamSnapshot>;
  return typeof item.name === 'string'
    && typeof item.file === 'string'
    && typeof item.speed === 'number'
    && typeof item.sampleRate === 'number'
    && typeof item.channels === 'number'
    && typeof item.format === 'string'
    && typeof item.audioTime === 'number'
    && typeof item.duration === 'number';
}

export function isAudioVideoStreamSnapshot(value: unknown): value is AudioVideoStreamSnapshot {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const item = value as Partial<AudioVideoStreamSnapshot>;
  return typeof item.name === 'string'
    && typeof item.file === 'string'
    && typeof item.fps === 'number'
    && typeof item.speed === 'number'
    && typeof item.mediaTime === 'number'
    && typeof item.duration === 'number'
    && typeof item.sampleRate === 'number'
    && typeof item.channels === 'number'
    && typeof item.format === 'string';
}

export class AudioFileStream implements WatchStream {
  readonly waking = false;
  private audioTime: number;
  private lastPopTime: Date | undefined;

  constructor(
    readonly name: string,
    private readonly file: string,
    private readonly displayPath: string,
    private readonly speed: number,
    private readonly sampleRate: number,
    private readonly channels: number,
    private readonly format: string,
    startSecond: number,
    private readonly duration: number,
  ) {
    this.audioTime = startSecond;
  }

  push(): void {
    // Audio file streams advance only when sampled into a Sounding.
  }

  hasDelta(): boolean {
    return this.audioTime < this.duration;
  }

  async readInitialChunk(): Promise<JsonObject | undefined> {
    this.lastPopTime = new Date();
    const duration = Math.min(1, this.duration - this.audioTime);
    const chunk = await readAudioChunk({
      file: this.file,
      stream: this.name,
      startOffset: this.audioTime,
      endOffset: this.audioTime + duration,
      sampleRate: this.sampleRate,
      channels: this.channels,
      format: this.format,
    });
    if (!chunk) {
      return undefined;
    }
    return {
      ...chunk,
    };
  }

  async popDelta(context: StreamPopContext): Promise<StreamDelta | undefined> {
    const now = context.now;
    const elapsedSeconds = elapsedSecondsSince(this.lastPopTime, now);
    this.lastPopTime = now;

    const { startOffset, endOffset } = nextMediaWindow(this.audioTime, this.duration, this.speed, elapsedSeconds);
    this.audioTime = endOffset;

    const chunk = await readAudioChunk({
      file: this.file,
      startOffset,
      endOffset,
      stream: this.name,
      sampleRate: this.sampleRate,
      channels: this.channels,
      format: this.format,
    });
    if (!chunk) {
      return undefined;
    }

    const done = this.audioTime >= this.duration;
    return {
      stream: this.name,
      at: now.toISOString(),
      payload: {
        ...chunk,
        file: this.displayPath,
        filename: basename(this.file),
        audioTime: this.audioTime,
        duration: this.duration,
        done,
        hint: done
          ? 'Audio stream reached end and will be removed from gaze.'
          : `Next Sounding will include audio chunk. Call audio_stream_close or unsubscribe_stream to stop.`,
      },
    };
  }

  isDone(): boolean {
    return !this.hasDelta();
  }

  snapshot(): AudioStreamSnapshot {
    return {
      name: this.name,
      file: this.file,
      speed: this.speed,
      sampleRate: this.sampleRate,
      channels: this.channels,
      format: this.format,
      audioTime: this.audioTime,
      duration: this.duration,
    };
  }
}

export class VideoFileStream implements WatchStream {
  readonly waking = false;
  private videoTime: number;
  private lastPopTime: Date | undefined;

  constructor(
    readonly name: string,
    private readonly file: string,
    private readonly displayPath: string,
    private readonly fps: number,
    private readonly speed: number,
    startSecond: number,
    private readonly duration: number,
    private readonly width?: number,
    private readonly height?: number,
    private readonly initialPreferVideo = false,
  ) {
    this.videoTime = startSecond;
  }

  push(): void {
    // Video file streams advance only when sampled into a Sounding.
  }

  hasDelta(): boolean {
    return this.videoTime < this.duration;
  }

  async readInitialChunk(): Promise<JsonObject | undefined> {
    this.lastPopTime = new Date();
    if (this.initialPreferVideo) {
      const endOffset = Math.min(this.duration, this.videoTime + 1);
      return readVideoChunk({
        file: this.file,
        stream: this.name,
        startOffset: this.videoTime,
        endOffset,
        deltaSeconds: endOffset - this.videoTime,
        fps: this.fps,
        width: this.width,
        height: this.height,
        preferVideo: true,
      });
    }

    const base64 = await extractVideoFrame(this.file, this.videoTime, this.width, this.height);
    if (!base64) {
      return undefined;
    }
    return {
      kind: 'video_frame',
      stream: this.name,
      timestamp: this.videoTime,
      dataBase64: base64,
      mediaType: 'image/jpeg',
    };
  }

  async popDelta(context: StreamPopContext): Promise<StreamDelta | undefined> {
    const now = context.now;
    const elapsedSeconds = elapsedSecondsSince(this.lastPopTime, now);
    this.lastPopTime = now;

    const { startOffset, endOffset, deltaSeconds } = nextMediaWindow(this.videoTime, this.duration, this.speed, elapsedSeconds);
    this.videoTime = endOffset;

    const video = await readVideoChunk({
      file: this.file,
      stream: this.name,
      startOffset,
      endOffset,
      deltaSeconds,
      fps: this.fps,
      width: this.width,
      height: this.height,
      preferVideo: context.capabilities.video,
    });
    if (!video) {
      return undefined;
    }

    const done = this.videoTime >= this.duration;
    return {
      stream: this.name,
      at: now.toISOString(),
      payload: {
        kind: 'video_file_chunk',
        stream: this.name,
        file: this.displayPath,
        filename: basename(this.file),
        startOffset,
        endOffset,
        videoTime: this.videoTime,
        duration: this.duration,
        done,
        ...video,
        hint: done
          ? 'Video stream reached end and will be removed from gaze.'
          : `Next Sounding will include video chunks. Call video_stream_close or unsubscribe_stream to stop.`,
      },
    };
  }

  isDone(): boolean {
    return !this.hasDelta();
  }

  snapshot(): VideoStreamSnapshot {
    return {
      name: this.name,
      file: this.file,
      fps: this.fps,
      speed: this.speed,
      videoTime: this.videoTime,
      duration: this.duration,
      width: this.width,
      height: this.height,
    };
  }
}

export class AudioVideoFileStream implements WatchStream {
  readonly waking = false;
  private mediaTime: number;
  private lastPopTime: Date | undefined;

  constructor(
    readonly name: string,
    private readonly file: string,
    private readonly displayPath: string,
    private readonly fps: number,
    private readonly speed: number,
    startSecond: number,
    private readonly duration: number,
    private readonly sampleRate: number,
    private readonly channels: number,
    private readonly format: string,
    private readonly width?: number,
    private readonly height?: number,
    private readonly initialPreferVideo = false,
  ) {
    this.mediaTime = startSecond;
  }

  push(): void {
    // Audio/video file streams advance only when sampled into a Sounding.
  }

  hasDelta(): boolean {
    return this.mediaTime < this.duration;
  }

  async readInitialChunk(): Promise<JsonObject | undefined> {
    this.lastPopTime = new Date();
    const initialDuration = Math.min(1, this.duration - this.mediaTime);
    const [audio, videoPayload] = await Promise.all([
      readAudioChunk({
        file: this.file,
        stream: this.name,
        startOffset: this.mediaTime,
        endOffset: this.mediaTime + initialDuration,
        sampleRate: this.sampleRate,
        channels: this.channels,
        format: this.format,
      }),
      this.initialPreferVideo
        ? readVideoChunk({
            file: this.file,
            stream: this.name,
            startOffset: this.mediaTime,
            endOffset: this.mediaTime + initialDuration,
            deltaSeconds: initialDuration,
            fps: this.fps,
            width: this.width,
            height: this.height,
            preferVideo: true,
          })
        : extractVideoFrame(this.file, this.mediaTime, this.width, this.height),
    ]);

    const video = this.initialPreferVideo
      ? videoPayload
      : typeof videoPayload === 'string'
        ? {
            kind: 'video_frame',
            stream: this.name,
            timestamp: this.mediaTime,
            dataBase64: videoPayload,
            mediaType: 'image/jpeg',
          }
        : undefined;

    if (!audio && !video) {
      return undefined;
    }

    return compactJsonObject({
      kind: 'av_file_chunk',
      stream: this.name,
      startOffset: this.mediaTime,
      endOffset: this.mediaTime + initialDuration,
      audio,
      video,
    });
  }

  async popDelta(context: StreamPopContext): Promise<StreamDelta | undefined> {
    const now = context.now;
    const elapsedSeconds = elapsedSecondsSince(this.lastPopTime, now);
    this.lastPopTime = now;

    const { startOffset, endOffset, deltaSeconds } = nextMediaWindow(this.mediaTime, this.duration, this.speed, elapsedSeconds);
    this.mediaTime = endOffset;

    const [audio, video] = await Promise.all([
      readAudioChunk({
        file: this.file,
        stream: this.name,
        startOffset,
        endOffset,
        sampleRate: this.sampleRate,
        channels: this.channels,
        format: this.format,
      }),
      readVideoChunk({
        file: this.file,
        stream: this.name,
        startOffset,
        endOffset,
        deltaSeconds,
        fps: this.fps,
        width: this.width,
        height: this.height,
        preferVideo: context.capabilities.video,
      }),
    ]);

    if (!audio && !video) {
      return undefined;
    }

    const done = this.mediaTime >= this.duration;
    return {
      stream: this.name,
      at: now.toISOString(),
      payload: compactJsonObject({
        kind: 'av_file_chunk',
        stream: this.name,
        file: this.displayPath,
        filename: basename(this.file),
        startOffset,
        endOffset,
        mediaTime: this.mediaTime,
        duration: this.duration,
        done,
        audio,
        video,
        hint: done
          ? 'Audio/video stream reached end and will be removed from gaze.'
          : `Next Sounding will include audio chunk and video chunks. Call av_stream_close or unsubscribe_stream to stop.`,
      }),
    };
  }

  isDone(): boolean {
    return !this.hasDelta();
  }

  snapshot(): AudioVideoStreamSnapshot {
    return {
      name: this.name,
      file: this.file,
      fps: this.fps,
      speed: this.speed,
      mediaTime: this.mediaTime,
      duration: this.duration,
      width: this.width,
      height: this.height,
      sampleRate: this.sampleRate,
      channels: this.channels,
      format: this.format,
    };
  }
}

export function downsampleImage(
  base64Data: string,
  width: number,
  height: number,
): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn('ffmpeg', [
      '-i', 'pipe:0',
      '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
      '-f', 'image2pipe',
      '-vcodec', 'mjpeg',
      '-',
    ]);

    const chunks: Buffer[] = [];
    proc.stdout.on('data', (chunk) => {
      chunks.push(chunk);
    });

    proc.on('close', (code) => {
      if (code === 0 && chunks.length > 0) {
        resolve(Buffer.concat(chunks).toString('base64'));
      } else {
        resolve(null);
      }
    });

    proc.on('error', () => {
      resolve(null);
    });

    // Handle stdin errors (e.g. EPIPE) if ffmpeg exits immediately
    proc.stdin.on('error', () => {});

    // Write the source base64 image to ffmpeg stdin.
    // Note: Node's spawn starts the process asynchronously; writing here is safe
    // because streams buffer writes until the fd is open, but we handle potential
    // write failures gracefully via the close/error event handlers and the stdin error catcher.
    proc.stdin.write(Buffer.from(base64Data, 'base64'));
    proc.stdin.end();
  });
}

export function downsampleVideo(
  inputPath: string,
  outputPath: string,
  width: number,
  height: number,
  fps: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn('ffmpeg', [
      '-i', inputPath,
      '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease,fps=${fps}`,
      '-vcodec', 'libx264',
      '-crf', '30',
      '-preset', 'ultrafast',
      '-y',
      outputPath,
    ]);

    proc.on('close', (code) => {
      resolve(code === 0);
    });

    proc.on('error', () => {
      resolve(false);
    });
  });
}

type TerminateChildProcessResult =
  | { ok: true; code: number | null }
  | { ok: false; error: string; code?: number | null };

export async function terminateChildProcess(
  proc: ChildProcessWithoutNullStreams,
  closed: Promise<number | null>,
  timeouts = {
    sigintMs: DESKTOP_CAPTURE_SIGINT_TIMEOUT_MS,
    sigtermMs: DESKTOP_CAPTURE_SIGTERM_TIMEOUT_MS,
    sigkillMs: DESKTOP_CAPTURE_SIGKILL_TIMEOUT_MS,
  },
): Promise<TerminateChildProcessResult> {
  if (proc.exitCode !== null || proc.signalCode !== null) {
    return { ok: true, code: await closed };
  }

  const sigint = await signalAndWait(proc, closed, 'SIGINT', timeouts.sigintMs);
  if (sigint.settled) {
    return { ok: true, code: sigint.code };
  }

  const sigterm = await signalAndWait(proc, closed, 'SIGTERM', timeouts.sigtermMs);
  if (sigterm.settled) {
    return { ok: true, code: sigterm.code };
  }

  const sigkill = await signalAndWait(proc, closed, 'SIGKILL', timeouts.sigkillMs);
  if (sigkill.settled) {
    return { ok: true, code: sigkill.code };
  }

  return { ok: false, error: `Child process did not exit after SIGINT, SIGTERM, or SIGKILL within ${timeouts.sigintMs + timeouts.sigtermMs + timeouts.sigkillMs}ms` };
}

async function signalAndWait(
  proc: ChildProcessWithoutNullStreams,
  closed: Promise<number | null>,
  signal: NodeJS.Signals,
  timeoutMs: number,
): Promise<{ settled: true; code: number | null } | { settled: false }> {
  try {
    proc.kill(signal);
  } catch {
    // The process may have exited between checks; the close promise decides.
  }

  const result = await Promise.race([
    closed.then(code => ({ settled: true as const, code })),
    sleep(timeoutMs).then(() => ({ settled: false as const })),
  ]);
  return result;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class DesktopCaptureBridge {
  private running = false;
  private current:
    | {
        rawFile: string;
        downsampledFile: string;
        process: ChildProcessWithoutNullStreams;
        closed: Promise<number | null>;
        startedAt: Date;
      }
    | undefined;

  constructor(
    private readonly config: DesktopCaptureConfig,
    private readonly streams: { push(stream: string, payload: JsonObject): boolean },
    private readonly log: { append(event: JsonObject): void },
  ) {}

  start(): void {
    if (this.running) {
      return;
    }
    if (process.platform !== 'darwin') {
      this.log.append({
        type: 'desktop_capture_error',
        at: new Date().toISOString(),
        error: {
          message: `Desktop capture requires macOS (darwin platform). Current platform is: ${process.platform}`,
        },
      });
      return;
    }
    this.running = true;
  }

  stop(): void {
    this.running = false;
    void this.discardCurrentSegment();
  }

  startSegment(): void {
    if (!this.running || this.current || process.platform !== 'darwin') {
      return;
    }
    const nowMs = Date.now();
    const rawFile = `/tmp/watch-desktop-raw-${nowMs}.mp4`;
    const downsampledFile = `/tmp/watch-desktop-downsampled-${nowMs}.mp4`;
    const proc = spawn('screencapture', ['-x', '-v', rawFile]);
    const closed = new Promise<number | null>((resolve) => {
      proc.on('close', code => resolve(code));
      proc.on('error', error => {
        if (this.running) {
          this.log.append({
            type: 'desktop_capture_error',
            at: new Date().toISOString(),
            error: { message: error instanceof Error ? error.message : String(error) },
          });
        }
        resolve(null);
      });
    });
    this.current = { rawFile, downsampledFile, process: proc, closed, startedAt: new Date() };
  }

  async finishSegmentAndPush(): Promise<void> {
    const segment = this.current;
    this.current = undefined;
    if (!segment) {
      return;
    }

    const streamName = this.config.name ?? 'desktop:capture';
    const width = this.config.width ?? 1024;
    const height = this.config.height ?? 768;
    const fps = this.config.fps ?? 5;

    try {
      const terminated = await terminateChildProcess(segment.process, segment.closed);
      if (!terminated.ok) {
        this.log.append({
          type: 'desktop_capture_error',
          at: new Date().toISOString(),
          error: { message: terminated.error },
        });
        return;
      }
      if (terminated.code !== 0) {
        this.log.append({
          type: 'desktop_capture_error',
          at: new Date().toISOString(),
          error: { message: `Desktop capture exited with code ${terminated.code ?? 'unknown'}` },
        });
        return;
      }

      const downsampled = await downsampleVideo(segment.rawFile, segment.downsampledFile, width, height, fps);
      if (!downsampled) {
        this.log.append({
          type: 'desktop_capture_error',
          at: new Date().toISOString(),
          error: { message: 'Desktop capture downsampling failed' },
        });
        return;
      }

      const fs = await import('node:fs/promises');
      const buffer = await fs.readFile(segment.downsampledFile);
      const base64 = buffer.toString('base64');
      this.streams.push(streamName, {
        type: 'chunk',
        mediaType: 'video/mp4',
        dataBase64: base64,
        timestamp: new Date().toISOString(),
        startedAt: segment.startedAt.toISOString(),
        endedAt: new Date().toISOString(),
        filename: 'desktop.mp4',
      });
    } catch (error) {
      this.log.append({
        type: 'desktop_capture_error',
        at: new Date().toISOString(),
        error: {
          message: error instanceof Error ? error.message : String(error),
        },
      });
    } finally {
      try { unlinkSync(segment.rawFile); } catch {}
      try { unlinkSync(segment.downsampledFile); } catch {}
    }
  }

  private async discardCurrentSegment(): Promise<void> {
    const segment = this.current;
    this.current = undefined;
    if (!segment) {
      return;
    }
    try {
      const terminated = await terminateChildProcess(segment.process, segment.closed);
      if (!terminated.ok) {
        this.log.append({
          type: 'desktop_capture_error',
          at: new Date().toISOString(),
          error: { message: `Desktop capture discard failed: ${terminated.error}` },
        });
      }
    } finally {
      try { unlinkSync(segment.rawFile); } catch {}
      try { unlinkSync(segment.downsampledFile); } catch {}
    }
  }
}
