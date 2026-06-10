#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { cwd, exit } from 'node:process';
import * as dotenv from 'dotenv';
import { configPath, eventLogPath } from './paths.js';
import { sendControl } from './client.js';
import { runDaemon } from './server.js';
import { runOperatorConsole } from './tui.js';
import type { CameraStreamConfig, WatchConfig, WebApiStreamConfig, SseStreamConfig } from './types.js';

dotenv.config();

type WatchConfigFile = {
  defaultModel?: string;
  restingModel?: string;
  ledgerPath?: string;
  minCffMs?: number;
  maxCffMs?: number;
  webApiStreams?: WebApiStreamConfig[];
  sseStreams?: SseStreamConfig[];
  cameraStreams?: CameraStreamConfig[];
  scratchpad?: WatchConfig['scratchpad'];
  restAfterNoToolSoundings?: number;
  estimatedTokenWarningThreshold?: number;
  discord?: WatchConfig['discord'];
  desktopCapture?: WatchConfig['desktopCapture'];
};

async function main(): Promise<void> {
  const [area, action, ...args] = process.argv.slice(2);
  const cloneRoot = cwd();
  const instanceRoot = dirname(cloneRoot);
  const configFile = readWatchConfig(instanceRoot);

  if (!area) {
    if (!configFile.ok) {
      print(configFile.error);
      exit(1);
    }
    if (await canReachDaemon(instanceRoot)) {
      await attach(instanceRoot);
    } else {
      await waitForDaemonAndAttach(cloneRoot, instanceRoot);
    }
    return;
  }

  if (area === 'daemon' && action === 'start') {
    if (!configFile.ok) {
      print(configFile.error);
      exit(1);
    }
    await runDaemon(defaultConfig(instanceRoot, cloneRoot, configFile.file, args));
    return;
  }

  if (area === 'send') {
    const message = [action, ...args].filter(Boolean).join(' ');
    const response = await sendControl(instanceRoot, { command: 'send', message, source: 'cli' });
    print(response);
    return;
  }

  if (area === 'status') {
    print(await sendControl(instanceRoot, { command: 'status' }));
    return;
  }

  if (area === 'sound') {
    print(await sendControl(instanceRoot, { command: 'sound' }));
    return;
  }

  if (area === 'stop') {
    print(await sendControl(instanceRoot, { command: 'stop' }));
    return;
  }

  if (area === 'reboot') {
    const ledgerEntry = [action, ...args].filter(Boolean).join(' ').trim() || undefined;
    print(await sendControl(instanceRoot, { command: 'reboot', ledgerEntry }));
    return;
  }

  if (area === 'logs') {
    const pretty = action === '--pretty' || args.includes('--pretty');
    const lineArg = pretty ? args.find(arg => /^\d+$/.test(arg)) : action;
    const lines = Number(lineArg ?? '40');
    const log = readFileSync(eventLogPath(instanceRoot), 'utf8').trim().split('\n');
    if (pretty) {
      console.log(log.slice(-lines).map(formatLogLine).join('\n'));
    } else {
      console.log(log.slice(-lines).join('\n'));
    }
    return;
  }

  if (area === 'attach') {
    if (!configFile.ok) {
      print(configFile.error);
      exit(1);
    }
    await attach(instanceRoot);
    return;
  }

  usage();
  exit(1);
}

