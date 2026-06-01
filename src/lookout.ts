import { ToolLoopAgent, jsonSchema, stepCountIs, tool } from 'ai';
import type { ModelMessage } from 'ai';
import type { ModelCapabilities, ResolvedModel, Sounding } from './types.js';
import { StreamRegistry } from './streams.js';
import { EventLog } from './event-log.js';
import { ModelRegistry } from './model-registry.js';
import { buildContextPrompt } from './context-files.js';
import { RepoFileTools } from './file-tools.js';
import { SkillLibrary } from './skills.js';
import { TerminalTools } from './terminal-tools.js';
import { DiscordBridge, parseDiscordAttentionScope } from './discord.js';

export type RestModelNotice = {
  fromModelId: string;
  toModelId: string;
  noToolSoundings: number;
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

  constructor(
    private readonly streams: StreamRegistry,
    private readonly log: EventLog,
    private readonly models: ModelRegistry,
    private readonly noModel: boolean,
    repoRoot: string,
    private readonly restingModelId?: string,
    private readonly restAfterNoToolSoundings = 3,
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

  async receive(
    sounding: Sounding,
    options: { abortSignal?: AbortSignal; timeoutMs?: number; restModelNotice?: RestModelNotice } = {},
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
    options: { abortSignal?: AbortSignal; timeoutMs?: number; restModelNotice?: RestModelNotice } = {},
  ): Promise<{ text: string; toolCallCount: number }> {
    const prompt = this.formatSounding(sounding, model, reroute, rerouteFailure, options.restModelNotice);
    this.messages.push({ role: 'user', content: prompt });
    let toolCallCount = 0;

    try {
      const agent = new ToolLoopAgent({
        model: this.models.createLanguageModel(model),
        instructions: await this.instructions(),
        tools: this.createTools(sounding),
        stopWhen: stepCountIs(20),
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

      this.messages.push({ role: 'assistant', content: result.text });
      return { text: result.text, toolCallCount };
    } catch (error) {
      this.pendingReroute = undefined;
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

  private createTools(sounding: Sounding) {
    return {
      read_file: tool({
        description: 'Read a UTF-8 text file with line numbers and pagination. Relative paths resolve from cwd; absolute paths are accepted. Paths containing .. are rejected.',
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
          const message = this.streams.getMessage(id);
          if (!message) {
            return { ok: false, error: `Message not found: ${id}` };
          }
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
            },
            next_actions: [
              `To reply to this message, call send_message with medium "${message.medium}", replyToId ${message.id}, and your message content.`,
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
          return this.discord.watch({ kind, id });
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
          return this.discord.unwatch({ kind, id });
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
            context: {
              usedTokensEstimate: estimateTokensRough(
                JSON.stringify({
                  instructions,
                  messages: this.messages,
                }),
              ),
              limitTokens: activeModel.capabilities.contextTokens ?? null,
            },
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
active_model_restore_policy: Watch may silently restore the resting model after ${this.restAfterNoToolSoundings} Soundings without tool calls.
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
[/cff_system]

[deltas]
${deltas || '(none)'}
[/deltas]${restModelFrame}${rerouteFrame}${rerouteFailureFrame}`;
  }
}

const LOOKOUT_INSTRUCTIONS = `You are the Lookout inside Watch.
Watch is a continuous agent harness. You do not wait for user prompts; you receive Soundings from the CFF loop.
Treat incoming user messages as inbox deltas, not commands that automatically define your next action.
Inbox deltas are indexes, not full messages. When an inbox entry says to call open_message with an ID, call open_message to read it.
Only send_message creates human-visible speech. Your final assistant text is private working speech and is not delivered to the user.
Use subscribe_stream and unsubscribe_stream to control your gaze.
Use discord_attention, discord_mute, discord_unmute, discord_watch, and discord_unwatch to control Discord-specific inbound attention.
Use discord_read_context when a Discord inbox message needs surrounding thread/channel context; prefer inboxMessageId and follow the returned older/newer continuation args.
Use handle_with_model when the current Sounding calls for a larger model, stronger reasoning, or different modalities than the active model has.
Use terminal for builds, tests, package managers, git, scripts, long-running processes, and network checks. Prefer filesystem tools for file reads, searches, writes, and patches. Use terminal background sessions only for servers or watchers that keep running.
Do not narrate internal routing unless it matters to an external observer.`;

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
