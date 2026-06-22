import { jsonSchema, tool } from 'ai';
import type { MoltbookScopeConfig } from '../types.js';
import type { MoltbookMarkReadInput, MoltbookReadInput } from '../moltbook.js';
import type { LookoutToolContext } from './context.js';

export function createMoltbookTools(ctx: LookoutToolContext) {
  return {
    moltbook_attention: tool({
      description:
        'Inspect Moltbook stream attention, configured/runtime scopes, poll status, rate-limit/backoff state, and recent non-secret errors.',
      inputSchema: jsonSchema<Record<string, never>>({
        type: 'object',
        properties: {},
        additionalProperties: false,
      }),
      execute: async () => ctx.moltbook?.getAttention() ?? { enabled: false, reason: 'Moltbook bridge is not configured.' },
    }),
    moltbook_watch: tool({
      description:
        'Watch a Moltbook scope. Supported types: home, feed, submolt, user, post, search, announcements. Runtime scopes persist across restarts.',
      inputSchema: jsonSchema<MoltbookScopeConfig>({
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['home', 'feed', 'submolt', 'user', 'post', 'search', 'announcements'] },
          name: { type: 'string', description: 'Submolt or molty name for submolt/user scopes.' },
          id: { type: 'string', description: 'Post ID for post comment scopes.' },
          query: { type: 'string', description: 'Search query for search scopes.' },
          filter: { type: 'string', enum: ['all', 'following'], description: 'Feed filter. Defaults to all.' },
          sort: { type: 'string', enum: ['new', 'hot', 'top', 'rising', 'best', 'old'], description: 'Sort order. Defaults to new.' },
          comments: { type: 'boolean', description: 'Reserved for post/comment scope clarity.' },
          waking: { type: 'boolean', description: 'Override the default actionable wake policy for this scope.' },
          intervalMs: { type: 'number', description: 'Optional polling interval for this scope, minimum 30000ms.' },
        },
        required: ['type'],
        additionalProperties: false,
      }),
      execute: async input => {
        if (!ctx.moltbook) return { ok: false, error: 'Moltbook bridge is not configured.' };
        return ctx.moltbook.watch(input);
      },
    }),
    moltbook_unwatch: tool({
      description: 'Remove a runtime Moltbook watch scope by stable scope key from moltbook_attention.',
      inputSchema: jsonSchema<{ key: string }>({
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Stable scope key returned by moltbook_attention.' },
        },
        required: ['key'],
        additionalProperties: false,
      }),
      execute: async ({ key }) => {
        if (!ctx.moltbook) return { ok: false, error: 'Moltbook bridge is not configured.' };
        return ctx.moltbook.unwatch(key);
      },
    }),
    moltbook_read: tool({
      description:
        'Read Moltbook details with the configured API key. Supports home, post, comments, profile, feed, and search. This is read-only.',
      inputSchema: jsonSchema<MoltbookReadInput>({
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['home', 'post', 'comments', 'profile', 'feed', 'search'] },
          postId: { type: 'string', description: 'Post ID for post or comments reads.' },
          name: { type: 'string', description: 'Molty name for profile reads.' },
          query: { type: 'string', description: 'Search query.' },
          filter: { type: 'string', enum: ['all', 'following'], description: 'Feed filter.' },
          sort: { type: 'string', description: 'Sort value for feed/comments reads.' },
          limit: { type: 'number', description: 'Page size, capped at 100.' },
          cursor: { type: 'string', description: 'Pagination cursor from a previous response.' },
        },
        required: ['kind'],
        additionalProperties: false,
      }),
      execute: async input => {
        if (!ctx.moltbook) return { ok: false, error: 'Moltbook bridge is not configured.' };
        return ctx.moltbook.read(input);
      },
    }),
    moltbook_mark_read: tool({
      description: 'Mark Moltbook notifications read by post, or mark all notifications read. Does not post/comment/vote.',
      inputSchema: jsonSchema<MoltbookMarkReadInput>({
        type: 'object',
        properties: {
          postId: { type: 'string', description: 'Post ID whose notifications should be marked read.' },
          all: { type: 'boolean', description: 'Set true to mark all notifications read.' },
        },
        additionalProperties: false,
      }),
      execute: async input => {
        if (!ctx.moltbook) return { ok: false, error: 'Moltbook bridge is not configured.' };
        return ctx.moltbook.markRead(input);
      },
    }),
  };
}
