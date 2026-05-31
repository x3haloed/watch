import type { JsonObject, ModelCapabilities, StreamDelta } from './types.js';

export type StoredMessage = {
  id: number;
  medium: string;
  source: string;
  subject: string;
  content: string;
  receivedAt: string;
};

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
  private pendingIds: number[] = [];

  constructor(private readonly messages: MessageStore) {}

  push(payload: JsonObject): void {
    const message = this.messages.add({
      medium: String(payload.medium ?? payload.source ?? 'cli'),
      source: String(payload.source ?? payload.medium ?? 'cli'),
      subject: typeof payload.subject === 'string' ? payload.subject : undefined,
      content: String(payload.message ?? payload.content ?? ''),
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
            {
              id: message.id,
              medium: message.medium,
              source: message.source,
              subject: message.subject,
              receivedAt: message.receivedAt,
              hint: `Call open_message with id ${message.id} to read the full message. To reply after reading, call send_message with medium "${message.medium}" and replyToId ${message.id}.`,
            },
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
  private readonly messages = new MessageStore();
  private readonly streams = new Map<string, WatchStream>([
    ['clock', new ClockStream()],
    ['inbox', new InboxStream(this.messages)],
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

  getMessage(id: number): StoredMessage | undefined {
    return this.messages.get(id);
  }

  listMessages(medium: string, page = 1, pageSize = 10): { entries: MessageEntry[]; page: number; pageSize: number; total: number; totalPages: number } {
    return this.messages.list(medium, page, pageSize);
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

  add(input: { medium: string; source: string; subject?: string; content: string }): StoredMessage {
    const id = this.nextId++;
    const content = input.content;
    const message: StoredMessage = {
      id,
      medium: input.medium,
      source: input.source,
      subject: input.subject?.trim() || preview(content),
      content,
      receivedAt: new Date().toISOString(),
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

function preview(content: string): string {
  const text = content.replace(/\s+/g, ' ').trim();
  if (!text) return '(empty message)';
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
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
