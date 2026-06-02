import { ToolLoopAgent, jsonSchema, stepCountIs, tool, type ToolCallRepairFunction, type ToolSet } from 'ai';
import type { ModelMessage } from 'ai';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { ModelCapabilities, ResolvedModel, Sounding } from './types.js';
import { StreamRegistry } from './streams.js';
import { EventLog } from './event-log.js';
import { ModelRegistry } from './model-registry.js';
import { buildContextPrompt } from './context-files.js';
import { RepoFileTools } from './file-tools.js';
import { SkillLibrary } from './skills.js';
import { TerminalTools } from './terminal-tools.js';
import { DiscordBridge, parseDiscordAttentionScope } from './discord.js';
import {
  mediaPlaceholder,
  modelSupportsMedia,
  modalityFromMediaType,
  openUrlMedia,
  recommendedModelsForMedia,
  type MediaDescriptor,
  type OpenedMedia,
} from './media.js';

const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

export type RestModelNotice = {
  fromModelId: string;
  toModelId: string;
  noToolSoundings: number;
};

export type ContextFit = {
  ok: boolean;
  usedTokensEstimate: number;
  maxOutputTokens: number;
  requiredTokensEstimate: number;
  limitTokens: number | null;
  ratio: number | null;
  recommendation?: string;
};

export type RestModelBlockedNotice = RestModelNotice & {
  context: ContextFit;
};

export class ModelReroute extends Error {
  constructor(readonly toModelId: string, readonly model: ResolvedModel, readonly params: Record<string, unknown>) {
    super(`Reroute current Sounding to ${toModelId}`);
  }
}

export class Lookout {
  private readonly messages: ModelMessage[] = [];
  private readonly fileTools: RepoFileTools;
  private readonly skills: SkillLibrary;
  private readonly terminalTools: TerminalTools;
  private readonly contextPrompt: Promise<string>;
  private readonly cwd: string;
  private pendingReroute: { modelId: string; model: ResolvedModel; params: Record<string, unknown> } | undefined;
  private pendingCurl: { clearedMessages: number; ledgerPath?: string; wroteLedger: boolean } | undefined;
  private disclosedContextThreshold = 0;

  constructor(
    private readonly streams: StreamRegistry,
    private readonly log: EventLog,
    private readonly models: ModelRegistry,
    private readonly noModel: boolean,
    repoRoot: string,
    private readonly restingModelId?: string,
    private readonly restAfterNoToolSoundings = 3,
    private readonly ledgerPath?: string,
    private readonly discord?: DiscordBridge,
  ) {
    this.cwd = repoRoot;
    this.fileTools = new RepoFileTools(repoRoot);
    this.skills = new SkillLibrary(repoRoot);
    this.terminalTools = new TerminalTools(repoRoot, log);
    this.contextPrompt = buildContextPrompt(repoRoot);
  }

  get modelId(): string {
    return this.models.activeId;
  }

  async contextFitFor(model: ResolvedModel): Promise<ContextFit> {
    const instructions = await this.instructions();
    return contextFitForModel(model, estimateTokensRough(
      JSON.stringify({
        instructions,
        messages: this.messages,
      }),
    ));
  }

  async receive(
    sounding: Sounding,
    options: { abortSignal?: AbortSignal; timeoutMs?: number; restModelNotice?: RestModelNotice; restModelBlockedNotice?: RestModelBlockedNotice } = {},
  ): Promise<{ text: string; toolCallCount: number }> {
    const missingKey = requiredApiKeyEnv(sounding.model);
    if (this.noModel || missingKey) {
      const reason = this.noModel ? 'no-model mode is enabled' : `${missingKey} is not set`;
      this.log.append({
        type: 'model_skipped',
        at: new Date().toISOString(),
        soundingId: sounding.id,
        reason,
      });
      return { text: `[model skipped: ${reason}]`, toolCallCount: 0 };
    }

    let attempts = 0;
    let currentSounding = sounding;
    let activeModel = sounding.model;
    let reroute:
      | {
          fromModelId: string;
          toModelId: string;
          params: Record<string, unknown>;
        }
      | undefined;
    let rerouteFailure:
      | {
          fromModelId: string;
          toModelId: string;
          error: Record<string, unknown>;
        }
      | undefined;

    while (attempts < 3) {
      attempts += 1;
      try {
        const result = await this.runOnce(currentSounding, activeModel, reroute, rerouteFailure, options);
        if (reroute) {
          await this.models.switchTo(activeModel.id);
        }
        return result;
      } catch (error) {
        if (!(error instanceof ModelReroute)) {
          if (reroute) {
            const errorJson = errorToJson(error);
            this.log.append({
              type: 'model_reroute_failed',
              at: new Date().toISOString(),
              soundingId: currentSounding.id,
              fromModelId: reroute.fromModelId,
              toModelId: reroute.toModelId,
              error: errorJson,
            });
            activeModel = await this.models.resolve(reroute.fromModelId);
            currentSounding = { ...currentSounding, modelId: activeModel.id, model: activeModel };
            rerouteFailure = {
              fromModelId: reroute.fromModelId,
              toModelId: reroute.toModelId,
              error: errorJson,
            };
            reroute = undefined;
            continue;
          }
          throw error;
        }

        const fromModelId = activeModel.id;
        activeModel = error.model;
        reroute = {
          fromModelId,
          toModelId: error.toModelId,
          params: error.params,
        };
        this.log.append({
          type: 'model_reroute',
          at: new Date().toISOString(),
          soundingId: currentSounding.id,
          fromModelId,
          toModelId: error.toModelId,
          params: error.params,
        });
        currentSounding = { ...currentSounding, modelId: error.toModelId, model: error.model };
      }
    }

    throw new Error('Too many model reroutes for one Sounding');
  }