async function canReachDaemon(instanceRoot: string): Promise<boolean> {
  try {
    const response = await sendControl(instanceRoot, { command: 'status' });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForDaemonAndAttach(cloneRoot: string, instanceRoot: string): Promise<void> {
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
  cd ${cloneRoot}
  npx tsx src/index.ts daemon start --min-cff-ms 10000 --max-cff-ms 10000

Press Ctrl-C to stop waiting.
`);
      await sleep(1000);
      if (await canReachDaemon(instanceRoot)) {
        await attach(instanceRoot);
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

function defaultConfig(instanceRoot: string, cloneRoot: string, file: WatchConfigFile, args: string[]): WatchConfig {
  const defaultModel = stringFlag(args, '--model') ?? file.defaultModel;
  if (!defaultModel?.trim()) {
    throw new Error('No default model configured. Set defaultModel in config.json or pass --model.');
  }
  return {
    instanceRoot,
    cloneRoot,
    minCffMs: numberFlag(args, '--min-cff-ms') ?? file.minCffMs ?? 2_000,
    maxCffMs: numberFlag(args, '--max-cff-ms') ?? file.maxCffMs ?? 30_000,
    modelTimeoutMs: numberFlag(args, '--model-timeout-ms') ?? 120_000,
    defaultModel,
    ledgerPath: file.ledgerPath,
    webApiStreams: Array.isArray(file.webApiStreams) ? file.webApiStreams : [],
    sseStreams: Array.isArray(file.sseStreams) ? file.sseStreams : [],
    cameraStreams: Array.isArray(file.cameraStreams) ? file.cameraStreams : [],
    discord: file.discord,
    desktopCapture: file.desktopCapture ? {
      enabled: file.desktopCapture.enabled !== false,
      name: file.desktopCapture.name || 'desktop:capture',
      fps: file.desktopCapture.fps ?? 5,
      width: file.desktopCapture.width ?? 1024,
      height: file.desktopCapture.height ?? 768,
      waking: file.desktopCapture.waking ?? false,
      subscribed: file.desktopCapture.subscribed ?? true,
      maxBufferedChunks: file.desktopCapture.maxBufferedChunks ?? 3,
    } : undefined,
    scratchpad: file.scratchpad ?? {},
    restingModel: stringFlag(args, '--resting-model') ?? file.restingModel ?? file.defaultModel ?? defaultModel,
    restAfterNoToolSoundings: numberFlag(args, '--rest-after-no-tool-soundings') ?? file.restAfterNoToolSoundings ?? 3,
    estimatedTokenWarningThreshold: file.estimatedTokenWarningThreshold ?? 120_000,
    availableModels: (stringFlag(args, '--models') ?? '')
      .split(',')
      .map(model => model.trim())
      .filter(Boolean),
    noModel: args.includes('--no-model'),
  };
}

function readWatchConfig(instanceRoot: string): { ok: true; file: WatchConfigFile; filePath: string } | { ok: false; error: string } {
  const path = configPath(instanceRoot);
  if (!existsSync(path)) {
    return {
      ok: false,
      error: `Missing required install config: ${path}\n\nWatch now runs from inside the cloned repo at <instance>/watch/ and expects ../config.json to exist at the instance root.`,
    };
  }
  try {
    return { ok: true, file: JSON.parse(readFileSync(path, 'utf8')) as WatchConfigFile, filePath: path };
  } catch (error) {
    return {
      ok: false,
      error: `Failed to read config.json at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
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
  watch daemon start [--no-model] [--min-cff-ms 2000] [--max-cff-ms 30000] [--model-timeout-ms 120000] [--model id] [--resting-model id] [--rest-after-no-tool-soundings 3] [--models id,id]
  watch send "message"
  watch status
  watch sound
  watch attach
  watch logs [lines]
  watch logs --pretty [lines]
  watch stop
  watch reboot ["ledger entry"]`);
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
      case 'daemon_start_blocked':
        return `${at} daemon start blocked pid=${event.pid ?? '?'} reason=${event.reason}`;
      case 'daemon_stopped':
        return `${at} daemon stopped pid=${event.pid ?? '?'} reason=${event.reason}`;
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
      case 'model_failure_backoff':
        return `${at} model failure backoff ${event.modelId} failures=${event.failures} delay=${event.delayMs}ms until=${event.until} reason=${event.reason}`;
      case 'model_unavailable':
        return `${at} model unavailable ${event.soundingId} ${event.modelId}: ${event.reason}`;
      case 'sounding_failed':
        return `${at} sounding failed ${event.soundingId} ${event.error?.name ?? 'Error'}: ${event.error?.message ?? ''}`;
      case 'model_reroute':
        return `${at} reroute ${event.soundingId} ${event.fromModelId} -> ${event.toModelId}`;
      case 'model_reroute_failed':
        return `${at} reroute failed ${event.soundingId} ${event.fromModelId} -> ${event.toModelId}: ${event.error?.name ?? 'Error'} ${event.error?.message ?? ''}`;
      case 'model_auto_restored':
        return `${at} auto-restored model ${event.fromModelId} -> ${event.toModelId} after ${event.noToolSoundings} no-tool soundings`;
      case 'terminal_started':
        return `${at} terminal started ${event.sessionId} ${event.background ? 'bg' : 'fg'} cwd=${event.cwd} $ ${event.command}`;
      case 'terminal_output_delta':
        return `${at} terminal ${event.sessionId} ${event.stream}> ${shortText(event.text)}`;
      case 'terminal_finished':
        return `${at} terminal finished ${event.sessionId} exit=${event.exitCode} duration=${event.durationMs}ms output=${shortText(event.output)}`;
      case 'terminal_input':
        return `${at} terminal input ${event.sessionId} ${shortText(event.text)}`;
      case 'terminal_killed':
        return `${at} terminal killed ${event.sessionId}`;
      case 'subscription_changed':
        return `${at} ${event.subscribed ? 'subscribed' : 'unsubscribed'} ${event.stream}`;
      case 'sse_stream_connected':
        return `${at} sse stream connected ${event.stream} -> ${event.url}`;
      case 'sse_stream_disconnected':
        return `${at} sse stream disconnected ${event.stream} reason=${event.reason}`;
      case 'sse_stream_error':
        return `${at} sse stream error ${event.stream} error=${event.error}`;
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

async function attach(instanceRoot: string): Promise<void> {
  await runOperatorConsole(instanceRoot);
}
