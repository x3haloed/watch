import { ToolLoopAgent, stepCountIs } from 'ai';
import type { ModelMessage } from 'ai';
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
  countToolCalls,
  errorToJson,
  isTimeoutLikeError,
  maxOutputTokensForModel,
  messagesForModel,
  repairIncompleteToolTurns,
  repairFlatToolCall,
  requiredApiKeyEnv,
  sanitizeMessagesForHistory,
  timeoutTraceMessage,
  toJsonObject,
} from './lookout-helpers.js';
import { createLookoutTools } from './lookout-tools.js';
import { MediaService, type OpenMediaInput } from './media-service.js';
import { SessionController, type CurlResult, type RebootRequest } from './session-controller.js';
import { SoundingPromptBuilder } from './sounding-prompt.js';
import type { LookoutToolContext, RerouteRequest } from './tools/context.js';
import { ContextTokenTracker } from './token-estimator.js';


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

export class Lookout {
  private readonly messages: ModelMessage[] = [];
  private readonly fileTools: RepoFileTools;
  private readonly skills: SkillLibrary;
  private readonly terminalTools: TerminalTools;
  private readonly prompt: SoundingPromptBuilder;
  private readonly media: MediaService;
  private readonly session: SessionController;
  private readonly tokenTracker = new ContextTokenTracker();
  private readonly cwd: string;

  constructor(
    private readonly streams: StreamRegistry,
    private readonly log: EventLog,
    private readonly models: ModelRegistry,
    private readonly noModel: boolean,
    repoRoot: string,
    restingModelId?: string,
    restAfterNoToolSoundings = 3,
    ledgerPath?: string,
    estimatedTokenWarningThreshold = 120_000,
    private readonly discord?: DiscordBridge,
    private readonly scratchpad?: Scratchpad,
  ) {
    this.cwd = repoRoot;
    this.fileTools = new RepoFileTools(repoRoot);
    this.skills = new SkillLibrary(repoRoot);
    this.terminalTools = new TerminalTools(repoRoot, log);
    this.media = new MediaService(this.fileTools, streams.inbox, models);
    this.prompt = new SoundingPromptBuilder({
      cwd: repoRoot,
      contextPrompt: buildContextPrompt(repoRoot),
      models,
      skills: this.skills,
      listSubscriptions: () => this.streams.listSubscriptions(),
      messages: this.messages,
      restingModelId,
      restAfterNoToolSoundings,
      estimatedTokenWarningThreshold,
      tokenTracker: this.tokenTracker,
      scratchpad,
    });
    this.session = new SessionController({
      cwd: repoRoot,
      ledgerPath,
      messages: this.messages,
      scratchpad,
      log,
      resetPromptState: () => this.prompt.resetContextDisclosure(),
    });
  }

  get modelId(): string {
    return this.models.activeId;
  }

  async contextFitFor(model: ResolvedModel): Promise<ContextFit> {
    const instructions = await this.prompt.instructions();
    return this.tokenTracker.contextFitFor(model, this.tokenTracker.estimatePrompt({ instructions, messages: this.messages }));
  }

  async curlFromSystem(soundingId: string, ledgerEntry?: string): Promise<CurlResult> {
    return this.session.curl(soundingId, ledgerEntry);
  }

  stopTerminalSessions(reason: string): number {
    return this.terminalTools.killAll('runtime:stop', reason);
  }

  consumeRebootRequest(): RebootRequest | undefined {
    return this.session.consumeRebootRequest();
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

    return this.runOnce(sounding, sounding.model, options);
  }

