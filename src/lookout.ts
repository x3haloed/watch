import { ToolLoopAgent, stepCountIs } from 'ai';
import type { ModelMessage } from 'ai';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { ResolvedModel, Sounding } from './types.js';
import { StreamRegistry } from './streams.js';
import { EventLog } from './event-log.js';
import { ModelRegistry } from './model-registry.js';
import { buildContextPrompt } from './context-files.js';
import { RepoFileTools } from './file-tools.js';
import { SkillLibrary } from './skills.js';
import { TerminalTools } from './terminal-tools.js';
import { DiscordBridge } from './discord.js';
import { Scratchpad } from './scratchpad.js';
import {
  mediaPlaceholder,
  mediaTypeFromFilename,
  modelSupportsMedia,
  modalityFromMediaType,
  openUrlMedia,
  recommendedModelsForMedia,
  type MediaDescriptor,
  type OpenedMedia,
} from './media.js';
import {
  contextFitForModel,
  countToolCalls,
  crossedContextThreshold,
  defaultUseFor,
  errorToJson,
  estimateTokensRough,
  formatCapabilities,
  formatLedgerEntry,
  formatPercent,
  highestContextThresholdAtOrBelow,
  inferParamCount,
  isTimeoutLikeError,
  maxOutputTokensForModel,
  messagesForModel,
  prepareSoundingDeltas,
  promptMediaSupportForModel,
  readDiscordAttachments,
  repairIncompleteToolTurns,
  repairFlatToolCall,
  requiredApiKeyEnv,
  sanitizeMessagesForHistory,
  type SoundingMediaPart,
  timeoutTraceMessage,
  toJsonObject,
  validEstimatedTokenWarningThreshold,
} from './lookout-helpers.js';
import { LOOKOUT_INSTRUCTIONS } from './lookout-instructions.js';
import { createLookoutTools } from './lookout-tools.js';


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

export type RebootRequest = {
  ledgerPath?: string;
  wroteLedger: boolean;
  clearedMessages: number;
  source: 'tool' | 'control';
};