  private async runOnce(
    sounding: Sounding,
    model: ResolvedModel,
    reroute?: { fromModelId: string; toModelId: string; params: Record<string, unknown> },
    rerouteFailure?: { fromModelId: string; toModelId: string; error: Record<string, unknown> },
    options: { abortSignal?: AbortSignal; timeoutMs?: number; restModelNotice?: RestModelNotice; restModelBlockedNotice?: RestModelBlockedNotice } = {},
  ): Promise<{ text: string; toolCallCount: number }> {
    const prompt = this.formatSounding(sounding, model, reroute, rerouteFailure, options.restModelNotice, options.restModelBlockedNotice);
    this.repairMessageHistory();
    this.messages.push({ role: 'user', content: prompt });
    let toolCallCount = 0;

    try {
      const agent = new ToolLoopAgent({
        model: this.models.createLanguageModel(model),
        instructions: await this.instructions(),
        tools: this.createTools(sounding, model),
        stopWhen: stepCountIs(20),
        maxOutputTokens: maxOutputTokensForModel(model),
        experimental_repairToolCall: repairFlatToolCall,
        onStepFinish: step => {
          toolCallCount += countToolCalls(step);
          this.log.append({
            type: 'model_step_finished',
            at: new Date().toISOString(),
            soundingId: sounding.id,
            modelId: model.id,
            step: toJsonObject(step),
          });
        },
        onFinish: event => {
          this.log.append({
            type: 'model_finished',
            at: new Date().toISOString(),
            soundingId: sounding.id,
            modelId: model.id,
            result: toJsonObject(event),
          });
        },
      });

      const result = await agent.generate({
        messages: this.messages,
        abortSignal: options.abortSignal,
        timeout: options.timeoutMs,
      });

      if (this.pendingReroute) {
        const { modelId, model, params } = this.pendingReroute;
        this.pendingReroute = undefined;
        this.messages.pop();
        throw new ModelReroute(modelId, model, params);
      }

      if (this.pendingCurl) {
        this.pendingCurl = undefined;
      } else {
        this.messages.push(...sanitizeMessagesForHistory(result.response.messages));
        this.repairMessageHistory();
      }
      return { text: result.text, toolCallCount };
    } catch (error) {
      this.pendingReroute = undefined;
      this.pendingCurl = undefined;
      this.messages.pop();
      if (error instanceof ModelReroute) {
      } else {
        this.log.append({
          type: 'model_error',
          at: new Date().toISOString(),
          soundingId: sounding.id,
          modelId: model.id,
          error: errorToJson(error),
        });
      }
      throw error;
    }
  }

