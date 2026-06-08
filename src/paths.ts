import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export function instanceDir(instanceRoot: string): string {
  return instanceRoot;
}

export function ensureInstanceDir(instanceRoot: string): string {
  const dir = instanceDir(instanceRoot);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function stateDir(instanceRoot: string): string {
  return join(instanceDir(instanceRoot), 'state');
}

export function logsDir(instanceRoot: string): string {
  return join(instanceDir(instanceRoot), 'logs');
}

export function scratchpadDir(instanceRoot: string): string {
  return join(instanceDir(instanceRoot), 'scratchpad');
}

export function socketPath(instanceRoot: string): string {
  return join(stateDir(instanceRoot), 'watch.sock');
}

export function daemonLockPath(instanceRoot: string): string {
  return join(stateDir(instanceRoot), 'daemon.lock');
}

export function eventLogPath(instanceRoot: string): string {
  return join(logsDir(instanceRoot), 'events.jsonl');
}

export function statePath(instanceRoot: string): string {
  return join(stateDir(instanceRoot), 'state.json');
}

export function modelsDevCachePath(instanceRoot: string): string {
  return join(stateDir(instanceRoot), 'models-dev-cache.json');
}

export function configPath(instanceRoot: string): string {
  return join(instanceDir(instanceRoot), 'config.json');
}
