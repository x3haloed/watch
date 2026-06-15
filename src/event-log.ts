import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { eventLogPath, ensureInstanceDir, logsDir } from './paths.js';
import type { WatchEvent } from './types.js';

export type EventLogSubscriber = (event: WatchEvent) => void;

export class EventLog {
  private readonly subscribers = new Set<EventLogSubscriber>();

  constructor(private readonly instanceRoot: string) {
    ensureInstanceDir(instanceRoot);
    mkdirSync(logsDir(instanceRoot), { recursive: true });
  }

  append(event: WatchEvent): void {
    appendFileSync(eventLogPath(this.instanceRoot), `${JSON.stringify(event)}\n`, 'utf8');
    for (const subscriber of this.subscribers) {
      subscriber(event);
    }
  }

  subscribe(subscriber: EventLogSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  tail(limit = 300): WatchEvent[] {
    const path = eventLogPath(this.instanceRoot);
    if (!existsSync(path)) {
      return [];
    }
    return readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .slice(-Math.max(1, limit))
      .flatMap(line => {
        try {
          return [JSON.parse(line) as WatchEvent];
        } catch {
          return [];
        }
      });
  }
}
