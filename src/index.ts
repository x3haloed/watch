#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { cwd, exit } from 'node:process';
import { eventLogPath } from './paths.js';
import { sendControl } from './client.js';
import { runDaemon } from './server.js';
import type { WatchConfig } from './types.js';

async function main(): Promise<void> {
  const [area, action, ...args] = process.argv.slice(2);
  const repoRoot = cwd();

  if (!area) {
    if (await canReachDaemon(repoRoot)) {
      await attach(repoRoot);
    } else {
      await waitForDaemonAndAttach(repoRoot);
    }
    return;
  }

  if (area === 'daemon' && action === 'start') {
    await runDaemon(defaultConfig(repoRoot, args));
    return;
  }

  if (area === 'send') {
    const message = [action, ...args].filter(Boolean).join(' ');
    const response = await sendControl(repoRoot, { command: 'send', message, source: 'cli' });
    print(response);
    return;
  }

  if (area === 'status') {
    print(await sendControl(repoRoot, { command: 'status' }));
    return;
  }

  if (area === 'sound') {
    print(await sendControl(repoRoot, { command: 'sound' }));
    return;
  }

  if (area === 'stop') {
    print(await sendControl(repoRoot, { command: 'stop' }));
    return;
  }

  if (area === 'logs') {
    const pretty = action === '--pretty' || args.includes('--pretty');
    const lineArg = pretty ? args.find(arg => /^\d+$/.test(arg)) : action;
    const lines = Number(lineArg ?? '40');
    const log = readFileSync(eventLogPath(repoRoot), 'utf8').trim().split('\n');
    if (pretty) {
      console.log(log.slice(-lines).map(formatLogLine).join('\n'));
    } else {
      console.log(log.slice(-lines).join('\n'));
    }
    return;
  }

  if (area === 'attach') {
    await attach(repoRoot);
    return;
  }

  usage();
  exit(1);
}

