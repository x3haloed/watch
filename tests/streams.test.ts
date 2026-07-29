import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
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

test('pops only waking deltas for live steering', async () => {
  const streams = new StreamRegistry([], process.cwd());
  streams.registerBufferedStream('waking', { waking: true });
  streams.registerBufferedStream('ambient', { waking: false });
  streams.push('waking', { value: 1 });
  streams.push('ambient', { value: 2 });
  const capabilities = { tools: true, text: true, images: false, audio: false, video: false, pdf: false, source: 'test' };

  const waking = await streams.popWakingDeltas({ now: new Date(), capabilities });
  assert.deepEqual(waking.map(delta => delta.stream), ['waking']);
  assert.equal(streams.hasPending(), true);
  const remaining = await streams.popDeltas({ now: new Date(), capabilities });
  assert.equal(remaining.some(delta => delta.stream === 'ambient'), true);
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

test('restores audio/video file streams as one composite stream', () => {
  const registry = new StreamRegistry(
    [],
    process.cwd(),
    {
      subscriptions: ['av:clip.mp4:test'],
      knownStreams: ['av:clip.mp4:test'],
      textStreams: [],
      avStreams: [{
        name: 'av:clip.mp4:test',
        file: join(process.cwd(), 'clip.mp4'),
        fps: 2,
        speed: 1.5,
        mediaTime: 3,
        duration: 10,
        width: 320,
        height: 180,
        sampleRate: 16000,
        channels: 1,
        format: 'wav',
      }],
    },
  );

  assert.equal(registry.listStreams().includes('av:clip.mp4:test'), true);
  assert.equal(registry.listSubscriptions().includes('av:clip.mp4:test'), true);

  const snapshot = registry.snapshot();
  assert.equal(snapshot.avStreams?.length, 1);
  assert.equal(snapshot.avStreams?.[0]?.mediaTime, 3);
  assert.equal(snapshot.avStreams?.[0]?.sampleRate, 16000);
});

test('closes audio/video file streams by composite stream id', () => {
  const registry = new StreamRegistry(
    [],
    process.cwd(),
    {
      subscriptions: ['av:clip.mp4:test'],
      knownStreams: ['av:clip.mp4:test'],
      textStreams: [],
      avStreams: [{
        name: 'av:clip.mp4:test',
        file: join(process.cwd(), 'clip.mp4'),
        fps: 1,
        speed: 1,
        mediaTime: 0,
        duration: 10,
        sampleRate: 16000,
        channels: 1,
        format: 'wav',
      }],
    },
  );

  const result = registry.closeAudioVideoFileStream('av:clip.mp4:test');

  assert.equal(result.closed, true);
  assert.equal(result.unsubscribed, true);
  assert.equal(registry.listStreams().includes('av:clip.mp4:test'), false);
  assert.equal(registry.listSubscriptions().includes('av:clip.mp4:test'), false);
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

test('unified registry lists system, buffered, Web API, and SSE definitions with redacted secrets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'watch-streams-'));
  const registry = new StreamRegistry([], root, undefined, undefined, undefined, undefined, [], undefined, [
    { kind: 'buffered', name: 'metrics', active: false, waking: false },
    { kind: 'web_api', name: 'poll', url: 'http://127.0.0.1:1/poll', active: false, waking: false },
    { kind: 'sse', name: 'events', url: 'http://127.0.0.1:1/events', headers: { Authorization: 'secret' }, active: false, waking: true },
  ]);

  const views = registry.list();
  assert.equal(views.some(view => view.kind === 'system' && view.name === 'inbox'), true);
  assert.equal(views.some(view => view.kind === 'buffered'), true);
  assert.equal(views.some(view => view.kind === 'web_api'), true);
  assert.equal(views.some(view => view.kind === 'sse'), true);
  assert.deepEqual(views.find(view => view.name === 'events')?.definition?.headers, { redacted: true, count: 1 });
  assert.deepEqual(registry.list({ active: false }).map(view => view.name), ['events', 'metrics', 'poll']);
});

test('SSE connector lifecycle follows gaze activation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'watch-streams-'));
  let connections = 0;
  let registry: StreamRegistry | undefined;
  const server = createServer((_, response) => {
    connections += 1;
    response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive' });
    response.write('data: {\"value\":1}\n\n');
  });
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    registry = new StreamRegistry([], root, undefined, undefined, undefined, undefined, [], undefined, [{
      kind: 'sse',
      name: 'events',
      url: `http://127.0.0.1:${address.port}/events`,
      active: false,
      waking: true,
    }]);
    registry.start();
    await delay(30);
    assert.equal(connections, 0);
    registry.setGaze('events', { active: true }, false);
    await waitFor(() => connections >= 1 && registry?.list({ name: 'events' })[0]?.connectorState === 'connected');
    registry.setGaze('events', { active: false }, false);
    assert.equal(registry.list({ name: 'events' })[0]?.connectorState, 'stopped');
    registry.stop();
  } finally {
    registry?.stop();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('snapshot v2 preserves runtime definitions, gaze overrides, and config tombstones', async () => {
  const root = await mkdtemp(join(tmpdir(), 'watch-streams-'));
  const configured = { kind: 'buffered' as const, name: 'configured', active: true, waking: false };
  const registry = new StreamRegistry([], root, undefined, undefined, undefined, undefined, [], undefined, [configured]);
  registry.setDefinition({ kind: 'buffered', name: 'runtime', active: true, waking: false }, false);
  registry.setGaze('runtime', { active: false, waking: true }, false);
  registry.removeDefinition('configured', false);

  const restored = new StreamRegistry([], root, registry.snapshot(), undefined, undefined, undefined, [], undefined, [configured]);
  assert.equal(restored.list({ name: 'configured' }).length, 0);
  const runtime = restored.list({ name: 'runtime' })[0];
  assert.equal(runtime?.origin, 'runtime');
  assert.equal(runtime?.active, false);
  assert.equal(runtime?.waking, true);
});

test('snapshot v2 lets changed config defaults apply unless gaze explicitly overrides them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'watch-streams-'));
  const inactive = { kind: 'buffered' as const, name: 'configured', active: false, waking: false };
  const active = { ...inactive, active: true };
  const original = new StreamRegistry([], root, undefined, undefined, undefined, undefined, [], undefined, [inactive]);

  const configChanged = new StreamRegistry([], root, original.snapshot(), undefined, undefined, undefined, [], undefined, [active]);
  assert.equal(configChanged.list({ name: 'configured' })[0]?.active, true);

  original.setGaze('configured', { active: false }, false);
  const overridden = new StreamRegistry([], root, original.snapshot(), undefined, undefined, undefined, [], undefined, [active]);
  assert.equal(overridden.list({ name: 'configured' })[0]?.active, false);
});

test('snapshot v2 applies durable gaze when an integration registers after restore', async () => {
  const root = await mkdtemp(join(tmpdir(), 'watch-streams-'));
  const original = new StreamRegistry([], root);
  original.registerBufferedStream('discord:reactions', { subscribed: true, waking: false });
  original.setGaze('discord:reactions', { active: false }, false);

  const restored = new StreamRegistry([], root, original.snapshot());
  restored.registerBufferedStream('discord:reactions', { subscribed: true, waking: false });
  assert.equal(restored.list({ name: 'discord:reactions' })[0]?.active, false);
});

test('persistent mutation writes canonical streams and removes legacy stream fields', async () => {
  const root = await mkdtemp(join(tmpdir(), 'watch-streams-'));
  await writeFile(join(root, 'config.json'), JSON.stringify({
    defaultModel: 'test',
    sseStreams: [{ name: 'legacy', url: 'http://legacy.test/events', subscribed: true }],
    cameraStreams: [],
  }), 'utf8');
  const registry = new StreamRegistry([], root);
  registry.setDefinition({ kind: 'buffered', name: 'metrics', active: true, waking: false }, true);
  registry.setGaze('metrics', { active: false, waking: true }, true);

  const persisted = JSON.parse(await readFile(join(root, 'config.json'), 'utf8'));
  assert.equal(persisted.defaultModel, 'test');
  assert.equal('sseStreams' in persisted, false);
  assert.equal('cameraStreams' in persisted, false);
  assert.deepEqual(persisted.streams, [
    { kind: 'sse', name: 'legacy', url: 'http://legacy.test/events', active: true },
    { kind: 'buffered', name: 'metrics', active: false, waking: true },
  ]);
});

test('Web API sampling is suspended while gaze is inactive', async () => {
  const root = await mkdtemp(join(tmpdir(), 'watch-streams-'));
  let requests = 0;
  const server = createServer((_, response) => {
    requests += 1;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{\"value\":1}');
  });
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const registry = new StreamRegistry([], root, undefined, undefined, undefined, undefined, [], undefined, [{
      kind: 'web_api',
      name: 'poll',
      url: `http://127.0.0.1:${address.port}/poll`,
      active: false,
      waking: false,
      emitUnchanged: true,
    }]);
    await registry.popDeltas({ now: new Date(), capabilities });
    assert.equal(requests, 0);
    registry.setGaze('poll', { active: true }, false);
    await registry.popDeltas({ now: new Date(), capabilities });
    assert.equal(requests, 1);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('camera connector lifecycle follows gaze activation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'watch-streams-'));
  const OriginalWebSocket = globalThis.WebSocket;
  let connections = 0;
  let closes = 0;
  class FakeWebSocket {
    static readonly OPEN = 1;
    readyState = FakeWebSocket.OPEN;
    private readonly listeners = new Map<string, Array<(event: any) => void>>();
    constructor(_url: string) {
      connections += 1;
      queueMicrotask(() => this.emit('open', {}));
    }
    addEventListener(type: string, listener: (event: any) => void): void {
      this.listeners.set(type, [...this.listeners.get(type) ?? [], listener]);
    }
    send(): void {}
    close(_code?: number, reason = ''): void {
      closes += 1;
      this.emit('close', { code: 1000, reason });
    }
    private emit(type: string, event: any): void {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }
  }
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, writable: true, value: FakeWebSocket });
  try {
    const registry = new StreamRegistry([], root, undefined, undefined, undefined, undefined, [], undefined, [{
      kind: 'camera',
      name: 'camera:test',
      url: 'ws://127.0.0.1:8765/',
      active: false,
      waking: true,
    }]);
    registry.start();
    assert.equal(connections, 0);
    registry.setGaze('camera:test', { active: true }, false);
    await waitFor(() => connections === 1);
    registry.setGaze('camera:test', { active: false }, false);
    assert.equal(closes, 1);
    assert.equal(registry.list({ name: 'camera:test' })[0]?.connectorState, 'stopped');
    registry.stop();
  } finally {
    Object.defineProperty(globalThis, 'WebSocket', { configurable: true, writable: true, value: OriginalWebSocket });
  }
});

test('system and integration-owned stream capabilities enforce their boundaries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'watch-streams-'));
  const registry = new StreamRegistry([], root);
  registry.registerBufferedStream('discord:reactions', { subscribed: true, waking: false });

  assert.equal(registry.list({ name: 'inbox' })[0]?.capabilities.removable, false);
  assert.throws(() => registry.setGaze('inbox', { active: false }, false), /cannot be changed/);
  assert.throws(() => registry.removeDefinition('discord:reactions', false), /cannot be removed/);
  assert.throws(() => registry.setGaze('discord:reactions', { active: false }, true), /cannot be persisted/);
  registry.setGaze('discord:reactions', { active: false }, false);
  assert.equal(registry.list({ name: 'discord:reactions' })[0]?.active, false);
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(10);
  }
  throw new Error('timed out waiting for condition');
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
