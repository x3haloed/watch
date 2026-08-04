import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { EventLog } from '../src/event-log.js';
import { GazeStore } from '../src/gaze-state.js';
import { SessionController } from '../src/session-controller.js';
import { resolveScratchpadPaths } from '../src/scratchpad.js';
import { eventLogPath, resolveInstanceRoot, socketPath, statePath } from '../src/paths.js';

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

test('instance root defaults to the clone parent', () => {
  const instanceRoot = mkdtempSync(join(tmpdir(), 'watch-instance-'));
  const cloneRoot = join(instanceRoot, 'watch');

  assert.equal(resolveInstanceRoot(cloneRoot), instanceRoot);
});

test('WATCH_INSTANCE_ROOT overrides the clone parent and resolves absolutely', () => {
  const cloneRoot = join(tmpdir(), 'watch-source', 'watch');
  const absoluteRoot = join(tmpdir(), 'watch-runtime');

  assert.equal(resolveInstanceRoot(cloneRoot, absoluteRoot), absoluteRoot);
  assert.equal(resolveInstanceRoot(cloneRoot, 'relative-watch-runtime'), resolve('relative-watch-runtime'));
  assert.equal(resolveInstanceRoot(cloneRoot, '   '), dirname(cloneRoot));
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
