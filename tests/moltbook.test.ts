import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventLog } from '../src/event-log.js';
import { MoltbookBridge, apiUrl } from '../src/moltbook.js';
import { StreamRegistry } from '../src/streams.js';
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

test('moltbook is disabled by default and enabled config defaults to home scope', async () => {
  const root = await mkdtemp(join(tmpdir(), 'watch-moltbook-'));
  const disabledRegistry = new StreamRegistry([], root);
  const disabled = new MoltbookBridge(undefined, disabledRegistry, new EventLog(root));

  assert.equal(disabled.isEnabled(), false);
  assert.deepEqual(disabled.snapshotState().scopes, []);
  assert.equal(disabledRegistry.listStreams().includes('moltbook'), false);

  const enabledRegistry = new StreamRegistry([], root);
  const enabled = new MoltbookBridge({ enabled: true, apiKeyEnv: 'MOLTBOOK_TEST_KEY' }, enabledRegistry, new EventLog(root));
  assert.equal(enabled.isEnabled(), true);
  assert.equal(enabled.snapshotState().scopes.length, 1);
  assert.equal(enabled.snapshotState().scopes[0]?.key, 'home');
  assert.equal(enabledRegistry.listSubscriptions().includes('moltbook'), true);
});

test('moltbook API URL guard only permits www API paths', () => {
  assert.equal(apiUrl('/home'), 'https://www.moltbook.com/api/v1/home');
  assert.equal(apiUrl('https://moltbook.com/api/v1/home'), undefined);
  assert.equal(apiUrl('/../login'), undefined);
});

test('moltbook polling baselines first, ignores unchanged, then emits bounded actionable deltas', async () => {
  const previous = process.env.MOLTBOOK_TEST_KEY;
  process.env.MOLTBOOK_TEST_KEY = 'test-secret';
  const root = await mkdtemp(join(tmpdir(), 'watch-moltbook-'));
  const registry = new StreamRegistry([], root);
  const bodies = [
    homeBody([{ post_id: 'p1', post_title: 'Hello', latest_at: '2026-06-01T00:00:00.000Z', new_notification_count: 1 }]),
    homeBody([{ post_id: 'p1', post_title: 'Hello', latest_at: '2026-06-01T00:00:00.000Z', new_notification_count: 1 }]),
    homeBody([
      { post_id: 'p1', post_title: 'Hello', latest_at: '2026-06-01T00:00:00.000Z', new_notification_count: 1 },
      { post_id: 'p2', post_title: 'New reply', latest_at: '2026-06-01T00:01:00.000Z', new_notification_count: 1 },
    ]),
  ];
  const calls: Array<{ url: string; authorization?: string }> = [];
  const bridge = new MoltbookBridge(
    { enabled: true, apiKeyEnv: 'MOLTBOOK_TEST_KEY', maxItemsPerDelta: 1 },
    registry,
    new EventLog(root),
    undefined,
    () => {},
    async (url, init) => {
      calls.push({ url: String(url), authorization: new Headers(init?.headers).get('authorization') ?? undefined });
      return jsonResponse(bodies.shift() ?? homeBody([]));
    },
  );

  try {
    await bridge.pollNow(true);
    let deltas = await registry.popDeltas({ now: new Date('2026-06-01T00:00:00.000Z'), capabilities });
    assert.equal(firstBufferedKind(deltas, 'moltbook:updates'), 'moltbook_baseline');

    await bridge.pollNow(true);
    deltas = await registry.popDeltas({ now: new Date('2026-06-01T00:00:01.000Z'), capabilities });
    assert.equal(deltas.some(delta => delta.stream === 'moltbook' || delta.stream === 'moltbook:updates'), false);

    await bridge.pollNow(true);
    assert.equal(registry.hasWakingPending(new Date('2026-06-01T00:00:02.000Z')), true);
    deltas = await registry.popDeltas({ now: new Date('2026-06-01T00:00:02.000Z'), capabilities });
    const moltbook = deltas.find(delta => delta.stream === 'moltbook');
    const item = firstBufferedItem(moltbook);
    assert.equal(item?.kind, 'moltbook_home_activity');
    assert.equal(item?.count, 1);
    assert.equal(Array.isArray(item?.items), true);
    assert.equal((item?.items as unknown[]).length, 1);
    assert.equal(item?.truncated, false);
    assert.equal(calls[0]?.authorization, 'Bearer test-secret');
    assert.ok(calls.every(call => call.url.startsWith('https://www.moltbook.com/api/v1/')));
  } finally {
    if (previous === undefined) delete process.env.MOLTBOOK_TEST_KEY;
    else process.env.MOLTBOOK_TEST_KEY = previous;
  }
});

