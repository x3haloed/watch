import { appendFileSync } from 'node:fs';
import { eventLogPath, ensureWatchDir } from './paths.js';
import type { WatchEvent } from './types.js';

export class EventLog {
  constructor(private readonly repoRoot: string) {
    ensureWatchDir(repoRoot);
  }

  append(event: WatchEvent): void {
    appendFileSync(eventLogPath(this.repoRoot), `${JSON.stringify(event)}\n`, 'utf8');
  }
}
