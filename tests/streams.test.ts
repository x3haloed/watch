import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StreamRegistry } from '../src/streams.js';
import { terminateChildProcess } from '../src/stream-primitives.js';
import type { ModelCapabilities } from '../src/types.js';

const capabilities: ModelCapabilities = {
  tools: true,
  text: true,
  images: true,
  audio: true,
  video: true,
  pdf: true,
  source: 'test',
};

test('subscribes buffered streams and pops pending deltas', async () => {
  const registry = new StreamRegistry([], process.cwd());

  assert.equal(registry.subscribe('custom'), true);
  assert.equal(registry.push('custom', { value: 1 }), true);

  const deltas = await registry.popDeltas({ now: new Date('2026-06-07T00:00:00.000Z'), capabilities });
  const custom = deltas.find(delta => delta.stream === 'custom');

  assert.equal(custom?.payload.count, 1);
  assert.equal(registry.hasPending(new Date('2026-06-07T00:00:01.000Z')), true);
});

test('desktop capture uses video-style delivery labels', async () => {
  const registry = new StreamRegistry([], process.cwd());
  registry.registerBufferedStream('desktop:capture', { subscribed: true });
  registry.push('desktop:capture', { mediaType: 'video/mp4', dataBase64: 'aaaa' });

  const deltas = await registry.popDeltas({ now: new Date('2026-06-07T00:00:00.000Z'), capabilities });
  const desktop = deltas.find(delta => delta.stream === 'desktop:capture');

  assert.equal(desktop?.payload.delivery, 'video');
});


test('text file streams are removed from gaze after EOF', async () => {
  const root = await mkdtemp(join(tmpdir(), 'watch-streams-'));
  await writeFile(join(root, 'note.txt'), 'hello', 'utf8');
  const registry = new StreamRegistry([], root);

  const opened = await registry.openTextFileStream({ path: 'note.txt', charsPerSounding: 100 });
  assert.equal(opened.subscribed, false);
  assert.equal(registry.listSubscriptions().includes(String(opened.stream)), false);
});

test('restores configured subscriptions from snapshot while preserving new configured streams', () => {
  const registry = new StreamRegistry(
    [{ name: 'api:test', url: 'http://127.0.0.1:1', subscribed: true }],
    process.cwd(),
    { subscriptions: ['inbox'], knownStreams: ['inbox'], textStreams: [] },
  );

  assert.equal(registry.listSubscriptions().includes('clock'), true);
  assert.equal(registry.listSubscriptions().includes('api:test'), true);
});

test('child process termination escalates when polite signals are ignored', async () => {
  const proc = spawn(process.execPath, [
    '-e',
    'process.on("SIGINT", () => {}); process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);',
  ]);
  const closed = new Promise<number | null>(resolve => proc.on('close', code => resolve(code)));

  const result = await terminateChildProcess(proc, closed, {
    sigintMs: 25,
    sigtermMs: 25,
    sigkillMs: 1000,
  });

  assert.equal(result.ok, true);
});