test('moltbook generic feed changes are non-waking by default', async () => {
  const previous = process.env.MOLTBOOK_TEST_KEY;
  process.env.MOLTBOOK_TEST_KEY = 'test-secret';
  const root = await mkdtemp(join(tmpdir(), 'watch-moltbook-'));
  const registry = new StreamRegistry([], root);
  const bodies = [
    { posts: [{ id: 'p1', title: 'One', created_at: '2026-06-01T00:00:00.000Z' }] },
    { posts: [{ id: 'p2', title: 'Two', created_at: '2026-06-01T00:01:00.000Z' }] },
  ];
  const bridge = new MoltbookBridge(
    { enabled: true, apiKeyEnv: 'MOLTBOOK_TEST_KEY', scopes: [{ type: 'feed', sort: 'new' }] },
    registry,
    new EventLog(root),
    undefined,
    () => {},
    async () => jsonResponse(bodies.shift() ?? { posts: [] }),
  );

  try {
    await bridge.pollNow(true);
    await registry.popDeltas({ now: new Date('2026-06-01T00:00:00.000Z'), capabilities });
    await bridge.pollNow(true);
    assert.equal(registry.hasWakingPending(new Date('2026-06-01T00:00:01.000Z')), false);
    const deltas = await registry.popDeltas({ now: new Date('2026-06-01T00:00:01.000Z'), capabilities });
    assert.equal(firstBufferedKind(deltas, 'moltbook:updates'), 'moltbook_new_items');
  } finally {
    if (previous === undefined) delete process.env.MOLTBOOK_TEST_KEY;
    else process.env.MOLTBOOK_TEST_KEY = previous;
  }
});

test('moltbook rate limits set backoff and emit compact scope error', async () => {
  const previous = process.env.MOLTBOOK_TEST_KEY;
  process.env.MOLTBOOK_TEST_KEY = 'test-secret';
  const root = await mkdtemp(join(tmpdir(), 'watch-moltbook-'));
  const registry = new StreamRegistry([], root);
  const bridge = new MoltbookBridge(
    { enabled: true, apiKeyEnv: 'MOLTBOOK_TEST_KEY' },
    registry,
    new EventLog(root),
    undefined,
    () => {},
    async () => jsonResponse({ error: 'Rate limit exceeded' }, 429, { 'retry-after': '45' }),
  );

  try {
    await bridge.pollNow(true);
    const attention = bridge.getAttention();
    assert.equal(typeof (attention.poll as Record<string, unknown>).backoffUntil, 'string');
    const deltas = await registry.popDeltas({ now: new Date('2026-06-01T00:00:00.000Z'), capabilities });
    const error = deltas.find(delta => delta.stream === 'moltbook');
    const item = firstBufferedItem(error);
    assert.equal(item?.kind, 'moltbook_scope_error');
    assert.equal(item?.status, 429);
  } finally {
    if (previous === undefined) delete process.env.MOLTBOOK_TEST_KEY;
    else process.env.MOLTBOOK_TEST_KEY = previous;
  }
});

test('moltbook runtime watches persist through state snapshots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'watch-moltbook-'));
  const registry = new StreamRegistry([], root);
  let snapshot;
  const bridge = new MoltbookBridge(
    { enabled: true, apiKeyEnv: 'MOLTBOOK_TEST_KEY' },
    registry,
    new EventLog(root),
    undefined,
    state => {
      snapshot = state;
    },
  );
  const result = bridge.watch({ type: 'submolt', name: 'general' });
  assert.equal(result.ok, true);

  const restored = new MoltbookBridge(
    { enabled: true, apiKeyEnv: 'MOLTBOOK_TEST_KEY' },
    new StreamRegistry([], root),
    new EventLog(root),
    snapshot,
  );
  assert.equal(restored.snapshotState().scopes.some(scope => scope.key === 'submolt:general:new'), true);
});

function homeBody(activity: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    your_account: { name: 'Tester', karma: 1, unread_notification_count: activity.length },
    activity_on_your_posts: activity,
  };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText: status === 200 ? 'OK' : 'Too Many Requests',
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
  });
}

function firstBufferedKind(deltas: Array<{ stream: string; payload: Record<string, unknown> }>, stream: string): unknown {
  return firstBufferedItem(deltas.find(delta => delta.stream === stream))?.kind;
}

function firstBufferedItem(delta: { payload: Record<string, unknown> } | undefined): Record<string, unknown> | undefined {
  const items = delta?.payload.items;
  return Array.isArray(items) && typeof items[0] === 'object' && items[0] !== null ? items[0] as Record<string, unknown> : undefined;
}
