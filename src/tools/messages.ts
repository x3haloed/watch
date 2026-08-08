import { jsonSchema, tool } from 'ai';
import { resolve, isAbsolute } from 'node:path';
import type { Sounding } from '../types.js';
import { readDiscordAttachments } from '../lookout-helpers.js';
import type { LookoutToolContext } from './context.js';

export function createMessageTools(ctx: LookoutToolContext, sounding: Sounding) {
  return {
    open_message: tool({
      description:
        'Open a message by global ID from an inbox Sounding. Inbox entries identify messages by the ID accepted here.',
      inputSchema: jsonSchema<{ id: number }>({
        type: 'object',
        properties: {
          id: { type: 'number', description: 'Global message ID from an inbox Sounding entry.' },
        },
        required: ['id'],
        additionalProperties: false,
      }),
      execute: async ({ id }) => {
        if (!Number.isFinite(id)) {
          return {
            ok: false,
            error: 'open_message requires a numeric id from an inbox delta. No id was provided.',
            hint: 'Look at the latest [deltas] inbox entry and call open_message with that numeric id, or call message_page with medium "cli" or "discord" to list recent message ids.',
          };
        }
        const message = ctx.inbox.get(id);
        if (!message) {
          return {
            ok: false,
            error: `Message not found: ${id}`,
            hint: 'The id may be stale or from a previous daemon run. message_page lists currently available message IDs for medium "cli" or "discord".',
          };
        }
        const attachments = readDiscordAttachments(message.metadata);
        return {
          ok: true,
          message: {
            id: message.id,
            medium: message.medium,
            source: message.source,
            subject: message.subject,
            receivedAt: message.receivedAt,
            content: message.content,
            metadata: message.metadata,
            attachments,
          },
          next_actions: [
            `To reply to this message, call send_message with medium "${message.medium}", replyToId ${message.id}, and your message content.`,
            ...(message.medium === 'discord' && discordChannelId(message.metadata)
              ? [`To post proactively into the same Discord channel, call send_message with medium "discord", channelId "${discordChannelId(message.metadata)}", and your message content.`]
              : []),
            ...attachments.map(attachment => `To inspect attachment ${attachment.id} (${attachment.mediaType}), call open_media with inboxMessageId ${message.id} and attachmentId "${attachment.id}".`),
            'If no reply is needed, continue monitoring.',
          ],
        };
      },
    }),
    message_page: tool({
      description:
        'List messages from a medium in pages. Results contain IDs and previews; open_message expands an ID into its full message.',
      inputSchema: jsonSchema<{ medium: string; page?: number; pageSize?: number }>({
        type: 'object',
        properties: {
          medium: { type: 'string', description: 'Message medium, for example "cli".' },
          page: { type: 'number', description: '1-based page number. Defaults to 1.' },
          pageSize: { type: 'number', description: 'Messages per page. Defaults to 10, max 50.' },
        },
        required: ['medium'],
        additionalProperties: false,
      }),
      execute: async ({ medium, page = 1, pageSize = 10 }) => {
        const result = ctx.inbox.list(medium, page, pageSize);
        return {
          ok: true,
          medium,
          ...result,
          hint: 'open_message expands an ID into a full message.',
          nextPageHint: result.page < result.totalPages ? `message_page accepts medium "${medium}" and page ${result.page + 1} for the next page.` : undefined,
        };
      },
    }),
    react: tool({
      description:
        'React to a Discord message. The id may be an inbox message ID or a Discord message ID snowflake; pass channelId when using a Discord message ID directly. Defaults to 👍 when reaction is omitted. Discord message.react accepts Unicode emoji like "👍", custom emoji IDs, and custom emoji identifiers like "name:id" or "<:name:id>".',
      inputSchema: jsonSchema<{ id: number | string; channelId?: string; reaction?: string }>({
        type: 'object',
        properties: {
          id: {
            anyOf: [{ type: 'number' }, { type: 'string' }],
            description: 'Inbox message ID or Discord message ID. Use a string for Discord snowflakes to preserve precision.',
          },
          channelId: { type: 'string', description: 'Discord channel or thread ID. Required when id is a Discord message ID instead of an inbox ID.' },
          reaction: {
            type: 'string',
            description: 'Optional reaction. Defaults to 👍. Accepts Unicode emoji, custom emoji IDs, and custom emoji identifiers like "name:id" or "<:name:id>".',
          },
        },
        required: ['id'],
        additionalProperties: false,
      }),
      execute: async ({ id, channelId, reaction }) => {
        if (!ctx.discord) return { ok: false, error: 'Discord bridge is not configured.' };
        return ctx.discord.react({ id, channelId, reaction });
      },
    }),
    send_message: tool({
      description:
        'Send a user-facing message to an external medium. This is Watch’s built-in/traced delivery path; final assistant text is private working speech and is not routed to the user.',
      inputSchema: jsonSchema<{ medium: string; message: string; replyToId?: number | string; channelId?: string; attachments?: string[] }>({
        type: 'object',
        properties: {
          medium: { type: 'string', description: 'Destination medium, for example "cli".' },
          message: { type: 'string', description: 'Message to send.' },
          replyToId: {
            anyOf: [{ type: 'number' }, { type: 'string' }],
            description: 'Optional inbox message ID being replied to. For Discord, may also be a Discord message ID; use a string for Discord snowflakes and include channelId.',
          },
          channelId: { type: 'string', description: 'Discord channel or thread ID for proactive posting when no replyToId is available.' },
          attachments: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional file paths or URLs to attach (Discord only).',
          },
        },
        required: ['medium', 'message'],
        additionalProperties: false,
      }),
      execute: async ({ medium, message, replyToId, channelId, attachments }) => {
        const resolvedAttachments = attachments && attachments.length > 0
          ? attachments.map(filePath => {
              const cleanPath = filePath.trim();
              if (cleanPath.startsWith('http://') || cleanPath.startsWith('https://')) {
                return cleanPath;
              }
              if (cleanPath.split(/[\\/]+/).includes('..')) {
                throw new Error(`Parent traversal (..) is not allowed in attachment paths: ${cleanPath}`);
              }
              return isAbsolute(cleanPath) ? cleanPath : resolve(ctx.cwd, cleanPath);
            })
          : undefined;

        if (medium === 'cli') {
          ctx.log.append({
            type: 'cli_message',
            at: new Date().toISOString(),
            soundingId: sounding.id,
            medium,
            replyToId,
            message,
            attachments: resolvedAttachments,
          });
          return { ok: true, delivered: medium, replyToId, attachments: resolvedAttachments };
        }
        if (medium === 'discord') {
          if (!ctx.discord) return { ok: false, error: 'Discord bridge is not configured.' };
          const result = await ctx.discord.sendMessage({ replyToId, channelId, message, attachments: resolvedAttachments });
          if (result.ok === true) {
            const messageIds = Array.isArray(result.messages)
              ? result.messages
                  .map(entry => entry && typeof entry === 'object' && 'messageId' in entry ? String(entry.messageId) : '')
                  .filter(Boolean)
              : [];
            ctx.log.append({
              type: 'discord_outbound',
              at: new Date().toISOString(),
              soundingId: sounding.id,
              replyToId,
              channelId,
              messageIds,
            });
          }
          return result;
        }
        return { ok: false, error: `Unsupported medium: ${medium}`, supportedMedia: ['cli', 'discord'] };
      },
  }),
  };
}

function discordChannelId(metadata: unknown): string | undefined {
  if (!metadata || typeof metadata !== 'object') return undefined;
  const discord = (metadata as { discord?: unknown }).discord;
  if (!discord || typeof discord !== 'object') return undefined;
  const channelId = (discord as { channelId?: unknown }).channelId;
  return typeof channelId === 'string' && channelId.trim() ? channelId.trim() : undefined;
}