async function canReachDaemon(repoRoot: string): Promise<boolean> {
  try {
    const response = await sendControl(repoRoot, { command: 'status' });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForDaemonAndAttach(repoRoot: string): Promise<void> {
  process.stdout.write('\x1b[?25l');
  let attempts = 0;
  try {
    while (true) {
      attempts += 1;
      process.stdout.write('\x1b[H\x1b[2J');
      process.stdout.write(`watch mirror

No Watch daemon found yet.
Waiting to auto-attach... (${attempts})

Start one in another terminal:
  npm run dev -- daemon start --min-cff-ms 10000 --max-cff-ms 10000

Press Ctrl-C to stop waiting.
`);
      await sleep(1000);
      if (await canReachDaemon(repoRoot)) {
        await attach(repoRoot);
        return;
      }
    }
  } finally {
    process.stdout.write('\x1b[?25h');
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function defaultConfig(repoRoot: string, args: string[]): WatchConfig {
  return {
    repoRoot,
    minCffMs: numberFlag(args, '--min-cff-ms') ?? 2_000,
    maxCffMs: numberFlag(args, '--max-cff-ms') ?? 30_000,
    modelTimeoutMs: numberFlag(args, '--model-timeout-ms') ?? 120_000,
    defaultModel: stringFlag(args, '--model') ?? 'openrouter:anthropic/claude-sonnet-4.5',
    availableModels: (stringFlag(args, '--models') ?? '')
      .split(',')
      .map(model => model.trim())
      .filter(Boolean),
    noModel: args.includes('--no-model'),
  };
}

function stringFlag(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
}

function numberFlag(args: string[], flag: string): number | undefined {
  const value = stringFlag(args, flag);
  return value ? Number(value) : undefined;
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function usage(): void {
  console.log(`watch

Commands:
  watch daemon start [--no-model] [--min-cff-ms 2000] [--max-cff-ms 30000] [--model-timeout-ms 120000] [--model id] [--models id,id]
  watch send "message"
  watch status
  watch sound
  watch attach
  watch logs [lines]
  watch logs --pretty [lines]
  watch stop`);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  exit(1);
});

function formatLogLine(line: string): string {
  try {
    const event = JSON.parse(line) as Record<string, any>;
    const at = String(event.at ?? '').replace('T', ' ').replace('Z', '');
    switch (event.type) {
      case 'daemon_started':
        return `${at} daemon started pid=${event.pid}`;
      case 'daemon_stopped':
        return `${at} daemon stopped reason=${event.reason}`;
      case 'stream_delta':
        return `${at} delta ${event.delta?.stream}: ${shortJson(event.delta?.payload)}`;
      case 'stream_buffered':
        return `${at} buffered ${event.stream}: ${shortJson(event.payload)}`;
      case 'sounding_started':
        return `${at} sounding ${event.sounding?.id} ${event.sounding?.trigger} model=${event.sounding?.modelId} deltas=${event.sounding?.deltas?.length ?? 0}`;
      case 'model_step_finished':
        return `${at} step ${event.soundingId} finish=${event.step?.finishReason} tools=${toolNames(event.step).join(',') || '-'} text=${shortText(textFromContent(event.step?.content))}`;
      case 'model_finished':
        return `${at} model finished ${event.soundingId} text=${shortText(event.result?.text)}`;
      case 'sounding_finished':
        return `${at} sounding finished ${event.soundingId} text=${shortText(event.text)}`;
      case 'model_error':
        return `${at} model error ${event.soundingId} ${event.error?.name ?? 'Error'}: ${event.error?.message ?? ''}`;
      case 'model_aborted':
        return `${at} model aborted ${event.soundingId} reason=${event.reason}`;
      case 'model_unavailable':
        return `${at} model unavailable ${event.soundingId} ${event.modelId}: ${event.reason}`;
      case 'sounding_failed':
        return `${at} sounding failed ${event.soundingId} ${event.error?.name ?? 'Error'}: ${event.error?.message ?? ''}`;
      case 'model_reroute':
        return `${at} reroute ${event.soundingId} ${event.fromModelId} -> ${event.toModelId}`;
      case 'subscription_changed':
        return `${at} ${event.subscribed ? 'subscribed' : 'unsubscribed'} ${event.stream}`;
      case 'control_message':
        return `${at} control ${event.command}`;
      case 'model_skipped':
        return `${at} model skipped ${event.soundingId} reason=${event.reason}`;
      default:
        return `${at} ${event.type ?? 'event'} ${shortJson(event)}`;
    }
  } catch {
    return line;
  }
}

function textFromContent(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter(part => part && typeof part === 'object' && (part as { type?: string }).type === 'text')
    .map(part => String((part as { text?: unknown }).text ?? ''))
    .join('');
}

function toolNames(step: any): string[] {
  const content = Array.isArray(step?.content) ? step.content : [];
  return content
    .filter((part: any) => part?.type === 'tool-call' || part?.type === 'tool-result')
    .map((part: any) => part.toolName)
    .filter(Boolean);
}

function shortText(value: unknown): string {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > 180 ? `${text.slice(0, 177)}...` : text;
}

function shortJson(value: unknown): string {
  return shortText(JSON.stringify(value));
}

async function attach(repoRoot: string): Promise<void> {
  const input = createInterface({ input: process.stdin, output: process.stdout });
  const state: MirrorState = {
    events: [],
    tools: [],
    lastRendered: '',
  };

  input.on('line', line => {
    void handleAttachLine(repoRoot, line);
  });

  input.on('SIGINT', () => {
    cleanup();
    exit(0);
  });

  const interval = setInterval(() => {
    refreshMirror(repoRoot, state);
  }, 250);
  refreshMirror(repoRoot, state);

  await new Promise<void>(resolve => {
    input.on('close', resolve);
  });
  clearInterval(interval);
  cleanup();
}

async function handleAttachLine(repoRoot: string, rawLine: string): Promise<void> {
  const line = rawLine.trim();
  if (!line) return;

  try {
    if (line === '/q' || line === '/quit' || line === '/exit') {
      process.exit(0);
    }
    if (line === '/status') {
      await sendControl(repoRoot, { command: 'status' });
      return;
    }
    if (line === '/sound') {
      await sendControl(repoRoot, { command: 'sound' });
      return;
    }
    if (line === '/stop') {
      await sendControl(repoRoot, { command: 'stop' });
      return;
    }
    await sendControl(repoRoot, { command: 'send', message: rawLine, source: 'cli' });
  } catch {
    // The mirror will make daemon availability obvious from the log/status area.
  }
}

function refreshMirror(repoRoot: string, state: MirrorState): void {
  const events = readEvents(repoRoot).slice(-200);
  state.events = events;
  const screen = renderMirror(events);
  if (screen === state.lastRendered) return;
  state.lastRendered = screen;
  process.stdout.write('\x1b[?25l\x1b[H\x1b[2J');
  process.stdout.write(screen);
}

function renderMirror(events: Array<Record<string, any>>): string {
  const latestSounding = [...events].reverse().find(event => event.type === 'sounding_started')?.sounding;
  const latestFinished = [...events].reverse().find(event => event.type === 'sounding_finished');
  const latestFailure = [...events].reverse().find(event => event.type === 'sounding_failed');
  const active = inferActive(events);
  const toolRows = extractToolRows(events).slice(-8);
  const recent = events.slice(-8).map(formatEventForMirror);

  return [
    'watch mirror',
    'Commands: type to send, /status, /sound, /stop, /quit',
    '',
    'Current Sounding',
    latestSounding
      ? [
          `  id: ${latestSounding.id}`,
          `  at: ${latestSounding.at}`,
          `  trigger: ${latestSounding.trigger}`,
          `  model: ${latestSounding.modelId}`,
          `  deltas: ${(latestSounding.deltas ?? []).length}`,
          ...(latestSounding.deltas ?? []).slice(-4).map((delta: any) => `    - ${delta.stream}: ${shortJson(delta.payload)}`),
        ].join('\n')
      : '  (none yet)',
    '',
    'Inference Status',
    `  ${active}`,
    latestFinished ? `  last output: ${shortText(latestFinished.text)}` : '',
    latestFailure ? `  last failure: ${latestFailure.error?.name ?? 'Error'}: ${latestFailure.error?.message ?? ''}` : '',
    '',
    'Tool In/Out',
    toolRows.length ? toolRows.map(row => `  ${row}`).join('\n') : '  (no tool calls yet)',
    '',
    'Recent Events',
    recent.map(line => `  ${line}`).join('\n'),
    '',
    '> ',
  ]
    .filter(line => line !== '')
    .join('\n');
}

function readEvents(repoRoot: string): Array<Record<string, any>> {
  const path = eventLogPath(repoRoot);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => {
      try {
        return JSON.parse(line) as Record<string, any>;
      } catch {
        return { type: 'parse_error', line };
      }
    });
}

function inferActive(events: Array<Record<string, any>>): string {
  const latest = [...events]
    .reverse()
    .find(event =>
      ['sounding_started', 'sounding_finished', 'sounding_failed', 'model_step_finished', 'model_unavailable', 'model_aborted'].includes(
        event.type,
      ),
    );
  if (!latest) return 'idle';
  if (latest.type === 'sounding_started' || latest.type === 'model_step_finished') {
    return `running sounding=${latest.soundingId ?? latest.sounding?.id}`;
  }
  if (latest.type === 'model_unavailable') return `unavailable ${latest.modelId}: ${latest.reason}`;
  if (latest.type === 'model_aborted') return `aborted sounding=${latest.soundingId}`;
  return `idle after ${latest.soundingId}`;
}

function extractToolRows(events: Array<Record<string, any>>): string[] {
  const rows: string[] = [];
  for (const event of events) {
    if (event.type !== 'model_step_finished') continue;
    const content = Array.isArray(event.step?.content) ? event.step.content : [];
    for (const part of content) {
      if (part?.type === 'tool-call') {
        rows.push(`${event.soundingId} -> ${part.toolName} ${shortJson(part.input ?? part.args ?? part)}`);
      }
      if (part?.type === 'tool-result') {
        rows.push(`${event.soundingId} <- ${part.toolName} ${shortJson(part.output ?? part.result ?? part)}`);
      }
    }
  }
  return rows;
}

function formatEventForMirror(event: Record<string, any>): string {
  switch (event.type) {
    case 'sounding_started':
      return `sounding ${event.sounding?.id} ${event.sounding?.trigger} deltas=${event.sounding?.deltas?.length ?? 0}`;
    case 'sounding_finished':
      return `finished ${event.soundingId} ${shortText(event.text)}`;
    case 'sounding_failed':
      return `failed ${event.soundingId} ${event.error?.name ?? 'Error'}: ${event.error?.message ?? ''}`;
    case 'model_step_finished':
      return `step ${event.soundingId} tools=${toolNames(event.step).join(',') || '-'} finish=${event.step?.finishReason ?? '-'}`;
    case 'stream_delta':
      return `delta ${event.delta?.stream}: ${shortJson(event.delta?.payload)}`;
    case 'stream_buffered':
      return `buffered ${event.stream}`;
    case 'control_message':
      return `control ${event.command}`;
    default:
      return `${event.type ?? 'event'} ${shortJson(event)}`;
  }
}

function cleanup(): void {
  process.stdout.write('\x1b[?25h');
}

type MirrorState = {
  events: Array<Record<string, any>>;
  tools: string[];
  lastRendered: string;
};
