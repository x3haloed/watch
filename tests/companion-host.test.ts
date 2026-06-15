import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createServer } from 'node:net';
import { startCompanionHost } from '../src/companion-host.js';
import { WatchRuntime } from '../src/runtime.js';
import type { WatchConfig } from '../src/types.js';

test('companion host sends messages through the Watch inbox projection', async () => {
  const instanceRoot = mkdtempSync(join(tmpdir(), 'watch-companion-test-'));
  const previousPort = process.env.WATCH_COMPANION_PORT;
  const port = await freePort();
  process.env.WATCH_COMPANION_PORT = String(port);

  const runtime = new WatchRuntime(testConfig(instanceRoot));
  const host = await startCompanionHost(runtime);
  runtime.start();

  try {
    const status = await fetchJson(`http://127.0.0.1:${port}/api/status`);
    assert.equal(status.running, true);

    const send = await fetchJson(`http://127.0.0.1:${port}/api/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hello companion', source: 'desktop-companion' }),
    });
    assert.equal(send.ok, true);
    assert.equal(send.accepted, true);

    const conversation = await fetchJson(`http://127.0.0.1:${port}/api/conversation`);
    assert.ok(
      conversation.messages.some(
        (message: Record<string, unknown>) =>
          message.direction === 'out' &&
          message.source === 'desktop-companion' &&
          message.text === 'hello companion',
      ),
    );
  } finally {
    await runtime.stop('test done');
    await host.close();
    if (previousPort === undefined) {
      delete process.env.WATCH_COMPANION_PORT;
    } else {
      process.env.WATCH_COMPANION_PORT = previousPort;
    }
    rmSync(instanceRoot, { recursive: true, force: true });
  }
});

test('companion visualization stream projects Watch events', async () => {
  const instanceRoot = mkdtempSync(join(tmpdir(), 'watch-companion-viz-test-'));
  const previousPort = process.env.WATCH_COMPANION_PORT;
  const port = await freePort();
  process.env.WATCH_COMPANION_PORT = String(port);

  const runtime = new WatchRuntime(testConfig(instanceRoot));
  const host = await startCompanionHost(runtime);
  runtime.start();
  const abort = new AbortController();

  try {
    const stream = await openSseStream(`http://127.0.0.1:${port}/api/visualization/stream`, abort.signal);
    await stream.waitFor(event => event.type === 'visualization.snapshot');
    await runtime.handle({ command: 'sound' });
    const events = await stream.waitFor(
      event => event.type === 'visualization.output_packet',
    );
    assert.ok(events.some(event => event.type === 'visualization.snapshot'));
    assert.ok(events.some(event => event.type === 'visualization.impact'));
    assert.ok(events.some(event => event.type === 'visualization.output_packet'));
    assert.ok(events.some(event => event.type === 'visualization.state'));
  } finally {
    abort.abort();
    await runtime.stop('test done');
    await host.close();
    if (previousPort === undefined) {
      delete process.env.WATCH_COMPANION_PORT;
    } else {
      process.env.WATCH_COMPANION_PORT = previousPort;
    }
    rmSync(instanceRoot, { recursive: true, force: true });
  }
});

async function fetchJson(url: string, init?: RequestInit): Promise<Record<string, any>> {
  const response = await fetch(url, init);
  assert.equal(response.ok, true);
  return response.json() as Promise<Record<string, any>>;
}

function testConfig(instanceRoot: string): WatchConfig {
  return {
    cloneRoot: process.cwd(),
    instanceRoot,
    minCffMs: 60_000,
    maxCffMs: 120_000,
    modelTimeoutMs: 1_000,
    defaultModel: 'local:test',
    availableModels: [],
    webApiStreams: [],
    sseStreams: [],
    cameraStreams: [],
    scratchpad: { enabled: false },
    restAfterNoToolSoundings: 3,
    estimatedTokenWarningThreshold: 120_000,
    noModel: true,
  };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === 'object') {
          resolve(address.port);
        } else {
          reject(new Error('failed to allocate a free port'));
        }
      });
    });
  });
}

async function openSseStream(url: string, signal: AbortSignal): Promise<{
  waitFor: (predicate: (event: { type: string; data: unknown }) => boolean) => Promise<Array<{ type: string; data: unknown }>>;
}> {
  const response = await fetch(url, { signal });
  assert.equal(response.ok, true);
  assert.ok(response.body);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events: Array<{ type: string; data: unknown }> = [];
  const waiters: Array<{
    predicate: (event: { type: string; data: unknown }) => boolean;
    resolve: (events: Array<{ type: string; data: unknown }>) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];
  let buffer = '';
  void (async () => {
    try {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? '';
        for (const part of parts) {
          const event = parseSseEvent(part);
          if (event) {
            events.push(event);
            resolveWaiters(events, waiters);
          }
        }
        if (signal.aborted) return;
        const next = await reader.read();
        if (next.done) return;
        buffer += decoder.decode(next.value, { stream: true });
      }
    } catch (error) {
      if (!signal.aborted) {
        for (const waiter of waiters.splice(0)) {
          clearTimeout(waiter.timer);
          waiter.reject(error instanceof Error ? error : new Error(String(error)));
        }
      }
    } finally {
      reader.releaseLock();
    }
  })();

  return {
    waitFor(predicate) {
      if (events.some(predicate)) {
        return Promise.resolve([...events]);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out waiting for SSE event')), 5_000);
        waiters.push({ predicate, resolve, reject, timer });
      });
    },
  };
}

function resolveWaiters(
  events: Array<{ type: string; data: unknown }>,
  waiters: Array<{
    predicate: (event: { type: string; data: unknown }) => boolean;
    resolve: (events: Array<{ type: string; data: unknown }>) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>,
): void {
  for (let index = waiters.length - 1; index >= 0; index -= 1) {
    const waiter = waiters[index];
    if (events.some(waiter.predicate)) {
      clearTimeout(waiter.timer);
      waiters.splice(index, 1);
      waiter.resolve([...events]);
    }
  }
}

function parseSseEvent(raw: string): { type: string; data: unknown } | undefined {
  const eventLine = raw.split('\n').find(line => line.startsWith('event: '));
  const dataLine = raw.split('\n').find(line => line.startsWith('data: '));
  if (!eventLine || !dataLine) {
    return undefined;
  }
  return {
    type: eventLine.slice('event: '.length),
    data: JSON.parse(dataLine.slice('data: '.length)),
  };
}
