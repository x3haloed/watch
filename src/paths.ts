import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export function watchDir(repoRoot: string): string {
  return join(repoRoot, '.watch');
}

export function ensureWatchDir(repoRoot: string): string {
  const dir = watchDir(repoRoot);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function socketPath(repoRoot: string): string {
  return join(watchDir(repoRoot), 'watch.sock');
}

export function eventLogPath(repoRoot: string): string {
  return join(watchDir(repoRoot), 'events.jsonl');
}
