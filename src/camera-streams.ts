import type { CameraStreamConfig, JsonObject } from './types.js';
import { EventLog } from './event-log.js';
import { StreamRegistry } from './streams.js';
import { downsampleImage } from './stream-primitives.js';

const DEFAULT_CAMERA_STREAM_FPS = 1;
const DEFAULT_CAMERA_STREAM_MODE = 'stills';
const DEFAULT_CAMERA_STREAM_URL = 'ws://127.0.0.1:8765/';
const DEFAULT_MAX_BUFFERED_CHUNKS = 3;
const RECONNECT_DELAY_MS = 3_000;

export class CameraStreamBridge {
  private running = false;
  private socket: WebSocket | undefined;
  private processingChain = Promise.resolve();

  constructor(
    private readonly config: CameraStreamConfig,
    private readonly streams: StreamRegistry,
    private readonly log: EventLog,
  ) {}

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.processingChain = Promise.resolve();
    void this.connectLoop();
  }

  stop(reason = 'stop requested'): void {
    this.running = false;
    this.socket?.close(1000, reason);
    this.socket = undefined;
  }

  private async connectLoop(): Promise<void> {
    while (this.running) {
      try {
        await this.connectOnce();
      } catch (error) {
        this.log.append({
          type: 'camera_stream_error',
          at: new Date().toISOString(),
          stream: this.config.name,
          error: errorToJson(error),
        });
      }

      if (this.running) {
        await sleep(RECONNECT_DELAY_MS);
      }
    }
  }

  private connectOnce(): Promise<void> {
    const url = this.config.url || DEFAULT_CAMERA_STREAM_URL;
    const handshake = cameraHandshake(this.config);

    return new Promise((resolve, reject) => {
      const WebSocketCtor = globalThis.WebSocket;
      if (!WebSocketCtor) {
        reject(new Error('Global WebSocket is not available in this Node runtime.'));
        return;
      }

      const socket = new WebSocketCtor(url);
      this.socket = socket;

      socket.addEventListener('open', () => {
        socket.send(JSON.stringify(handshake));
        this.log.append({
          type: 'camera_stream_connected',
          at: new Date().toISOString(),
          stream: this.config.name,
          url,
          handshake,
        });
      });

      socket.addEventListener('message', event => {
        const payload = parseMessage(event.data);
        if (!payload) {
          return;
        }

        if (payload.type === 'chunk') {
          this.processingChain = this.processingChain.then(async () => {
            let finalPayload = payload;
            if (
              this.config.width &&
              this.config.height &&
              typeof payload.dataBase64 === 'string' &&
              typeof payload.mediaType === 'string' &&
              payload.mediaType.startsWith('image/')
            ) {
              const downsampled = await downsampleImage(payload.dataBase64, this.config.width, this.config.height);
              if (downsampled) {
                finalPayload = {
                  ...payload,
                  dataBase64: downsampled,
                  mediaType: 'image/jpeg',
                  sizeBytes: Buffer.from(downsampled, 'base64').byteLength,
                };
              }
            }

            const accepted = this.streams.push(this.config.name, finalPayload);
            if (accepted) {
              this.log.append({
                type: 'camera_stream_buffered',
                at: new Date().toISOString(),
                stream: this.config.name,
                sequence: numberOrUndefined(finalPayload.sequence),
                mediaType: typeof finalPayload.mediaType === 'string' ? finalPayload.mediaType : undefined,
                sizeBytes: numberOrUndefined(finalPayload.sizeBytes),
              });
            }
          }).catch(err => {
            this.log.append({
              type: 'camera_stream_error',
              at: new Date().toISOString(),
              stream: this.config.name,
              error: errorToJson(err),
            });
          });
        } else if (payload.type === 'error') {
          this.log.append({
            type: 'camera_stream_error',
            at: new Date().toISOString(),
            stream: this.config.name,
            error: payload,
          });
        }
      });

      socket.addEventListener('close', event => {
        this.socket = undefined;
        this.log.append({
          type: 'camera_stream_disconnected',
          at: new Date().toISOString(),
          stream: this.config.name,
          reason: event.reason || `code ${event.code}`,
        });
        resolve();
      });

      socket.addEventListener('error', () => {
        reject(new Error(`Camera stream connection failed for ${this.config.name}`));
      });
    });
  }
}

export function registerCameraStreams(configs: CameraStreamConfig[], streams: StreamRegistry, log: EventLog): CameraStreamBridge[] {
  const bridges: CameraStreamBridge[] = [];
  for (const config of configs) {
    if (!config.name?.trim()) {
      continue;
    }
    streams.registerBufferedStream(config.name, {
      subscribed: config.subscribed,
      waking: config.waking ?? true,
      maxPayloads: config.maxBufferedChunks ?? DEFAULT_MAX_BUFFERED_CHUNKS,
    });
    bridges.push(new CameraStreamBridge(config, streams, log));
  }
  return bridges;
}

function cameraHandshake(config: CameraStreamConfig): JsonObject {
  const handshake: JsonObject = {
    mode: config.mode ?? DEFAULT_CAMERA_STREAM_MODE,
    fps: config.fps ?? DEFAULT_CAMERA_STREAM_FPS,
    motionGate: config.motionGate ?? true,
    format: config.format ?? 'base64',
  };
  if (config.duration !== undefined) {
    handshake.duration = config.duration;
  }
  return handshake;
}

function parseMessage(data: unknown): JsonObject | undefined {
  try {
    const text = typeof data === 'string' ? data : data instanceof Buffer ? data.toString('utf8') : String(data);
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as JsonObject : undefined;
  } catch {
    return undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function errorToJson(error: unknown): JsonObject {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return { message: String(error) };
}
