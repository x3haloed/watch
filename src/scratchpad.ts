import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { ScratchpadConfig } from './types.js';

const DEFAULT_SCRATCHPAD_DIR = 'scratchpad';
const DEFAULT_AGENT_FILE = 'AGENT.md';
const DEFAULT_USER_FILE = 'USER.md';
const DEFAULT_AGENT_MAX_CHARS = 6000;
const DEFAULT_USER_MAX_CHARS = 6000;

export type ScratchpadPaths = {
  agentPath: string;
  userPath: string;
  agentMaxChars: number;
  userMaxChars: number;
};

export class Scratchpad {
  readonly paths: ScratchpadPaths;
  private currentAgentPromptContent: string;

  constructor(instanceRoot: string, config: ScratchpadConfig = {}) {
    this.paths = resolveScratchpadPaths(instanceRoot, config);
    ensureFile(this.paths.agentPath);
    ensureFile(this.paths.userPath);
    this.currentAgentPromptContent = this.readAgentForPrompt();
  }

  agentPrompt(): string {
    const content = this.currentAgentPromptContent;
    return `[scratchpad]\n${content || '(empty)'}\n[/scratchpad]`;
  }

  refreshPromptSnapshot(): void {
    this.currentAgentPromptContent = this.readAgentForPrompt();
  }

  read(): Record<string, unknown> {
    const agent = truncate(readText(this.paths.agentPath), this.paths.agentMaxChars);
    const user = truncate(readText(this.paths.userPath), this.paths.userMaxChars);
    return {
      ok: true,
      agent: fileSnapshot('AGENT.md', this.paths.agentPath, agent, this.paths.agentMaxChars),
      user: fileSnapshot('USER.md', this.paths.userPath, user, this.paths.userMaxChars),
      note: 'USER.md is user-owned. Use scratchpad_update_agent to update AGENT.md only.',
    };
  }

  updateAgent(content: string): Record<string, unknown> {
    const next = content.trim();
    if (next.length > this.paths.agentMaxChars) {
      return {
        ok: false,
        error: `AGENT.md content is ${next.length}/${this.paths.agentMaxChars} chars. Shorten it before saving.`,
        maxChars: this.paths.agentMaxChars,
        chars: next.length,
      };
    }

    writeFileSync(this.paths.agentPath, next ? `${next}\n` : '', 'utf8');
    const saved = readText(this.paths.agentPath);
    return {
      ok: true,
      message: 'AGENT.md saved. Final saved content is included below to confirm the write stuck.',
      agent: fileSnapshot('AGENT.md', this.paths.agentPath, saved, this.paths.agentMaxChars),
      content: saved,
    };
  }

  private readAgentForPrompt(): string {
    return truncate(readText(this.paths.agentPath), this.paths.agentMaxChars);
  }
}

export function resolveScratchpadPaths(instanceRoot: string, config: ScratchpadConfig = {}): ScratchpadPaths {
  const dir = resolveFrom(instanceRoot, config.dir ?? DEFAULT_SCRATCHPAD_DIR);
  const agentPath = resolveFrom(dir, config.agentFile ?? DEFAULT_AGENT_FILE);
  const userPath = resolveFrom(dir, config.userFile ?? DEFAULT_USER_FILE);
  return {
    agentPath,
    userPath,
    agentMaxChars: validMaxChars(config.agentMaxChars, DEFAULT_AGENT_MAX_CHARS),
    userMaxChars: validMaxChars(config.userMaxChars, DEFAULT_USER_MAX_CHARS),
  };
}

function fileSnapshot(name: string, path: string, content: string, maxChars: number): Record<string, unknown> {
  return {
    name,
    path,
    chars: content.length,
    maxChars,
    remainingChars: Math.max(0, maxChars - content.length),
    content,
  };
}

function ensureFile(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) {
    writeFileSync(path, '', 'utf8');
  }
}

function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return '';
  }
}

function resolveFrom(root: string, path: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(root, path);
}

function validMaxChars(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function truncate(content: string, maxChars: number): string {
  if (content.length <= maxChars) {
    return content;
  }
  return `${content.slice(0, maxChars)}\n[...truncated scratchpad at ${maxChars}/${content.length} chars]`;
}