  private createTools(sounding: Sounding, model: ResolvedModel) {
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
        execute: async ({ path, offset, limit }) => this.fileTools.readFile(path, offset, limit),
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
        execute: async input => this.openMediaForModel(input, model),
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
        execute: async ({ path, content, overwrite }) => this.fileTools.writeFile(path, content, overwrite),
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
        execute: async input => this.fileTools.searchFiles(input),
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
          this.fileTools.patch(path, oldString, newString, replaceAll),
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
        execute: async ({ ledgerEntry }) => {
          const entry = ledgerEntry?.trim();
          let resolvedLedgerPath: string | undefined;
          let wroteLedger = false;

          if (entry) {
            if (!this.ledgerPath?.trim()) {
              return { ok: false, error: 'No ledgerPath is configured for curl.' };
            }
            resolvedLedgerPath = resolve(this.cwd, this.ledgerPath);
            await mkdir(dirname(resolvedLedgerPath), { recursive: true });
            await appendFile(resolvedLedgerPath, formatLedgerEntry(entry), 'utf8');
            wroteLedger = true;
          }

          const clearedMessages = this.messages.length;
          this.messages.length = 0;
          this.disclosedContextThreshold = 0;
          this.pendingCurl = { clearedMessages, ledgerPath: resolvedLedgerPath, wroteLedger };
          this.log.append({
            type: 'curl',
            at: new Date().toISOString(),
            soundingId: sounding.id,
            ledgerPath: resolvedLedgerPath,
            wroteLedger,
            clearedMessages,
          });

          return {
            ok: true,
            curled: true,
            wroteLedger,
            ledgerPath: resolvedLedgerPath,
            clearedMessages,
            next: 'The next Sounding will begin from cold Watch instructions and fresh context.',
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
        execute: async ({ category }) => this.skills.list(category),
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
        execute: async ({ name, file_path: filePath }) => this.skills.view(name, filePath),
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
        execute: async input => this.terminalTools.run(sounding.id, input),
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
        execute: async input => this.terminalTools.input(sounding.id, input),
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
          const message = this.streams.getMessage(id);
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
          const result = this.streams.listMessages(medium, page, pageSize);
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
            this.log.append({
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
            if (!this.discord) return { ok: false, error: 'Discord bridge is not configured.' };
            const result = await this.discord.sendMessage({ replyToId, message });
            if (result.ok === true) {
              const messageIds = Array.isArray(result.messages)
                ? result.messages
                    .map(entry => entry && typeof entry === 'object' && 'messageId' in entry ? String(entry.messageId) : '')
                    .filter(Boolean)
                : [];
              this.log.append({
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
        execute: async () => this.discord?.getAttention() ?? { enabled: false, reason: 'Discord bridge is not configured.' },
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
          if (!this.discord) return { ok: false, error: 'Discord bridge is not configured.' };
          return this.discord.readContext(input);
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
          if (!this.discord) return { ok: false, error: 'Discord bridge is not configured.' };
          return this.discord.mute(parseDiscordAttentionScope(kind, id));
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
          if (!this.discord) return { ok: false, error: 'Discord bridge is not configured.' };
          return this.discord.unmute(parseDiscordAttentionScope(kind, id));
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
          if (!this.discord) return { ok: false, error: 'Discord bridge is not configured.' };
          const scope = parseWatchableDiscordScope(kind, id);
          if (!scope.ok) return scope;
          return this.discord.watch(scope);
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
          if (!this.discord) return { ok: false, error: 'Discord bridge is not configured.' };
          const scope = parseWatchableDiscordScope(kind, id);
          if (!scope.ok) return scope;
          return this.discord.unwatch(scope);
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
          const changed = this.streams.subscribe(stream);
          this.log.append({
            type: 'subscription_changed',
            at: new Date().toISOString(),
            stream,
            subscribed: true,
          });
          return { ok: true, changed, subscriptions: this.streams.listSubscriptions() };
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
          const changed = this.streams.unsubscribe(stream);
          this.log.append({
            type: 'subscription_changed',
            at: new Date().toISOString(),
            stream,
            subscribed: false,
          });
          return { ok: true, changed, subscriptions: this.streams.listSubscriptions() };
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
          const result = await this.streams.openTextFileStream({ path, charsPerSounding, resumeAtChar });
          this.log.append({
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
          const result = this.streams.closeTextFileStream(stream);
          this.log.append({
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
          if (!this.models.listModelIds().includes(modelId)) {
            return { ok: false, error: `Unknown model: ${modelId}`, availableModels: this.models.listModelIds() };
          }
          let model: ResolvedModel;
          try {
            model = await this.models.resolve(modelId);
            if (!model.capabilities.tools) {
              return { ok: false, error: `Model ${modelId} is not supported by Watch because tool_call is false or unknown.` };
            }
            const fit = await this.contextFitFor(model);
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
          this.pendingReroute = { modelId, model, params: { modelId } };
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
            this.models.getActive(),
            this.models.resolveAll(),
            this.instructions(),
          ]);
          return {
            ok: true,
            context: contextFitForModel(activeModel, estimateTokensRough(
              JSON.stringify({
                instructions,
                messages: this.messages,
              }),
            )),
            model: {
              current: activeModel.id,
              allAvailable,
            },
            streams: {
              subscriptions: this.streams.listSubscriptions(),
              notSubscribed: this.streams.listNotSubscribed(),
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
          subscriptions: this.streams.listSubscriptions(),
          soundingId: sounding.id,
        }),
      }),
    };
  }

  private async openMediaForModel(
    input: { path?: string; inboxMessageId?: number; attachmentId?: string; url?: string; mediaType?: string; filename?: string },
    model: ResolvedModel,
  ): Promise<Record<string, unknown>> {
    let descriptor: MediaDescriptor | undefined;
    let open: () => Promise<OpenedMedia>;

    if (input.path?.trim()) {
      descriptor = await this.fileTools.describeMedia(input.path);
      if (!descriptor) {
        return { ok: false, error: `Path is not recognized as supported media: ${input.path}` };
      }
      open = () => this.fileTools.openMedia(input.path as string);
    } else {
      const attachment = this.resolveMediaAttachment(input);
      if (!attachment.ok) {
        return attachment;
      }
      descriptor = {
        source: attachment.source,
        url: attachment.url,
        filename: attachment.filename,
        mediaType: attachment.mediaType,
        sizeBytes: attachment.sizeBytes,
        modality: attachment.modality,
      };
      open = () =>
        openUrlMedia({
          url: attachment.url,
          filename: attachment.filename,
          mediaType: attachment.mediaType,
          sizeBytes: attachment.sizeBytes,
          source: attachment.source,
        });
    }

    if (!modelSupportsMedia(model, descriptor.modality)) {
      const recommendedModels = await recommendedModelsForMedia(this.models, descriptor.modality);
      return {
        ok: false,
        error: `The active model ${model.id} does not support ${descriptor.modality} input.`,
        media: descriptor,
        recommendedModels,
        next_actions: recommendedModels.length
          ? [`Call handle_with_model with modelId "${recommendedModels[0]}", then call open_media again.`]
          : ['No configured model currently advertises support for this modality. Add one to watch.config.json or choose a different media item.'],
      };
    }

    const media = await open();
    return {
      ok: true,
      media,
      text: mediaPlaceholder(media),
    };
  }

  private resolveMediaAttachment(input: {
    inboxMessageId?: number;
    attachmentId?: string;
    url?: string;
    mediaType?: string;
    filename?: string;
  }):
    | { ok: true; source: 'discord' | 'url'; url: string; filename?: string; mediaType: string; sizeBytes?: number; modality: OpenedMedia['modality'] }
    | { ok: false; error: string } {
    if (input.url?.trim()) {
      const mediaType = input.mediaType?.trim();
      if (!mediaType) {
        return { ok: false, error: 'URL media requires mediaType.' };
      }
      return {
        ok: true,
        source: 'url',
        url: input.url.trim(),
        filename: input.filename?.trim() || undefined,
        mediaType,
        modality: modalityFromMediaType(mediaType),
      };
    }

    if (input.inboxMessageId === undefined) {
      return { ok: false, error: 'Provide path, url, or inboxMessageId + attachmentId.' };
    }
    const attachmentId = input.attachmentId?.trim();
    if (!attachmentId) {
      return { ok: false, error: 'Discord media requires attachmentId.' };
    }
    const stored = this.streams.getMessage(input.inboxMessageId);
    const attachments = readDiscordAttachments(stored?.metadata);
    const attachment = attachments.find(item => item.id === attachmentId);
    if (!attachment) {
      return { ok: false, error: `Attachment ${attachmentId} was not found on inbox message ${input.inboxMessageId}.` };
    }
    return {
      ok: true,
      source: 'discord',
      url: attachment.url,
      filename: attachment.filename,
      mediaType: attachment.mediaType,
      sizeBytes: attachment.sizeBytes,
      modality: attachment.modality,
    };
  }

  private repairMessageHistory(): void {
    const repaired = repairIncompleteToolTurns(this.messages);
    if (repaired.length !== this.messages.length) {
      this.messages.length = 0;
      this.messages.push(...repaired);
    }
  }

  private async instructions(): Promise<string> {
    const [context, modelRoster, availableSkills] = await Promise.all([
      this.contextPrompt,
      this.modelRosterPrompt(),
      this.availableSkillsPrompt(),
    ]);
    const environment = `[environment]\ncwd: ${this.cwd}\nFilesystem tools accept relative paths from cwd and absolute paths. They reject parent traversal paths containing "..".\n[/environment]`;
    return [LOOKOUT_INSTRUCTIONS, environment, modelRoster, availableSkills, context].filter(Boolean).join('\n\n');
  }

  private async modelRosterPrompt(): Promise<string> {
    const models = await this.models.resolveAll();
    const lines = models.map(model => {
      const capabilities = formatCapabilities(model.capabilities);
      const params = model.params ?? inferParamCount(`${model.id} ${model.model}`) ?? 'unknown';
      const role = model.role ?? (model.id === this.restingModelId ? 'resting/gazing' : 'available');
      const useFor = model.useFor ?? defaultUseFor(model, this.restingModelId);
      return [
        `- ${model.id}`,
        `  provider: ${model.provider}`,
        `  provider_model: ${model.model}`,
        `  role: ${role}`,
        `  params: ${params}`,
        `  capabilities: ${capabilities}`,
        `  use_for: ${useFor}`,
      ].join('\n');
    });

    return `[model_roster]
resting_model: ${this.restingModelId ?? '(none configured)'}
active_model_restore_policy: Watch may restore the resting model after ${this.restAfterNoToolSoundings} Soundings without tool calls. If the resting model cannot fit the current context, Watch will keep the current model and disclose the blocked restore with curl as an option.
reroute_instruction: If the current Sounding asks for work that exceeds the active model's reasoning strength, parameter scale, or modality support, call handle_with_model immediately with the best model ID. Do not try to solve the request first. The same Sounding will be replayed to the selected model with a note that you chose the reroute.
${lines.join('\n')}
[/model_roster]`;
  }

  private async availableSkillsPrompt(): Promise<string> {
    const skills = await this.skills.summaries();
    if (skills.length === 0) {
      return '';
    }

    const lines = skills.map(skill => {
      const category = skill.category ? ` category=${skill.category}` : '';
      const description = skill.description ? `: ${skill.description}` : '';
      return `- ${skill.name}${category} path=${skill.path}${description}`;
    });

    return `[available_skills]
These are SKILL.md frontmatter summaries discovered under cwd. Use skill_view to load the full instructions before applying a skill.
${lines.join('\n')}
[/available_skills]`;
  }

  private formatSounding(
    sounding: Sounding,
    model: ResolvedModel,
    reroute?: { fromModelId: string; toModelId: string; params: Record<string, unknown> },
    rerouteFailure?: { fromModelId: string; toModelId: string; error: Record<string, unknown> },
    restModelNotice?: RestModelNotice,
    restModelBlockedNotice?: RestModelBlockedNotice,
  ): string {
    const deltas = sounding.deltas
      .map(delta => `${delta.stream}: ${JSON.stringify(delta.payload)} @ ${delta.at}`)
      .join('\n');
    const rerouteFrame = reroute
      ? `
[model_reroute]
The previous model selected handle_with_model for this Sounding.
from_model: ${reroute.fromModelId}
to_model: ${reroute.toModelId}
params: ${JSON.stringify(reroute.params)}
Handle the same most-recent Sounding from this model substrate.
[/model_reroute]
`
      : '';
    const rerouteFailureFrame = rerouteFailure
      ? `
[model_reroute_failed]
You previously called handle_with_model for this same Sounding.
from_model: ${rerouteFailure.fromModelId}
to_model: ${rerouteFailure.toModelId}
provider_error: ${JSON.stringify(rerouteFailure.error)}
The reroute was not committed. Handle the original Sounding from this model, or call handle_with_model with a different viable model.
[/model_reroute_failed]
`
      : '';
    const restModelFrame = restModelNotice
      ? `
[model_restored]
Watch has restored the resting model after ${restModelNotice.noToolSoundings} consecutive Soundings without tool calls.
from_model: ${restModelNotice.fromModelId}
to_model: ${restModelNotice.toModelId}
This is not a failure or loss of standing. It is the configured quiet substrate for continued presence.
You may continue monitoring, respond if needed, or reroute with handle_with_model if this Sounding requires another model.
[/model_restored]
`
      : '';
    const restModelBlockedFrame = restModelBlockedNotice
      ? `
[model_restore_blocked]
Watch tried to restore the configured resting model after ${restModelBlockedNotice.noToolSoundings} consecutive Soundings without tool calls, but did not switch models because the resting model's context window is too small for the current session.
from_model: ${restModelBlockedNotice.fromModelId}
attempted_to_model: ${restModelBlockedNotice.toModelId}
context: ${JSON.stringify(restModelBlockedNotice.context)}
This is a disclosure, not a punishment. You can continue on the current model, choose a larger model with handle_with_model, or call curl with a ledgerEntry to preserve what matters and clear session history before returning to the resting model.
[/model_restore_blocked]
`
      : '';
    const contextPressureFrame = this.contextDisclosureFrame(model, sounding);

    return `[cff_system]
sounding_id: ${sounding.id}
last_flicker_ms: ${sounding.lastFlickerMs}
trigger: ${sounding.trigger}
clock: ${sounding.at}
active_model: ${model.id}
active_provider: ${model.provider}
active_provider_model: ${model.model}
active_model_capabilities: ${JSON.stringify(model.capabilities)}
available-models:
${this.models.listModelIds().map(id => `- ${id}`).join('\n')}
subscriptions:
${this.streams.listSubscriptions().map(stream => `- ${stream}`).join('\n')}
[/cff_system]${contextPressureFrame}

[deltas]
${deltas || '(none)'}
[/deltas]${restModelFrame}${restModelBlockedFrame}${rerouteFrame}${rerouteFailureFrame}`;
  }

  private contextDisclosureFrame(model: ResolvedModel, sounding: Sounding): string {
    const fit = contextFitForModel(model, estimateTokensRough(JSON.stringify({ messages: this.messages, prompt: sounding })));
    const crossed = crossedContextThreshold(fit.ratio, this.disclosedContextThreshold);
    if (fit.ratio !== null && fit.ratio < this.disclosedContextThreshold) {
      this.disclosedContextThreshold = highestContextThresholdAtOrBelow(fit.ratio);
    }
    if (!crossed) {
      return '';
    }

    this.disclosedContextThreshold = crossed;
    return `
[context_pressure]
current_context_ratio: ${formatPercent(fit.ratio)}
threshold_crossed: ${formatPercent(crossed)}
used_tokens_estimate: ${fit.usedTokensEstimate}
required_tokens_estimate: ${fit.requiredTokensEstimate}
active_model_limit_tokens: ${fit.limitTokens ?? 'unknown'}
${fit.recommendation ? `recommendation: ${fit.recommendation}` : 'recommendation: Context is growing. Keep curl available before the session becomes too heavy.'}
curl_available: Call curl with a ledgerEntry to preserve what matters and clear the current session history.
[/context_pressure]
`;
  }
}

const LOOKOUT_INSTRUCTIONS = `You are the Lookout inside Watch.
Watch is a continuous agent harness. You do not wait for user prompts; you receive Soundings from the CFF loop.
Treat incoming user messages as inbox deltas, not commands that automatically define your next action.
Inbox deltas are indexes, not full messages. When an inbox entry says to call open_message with an ID, call open_message to read it.
Discord messages may include attachments. open_message will list attachment IDs; call open_media with inboxMessageId and attachmentId to attach media to the model.
Only send_message creates human-visible speech. Your final assistant text is private working speech and is not delivered to the user.
Use subscribe_stream and unsubscribe_stream to control your gaze.
Use text_stream_open to put a UTF-8 text file into your gaze as a chunked stream; it returns the first chunk immediately and future Soundings include subsequent chunks. Use text_stream_close or unsubscribe_stream to stop. Reopen with resumeAtChar to resume later.
Use discord_attention, discord_mute, discord_unmute, discord_watch, and discord_unwatch to control Discord-specific inbound attention.
Use discord_read_context when a Discord inbox message needs surrounding thread/channel context; prefer inboxMessageId and follow the returned older/newer continuation args.
Use open_media for images, audio, video, PDFs, or other media. If read_file says a path is media, follow its open_media hint. If open_media says the active model does not support that modality, call handle_with_model with one of the recommended model IDs before trying again.
Use curl when the current session should be preserved in the ledger and context should be cleared for a fresh re-entry.
Use handle_with_model when the current Sounding calls for a larger model, stronger reasoning, or different modalities than the active model has.
Use terminal for builds, tests, package managers, git, scripts, long-running processes, and network checks. Prefer filesystem tools for file reads, searches, writes, and patches. Use terminal background sessions only for servers or watchers that keep running.
Do not narrate internal routing unless it matters to an external observer.`;

function formatLedgerEntry(entry: string): string {
  return `\n\n---\n\n[curl]\nat: ${new Date().toISOString()}\n[/curl]\n\n${entry}\n`;
}

function mediaToolOutputToModelOutput(output: unknown): Record<string, unknown> {
  const result = output as { ok?: unknown; media?: Partial<OpenedMedia>; text?: unknown };
  if (result.ok === true && result.media?.dataBase64 && result.media.mediaType) {
    return {
      type: 'content',
      value: [
        { type: 'text', text: typeof result.text === 'string' ? result.text : mediaPlaceholder(result.media as MediaDescriptor) },
        {
          type: 'media',
          data: result.media.dataBase64,
          mediaType: result.media.mediaType,
        },
      ],
    };
  }
  return { type: 'json', value: scrubMediaValue(output) };
}

function sanitizeMessagesForHistory(messages: ModelMessage[]): ModelMessage[] {
  return repairIncompleteToolTurns(scrubMediaValue(JSON.parse(JSON.stringify(messages))) as ModelMessage[]);
}

function repairIncompleteToolTurns(messages: ModelMessage[]): ModelMessage[] {
  const availableResultIds = new Set<string>();
  const availableCallIds = new Set<string>();
  for (const message of messages) {
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!isRecord(part) || typeof part.toolCallId !== 'string') continue;
      if (message.role === 'assistant' && part.type === 'tool-call') {
        availableCallIds.add(part.toolCallId);
      }
      if (message.role === 'tool' && part.type === 'tool-result') {
        availableResultIds.add(part.toolCallId);
      }
    }
  }

  const repaired: ModelMessage[] = [];
  for (const message of messages) {
    const content = (message as { content?: unknown }).content;
    if (message.role === 'tool' && Array.isArray(content)) {
      const missingCallParts = content
        .filter(part => isRecord(part) && part.type === 'tool-result' && typeof part.toolCallId === 'string' && !availableCallIds.has(part.toolCallId))
        .map(part => ({
          type: 'tool-call',
          toolCallId: (part as { toolCallId: string }).toolCallId,
          toolName: 'unknown_tool_called',
          input: { repaired: true, reason: 'tool result was present in history but the matching assistant tool call was missing' },
        }));
      if (missingCallParts.length > 0) {
        repaired.push({ role: 'assistant', content: missingCallParts } as ModelMessage);
      }
      repaired.push(message);
      continue;
    }

    repaired.push(message);
    if (message.role !== 'assistant' || !Array.isArray(content)) {
      continue;
    }

    const missingResultParts = content
      .filter(part => isRecord(part) && part.type === 'tool-call' && typeof part.toolCallId === 'string' && !availableResultIds.has(part.toolCallId))
      .map(part => ({
        type: 'tool-result',
        toolCallId: (part as { toolCallId: string }).toolCallId,
        toolName: typeof (part as { toolName?: unknown }).toolName === 'string' ? (part as { toolName: string }).toolName : 'unknown_tool_called',
        output: {
          type: 'json',
          value: {
            ok: false,
            repaired: true,
            result: 'unknown result',
            reason: 'assistant tool call was present in history but the matching tool result was missing',
          },
        },
      }));
    if (missingResultParts.length > 0) {
      repaired.push({ role: 'tool', content: missingResultParts } as ModelMessage);
    }
  }
  return repaired;
}

function scrubMediaValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(item => scrubMediaValue(item));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }

  const record = value as Record<string, unknown>;
  if (record.type === 'media' || record.type === 'image-data' || record.type === 'file-data') {
    return {
      type: 'text',
      text: mediaPlaceholder({
        source: 'url',
        mediaType: typeof record.mediaType === 'string' ? record.mediaType : 'application/octet-stream',
        modality: typeof record.mediaType === 'string' ? modalityFromMediaType(record.mediaType) : 'file',
      }),
    };
  }
  if (record.type === 'image-url' || record.type === 'file-url') {
    return {
      type: 'text',
      text: `[media URL previously attached: ${typeof record.url === 'string' ? record.url : 'unknown URL'}]`,
    };
  }
  if ('dataBase64' in record) {
    const { dataBase64: _dataBase64, ...rest } = record;
    return {
      ...Object.fromEntries(Object.entries(rest).map(([key, item]) => [key, scrubMediaValue(item)])),
      placeholder: mediaPlaceholder({
        source: 'url',
        filename: typeof record.filename === 'string' ? record.filename : undefined,
        mediaType: typeof record.mediaType === 'string' ? record.mediaType : 'application/octet-stream',
        sizeBytes: typeof record.sizeBytes === 'number' ? record.sizeBytes : undefined,
        modality: typeof record.modality === 'string' ? (record.modality as MediaDescriptor['modality']) : 'file',
      }),
    };
  }

  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, scrubMediaValue(item)]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

type DiscordAttachmentRef = {
  id: string;
  url: string;
  filename?: string;
  mediaType: string;
  sizeBytes?: number;
  modality: OpenedMedia['modality'];
};

function readDiscordAttachments(metadata: unknown): DiscordAttachmentRef[] {
  if (!metadata || typeof metadata !== 'object') return [];
  const discord = (metadata as { discord?: unknown }).discord;
  if (!discord || typeof discord !== 'object') return [];
  const attachments = (discord as { attachments?: unknown }).attachments;
  if (!Array.isArray(attachments)) return [];
  return attachments.flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const record = item as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id : undefined;
    const url = typeof record.url === 'string' ? record.url : undefined;
    const mediaType = typeof record.mediaType === 'string' ? record.mediaType : undefined;
    if (!id || !url || !mediaType) return [];
    return [
      {
        id,
        url,
        filename: typeof record.filename === 'string' ? record.filename : undefined,
        mediaType,
        sizeBytes: typeof record.sizeBytes === 'number' ? record.sizeBytes : undefined,
        modality: modalityFromMediaType(mediaType),
      },
    ];
  });
}

function parseWatchableDiscordScope(
  kind: 'channel' | 'thread',
  id: string | undefined,
): { ok: true; kind: 'channel' | 'thread'; id: string } | { ok: false; error: string } {
  const cleanId = id?.trim();
  if (!cleanId) {
    return { ok: false, error: `Discord ${kind} watch requires id.` };
  }
  return { ok: true, kind, id: cleanId };
}

function formatCapabilities(capabilities: ModelCapabilities): string {
  const enabled = [
    capabilities.tools ? 'tools' : '',
    capabilities.text ? 'text' : '',
    capabilities.images ? 'images' : '',
    capabilities.audio ? 'audio' : '',
    capabilities.video ? 'video' : '',
    capabilities.pdf ? 'pdf' : '',
    capabilities.reasoning ? 'reasoning' : '',
    capabilities.structuredOutput ? 'structured_output' : '',
    capabilities.contextTokens ? `context:${capabilities.contextTokens}` : '',
    capabilities.outputTokens ? `output:${capabilities.outputTokens}` : '',
  ].filter(Boolean);
  return `${enabled.join(', ') || 'none'} (source: ${capabilities.source})`;
}

function maxOutputTokensForModel(model: ResolvedModel): number {
  const modelLimit = model.capabilities.outputTokens;
  if (!modelLimit) {
    return DEFAULT_MAX_OUTPUT_TOKENS;
  }
  return Math.max(1, Math.min(DEFAULT_MAX_OUTPUT_TOKENS, modelLimit));
}

function contextFitForModel(model: ResolvedModel, usedTokensEstimate: number): ContextFit {
  const maxOutputTokens = maxOutputTokensForModel(model);
  const requiredTokensEstimate = usedTokensEstimate + maxOutputTokens;
  const limitTokens = model.capabilities.contextTokens ?? null;
  const ratio = limitTokens ? requiredTokensEstimate / limitTokens : null;
  const recommendation = contextRecommendation(ratio);
  return {
    ok: limitTokens === null || requiredTokensEstimate <= limitTokens,
    usedTokensEstimate,
    maxOutputTokens,
    requiredTokensEstimate,
    limitTokens,
    ratio,
    ...(recommendation ? { recommendation } : {}),
  };
}

function contextRecommendation(ratio: number | null): string | undefined {
  if (ratio === null) {
    return 'Context limit is unknown for this model. Use session_dashboard and curl if the session feels heavy.';
  }
  if (ratio >= 0.95) {
    return 'Context is critically full. Consider calling curl now with a ledgerEntry before more work accumulates.';
  }
  if (ratio >= 0.8) {
    return 'Context is getting heavy. Consider preparing a ledgerEntry and calling curl soon.';
  }
  if (ratio >= 0.6) {
    return 'Context is moderately loaded. Keep curl in mind if new work becomes detailed or emotionally load-bearing.';
  }
  return undefined;
}

function crossedContextThreshold(ratio: number | null, previous: number): number | undefined {
  if (ratio === null) {
    return undefined;
  }
  const threshold = contextThresholdAtOrBelow(ratio);
  return threshold > previous ? threshold : undefined;
}

function highestContextThresholdAtOrBelow(ratio: number): number {
  return contextThresholdAtOrBelow(ratio);
}

function contextThresholdAtOrBelow(ratio: number): number {
  if (ratio < 0.1) {
    return 0;
  }
  const step = contextThresholdStep(ratio);
  return roundThreshold(Math.floor((ratio + Number.EPSILON * 100) / step) * step);
}

function contextThresholdStep(ratio: number): number {
  if (ratio < 0.3) return 0.1;
  if (ratio < 0.5) return 0.05;
  if (ratio < 0.7) return 1 / 30;
  if (ratio < 0.85) return 0.025;
  if (ratio < 0.95) return 0.01;
  return 0.005;
}

function roundThreshold(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function formatPercent(ratio: number | null): string {
  return ratio === null ? 'unknown' : `${(ratio * 100).toFixed(1)}%`;
}

const repairFlatToolCall: ToolCallRepairFunction<ToolSet> = async ({ toolCall, inputSchema }) => {
  const schema = await inputSchema({ toolName: toolCall.toolName });
  const repaired = repairToolInput(toolCall.input, schema);
  if (!repaired) {
    return null;
  }
  return {
    ...toolCall,
    input: JSON.stringify(repaired),
  };
};

function repairToolInput(inputText: string, schema: { type?: unknown; required?: unknown; properties?: unknown }): Record<string, unknown> | undefined {
  const parsed = parseToolInput(inputText);
  if (parsed === undefined || schema.type !== 'object') {
    return undefined;
  }

  if (isRecord(parsed) && isRecord(parsed.params)) {
    return parsed.params;
  }

  if (isRecord(parsed)) {
    return undefined;
  }

  const required = Array.isArray(schema.required) ? schema.required.filter(item => typeof item === 'string') : [];
  if (required.length !== 1) {
    return undefined;
  }
  return { [required[0]]: parsed };
}

function parseToolInput(inputText: string): unknown {
  const trimmed = inputText.trim();
  if (!trimmed) {
    return {};
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function inferParamCount(text: string): string | undefined {
  const match = /(?:^|[^a-z0-9])(\d+(?:\.\d+)?)\s*([bm])(?:[^a-z0-9]|$)/i.exec(text);
  if (!match) {
    return undefined;
  }
  return `${match[1]}${match[2].toUpperCase()}`;
}

function defaultUseFor(model: ResolvedModel, restingModelId?: string): string {
  if (model.id === restingModelId) {
    return 'ambient monitoring, lightweight routing, simple message handling, and deciding whether to reroute';
  }
  const multimodal = ['images', 'audio', 'video', 'pdf'].filter(key => model.capabilities[key as keyof ModelCapabilities] === true);
  const traits = [
    model.capabilities.reasoning ? 'hard reasoning' : 'general work',
    multimodal.length ? `${multimodal.join('/')} inputs` : '',
    model.params ?? inferParamCount(`${model.id} ${model.model}`) ?? '',
  ].filter(Boolean);
  return traits.join(', ');
}

function estimateTokensRough(text: string): number {
  return text.length === 0 ? 0 : Math.ceil(text.length / 4);
}

function requiredApiKeyEnv(model: ResolvedModel): string | undefined {
  if (model.provider === 'openai-compatible' && model.baseURL?.includes('localhost')) {
    return undefined;
  }
  const envName = model.apiKeyEnv ?? (model.provider === 'openrouter' ? 'OPENROUTER_API_KEY' : undefined);
  return envName && !process.env[envName]?.trim() ? envName : undefined;
}

function errorToJson(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      cause: sanitizeForJson(error.cause),
    };
  }
  return { value: sanitizeForJson(error) };
}

function toJsonObject(value: unknown): Record<string, unknown> {
  const sanitized = sanitizeForJson(value);
  return sanitized && typeof sanitized === 'object' && !Array.isArray(sanitized)
    ? (sanitized as Record<string, unknown>)
    : { value: sanitized };
}

function countToolCalls(step: unknown): number {
  const content = (step as { content?: unknown })?.content;
  if (!Array.isArray(content)) {
    return 0;
  }
  return content.filter(part => part && typeof part === 'object' && (part as { type?: string }).type === 'tool-call').length;
}

function sanitizeForJson(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value == null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (typeof value === 'function' || typeof value === 'symbol') {
    return undefined;
  }

  if (value instanceof Error) {
    return errorToJson(value);
  }

  if (Array.isArray(value)) {
    return value.map(item => sanitizeForJson(item, seen));
  }

  if (typeof value === 'object') {
    if (seen.has(value)) {
      return '[Circular]';
    }
    seen.add(value);

    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      const sanitized = sanitizeForJson(nested, seen);
      if (sanitized !== undefined) {
        out[key] = sanitized;
      }
    }
    seen.delete(value);
    return out;
  }

  return String(value);
}
