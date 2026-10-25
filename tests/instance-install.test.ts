import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { EventLog } from '../src/event-log.js';
import { GazeStore } from '../src/gaze-state.js';
import { SessionController } from '../src/session-controller.js';
import { resolveScratchpadPaths } from '../src/scratchpad.js';
import { eventLogPath, resolveInstanceRoot, socketPath, statePath } from '../src/paths.js';
import { WatchRuntime } from '../src/runtime.js';
import { runDaemon } from '../src/server.js';
import type { WatchConfig } from '../src/types.js';

test('daemon start fails cleanly when the parent config.json is missing', () => {
  const instanceRoot = mkdtempSync(join(tmpdir(), 'watch-instance-'));
  const cloneRoot = join(instanceRoot, 'watch');
  mkdirSync(cloneRoot, { recursive: true });

  const tsxBin = resolve(process.cwd(), 'node_modules', '.bin', 'tsx');
  const result = spawnSync(tsxBin, [join(process.cwd(), 'src', 'index.ts'), 'daemon', 'start'], {
    cwd: cloneRoot,
    env: { ...process.env, OPENROUTER_API_KEY: 'test' },
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout ?? ''}\n${result.stderr ?? ''}`, /config\.json/);
});

test('v2 instance root defaults to a separate directory beneath the clone parent', () => {
  const instanceRoot = mkdtempSync(join(tmpdir(), 'watch-instance-'));
  const cloneRoot = join(instanceRoot, 'watch');

  assert.equal(resolveInstanceRoot(cloneRoot), join(instanceRoot, 'v2'));
});

test('WATCH_INSTANCE_ROOT overrides the clone parent and resolves absolutely', () => {
  const cloneRoot = join(tmpdir(), 'watch-source', 'watch');
  const absoluteRoot = join(tmpdir(), 'watch-runtime');

  assert.equal(resolveInstanceRoot(cloneRoot, absoluteRoot), absoluteRoot);
  assert.equal(resolveInstanceRoot(cloneRoot, 'relative-watch-runtime'), resolve('relative-watch-runtime'));
  assert.equal(resolveInstanceRoot(cloneRoot, '   '), join(dirname(cloneRoot), 'v2'));
});

test('v2 commands reject a v1 instance without modifying its files', t => {
  const root = mkdtempSync(join(tmpdir(), 'watch-v1-preserved-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'state'));
  mkdirSync(join(root, 'scratchpad'));
  const files = {
    'config.json': JSON.stringify({ defaultModel: 'local:test' }),
    'state/state.json': '{"activeModel":"local:old"}',
    'scratchpad/AGENT.md': 'Agent orientation',
    'scratchpad/USER.md': 'User preferences',
  };
  for (const [path, content] of Object.entries(files)) writeFileSync(join(root, path), content);
  for (const args of [['daemon', 'start'], ['status'], ['stop']]) {
    const result = spawnSync(process.execPath, [resolve('node_modules/tsx/dist/cli.mjs'), resolve('src/index.ts'), ...args], {
      cwd: root, env: { ...process.env, WATCH_INSTANCE_ROOT: root }, encoding: 'utf8', timeout: 5000,
    });
    assert.equal(result.status, 1);
    assert.match(`${result.stdout}\n${result.stderr}`, /requires instanceVersion: 2/);
  }
  assert.deepEqual(readdirSync(root).sort(), ['config.json', 'scratchpad', 'state']);
  for (const [path, content] of Object.entries(files)) assert.equal(readFileSync(join(root, path), 'utf8'), content);
  assert.deepEqual(readdirSync(join(root, 'state')), ['state.json']);
});

test('v2 runtime entry points reject older or future versions before writing state', async t => {
  const root = mkdtempSync(join(tmpdir(), 'watch-version-guard-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const instanceVersion of [undefined, 1, 3]) {
    const config = { instanceRoot: root, instanceVersion } as unknown as WatchConfig;
    assert.throws(() => new WatchRuntime(config), /requires instanceVersion: 2/);
    await assert.rejects(runDaemon(config), /requires instanceVersion: 2/);
  }
  assert.deepEqual(readdirSync(root), []);
});

test('relative ledger paths resolve from the instance root', async () => {
  const instanceRoot = mkdtempSync(join(tmpdir(), 'watch-instance-'));
  const cloneRoot = join(instanceRoot, 'watch');
  mkdirSync(cloneRoot, { recursive: true });

  const ledgerPath = 'ledger.md';
  const messages: Array<Record<string, unknown>> = [];
  const controller = new SessionController({
    cwd: instanceRoot,
    ledgerPath,
    messages,
    log: new EventLog(instanceRoot),
    resetPromptState: () => {},
  });

  const result = await controller.curl('sounding-1', 'Remember this');
  assert.equal(result.ok, true);
  assert.equal(result.wroteLedger, true);
  assert.equal(result.ledgerPath, join(instanceRoot, ledgerPath));
  assert.ok(existsSync(join(instanceRoot, ledgerPath)));
});

test('absolute ledger paths still work', async () => {
  const instanceRoot = mkdtempSync(join(tmpdir(), 'watch-instance-'));
  const ledgerPath = join(instanceRoot, 'absolute-ledger.md');
  const controller = new SessionController({
    cwd: instanceRoot,
    ledgerPath,
    messages: [],
    log: new EventLog(instanceRoot),
    resetPromptState: () => {},
  });

  const result = await controller.curl('sounding-1', 'Remember this too');
  assert.equal(result.ok, true);
  assert.equal(result.ledgerPath, ledgerPath);
  assert.ok(existsSync(ledgerPath));
});

test('instance state lands outside the clone root', () => {
  const instanceRoot = mkdtempSync(join(tmpdir(), 'watch-instance-'));
  const cloneRoot = join(instanceRoot, 'watch');
  mkdirSync(cloneRoot, { recursive: true });

  const scratchpad = resolveScratchpadPaths(instanceRoot, {});
  const gaze = new GazeStore(instanceRoot);
  const eventLog = new EventLog(instanceRoot);

  gaze.updateStreams({ subscriptions: [], textStreams: [] });
  eventLog.append({ type: 'daemon_stopped', at: new Date().toISOString(), pid: 1, reason: 'test' });

  const paths = [scratchpad.agentPath, scratchpad.userPath, statePath(instanceRoot), eventLogPath(instanceRoot), socketPath(instanceRoot)];
  for (const path of paths) {
    assert.equal(relative(cloneRoot, path).startsWith('..'), true, path);
    assert.equal(relative(instanceRoot, path).startsWith('..'), false, path);
  }
});
