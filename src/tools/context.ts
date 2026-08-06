import type { ModelMessage } from 'ai';
import type { DiscordBridge } from '../discord.js';
import type { MoltbookBridge } from '../moltbook.js';
import type { EventLog } from '../event-log.js';
import type { RepoFileTools } from '../file-tools.js';
import type { MediaService, OpenMediaInput } from '../media-service.js';
import type { MemoryLattice } from '../memory-lattice.js';
import type { MessageInbox } from '../message-inbox.js';
import type { ModelRegistry } from '../model-registry.js';
import type { Scratchpad } from '../scratchpad.js';
import type { SessionController } from '../session-controller.js';
import type { SkillLibrary } from '../skills.js';
import type { StreamRegistry } from '../streams.js';
import type { TerminalTools } from '../terminal-tools.js';
import type { ResolvedModel } from '../types.js';
import type { ContextFit } from '../lookout-helpers.js';
import type { SeedCrystalStore } from '../seed-crystals.js';
import type { RefinementStore } from '../refinements.js';

export type RerouteRequest = {
  modelId: string;
  model: ResolvedModel;
  params: Record<string, unknown>;
};

export interface LookoutToolContext {
  cwd: string;
  files: RepoFileTools;
  terminal: TerminalTools;
  streams: StreamRegistry;
  inbox: MessageInbox;
  models: ModelRegistry;
  media: MediaService;
  skills: SkillLibrary;
  session: SessionController;
  log: EventLog;
  discord?: DiscordBridge;
  moltbook?: MoltbookBridge;
  scratchpad?: Scratchpad;
  memory: MemoryLattice;
  refinements: RefinementStore;
  seedCrystals?: SeedCrystalStore;
  game?: { controlUrl: string; actionTimeoutMs?: number };
  messages: ModelMessage[];
  instructions: () => Promise<string>;
  contextFitFor: (model: ResolvedModel) => Promise<ContextFit>;
  currentModel: () => ResolvedModel;
  switchModelForCurrentSounding: (request: RerouteRequest) => Promise<Record<string, unknown>>;
  openMediaForModel: (input: OpenMediaInput, model: ResolvedModel) => Promise<Record<string, unknown>>;
}
