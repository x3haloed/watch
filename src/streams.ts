import type { JsonObject, StreamDelta } from './types.js';

export class StreamRegistry {
  private readonly subscriptions = new Set<string>(['clock', 'inbox']);
  private pending: StreamDelta[] = [];

  subscribe(stream: string): boolean {
    const changed = !this.subscriptions.has(stream);
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

  push(stream: string, payload: JsonObject): StreamDelta | undefined {
    if (!this.isSubscribed(stream)) {
      return undefined;
    }

    const delta: StreamDelta = {
      stream,
      at: new Date().toISOString(),
      payload,
    };
    this.pending.push(delta);
    return delta;
  }

  drain(): StreamDelta[] {
    const drained = this.pending;
    this.pending = [];
    return drained;
  }

  hasPending(): boolean {
    return this.pending.length > 0;
  }
}