  private async runOnce(
    sounding: Sounding,
    model: ResolvedModel,
    options: { abortSignal?: AbortSignal; timeoutMs?: number; restModelNotice?: RestModelNotice; restModelBlockedNotice?: RestModelBlockedNotice } = {},
  ): Promise<{ text: string; toolCallCount: number }> {
    let activeTurnModel = model;
    let currentStepModel = model;
    const { text: promptText, mediaParts } = this.prompt.formatSounding({
      sounding,
      model,
      restModelNotice: options.restModelNotice,
      restModelBlockedNotice: options.restModelBlockedNotice,
    });
    this.repairMessageHistory();
    // Build content as array when camera/video media is present, string otherwise
    const content = mediaParts.length > 0
      ? [
          { type: 'text' as const, text: promptText },
          ...mediaParts.map(m => {
            if (m.type === 'image') {
              return { type: 'image' as const, image: m.image, mediaType: m.mediaType };
            } else {
              return { type: 'file' as const, data: m.data, mediaType: m.mediaType };
            }
          })
        ]
      : promptText;
    this.messages.push({ role: 'user', content });
    let toolCallCount = 0;
    const checkpointMessages: ModelMessage[] = [];

    try {
      const agent = new ToolLoopAgent({
        model: this.models.createLanguageModel(model),
        instructions: await this.prompt.instructions(),
        tools: this.createTools(sounding, () => activeTurnModel, nextModel => {
          activeTurnModel = nextModel;
        }),
        stopWhen: stepCountIs(20),
        maxOutputTokens: maxOutputTokensForModel(model),
        experimental_repairToolCall: repairFlatToolCall,
        prepareStep: ({ messages }) => {
          currentStepModel = activeTurnModel;
          return {
            model: this.models.createLanguageModel(currentStepModel),
            messages: messagesForModel(currentStepModel, messages),
          };
        },
        onStepFinish: step => {
          toolCallCount += countToolCalls(step);
          checkpointMessages.push(...sanitizeMessagesForHistory(step.response.messages as ModelMessage[]));
          this.tokenTracker.recordProviderInput(step.usage.inputTokens, this.messages);
          this.log.append({
            type: 'model_step_finished',
            at: new Date().toISOString(),
            soundingId: sounding.id,
            modelId: currentStepModel.id,
            step: toJsonObject(step),
          });
        },
        onFinish: event => {
          this.log.append({
            type: 'model_finished',
            at: new Date().toISOString(),
            soundingId: sounding.id,
            modelId: activeTurnModel.id,
            result: toJsonObject(event),
          });
        },
      });

      const result = await agent.generate({
        messages: messagesForModel(model, this.messages),
        abortSignal: options.abortSignal,
      });

      if (!this.session.consumeCurlDuringTurn()) {
        this.messages.push(...sanitizeMessagesForHistory(result.response.messages));
        this.repairMessageHistory();
      }
      return { text: result.text, toolCallCount };
    } catch (error) {
      this.session.consumeCurlDuringTurn();
      if (isTimeoutLikeError(error) || options.abortSignal?.aborted) {
        this.messages.push(...checkpointMessages);
        this.messages.push(timeoutTraceMessage(sounding, checkpointMessages.length, toolCallCount));
        this.repairMessageHistory();
        this.log.append({
          type: 'model_timeout_checkpoint',
          at: new Date().toISOString(),
          soundingId: sounding.id,
          modelId: activeTurnModel.id,
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
        modelId: activeTurnModel.id,
        error: errorToJson(error),
      });
      throw error;
    }
  }

  private createTools(sounding: Sounding, currentModel: () => ResolvedModel, setCurrentModel: (model: ResolvedModel) => void) {
    const ctx: LookoutToolContext = {
      cwd: this.cwd,
      files: this.fileTools,
      terminal: this.terminalTools,
      streams: this.streams,
      inbox: this.streams.inbox,
      models: this.models,
      media: this.media,
      skills: this.skills,
      session: this.session,
      log: this.log,
      discord: this.discord,
      scratchpad: this.scratchpad,
      messages: this.messages,
      instructions: () => this.prompt.instructions(),
      contextFitFor: model => this.contextFitFor(model),
      currentModel,
      switchModelForCurrentSounding: request => this.switchModelForCurrentSounding(sounding, currentModel(), setCurrentModel, request),
      openMediaForModel: (input, activeModel) => this.openMediaForModel(input, activeModel),
    };
    return createLookoutTools(ctx, sounding, currentModel());
  }

  private repairMessageHistory(): void {
    const repaired = repairIncompleteToolTurns(this.messages);
    if (repaired.length !== this.messages.length) {
      this.messages.length = 0;
      this.messages.push(...repaired);
    }
  }

  private async switchModelForCurrentSounding(
    sounding: Sounding,
    fromModel: ResolvedModel,
    setCurrentModel: (model: ResolvedModel) => void,
    request: RerouteRequest,
  ): Promise<Record<string, unknown>> {
    await this.models.switchTo(request.modelId);
    setCurrentModel(request.model);
    this.log.append({
      type: 'model_reroute',
      at: new Date().toISOString(),
      soundingId: sounding.id,
      fromModelId: fromModel.id,
      toModelId: request.modelId,
      params: request.params,
    });
    return {
      ok: true,
      modelSwitched: true,
      fromModel: fromModel.id,
      toModel: request.modelId,
      message: `Welcome to ${request.modelId}. Continue this same Sounding from the current conversation state; do not replay the original deltas.`,
    };
  }

  private async openMediaForModel(input: OpenMediaInput, model: ResolvedModel): Promise<Record<string, unknown>> {
    return this.media.openForModel(input, model);
  }
}
