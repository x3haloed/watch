import { jsonSchema, tool } from 'ai';
import { parseDiscordAttentionScope } from '../discord.js';
import { parseWatchableDiscordScope } from '../lookout-helpers.js';
import type { LookoutToolContext } from './context.js';

export function createDiscordTools(ctx: LookoutToolContext) {
  return {
    discord_attention: tool({
      description:
        'Inspect Discord inbound attention. Discord delivers DMs, bot mentions, replies, and reactions on the agent\'s own messages by default unless muted. Watched channels or threads are also delivered into inbox. Reaction deltas use the non-waking discord:reactions stream.',
      inputSchema: jsonSchema<Record<string, never>>({
        type: 'object',
        properties: {},
        additionalProperties: false,
      }),
      execute: async () => ctx.discord?.getAttention() ?? { enabled: false, reason: 'Discord bridge is not configured.' },
    }),
    discord_read_context: tool({
      description:
        'Read a stable Discord message window for more context. Prefer inboxMessageId from an opened Discord inbox message. Returns chronological messages plus ready-made older/newer continuation args.',
      inputSchema: jsonSchema<{
        inboxMessageId?: number;
        channelId?: string;
        messageId?: string;
        before?: number;
        after?: number;
        beforeMessageId?: string;
        afterMessageId?: string;
        limit?: number;
      }>({
        type: 'object',
        properties: {
          inboxMessageId: { type: 'number', description: 'Watch inbox message ID to center around. Best default after open_message.' },
          channelId: { type: 'string', description: 'Discord channel/thread ID. Required if inboxMessageId is not provided.' },
          messageId: { type: 'string', description: 'Discord message ID to center around.' },
          before: { type: 'number', description: 'Centered mode: number of older messages. Defaults to 20, max 50.' },
          after: { type: 'number', description: 'Centered mode: number of newer messages. Defaults to 5, max 50.' },
          beforeMessageId: { type: 'string', description: 'Directional mode: read older messages before this Discord message ID.' },
          afterMessageId: { type: 'string', description: 'Directional mode: read newer messages after this Discord message ID.' },
          limit: { type: 'number', description: 'Directional/latest mode: number of messages. Defaults to 25, max 50.' },
        },
        additionalProperties: false,
      }),
      execute: async input => {
        if (!ctx.discord) return { ok: false, error: 'Discord bridge is not configured.' };
        return ctx.discord.readContext(input);
      },
    }),
    discord_mute: tool({
      description:
        'Stop Discord delivery for a scope. Use kind dms, mentions, replies, or reactions for default surfaces; use guild, channel, thread, or user with id for specific muting.',
      inputSchema: jsonSchema<{ kind: string; id?: string }>({
        type: 'object',
        properties: {
          kind: { type: 'string', description: 'One of dms, mentions, replies, reactions, guild, channel, thread, user.' },
          id: { type: 'string', description: 'Required for guild, channel, thread, and user scopes.' },
        },
        required: ['kind'],
        additionalProperties: false,
      }),
      execute: async ({ kind, id }) => {
        if (!ctx.discord) return { ok: false, error: 'Discord bridge is not configured.' };
        return ctx.discord.mute(parseDiscordAttentionScope(kind, id));
      },
    }),
    discord_unmute: tool({
      description:
        'Restore Discord delivery for a muted scope. Use kind dms, mentions, replies, or reactions for default surfaces; use guild, channel, thread, or user with id for specific muting.',
      inputSchema: jsonSchema<{ kind: string; id?: string }>({
        type: 'object',
        properties: {
          kind: { type: 'string', description: 'One of dms, mentions, replies, reactions, guild, channel, thread, user.' },
          id: { type: 'string', description: 'Required for guild, channel, thread, and user scopes.' },
        },
        required: ['kind'],
        additionalProperties: false,
      }),
      execute: async ({ kind, id }) => {
        if (!ctx.discord) return { ok: false, error: 'Discord bridge is not configured.' };
        return ctx.discord.unmute(parseDiscordAttentionScope(kind, id));
      },
    }),
    discord_watch: tool({
      description:
        'Begin delivering all messages from a Discord channel or thread into inbox, even when they are not DMs, mentions, or replies.',
      inputSchema: jsonSchema<{ kind: 'channel' | 'thread'; id: string }>({
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['channel', 'thread'], description: 'Watch a channel or thread.' },
          id: { type: 'string', description: 'Discord channel or thread ID.' },
        },
        required: ['kind', 'id'],
        additionalProperties: false,
      }),
      execute: async ({ kind, id }) => {
        if (!ctx.discord) return { ok: false, error: 'Discord bridge is not configured.' };
        const scope = parseWatchableDiscordScope(kind, id);
        if (!scope.ok) return scope;
        return ctx.discord.watch(scope);
      },
    }),
    discord_unwatch: tool({
      description:
        'Stop delivering all messages from a watched Discord channel or thread. Default DMs, mentions, and replies still apply unless muted separately.',
      inputSchema: jsonSchema<{ kind: 'channel' | 'thread'; id: string }>({
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['channel', 'thread'], description: 'Unwatch a channel or thread.' },
          id: { type: 'string', description: 'Discord channel or thread ID.' },
        },
        required: ['kind', 'id'],
        additionalProperties: false,
      }),
      execute: async ({ kind, id }) => {
        if (!ctx.discord) return { ok: false, error: 'Discord bridge is not configured.' };
        const scope = parseWatchableDiscordScope(kind, id);
        if (!scope.ok) return scope;
        return ctx.discord.unwatch(scope);
      },
    }),
  };
}
