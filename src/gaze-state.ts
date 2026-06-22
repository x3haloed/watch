import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { ensureInstanceDir, stateDir, statePath } from './paths.js';
import type { DiscordPolicySnapshot, MoltbookStateSnapshot, StreamRegistrySnapshot } from './types.js';

export type GazeState = {
  version: 1;
  updatedAt: string;
  activeModel?: string;
  streams?: StreamRegistrySnapshot;
  discord?: DiscordPolicySnapshot;
  moltbook?: MoltbookStateSnapshot;
  [key: string]: unknown;
};

export class GazeStore {
  private state: GazeState;

  constructor(private readonly instanceRoot: string) {
    ensureInstanceDir(instanceRoot);
    mkdirSync(stateDir(instanceRoot), { recursive: true });
    this.state = this.read();
  }

  get streams(): StreamRegistrySnapshot | undefined {
    return this.state.streams;
  }

  get discord(): DiscordPolicySnapshot | undefined {
    return this.state.discord;
  }

  get moltbook(): MoltbookStateSnapshot | undefined {
    return this.state.moltbook;
  }

  updateStreams(streams: StreamRegistrySnapshot): void {
    this.write({ ...this.read(), streams });
  }

  updateDiscord(discord: DiscordPolicySnapshot): void {
    this.write({ ...this.read(), discord });
  }

  updateMoltbook(moltbook: MoltbookStateSnapshot): void {
    this.write({ ...this.read(), moltbook });
  }

  snapshot(): GazeState {
    return this.state;
  }

  private read(): GazeState {
    const path = statePath(this.instanceRoot);
    if (!existsSync(path)) {
      return emptyState();
    }

    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<GazeState>;
      return {
        ...parsed,
        version: 1,
        updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
        activeModel: typeof parsed.activeModel === 'string' ? parsed.activeModel : undefined,
        streams: parsed.streams,
        discord: parsed.discord,
        moltbook: parsed.moltbook,
      };
    } catch {
      return emptyState();
    }
  }

  private write(next: Omit<GazeState, 'version' | 'updatedAt'> & Partial<Pick<GazeState, 'version' | 'updatedAt'>>): void {
    this.state = {
      ...next,
      version: 1,
      updatedAt: new Date().toISOString(),
      activeModel: typeof next.activeModel === 'string' ? next.activeModel : undefined,
      streams: next.streams as StreamRegistrySnapshot | undefined,
      discord: next.discord as DiscordPolicySnapshot | undefined,
      moltbook: next.moltbook as MoltbookStateSnapshot | undefined,
    };
    writeFileSync(statePath(this.instanceRoot), `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
  }
}

function emptyState(): GazeState {
  return { version: 1, updatedAt: new Date().toISOString() };
}
