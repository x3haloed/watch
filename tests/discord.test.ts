import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChannelType, type Message } from 'discord.js';
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

test('discord dm whitelist defaults to allowing all dm authors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'watch-discord-'));
  const streams = new StreamRegistry([], root);
  const bridge = new DiscordBridge({ enabled: false }, streams, new EventLog(root));

  assert.deepEqual(bridge.snapshotPolicy().dmWhitelist, { mode: 'all', userIds: [] });

  await (bridge as unknown as { handleMessage(message: Message): Promise<void> }).handleMessage(fakeDmMessage('user-a'));

  assert.equal(streams.listMessages('discord').total, 1);
  assert.equal(streams.getMessage(1)?.metadata?.discord && typeof streams.getMessage(1)?.metadata?.discord === 'object'
    ? (streams.getMessage(1)?.metadata?.discord as { authorId?: unknown }).authorId
    : undefined, 'user-a');
});

test('discord dm whitelist can restrict delivery to configured user ids', async () => {
  const root = await mkdtemp(join(tmpdir(), 'watch-discord-'));
  const streams = new StreamRegistry([], root);
  const log = new EventLog(root);
  const bridge = new DiscordBridge({
    enabled: false,
    dmWhitelist: { mode: 'users', userIds: ['allowed-user'] },
  }, streams, log);

  assert.deepEqual(bridge.snapshotPolicy().dmWhitelist, { mode: 'users', userIds: ['allowed-user'] });

  await (bridge as unknown as { handleMessage(message: Message): Promise<void> }).handleMessage(fakeDmMessage('blocked-user', 'm-blocked'));
  await (bridge as unknown as { handleMessage(message: Message): Promise<void> }).handleMessage(fakeDmMessage('allowed-user', 'm-allowed'));

  assert.equal(streams.listMessages('discord').total, 1);
  assert.equal(streams.getMessage(1)?.content, 'hello from allowed-user');
  assert.equal(log.tail(10).some(event => event.type === 'discord_dropped' && event.reason === 'dm author not whitelisted'), true);
});

function fakeDmMessage(authorId: string, id = `m-${authorId}`): Message {
  return {
    partial: false,
    id,
    author: { id: authorId, tag: `${authorId}#0001` },
    channelId: 'dm-channel',
    guildId: null,
    guild: null,
    channel: {
      type: ChannelType.DM,
      isThread: () => false,
    },
    content: `hello from ${authorId}`,
    attachments: new Map(),
    mentions: {
      users: new Map(),
      repliedUser: null,
    },
    reference: null,
    url: `https://discord.com/channels/@me/dm-channel/${id}`,
  } as unknown as Message;
}
