import { jsonSchema, tool } from 'ai';
import { resolve, isAbsolute } from 'node:path';
import type { Sounding } from '../types.js';
import { readDiscordAttachments } from '../lookout-helpers.js';
import type { LookoutToolContext } from './context.js';

export function createMessageTools(ctx: LookoutToolContext, sounding: Sounding) {
  return {
    open_message: tool({
      description:
        'Open a message by global ID from an inbox Sounding. Use this when an inbox entry says to call open_message with an ID.',
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
            hint: 'The id may be stale or from a previous daemon run. Call message_page with medium "cli" or "discord" to list currently available message ids.',
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
            ...attachments.map(attachment => `To inspect attachment ${attachment.id} (${attachment.mediaType}), call open_media with inboxMessageId ${message.id} and attachmentId "${attachment.id}".`),
            'If no reply is needed, continue monitoring.',
          ],
        };
      },
    }),
    message_page: tool({
      description:
        'List messages from a medium in pages. Returns IDs/previews only. Use open_message with an ID to read a full message.',
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
          hint: 'Call open_message with an id to read a full message.',
          nextPageHint: result.page < result.totalPages ? `Call message_page with medium "${medium}" and page ${result.page + 1} for the next page.` : undefined,
        };
      },
    }),
    send_message: tool({
      description:
        'Send a user-facing message to an external medium. Use this for communication; final assistant text is private working speech and is not routed to the user.',
      inputSchema: jsonSchema<{ medium: string; message: string; replyToId?: number; attachments?: string[] }>({
        type: 'object',
        properties: {
          medium: { type: 'string', description: 'Destination medium, for example "cli".' },
          message: { type: 'string', description: 'Message to send.' },
          replyToId: { type: 'number', description: 'Optional global message ID being replied to.' },
          attachments: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional file paths or URLs to attach (Discord only).',
          },
        },
        required: ['medium', 'message'],
        additionalProperties: false,
      }),
      execute: async ({ medium, message, replyToId, attachments }) => {
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
          const result = await ctx.discord.sendMessage({ replyToId, message, attachments: resolvedAttachments });
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
