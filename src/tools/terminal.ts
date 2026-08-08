import { jsonSchema, tool } from 'ai';
import type { Sounding } from '../types.js';
import type { LookoutToolContext } from './context.js';

export function createTerminalTools(ctx: LookoutToolContext, sounding: Sounding) {
  return {
    terminal: tool({
      description:
        'Run a shell command for builds, tests, package managers, git, scripts, processes, and network checks. read_file, search_files, write_file, and patch provide filesystem operations. background=true creates a continuing terminal session, suitable for servers or watchers. PTY is accepted for interactive tools but may fall back to normal pipes.',
      inputSchema: jsonSchema<{
        command: string;
        workdir?: string;
        timeoutMs?: number;
        background?: boolean;
        pty?: boolean;
        yieldTimeMs?: number;
        maxOutputChars?: number;
      }>({
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute.' },
          workdir: { type: 'string', description: 'Optional working directory. Relative paths resolve from cwd; absolute paths are accepted.' },
          timeoutMs: { type: 'number', description: 'Timeout in milliseconds. Defaults to 120000.' },
          background: { type: 'boolean', description: 'Creates a continuing session for a command that does not exit, such as a server or watcher. Returns a sessionId.' },
          pty: { type: 'boolean', description: 'Request PTY-like execution for interactive commands. Defaults to false.' },
          yieldTimeMs: { type: 'number', description: 'How long to wait for output before returning. Defaults to 1000.' },
          maxOutputChars: { type: 'number', description: 'Maximum output characters to return. Defaults to 20000.' },
        },
        required: ['command'],
        additionalProperties: false,
      }),
      execute: async input => ctx.terminal.run(sounding.id, input),
    }),
    terminal_input: tool({
      description:
        'Interact with a running terminal session from terminal(background=true): poll output, write stdin, or kill it.',
      inputSchema: jsonSchema<{
        sessionId: string;
        input?: string;
        action?: 'poll' | 'write' | 'kill';
        yieldTimeMs?: number;
        maxOutputChars?: number;
      }>({
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'Session ID returned by terminal(background=true).' },
          input: { type: 'string', description: 'Input bytes to write when action is write. Include newlines when needed.' },
          action: { type: 'string', enum: ['poll', 'write', 'kill'], description: 'Defaults to write when input is present, otherwise poll.' },
          yieldTimeMs: { type: 'number', description: 'How long to wait for more output before returning. Defaults to 1000.' },
          maxOutputChars: { type: 'number', description: 'Maximum output characters to return. Defaults to 20000.' },
        },
        required: ['sessionId'],
        additionalProperties: false,
      }),
      execute: async input => ctx.terminal.input(sounding.id, input),
    }),
  };
}
