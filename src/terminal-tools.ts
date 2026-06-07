import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { resolve, sep } from 'node:path';
import { EventLog } from './event-log.js';

type TerminalSession = {
  id: string;
  command: string;
  cwd: string;
  process: ChildProcessWithoutNullStreams;
  startedAt: number;
  output: string;
  exited: boolean;
  exitCode: number | null;
};

type TerminalRunInput = {
  command: string;
  workdir?: string;
  timeoutMs?: number;
  background?: boolean;
  pty?: boolean;
  yieldTimeMs?: number;
  maxOutputChars?: number;
};

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_YIELD_MS = 1_000;
const DEFAULT_MAX_OUTPUT_CHARS = 20_000;
const MAX_SESSION_OUTPUT_CHARS = 200_000;
const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;

export class TerminalTools {
  private readonly sessions = new Map<string, TerminalSession>();

  constructor(
    private readonly cwd: string,
    private readonly log: EventLog,
  ) {}

  async run(soundingId: string, input: TerminalRunInput): Promise<Record<string, unknown>> {
    const command = input.command.trim();
    if (!command) {
      return { ok: false, error: 'command is required' };
    }

    const blocked = obviouslyDangerous(command);
    if (blocked) {
      return { ok: false, status: 'blocked', error: blocked };
    }

    const cwd = this.resolveWorkdir(input.workdir);
    if ('error' in cwd) {
      return { ok: false, error: cwd.error };
    }

    const session = this.spawnSession(soundingId, command, cwd.path, input.background === true, input.pty === true);
    if (input.background) {
      return {
        ok: true,
        status: 'running',
        sessionId: session.id,
        pid: session.process.pid,
        hint: 'Use terminal_input with this sessionId to poll, write stdin, or kill the process.',
      };
    }

    const timeoutMs = positiveInt(input.timeoutMs) ?? DEFAULT_TIMEOUT_MS;
    const yieldMs = positiveInt(input.yieldTimeMs) ?? DEFAULT_YIELD_MS;
    const maxOutputChars = positiveInt(input.maxOutputChars) ?? DEFAULT_MAX_OUTPUT_CHARS;
    const result = await this.waitForSession(soundingId, session, timeoutMs, yieldMs);
    this.sessions.delete(session.id);
    return {
      ok: result.exitCode === 0,
      status: result.timedOut ? 'timeout' : 'exited',
      sessionId: session.id,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      output: truncate(cleanTerminalText(result.output), maxOutputChars),
      error: result.error,
    };
  }

  async input(
    soundingId: string,
    input: { sessionId: string; input?: string; action?: 'poll' | 'write' | 'kill'; yieldTimeMs?: number; maxOutputChars?: number },
  ): Promise<Record<string, unknown>> {
    const session = this.sessions.get(input.sessionId);
    if (!session) {
      return { ok: false, error: `No terminal session found: ${input.sessionId}` };
    }

    const action = input.action ?? (input.input ? 'write' : 'poll');
    if (action === 'kill') {
      killProcess(session.process);
      this.sessions.delete(session.id);
      this.log.append({ type: 'terminal_killed', at: new Date().toISOString(), soundingId, sessionId: session.id });
      return { ok: true, status: 'killed', sessionId: session.id };
    }

    if (action === 'write') {
      const text = input.input ?? '';
      session.process.stdin.write(text);
      this.log.append({ type: 'terminal_input', at: new Date().toISOString(), soundingId, sessionId: session.id, text });
    }

    const yieldMs = positiveInt(input.yieldTimeMs) ?? DEFAULT_YIELD_MS;
    if (!session.exited && yieldMs > 0) {
      await sleep(yieldMs);
    }

    const maxOutputChars = positiveInt(input.maxOutputChars) ?? DEFAULT_MAX_OUTPUT_CHARS;
    return {
      ok: true,
      status: session.exited ? 'exited' : 'running',
      sessionId: session.id,
      exitCode: session.exitCode,
      output: truncate(cleanTerminalText(session.output), maxOutputChars),
      hint: session.exited ? undefined : 'Call terminal_input again to poll, write more input, or kill the process.',
    };
  }

  killAll(soundingId: string, reason: string): number {
    const liveSessions = [...this.sessions.values()].filter(session => !session.exited);
    for (const session of liveSessions) {
      killProcess(session.process);
      this.log.append({
        type: 'terminal_killed',
        at: new Date().toISOString(),
        soundingId,
        sessionId: session.id,
        reason,
      });
    }
    this.sessions.clear();
    return liveSessions.length;
  }

