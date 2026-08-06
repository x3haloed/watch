import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { daemonLifecyclePath, stateDir } from './paths.js';

export type DaemonLifecycleSnapshot = {
  version: 1;
  state: 'running' | 'stopped';
  pid: number;
  startedAt: string;
  lastHeartbeatAt: string;
  stoppedAt?: string;
  stopReason?: string;
};

export class DaemonLifecycleStore {
  private readonly path: string;
  private current: DaemonLifecycleSnapshot | undefined;

  constructor(private readonly instanceRoot: string) {
    mkdirSync(stateDir(instanceRoot), { recursive: true });
    this.path = daemonLifecyclePath(instanceRoot);
  }

  begin(pid: number, at = new Date().toISOString()): { current: DaemonLifecycleSnapshot; previous?: DaemonLifecycleSnapshot } {
    const previous = this.read();
    this.current = { version: 1, state: 'running', pid, startedAt: at, lastHeartbeatAt: at };
    this.write(this.current);
    return { current: this.current, previous: previous?.state === 'running' ? previous : undefined };
  }

  heartbeat(at = new Date().toISOString()): DaemonLifecycleSnapshot | undefined {
    if (!this.current || this.current.state !== 'running') return this.current;
    this.current = { ...this.current, lastHeartbeatAt: at };
    this.write(this.current);
    return this.current;
  }

  stop(reason: string, at = new Date().toISOString()): DaemonLifecycleSnapshot | undefined {
    if (!this.current) return undefined;
    this.current = { ...this.current, state: 'stopped', lastHeartbeatAt: at, stoppedAt: at, stopReason: reason };
    this.write(this.current);
    return this.current;
  }

  snapshot(): DaemonLifecycleSnapshot | undefined {
    return this.current ?? this.read();
  }

  read(): DaemonLifecycleSnapshot | undefined {
    if (!existsSync(this.path)) return undefined;
    try {
      const value = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<DaemonLifecycleSnapshot>;
      if (value.version !== 1 || (value.state !== 'running' && value.state !== 'stopped') || typeof value.pid !== 'number'
        || typeof value.startedAt !== 'string' || typeof value.lastHeartbeatAt !== 'string') return undefined;
      return value as DaemonLifecycleSnapshot;
    } catch {
      return undefined;
    }
  }

  private write(snapshot: DaemonLifecycleSnapshot): void {
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, this.path);
  }
}

export function redactDiagnosticText(value: string, maxChars = 2_000): string {
  return value
    .replace(/Bearer\s+[^\s]+/gi, 'Bearer [REDACTED]')
    .replace(/([?&](?:token|key|secret|password)=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/\b(?:sk|pk)_[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]')
    .slice(-maxChars);
}
