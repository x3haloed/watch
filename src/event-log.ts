import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { rotateFileIfNeeded } from './log-retention.js';
import { eventLogPath, ensureInstanceDir, logsDir } from './paths.js';
import type { WatchEvent } from './types.js';

export type EventLogSubscriber = (event: WatchEvent) => void;

export class EventLog {
  private readonly subscribers = new Set<EventLogSubscriber>();
  private readonly path: string;
  private readonly archiveDir: string;
  private readonly maxBytes: number;
  private readonly maxArchives: number;

  constructor(private readonly instanceRoot: string, options: { maxBytes?: number; maxArchives?: number } = {}) {
    ensureInstanceDir(instanceRoot);
    mkdirSync(logsDir(instanceRoot), { recursive: true });
    this.path = eventLogPath(instanceRoot);
    this.archiveDir = join(logsDir(instanceRoot), 'archive');
    this.maxBytes = options.maxBytes ?? Number(process.env.WATCH_EVENT_LOG_MAX_BYTES ?? 25 * 1024 * 1024);
    this.maxArchives = options.maxArchives ?? Number(process.env.WATCH_EVENT_LOG_MAX_ARCHIVES ?? 10);
    mkdirSync(this.archiveDir, { recursive: true });
  }

  append(event: WatchEvent): void {
    rotateFileIfNeeded(this.path, {
      maxBytes: this.maxBytes,
      maxArchives: this.maxArchives,
      archiveDir: this.archiveDir,
      extension: '.jsonl',
    });
    appendFileSync(this.path, `${JSON.stringify(event)}\n`, 'utf8');
    for (const subscriber of this.subscribers) {
      subscriber(event);
    }
  }

  subscribe(subscriber: EventLogSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  tail(limit = 300): WatchEvent[] {
    if (!existsSync(this.path)) {
      return [];
    }
    return readFileSync(this.path, 'utf8')
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
