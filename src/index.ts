#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { cwd, exit } from 'node:process';
import { eventLogPath } from './paths.js';
import { sendControl } from './client.js';
import { runDaemon } from './server.js';
import type { WatchConfig } from './types.js';

async function main(): Promise<void> {
  const [area, action, ...args] = process.argv.slice(2);
  const repoRoot = cwd();

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
    const lines = Number(action ?? '40');
    const log = readFileSync(eventLogPath(repoRoot), 'utf8').trim().split('\n');
    console.log(log.slice(-lines).join('\n'));
    return;
  }

  usage();
  exit(1);
}

function defaultConfig(repoRoot: string, args: string[]): WatchConfig {
  return {
    repoRoot,
    minCffMs: numberFlag(args, '--min-cff-ms') ?? 2_000,
    maxCffMs: numberFlag(args, '--max-cff-ms') ?? 30_000,
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
  watch daemon start [--no-model] [--min-cff-ms 2000] [--max-cff-ms 30000] [--model id] [--models id,id]
  watch send "message"
  watch status
  watch sound
  watch logs [lines]
  watch stop`);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  exit(1);
});
