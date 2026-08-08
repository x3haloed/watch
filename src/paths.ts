import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export function resolveInstanceRoot(cloneRoot: string, override?: string): string {
  const configured = override?.trim();
  if (configured) {
    return resolve(configured);
  }
  return dirname(cloneRoot);
}

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

export function capturesDir(instanceRoot: string): string {
  return join(instanceDir(instanceRoot), 'captures');
}

export function socketPath(instanceRoot: string): string {
  return join(stateDir(instanceRoot), 'watch.sock');
}

export function daemonLockPath(instanceRoot: string): string {
  return join(stateDir(instanceRoot), 'daemon.lock');
}

export function daemonLifecyclePath(instanceRoot: string): string {
  return join(stateDir(instanceRoot), 'daemon-lifecycle.json');
}

export function eventLogPath(instanceRoot: string): string {
  return join(logsDir(instanceRoot), 'events.jsonl');
}

export function modelRequestLogDir(instanceRoot: string): string {
  return join(logsDir(instanceRoot), 'model-requests');
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

export function seedCrystalsPath(instanceRoot: string): string {
  return join(instanceDir(instanceRoot), 'memory', 'seed-crystals.jsonl');
}

export function refinementsPath(instanceRoot: string): string {
  return join(instanceDir(instanceRoot), 'memory', 'refinements.jsonl');
}

export function seedCrystalsIndexPath(instanceRoot: string): string {
  return join(instanceDir(instanceRoot), 'memory', 'seed-crystals-index.json');
}

export function seedCrystalControlPath(instanceRoot: string): string {
  return join(stateDir(instanceRoot), 'seed-crystal-control.json');
}
