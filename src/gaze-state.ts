import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { ensureWatchDir, statePath } from './paths.js';
import type { DiscordPolicySnapshot, StreamRegistrySnapshot } from './types.js';

export type GazeState = {
  version: 1;
  updatedAt: string;
  streams?: StreamRegistrySnapshot;
  discord?: DiscordPolicySnapshot;
};

export class GazeStore {
  private state: GazeState;

  constructor(private readonly repoRoot: string) {
    ensureWatchDir(repoRoot);
    this.state = this.read();
  }

  get streams(): StreamRegistrySnapshot | undefined {
    return this.state.streams;
  }

  get discord(): DiscordPolicySnapshot | undefined {
    return this.state.discord;
  }

  updateStreams(streams: StreamRegistrySnapshot): void {
    this.write({ ...this.state, streams });
  }

  updateDiscord(discord: DiscordPolicySnapshot): void {
    this.write({ ...this.state, discord });
  }

  snapshot(): GazeState {
    return this.state;
  }

  private read(): GazeState {
    const path = statePath(this.repoRoot);
    if (!existsSync(path)) {
      return emptyState();
    }

    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<GazeState>;
      return {
        version: 1,
        updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
        streams: parsed.streams,
        discord: parsed.discord,
      };
    } catch {
      return emptyState();
    }
  }

  private write(next: Omit<GazeState, 'version' | 'updatedAt'> & Partial<Pick<GazeState, 'version' | 'updatedAt'>>): void {
    this.state = {
      version: 1,
      updatedAt: new Date().toISOString(),
      streams: next.streams,
      discord: next.discord,
    };
    writeFileSync(statePath(this.repoRoot), `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
  }
}

function emptyState(): GazeState {
  return { version: 1, updatedAt: new Date().toISOString() };
}
