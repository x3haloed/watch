import { appendFileSync, mkdirSync } from 'node:fs';
import { eventLogPath, ensureInstanceDir, logsDir } from './paths.js';
import type { WatchEvent } from './types.js';

export class EventLog {
  constructor(private readonly instanceRoot: string) {
    ensureInstanceDir(instanceRoot);
    mkdirSync(logsDir(instanceRoot), { recursive: true });
  }

  append(event: WatchEvent): void {
    appendFileSync(eventLogPath(this.instanceRoot), `${JSON.stringify(event)}\n`, 'utf8');
  }
}
