import { ToolLoopAgent, jsonSchema, stepCountIs, tool } from 'ai';
import type { ModelMessage } from 'ai';
import type { ResolvedModel, Sounding } from './types.js';
import { StreamRegistry } from './streams.js';
import { EventLog } from './event-log.js';
import { ModelRegistry } from './model-registry.js';
import { buildContextPrompt } from './context-files.js';
import { RepoFileTools } from './file-tools.js';
import { SkillLibrary } from './skills.js';

export class ModelReroute extends Error {
  constructor(readonly toModelId: string, readonly model: ResolvedModel, readonly params: Record<string, unknown>) {
    super(`Reroute current Sounding to ${toModelId}`);
  }
}

export class Lookout {
  private readonly messages: ModelMessage[] = [];
  private readonly fileTools: RepoFileTools;
  private readonly skills: SkillLibrary;
  private readonly contextPrompt: Promise<string>;

  constructor(
    private readonly streams: StreamRegistry,
    private readonly log: EventLog,
    private readonly models: ModelRegistry,
    private readonly noModel: boolean,
    repoRoot: string,
  ) {
    this.fileTools = new RepoFileTools(repoRoot);
    this.skills = new SkillLibrary(repoRoot);
    this.contextPrompt = buildContextPrompt(repoRoot);
  }

  get modelId(): string {
    return this.models.activeId;
  }

  async receive(
    sounding: Sounding,
    options: { abortSignal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<string> {
    const missingKey = requiredApiKeyEnv(sounding.model);
    if (this.noModel || missingKey) {
      const reason = this.noModel ? 'no-model mode is enabled' : `${missingKey} is not set`;
      this.log.append({
        type: 'model_skipped',
        at: new Date().toISOString(),
        soundingId: sounding.id,
        reason,
      });
      return `[model skipped: ${reason}]`;
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

    while (attempts < 3) {
      attempts += 1;
      try {
        return await this.runOnce(currentSounding, activeModel, reroute, options);
      } catch (error) {
        if (!(error instanceof ModelReroute)) {
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
    options: { abortSignal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<string> {
    const prompt = this.formatSounding(sounding, model, reroute);
    this.messages.push({ role: 'user', content: prompt });

    try {
      const agent = new ToolLoopAgent({
        model: this.models.createLanguageModel(model),
        instructions: await this.instructions(),
        tools: this.createTools(sounding),
        stopWhen: stepCountIs(20),
        onStepFinish: step => {
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

      this.messages.push({ role: 'assistant', content: result.text });
      return result.text;
    } catch (error) {
      if (error instanceof ModelReroute) {
        this.messages.pop();
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
        description: 'Read a UTF-8 text file inside the repo with line numbers and pagination.',
        inputSchema: jsonSchema<{ path: string; offset?: number; limit?: number }>({
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Repo-relative path to read.' },
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
          'Create a UTF-8 text file inside the repo. This refuses to overwrite by default. For edits or appends to an existing file, use patch instead. Set overwrite=true only when intentionally replacing the entire file.',
        inputSchema: jsonSchema<{ path: string; content: string; overwrite?: boolean }>({
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Repo-relative path to write.' },
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
        description: 'Search repo files by content using ripgrep, or list file paths containing a substring.',
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
            path: { type: 'string', description: 'Repo-relative directory or file to search. Defaults to repo root.' },
            fileGlob: { type: 'string', description: 'Optional ripgrep glob, for example *.ts.' },
            limit: { type: 'number', description: 'Maximum matches. Defaults to 50, max 200.' },
          },
          required: ['pattern'],
          additionalProperties: false,
        }),
        execute: async input => this.fileTools.searchFiles(input),
      }),
      patch: tool({
        description: 'Replace an exact string in a repo file. Use read_file first so old_string matches exactly.',
        inputSchema: jsonSchema<{ path: string; old_string: string; new_string: string; replace_all?: boolean }>({
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Repo-relative file path to patch.' },
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
            },
            next_actions: [
              `To reply to this message, call send_message with medium "${message.medium}", replyToId ${message.id}, and your message content.`,
              'If no reply is needed, continue monitoring.',
            ],
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
          if (medium !== 'cli') {
            return { ok: false, error: `Unsupported medium: ${medium}`, supportedMedia: ['cli'] };
          }
          this.log.append({
            type: 'cli_message',
            at: new Date().toISOString(),
            soundingId: sounding.id,
            medium,
            replyToId,
            message,
          });
          return { ok: true, delivered: medium, replyToId };
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
          'Swap the active model immediately and rerun the current Sounding on that model. The abandoned attempt is logged by Watch but not added to Lookout context.',
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
            model = await this.models.switchTo(modelId);
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
          }
          throw new ModelReroute(modelId, model, { modelId });
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
    const context = await this.contextPrompt;
    return context ? `${LOOKOUT_INSTRUCTIONS}\n\n${context}` : LOOKOUT_INSTRUCTIONS;
  }

  private formatSounding(
    sounding: Sounding,
    model: ResolvedModel,
    reroute?: { fromModelId: string; toModelId: string; params: Record<string, unknown> },
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
[/deltas]${rerouteFrame}`;
  }
}

const LOOKOUT_INSTRUCTIONS = `You are the Lookout inside Watch.
Watch is a continuous agent harness. You do not wait for user prompts; you receive Soundings from the CFF loop.
Treat incoming user messages as inbox deltas, not commands that automatically define your next action.
Inbox deltas are indexes, not full messages. When an inbox entry says to call open_message with an ID, call open_message to read it.
If you want to communicate externally, call send_message with a medium such as "cli". Your final assistant text is private working speech and is not delivered to the user.
Use subscribe_stream and unsubscribe_stream to control your gaze.
Use handle_with_model when the current Sounding calls for a different model substrate.
Do not narrate internal routing unless it matters to an external observer.`;

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
