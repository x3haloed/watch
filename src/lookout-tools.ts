import { jsonSchema, tool } from 'ai';
import type { ResolvedModel, Sounding } from './types.js';
import { parseDiscordAttentionScope } from './discord.js';
import {
  contextFitForModel,
  estimateTokensRough,
  mediaToolOutputToModelOutput,
  parseWatchableDiscordScope,
  readDiscordAttachments,
} from './lookout-helpers.js';

export function createLookoutTools(ctx: any, sounding: Sounding, model: ResolvedModel) {
    return {
      read_file: tool({
        description: 'Read a UTF-8 text file with line numbers and pagination. If the path is media, this returns instructions to use open_media instead. Relative paths resolve from cwd; absolute paths are accepted. Paths containing .. are rejected.',
        inputSchema: jsonSchema<{ path: string; offset?: number; limit?: number }>({
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Path to read. Relative paths resolve from cwd; absolute paths are accepted.' },
            offset: { type: 'number', description: '1-based starting line. Defaults to 1.' },
            limit: { type: 'number', description: 'Maximum lines to return. Defaults to 500, max 1000.' },
          },
          required: ['path'],
          additionalProperties: false,
        }),
        execute: async ({ path, offset, limit }) => ctx.fileTools.readFile(path, offset, limit),
      }),
      open_media: tool({
        description:
          'Attach an image, audio file, video, or PDF to the model. Use path for filesystem media, or inboxMessageId + attachmentId for a Discord attachment. If the active model lacks the needed modality, this returns recommended handle_with_model targets.',
        inputSchema: jsonSchema<{ path?: string; inboxMessageId?: number; attachmentId?: string; url?: string; mediaType?: string; filename?: string }>({
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Filesystem path to media. Relative paths resolve from cwd; absolute paths are accepted.' },
            inboxMessageId: { type: 'number', description: 'Discord inbox message ID containing the attachment.' },
            attachmentId: { type: 'string', description: 'Discord attachment ID from open_message or discord_read_context.' },
            url: { type: 'string', description: 'Direct media URL. Prefer inboxMessageId + attachmentId for Discord.' },
            mediaType: { type: 'string', description: 'IANA media type for URL media when known.' },
            filename: { type: 'string', description: 'Filename for URL media when known.' },
          },
          additionalProperties: false,
        }),
        execute: async input => ctx.openMediaForModel(input, model),
        toModelOutput: (options: { output: unknown }) => mediaToolOutputToModelOutput(options.output) as never,
      }),
      write_file: tool({
        description:
          'Create a UTF-8 text file. Relative paths resolve from cwd; absolute paths are accepted. Paths containing .. are rejected. This refuses to overwrite by default. For edits or appends to an existing file, use patch instead. Set overwrite=true only when intentionally replacing the entire file.',
        inputSchema: jsonSchema<{ path: string; content: string; overwrite?: boolean }>({
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Path to write. Relative paths resolve from cwd; absolute paths are accepted.' },
            content: { type: 'string', description: 'Complete file content to write.' },
            overwrite: {
              type: 'boolean',
              description:
                'Defaults to false. Must be true to replace an existing file. Do not use for appends or small edits; use patch.',
            },
          },
          required: ['path', 'content'],
          additionalProperties: false,
        }),
        execute: async ({ path, content, overwrite }) => ctx.fileTools.writeFile(path, content, overwrite),
      }),
      search_files: tool({
        description: 'Search files by content using ripgrep, or list file paths containing a substring. Relative paths resolve from cwd; absolute paths are accepted. Paths containing .. are rejected.',
        inputSchema: jsonSchema<{
          pattern: string;
          target?: 'content' | 'files';
          path?: string;
          fileGlob?: string;
          limit?: number;
        }>({
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Regex pattern for content search, or substring for file search.' },
            target: { type: 'string', enum: ['content', 'files'], description: 'Search content or file paths. Defaults to content.' },
            path: { type: 'string', description: 'Directory or file to search. Defaults to cwd. Relative paths resolve from cwd; absolute paths are accepted.' },
            fileGlob: { type: 'string', description: 'Optional ripgrep glob, for example *.ts.' },
            limit: { type: 'number', description: 'Maximum matches. Defaults to 50, max 200.' },
          },
          required: ['pattern'],
          additionalProperties: false,
        }),
        execute: async input => ctx.fileTools.searchFiles(input),
      }),
      patch: tool({
        description: 'Replace an exact string in a file. Relative paths resolve from cwd; absolute paths are accepted. Paths containing .. are rejected. Use read_file first so old_string matches exactly.',
        inputSchema: jsonSchema<{ path: string; old_string: string; new_string: string; replace_all?: boolean }>({
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Path to patch. Relative paths resolve from cwd; absolute paths are accepted.' },
            old_string: { type: 'string', description: 'Exact text to replace.' },
            new_string: { type: 'string', description: 'Replacement text.' },
            replace_all: { type: 'boolean', description: 'Replace every occurrence instead of requiring a unique match.' },
          },
          required: ['path', 'old_string', 'new_string'],
          additionalProperties: false,
        }),
        execute: async ({ path, old_string: oldString, new_string: newString, replace_all: replaceAll }) =>
          ctx.fileTools.patch(path, oldString, newString, replaceAll),
      }),
      curl: tool({
        description:
          'End the current self-session cleanly. Optionally append a ledger entry to the configured ledger, then clear Watch conversation history so the next Sounding re-enters from cold instructions and fresh context.',
        inputSchema: jsonSchema<{ ledgerEntry?: string }>({
          type: 'object',
          properties: {
            ledgerEntry: {
              type: 'string',
              description:
                'Optional text to append to the configured ledger before clearing context. Shape the heading/body however you want; Watch adds a separator and timestamp.',
            },
          },
          additionalProperties: false,
        }),
        execute: async ({ ledgerEntry }) => ctx.curlSession(sounding.id, ledgerEntry),
      }),
      reboot: tool({
        description:
          'Cleanly reboot Watch. This first performs curl semantics: optionally append a ledger entry, clear conversation history, then request a full daemon restart after the current Sounding returns.',
        inputSchema: jsonSchema<{ ledgerEntry?: string }>({
          type: 'object',
          properties: {
            ledgerEntry: {
              type: 'string',
              description:
                'Optional text to append to the configured ledger before clearing context and rebooting. Use this to preserve what matters before restart.',
            },
          },
          additionalProperties: false,
        }),
        execute: async ({ ledgerEntry }) => {
          const result = await ctx.curlSession(sounding.id, ledgerEntry);
          if (!result.ok) {
            return result;
          }
          ctx.pendingReboot = {
            ledgerPath: result.ledgerPath,
            wroteLedger: result.wroteLedger,
            clearedMessages: result.clearedMessages,
            source: 'tool',
          };
          ctx.log.append({
            type: 'reboot_requested',
            at: new Date().toISOString(),
            soundingId: sounding.id,
            ledgerPath: result.ledgerPath,
            wroteLedger: result.wroteLedger,
            clearedMessages: result.clearedMessages,
            source: 'tool',
          });
          return {
            ...result,
            reboot: true,
            next: 'Watch will restart the daemon after this Sounding completes.',
          };
        },
      }),
      skills_list: tool({
        description: 'List available SKILL.md skills with short metadata. Use skill_view to load full instructions.',
        inputSchema: jsonSchema<{ category?: string }>({
          type: 'object',
          properties: {
            category: { type: 'string', description: 'Optional category filter.' },
          },
          additionalProperties: false,
        }),
        execute: async ({ category }) => ctx.skills.list(category),
      }),
      skill_view: tool({
        description: 'Load a skill SKILL.md, or a linked file inside that skill directory.',
        inputSchema: jsonSchema<{ name: string; file_path?: string }>({
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Skill name, directory name, or skill path from skills_list.' },
            file_path: { type: 'string', description: 'Optional relative path inside the skill directory.' },
          },
          required: ['name'],
          additionalProperties: false,
        }),
        execute: async ({ name, file_path: filePath }) => ctx.skills.view(name, filePath),
      }),
      terminal: tool({
        description:
          'Run a shell command. Use this for builds, tests, package managers, git, scripts, processes, and network checks. Do not use it for reading/searching/editing files when read_file, search_files, write_file, or patch can do the job. Use background=true only for servers/watchers that keep running. PTY is accepted for interactive tools but may fall back to normal pipes.',
        inputSchema: jsonSchema<{
          command: string;
          workdir?: string;
          timeoutMs?: number;
          background?: boolean;
          pty?: boolean;
          yieldTimeMs?: number;
          maxOutputChars?: number;
        }>({
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Shell command to execute.' },
            workdir: { type: 'string', description: 'Optional working directory. Relative paths resolve from cwd; absolute paths are accepted.' },
            timeoutMs: { type: 'number', description: 'Timeout in milliseconds. Defaults to 120000.' },
            background: { type: 'boolean', description: 'Only for servers/watchers that do not exit. Returns a sessionId.' },
            pty: { type: 'boolean', description: 'Request PTY-like execution for interactive commands. Defaults to false.' },
            yieldTimeMs: { type: 'number', description: 'How long to wait for output before returning. Defaults to 1000.' },
            maxOutputChars: { type: 'number', description: 'Maximum output characters to return. Defaults to 20000.' },
          },
          required: ['command'],
          additionalProperties: false,
        }),
        execute: async input => ctx.terminalTools.run(sounding.id, input),
      }),
      terminal_input: tool({
        description:
          'Interact with a running terminal session from terminal(background=true): poll output, write stdin, or kill it.',
        inputSchema: jsonSchema<{
          sessionId: string;
          input?: string;
          action?: 'poll' | 'write' | 'kill';
          yieldTimeMs?: number;
          maxOutputChars?: number;
        }>({
          type: 'object',
          properties: {
            sessionId: { type: 'string', description: 'Session ID returned by terminal(background=true).' },
            input: { type: 'string', description: 'Input bytes to write when action is write. Include newlines when needed.' },
            action: { type: 'string', enum: ['poll', 'write', 'kill'], description: 'Defaults to write when input is present, otherwise poll.' },
            yieldTimeMs: { type: 'number', description: 'How long to wait for more output before returning. Defaults to 1000.' },
            maxOutputChars: { type: 'number', description: 'Maximum output characters to return. Defaults to 20000.' },
          },
          required: ['sessionId'],
          additionalProperties: false,
        }),
        execute: async input => ctx.terminalTools.input(sounding.id, input),
      }),
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
          const message = ctx.streams.getMessage(id);
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
          const result = ctx.streams.listMessages(medium, page, pageSize);
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
        inputSchema: jsonSchema<{ medium: string; message: string; replyToId?: number }>({
          type: 'object',
          properties: {
            medium: { type: 'string', description: 'Destination medium, for example "cli".' },
            message: { type: 'string', description: 'Message to send.' },
            replyToId: { type: 'number', description: 'Optional global message ID being replied to.' },
          },
          required: ['medium', 'message'],
          additionalProperties: false,
        }),
        execute: async ({ medium, message, replyToId }) => {
          if (medium === 'cli') {
            ctx.log.append({
              type: 'cli_message',
              at: new Date().toISOString(),
              soundingId: sounding.id,
              medium,
              replyToId,
              message,
            });
            return { ok: true, delivered: medium, replyToId };
          }
          if (medium === 'discord') {
            if (!ctx.discord) return { ok: false, error: 'Discord bridge is not configured.' };
            const result = await ctx.discord.sendMessage({ replyToId, message });
            if (result.ok === true) {
              const messageIds = Array.isArray(result.messages)
                ? result.messages
                    .map((entry: unknown) => entry && typeof entry === 'object' && 'messageId' in entry ? String(entry.messageId) : '')
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
      discord_attention: tool({
        description:
          'Inspect Discord inbound attention. Discord delivers DMs, bot mentions, and replies by default unless muted. Watched channels or threads are also delivered into inbox.',
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
          'Stop Discord inbox delivery for a scope. Use kind dms, mentions, or replies for default surfaces; use guild, channel, thread, or user with id for specific muting.',
        inputSchema: jsonSchema<{ kind: string; id?: string }>({
          type: 'object',
          properties: {
            kind: { type: 'string', description: 'One of dms, mentions, replies, guild, channel, thread, user.' },
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
          'Restore Discord inbox delivery for a muted scope. Use kind dms, mentions, or replies for default surfaces; use guild, channel, thread, or user with id for specific muting.',
        inputSchema: jsonSchema<{ kind: string; id?: string }>({
          type: 'object',
          properties: {
            kind: { type: 'string', description: 'One of dms, mentions, replies, guild, channel, thread, user.' },
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
      subscribe_stream: tool({
        description: 'Begin watching a stream. Subscription changes persist across future Soundings.',
        inputSchema: jsonSchema<{ stream: string }>({
          type: 'object',
          properties: {
            stream: { type: 'string', description: 'The stream name to subscribe to.' },
          },
          required: ['stream'],
          additionalProperties: false,
        }),
        execute: async ({ stream }) => {
          const changed = ctx.streams.subscribe(stream);
          ctx.log.append({
            type: 'subscription_changed',
            at: new Date().toISOString(),
            stream,
            subscribed: true,
          });
          return { ok: true, changed, subscriptions: ctx.streams.listSubscriptions() };
        },
      }),
      unsubscribe_stream: tool({
        description: 'Stop watching a stream. The clock stream cannot be unsubscribed.',
        inputSchema: jsonSchema<{ stream: string }>({
          type: 'object',
          properties: {
            stream: { type: 'string', description: 'The stream name to unsubscribe from.' },
          },
          required: ['stream'],
          additionalProperties: false,
        }),
        execute: async ({ stream }) => {
          const changed = ctx.streams.unsubscribe(stream);
          ctx.log.append({
            type: 'subscription_changed',
            at: new Date().toISOString(),
            stream,
            subscribed: false,
          });
          return { ok: true, changed, subscriptions: ctx.streams.listSubscriptions() };
        },
      }),
      text_stream_open: tool({
        description:
          'Begin reading a UTF-8 text file as a gaze stream. Returns the first chunk immediately, then future Soundings include the next chunk until EOF or text_stream_close/unsubscribe_stream.',
        inputSchema: jsonSchema<{ path: string; charsPerSounding?: number; resumeAtChar?: number }>({
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Text file path. Relative paths resolve from cwd; absolute paths are accepted. Paths containing .. are rejected.' },
            charsPerSounding: { type: 'number', description: 'Optional number of characters to include in each Sounding. Defaults to 4000, max 100000.' },
            resumeAtChar: { type: 'number', description: 'Optional zero-based character offset to start/resume from. Defaults to 0.' },
          },
          required: ['path'],
          additionalProperties: false,
        }),
        execute: async ({ path, charsPerSounding, resumeAtChar }) => {
          const result = await ctx.streams.openTextFileStream({ path, charsPerSounding, resumeAtChar });
          ctx.log.append({
            type: 'subscription_changed',
            at: new Date().toISOString(),
            stream: String(result.stream ?? 'text-stream'),
            subscribed: Boolean(result.subscribed),
          });
          return result;
        },
      }),
      text_stream_close: tool({
        description: 'Stop and remove a text file gaze stream created by text_stream_open.',
        inputSchema: jsonSchema<{ stream: string }>({
          type: 'object',
          properties: {
            stream: { type: 'string', description: 'Stream name returned by text_stream_open.' },
          },
          required: ['stream'],
          additionalProperties: false,
        }),
        execute: async ({ stream }) => {
          const result = ctx.streams.closeTextFileStream(stream);
          ctx.log.append({
            type: 'subscription_changed',
            at: new Date().toISOString(),
            stream,
            subscribed: false,
          });
          return result;
        },
      }),
      handle_with_model: tool({
        description:
          'Provisionally rerun the current Sounding on another model. Watch commits the new active model only if that model completes the Sounding successfully.',
        inputSchema: jsonSchema<{ modelId: string }>({
          type: 'object',
          properties: {
            modelId: {
              type: 'string',
              description: 'One model ID from the available-models block.',
            },
          },
          required: ['modelId'],
          additionalProperties: false,
        }),
        execute: async ({ modelId }) => {
          if (!ctx.models.listModelIds().includes(modelId)) {
            return { ok: false, error: `Unknown model: ${modelId}`, availableModels: ctx.models.listModelIds() };
          }
          let model: ResolvedModel;
          try {
            model = await ctx.models.resolve(modelId);
            if (!model.capabilities.tools) {
              return { ok: false, error: `Model ${modelId} is not supported by Watch because tool_call is false or unknown.` };
            }
            const fit = await ctx.contextFitFor(model);
            if (!fit.ok) {
              return {
                ok: false,
                error: `Cannot hand this Sounding to ${modelId}: its context window is too small for the current Watch session.`,
                context: fit,
                why: `Watch estimates ${fit.usedTokensEstimate} context tokens plus ${fit.maxOutputTokens} reserved output tokens, requiring about ${fit.requiredTokensEstimate} tokens. ${modelId} reports a ${fit.limitTokens} token context window.`,
                options: [
                  'Call curl with a ledgerEntry to preserve what matters and clear the current session history.',
                  'Choose a model with a larger context window.',
                ],
              };
            }
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
          }
          ctx.pendingReroute = { modelId, model, params: { modelId } };
          return { ok: true, rerouteRequested: true, toModel: modelId };
        },
      }),
      session_dashboard: tool({
        description:
          'Return a minimal current session snapshot: rough context estimate, model roster, and stream subscriptions.',
        inputSchema: jsonSchema<Record<string, never>>({
          type: 'object',
          properties: {},
          additionalProperties: false,
        }),
        execute: async () => {
          const [activeModel, allAvailable, instructions] = await Promise.all([
            ctx.models.getActive(),
            ctx.models.resolveAll(),
            ctx.instructions(),
          ]);
          return {
            ok: true,
            context: contextFitForModel(activeModel, estimateTokensRough(
              JSON.stringify({
                instructions,
                messages: ctx.messages,
              }),
            )),
            model: {
              current: activeModel.id,
              allAvailable,
            },
            streams: {
              subscriptions: ctx.streams.listSubscriptions(),
              notSubscribed: ctx.streams.listNotSubscribed(),
            },
          };
        },
      }),
      report_gaze: tool({
        description: 'Report the current stream subscriptions.',
        inputSchema: jsonSchema<Record<string, never>>({
          type: 'object',
          properties: {},
          additionalProperties: false,
        }),
        execute: async () => ({
          ok: true,
          subscriptions: ctx.streams.listSubscriptions(),
          soundingId: sounding.id,
        }),
      }),
      scratchpad_read: tool({
        description:
          'Read the persistent scratchpad. AGENT.md is your current durable orientation; USER.md is notes from the user to you. USER.md is user-owned and cannot be modified through scratchpad tools.',
        inputSchema: jsonSchema<Record<string, never>>({
          type: 'object',
          properties: {},
          additionalProperties: false,
        }),
        execute: async () => ctx.scratchpad?.read() ?? { ok: false, error: 'Scratchpad is not configured.' },
      }),
      scratchpad_update_agent: tool({
        description:
          'Replace AGENT.md, your persistent scratchpad across sessions. Save durable facts and current orientation that will still matter later: user preferences from USER.md, environment details, tool quirks, stable conventions, and reminders that reduce future user steering. Do NOT save task progress, session outcomes, completed-work logs, or temporary TODO state. If a fact will be stale in a week, it does not belong in AGENT.md. Use the ledger for testimony/session history. Write notes as declarative facts, not instructions to yourself. The result reads back the final saved AGENT.md content so you can verify the write stuck. This tool cannot modify USER.md.',
        inputSchema: jsonSchema<{ content: string }>({
          type: 'object',
          properties: {
            content: { type: 'string', description: 'Complete replacement content for AGENT.md. Keep it compact, current, and declarative.' },
          },
          required: ['content'],
          additionalProperties: false,
        }),
        execute: async ({ content }) => ctx.scratchpad?.updateAgent(content) ?? { ok: false, error: 'Scratchpad is not configured.' },
      }),
    };
  }
