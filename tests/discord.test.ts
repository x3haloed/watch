import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiscordBridge, parseDiscordAttentionScope } from '../src/discord.js';
import { EventLog } from '../src/event-log.js';
import { StreamRegistry } from '../src/streams.js';

test('discord reaction stream is subscribed by default but non-waking', async () => {
  const root = await mkdtemp(join(tmpdir(), 'watch-discord-'));
  const streams = new StreamRegistry([], root);
  new DiscordBridge({ enabled: false }, streams, new EventLog(root));

  assert.equal(streams.listSubscriptions().includes('discord:reactions'), true);
  assert.equal(streams.push('discord:reactions', { kind: 'reaction' }), true);
  assert.equal(streams.hasPending(), true);
  assert.equal(streams.hasWakingPending(), false);
});

test('discord reaction attention is enabled by default and mutable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'watch-discord-'));
  const bridge = new DiscordBridge({ enabled: false }, new StreamRegistry([], root), new EventLog(root));

  assert.equal(bridge.snapshotPolicy().defaultReactions, true);
  bridge.mute(parseDiscordAttentionScope('reactions'));
  assert.equal(bridge.snapshotPolicy().defaultReactions, false);
  bridge.unmute(parseDiscordAttentionScope('reactions'));
  assert.equal(bridge.snapshotPolicy().defaultReactions, true);
});