  private spawnSession(soundingId: string, command: string, cwd: string, background: boolean, pty: boolean): TerminalSession {
    const session: TerminalSession = {
      id: randomUUID(),
      command,
      cwd,
      process: spawn(resolveShell(), ['-lc', command], {
        cwd,
        env: sanitizedEnv(),
        stdio: 'pipe',
        detached: process.platform !== 'win32',
      }),
      startedAt: Date.now(),
      output: '',
      exited: false,
      exitCode: null,
    };

    this.sessions.set(session.id, session);
    this.log.append({
      type: 'terminal_started',
      at: new Date().toISOString(),
      soundingId,
      sessionId: session.id,
      command,
      cwd,
      background,
      pty,
    });

    session.process.stdout.on('data', chunk => this.appendOutput(soundingId, session, 'stdout', chunk));
    session.process.stderr.on('data', chunk => this.appendOutput(soundingId, session, 'stderr', chunk));
    session.process.on('exit', exitCode => {
      session.exited = true;
      session.exitCode = exitCode;
      this.sessions.delete(session.id);
      this.log.append({
        type: 'terminal_finished',
        at: new Date().toISOString(),
        soundingId,
        sessionId: session.id,
        exitCode,
        durationMs: Date.now() - session.startedAt,
        output: truncate(cleanTerminalText(session.output), DEFAULT_MAX_OUTPUT_CHARS),
      });
    });
    session.process.on('error', error => {
      session.exited = true;
      this.sessions.delete(session.id);
      this.log.append({
        type: 'terminal_finished',
        at: new Date().toISOString(),
        soundingId,
        sessionId: session.id,
        exitCode: session.exitCode,
        durationMs: Date.now() - session.startedAt,
        output: truncate(cleanTerminalText(session.output), DEFAULT_MAX_OUTPUT_CHARS),
        error: error.message,
      });
    });

    return session;
  }

  private appendOutput(soundingId: string, session: TerminalSession, stream: 'stdout' | 'stderr', chunk: Buffer): void {
    const text = chunk.toString('utf8');
    session.output = truncate(session.output + text, MAX_SESSION_OUTPUT_CHARS, false);
    this.log.append({
      type: 'terminal_output_delta',
      at: new Date().toISOString(),
      soundingId,
      sessionId: session.id,
      stream,
      text: truncate(cleanTerminalText(text), 4_000),
    });
  }

  private async waitForSession(
    soundingId: string,
    session: TerminalSession,
    timeoutMs: number,
    yieldMs: number,
  ): Promise<{ exitCode: number | null; durationMs: number; output: string; timedOut: boolean; error?: string }> {
    const deadline = Date.now() + timeoutMs;
    while (!session.exited && Date.now() < deadline) {
      await Promise.race([waitForExit(session), sleep(Math.min(yieldMs, Math.max(50, deadline - Date.now())))]);
    }

    if (!session.exited) {
      killProcess(session.process);
      this.log.append({ type: 'terminal_killed', at: new Date().toISOString(), soundingId, sessionId: session.id });
      return {
        exitCode: 124,
        durationMs: Date.now() - session.startedAt,
        output: session.output,
        timedOut: true,
        error: `Command timed out after ${timeoutMs}ms`,
      };
    }

    return {
      exitCode: session.exitCode,
      durationMs: Date.now() - session.startedAt,
      output: session.output,
      timedOut: false,
    };
  }

  private resolveWorkdir(workdir?: string): { path: string } | { error: string } {
    if (workdir?.split(/[\\/]/).includes('..')) {
      return { error: 'workdir cannot contain .. path segments' };
    }
    return { path: workdir ? resolve(this.cwd, workdir) : this.cwd };
  }
}

function resolveShell(): string {
  return process.env.SHELL || '/bin/bash';
}

function sanitizedEnv(): NodeJS.ProcessEnv {
  const blocked = new Set(['OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY']);
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !blocked.has(key)));
}

function obviouslyDangerous(command: string): string | undefined {
  const normalized = command.replace(/\s+/g, ' ').trim();
  if (/\brm\s+(-[^\s]*[rf][^\s]*|-r|-f)\s+(\/|~|\$HOME)(\s|$)/.test(normalized)) {
    return 'Blocked obviously dangerous recursive deletion.';
  }
  if (/\b(shutdown|reboot|halt)\b/.test(normalized)) {
    return 'Blocked host power command.';
  }
  return undefined;
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : undefined;
}

function killProcess(child: ChildProcessWithoutNullStreams): void {
  if (child.killed) return;
  try {
    if (process.platform !== 'win32' && child.pid) {
      process.kill(-child.pid, 'SIGTERM');
    } else {
      child.kill('SIGTERM');
    }
  } catch {
    child.kill('SIGKILL');
  }
}

function cleanTerminalText(text: string): string {
  return text.replace(ANSI_PATTERN, '').trim();
}

function truncate(text: string, maxChars: number, middle = true): string {
  if (text.length <= maxChars) return text;
  if (!middle) return text.slice(-maxChars);
  const head = Math.floor(maxChars * 0.4);
  const tail = maxChars - head;
  return `${text.slice(0, head)}\n\n... [truncated ${text.length - maxChars} chars] ...\n\n${text.slice(-tail)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function waitForExit(session: TerminalSession): Promise<void> {
  if (session.exited) {
    return Promise.resolve();
  }
  return new Promise(resolve => {
    session.process.once('exit', () => resolve());
    session.process.once('error', () => resolve());
  });
}
