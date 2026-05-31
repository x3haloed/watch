import type { JsonObject, ModelCapabilities, StreamDelta } from './types.js';

export type StreamPopContext = {
  now: Date;
  capabilities: ModelCapabilities;
};

export interface WatchStream {
  readonly name: string;
  push(payload: JsonObject): void;
  hasDelta(now: Date): boolean;
  popDelta(context: StreamPopContext): StreamDelta | undefined;
}

class ClockStream implements WatchStream {
  readonly name = 'clock';
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
  private messages: JsonObject[] = [];

  push(payload: JsonObject): void {
    this.messages.push({ ...payload, receivedAt: new Date().toISOString() });
  }

  hasDelta(): boolean {
    return this.messages.length > 0;
  }

  popDelta({ now }: StreamPopContext): StreamDelta | undefined {
    if (this.messages.length === 0) {
      return undefined;
    }

    const messages = this.messages;
    this.messages = [];

    return {
      stream: this.name,
      at: now.toISOString(),
      payload: {
        count: messages.length,
        messages,
      },
    };
  }
}

class BufferedStream implements WatchStream {
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

export class StreamRegistry {
  private readonly streams = new Map<string, WatchStream>([
    ['clock', new ClockStream()],
    ['inbox', new InboxStream()],
  ]);
  private readonly subscriptions = new Set<string>(['clock', 'inbox']);

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

  isSubscribed(stream: string): boolean {
    return this.subscriptions.has(stream);
  }

  listSubscriptions(): string[] {
    return [...this.subscriptions].sort();
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

  popDeltas(context: StreamPopContext): StreamDelta[] {
    return [...this.streams.values()]
      .filter(stream => this.isSubscribed(stream.name))
      .flatMap(stream => {
        if (!stream.hasDelta(context.now)) {
          return [];
        }
        const delta = stream.popDelta(context);
        return delta ? [delta] : [];
      });
  }

  hasPending(now = new Date()): boolean {
    return [...this.streams.values()].some(stream => this.isSubscribed(stream.name) && stream.hasDelta(now));
  }
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
