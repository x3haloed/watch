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
