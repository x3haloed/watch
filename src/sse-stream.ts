import type { JsonObject, StreamDelta, SseStreamConfig } from './types.js';
import { type StreamPopContext, type WatchStream } from './stream-primitives.js';

export class SseStream implements WatchStream {
  readonly sampled = false;
  readonly waking: boolean;
  private buffer: JsonObject[] = [];
  private abortController: AbortController | null = null;
  private isConnected = false;

  constructor(
    readonly name: string,
    private readonly config: SseStreamConfig,
  ) {
    this.waking = config.waking !== false;
    this.connect();
  }

  push(payload: JsonObject): void {
    this.buffer.push({
      ...payload,
      receivedAt: new Date().toISOString(),
    });
  }

  hasDelta(): boolean {
    return this.buffer.length > 0;
  }

  popDelta({ now }: StreamPopContext): StreamDelta | undefined {
    if (this.buffer.length === 0) {
      return undefined;
    }

    const items = this.buffer;
    this.buffer = [];

    return {
      stream: this.name,
      at: now.toISOString(),
      payload: {
        count: items.length,
        items,
      },
    };
  }

  private connect(): void {
    if (this.abortController) {
      this.abortController.abort();
    }
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    const runStream = async () => {
      while (!signal.aborted) {
        try {
          const response = await fetch(this.config.url, {
            headers: {
              'Accept': 'text/event-stream',
              ...this.config.headers,
            },
            signal,
          });

          if (!response.ok) {
            throw new Error(`HTTP error ${response.status}: ${response.statusText}`);
          }

          this.isConnected = true;
          const reader = response.body?.getReader();
          if (!reader) {
            throw new Error('Response body is not readable');
          }

          const decoder = new TextDecoder();
          let partialLine = '';

          while (!signal.aborted) {
            const { value, done } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            const lines = (partialLine + chunk).split('\n');
            partialLine = lines.pop() ?? '';

            for (const line of lines) {
              const trimmed = line.trim();
              if (trimmed.startsWith('data:')) {
                const rawJson = trimmed.slice(5).trim();
                try {
                  const payload = JSON.parse(rawJson) as JsonObject;
                  this.push(payload);
                } catch {
                  // If not JSON, push as raw text
                  this.push({ raw: rawJson });
                }
              }
            }
          }
        } catch (error) {
          if (signal.aborted) {
            break;
          }
          this.isConnected = false;
          // Log error to console/buffer but keep reconnecting
          this.push({
            event: 'error',
            error: error instanceof Error ? error.message : String(error),
          });
          // Wait 5 seconds before reconnecting
          await new Promise(resolve => setTimeout(resolve, 5000));
        }
      }
    };

    void runStream();
  }

  close(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.isConnected = false;
  }
}
