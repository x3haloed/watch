import type { ToolSet } from 'ai';
import type { ResolvedModel, Sounding } from './types.js';
import type { LookoutToolContext } from './tools/context.js';
import { createDiscordTools } from './tools/discord.js';
import { createFileTools } from './tools/files.js';
import { createMessageTools } from './tools/messages.js';
import { createMemoryTools } from './tools/memory.js';
import { createMoltbookTools } from './tools/moltbook.js';
import { createScratchpadTools } from './tools/scratchpad.js';
import { createSessionTools } from './tools/session.js';
import { createSkillTools } from './tools/skills.js';
import { createStreamTools } from './tools/streams.js';
import { createTerminalTools } from './tools/terminal.js';
import { createGameTools } from './tools/game.js';

export function createLookoutTools(ctx: LookoutToolContext, sounding: Sounding, model: ResolvedModel): ToolSet {
  return {
    ...createFileTools(ctx),
    ...createSessionTools(ctx, sounding),
    ...createSkillTools(ctx),
    ...createTerminalTools(ctx, sounding),
    ...createMessageTools(ctx, sounding),
    ...createMemoryTools(ctx),
    ...createMoltbookTools(ctx),
    ...createDiscordTools(ctx),
    ...createStreamTools(ctx),
    ...createScratchpadTools(ctx),
    ...createGameTools(ctx),
  };
}