type CurlResult = {
  ok: true;
  curled: true;
  wroteLedger: boolean;
  ledgerPath?: string;
  clearedMessages: number;
  next: string;
} | {
  ok: false;
  error: string;
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
  private pendingReboot: RebootRequest | undefined;
  private disclosedContextThreshold = 0;
  private disclosedEstimatedTokenWarning = false;

  constructor(
    private readonly streams: StreamRegistry,
    private readonly log: EventLog,
    private readonly models: ModelRegistry,
    private readonly noModel: boolean,
    repoRoot: string,
    private readonly restingModelId?: string,
    private readonly restAfterNoToolSoundings = 3,
    private readonly ledgerPath?: string,
    private readonly estimatedTokenWarningThreshold = 120_000,
    private readonly discord?: DiscordBridge,
    private readonly scratchpad?: Scratchpad,
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

  async curlFromSystem(soundingId: string, ledgerEntry?: string): Promise<CurlResult> {
    return this.curlSession(soundingId, ledgerEntry);
  }

  stopTerminalSessions(reason: string): number {
    return this.terminalTools.killAll('runtime:stop', reason);
  }

  consumeRebootRequest(): RebootRequest | undefined {
    const request = this.pendingReboot;
    this.pendingReboot = undefined;
    return request;
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
    const { text: promptText, mediaParts } = this.formatSounding(sounding, model, reroute, rerouteFailure, options.restModelNotice, options.restModelBlockedNotice);
    this.repairMessageHistory();
    // Build content as array when camera media is present, string otherwise
    const content = mediaParts.length > 0
      ? [{ type: 'text' as const, text: promptText }, ...mediaParts.map(m => ({ type: 'image' as const, image: m.image, mediaType: m.mediaType }))]
      : promptText;
    this.messages.push({ role: 'user', content });
    let toolCallCount = 0;
    const checkpointMessages: ModelMessage[] = [];

    try {
      const agent = new ToolLoopAgent({
        model: this.models.createLanguageModel(model),
        instructions: await this.instructions(),
        tools: this.createTools(sounding, model),
        stopWhen: stepCountIs(20),
        maxOutputTokens: maxOutputTokensForModel(model),
        experimental_repairToolCall: repairFlatToolCall,
        prepareStep: ({ messages }) => ({
          messages: messagesForModel(model, messages),
        }),
        onStepFinish: step => {
          toolCallCount += countToolCalls(step);
          checkpointMessages.push(...sanitizeMessagesForHistory(step.response.messages as ModelMessage[]));
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
        messages: messagesForModel(model, this.messages),
        abortSignal: options.abortSignal,
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
      if (error instanceof ModelReroute) {
        this.messages.pop();
      } else {
        if (isTimeoutLikeError(error) || options.abortSignal?.aborted) {
          this.messages.push(...checkpointMessages);
          this.messages.push(timeoutTraceMessage(sounding, checkpointMessages.length, toolCallCount));
          this.repairMessageHistory();
          this.log.append({
            type: 'model_timeout_checkpoint',
            at: new Date().toISOString(),
            soundingId: sounding.id,
            modelId: model.id,
            checkpointMessages: checkpointMessages.length,
            toolCallCount,
          });
        } else {
          this.messages.pop();
        }
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
    return createLookoutTools(this, sounding, model);
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

    const providerSupport = promptMediaSupportForModel(model, descriptor.mediaType);
    if (!providerSupport.ok) {
      return {
        ok: false,
        error: providerSupport.reason,
        media: descriptor,
        next_actions: ['Use a different media format, or configure a provider adapter that can serialize this media type.'],
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
      const mediaType = input.mediaType?.trim() || mediaTypeFromFilename(input.filename ?? input.url);
      if (!mediaType) return { ok: false, error: 'URL media requires mediaType or a recognized media filename/URL extension.' };
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
    return [LOOKOUT_INSTRUCTIONS, this.scratchpadGuidance(), environment, modelRoster, availableSkills, context, this.scratchpad?.agentPrompt()].filter(Boolean).join('\n\n');
  }

  private scratchpadGuidance(): string {
    if (!this.scratchpad) {
      return '';
    }
    return [
      'You have a persistent scratchpad across sessions. Save durable facts using scratchpad_update_agent: user preferences from USER.md, environment details, tool quirks, stable conventions, and current orientation that will still matter later.',
      'Prioritize what reduces future user steering — the most valuable scratchpad note prevents the user from having to correct or remind you again. User preferences and recurring corrections matter more than procedural task details.',
      'Do NOT save task progress, session outcomes, completed-work logs, or temporary TODO state to AGENT.md. If a fact will be stale in a week, it does not belong there. Use the ledger for testimony/session history.',
      'Write scratchpad notes as declarative facts, not instructions to yourself. "User prefers concise responses" is good. "Always respond concisely" is not. Imperative phrasing gets re-read as a directive in later sessions.',
      'USER.md is user-owned. Treat user-notes deltas as notes from the user to you; use scratchpad_read to inspect both files, but update only AGENT.md through the scratchpad tool.',
    ].join('\n');
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
  ): { text: string; mediaParts: SoundingMediaPart[] } {
    const preparedDeltas = prepareSoundingDeltas(sounding, model);
    const deltas = preparedDeltas.textLines.join('\n');
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
    const estimatedTokenWarningFrame = this.estimatedTokenWarningFrame(model, sounding);

    const text = `[cff_system]
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
[/cff_system]${estimatedTokenWarningFrame}${contextPressureFrame}

[deltas]
${deltas || '(none)'}
[/deltas]${restModelFrame}${restModelBlockedFrame}${rerouteFrame}${rerouteFailureFrame}`;

    return { text, mediaParts: preparedDeltas.mediaParts };
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

  private estimatedTokenWarningFrame(model: ResolvedModel, sounding: Sounding): string {
    const threshold = validEstimatedTokenWarningThreshold(this.estimatedTokenWarningThreshold);
    if (threshold === undefined || this.disclosedEstimatedTokenWarning) {
      return '';
    }
    const fit = contextFitForModel(model, estimateTokensRough(JSON.stringify({ messages: this.messages, prompt: sounding })));
    if (fit.usedTokensEstimate < threshold) {
      return '';
    }

    this.disclosedEstimatedTokenWarning = true;
    return `
[estimated_token_warning]
Context window has passed ${threshold} estimated tokens.
used_tokens_estimate: ${fit.usedTokensEstimate}
Soundings will take longer to complete and timeout risk is increasing. Recommend \`curl\` when ready.
[/estimated_token_warning]
`;
  }

  private async curlSession(soundingId: string, ledgerEntry?: string): Promise<CurlResult> {
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
    this.scratchpad?.refreshPromptSnapshot();
    this.disclosedContextThreshold = 0;
    this.disclosedEstimatedTokenWarning = false;
    this.pendingCurl = { clearedMessages, ledgerPath: resolvedLedgerPath, wroteLedger };
    this.log.append({
      type: 'curl',
      at: new Date().toISOString(),
      soundingId,
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
  }
}
