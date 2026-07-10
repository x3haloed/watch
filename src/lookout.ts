import { ToolLoopAgent, stepCountIs } from 'ai';
import type { ModelMessage } from 'ai';
import type { ResolvedModel, Sounding, StreamDelta } from './types.js';
import { StreamRegistry } from './streams.js';
import { EventLog } from './event-log.js';
import { ModelRegistry } from './model-registry.js';
import { buildContextPrompt } from './context-files.js';
import { RepoFileTools } from './file-tools.js';
import { SkillLibrary } from './skills.js';
import { TerminalTools } from './terminal-tools.js';
import { DiscordBridge } from './discord.js';
import { MoltbookBridge } from './moltbook.js';
import { Scratchpad } from './scratchpad.js';
import {
  countToolCalls,
  errorToJson,
  classifyInferenceError,
  isTimeoutLikeError,
  maxOutputTokensForModel,
  messagesForModel,
  modelFailureTraceMessage,
  repairIncompleteToolTurns,
  repairFlatToolCall,
  requiredApiKeyEnv,
  sanitizeMessagesForHistory,
  timeoutTraceMessage,
  toJsonObject,
} from './lookout-helpers.js';
import { InferenceForensics } from './inference-forensics.js';
import { createLookoutTools } from './lookout-tools.js';
import { MediaService, type OpenMediaInput } from './media-service.js';
import { MemoryLattice } from './memory-lattice.js';
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
  private readonly memory: MemoryLattice;
  private readonly tokenTracker = new ContextTokenTracker();
  private readonly cwd: string;

  constructor(
    private readonly streams: StreamRegistry,
    private readonly log: EventLog,
    private readonly models: ModelRegistry,
    private readonly noModel: boolean,
    instanceRoot: string,
    restingModelId?: string,
    restAfterNoToolSoundings = 3,
    ledgerPath?: string,
    estimatedTokenWarningThreshold = 120_000,
    private readonly discord?: DiscordBridge,
    private readonly moltbook?: MoltbookBridge,
    private readonly scratchpad?: Scratchpad,
    redactedEnvNames: string[] = [],
  ) {
    this.cwd = instanceRoot;
    this.fileTools = new RepoFileTools(instanceRoot);
    this.skills = new SkillLibrary(instanceRoot);
    this.terminalTools = new TerminalTools(instanceRoot, log, redactedEnvNames);
    this.media = new MediaService(this.fileTools, streams.inbox, models);
    this.memory = new MemoryLattice(instanceRoot);
    this.prompt = new SoundingPromptBuilder({
      cwd: instanceRoot,
      contextPrompt: buildContextPrompt(instanceRoot),
      models,
      skills: this.skills,
      listSubscriptions: () => this.streams.listSubscriptions(),
      messages: this.messages,
      restingModelId,
      restAfterNoToolSoundings,
      estimatedTokenWarningThreshold,
      tokenTracker: this.tokenTracker,
      scratchpad,
      memory: this.memory,
    });
    this.session = new SessionController({
      cwd: instanceRoot,
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
    options: { abortSignal?: AbortSignal; timeoutMs?: number; restModelNotice?: RestModelNotice; restModelBlockedNotice?: RestModelBlockedNotice; hasSteeringPending?: () => boolean; takeSteeringDeltas?: () => StreamDelta[] } = {},
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
    options: { abortSignal?: AbortSignal; timeoutMs?: number; restModelNotice?: RestModelNotice; restModelBlockedNotice?: RestModelBlockedNotice; hasSteeringPending?: () => boolean; takeSteeringDeltas?: () => StreamDelta[] } = {},
  ): Promise<{ text: string; toolCallCount: number }> {
    let activeTurnModel = model;
    let currentStepModel = model;
    const { text: promptText, mediaParts, memoryCandidateIds } = this.prompt.formatSounding({
      sounding,
      model,
      restModelNotice: options.restModelNotice,
      restModelBlockedNotice: options.restModelBlockedNotice,
    });
    if (memoryCandidateIds.length > 0) {
      this.log.append({ type: 'memory_candidates_presented', at: new Date().toISOString(), soundingId: sounding.id, memoryIds: memoryCandidateIds });
    }
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
    const forensics = new InferenceForensics(this.cwd, sounding.id);
    const recordRequest = forensics.recorder();

    try {
      const agent = new ToolLoopAgent({
        model: this.models.createLanguageModel(model, recordRequest),
        instructions: await this.prompt.instructions(),
        tools: this.createTools(sounding, () => activeTurnModel, nextModel => {
          activeTurnModel = nextModel;
        }),
        stopWhen: [stepCountIs(20), () => options.hasSteeringPending?.() === true],
        maxOutputTokens: maxOutputTokensForModel(model),
        experimental_repairToolCall: repairFlatToolCall,
        prepareStep: ({ messages }) => {
          currentStepModel = activeTurnModel;
          return {
            model: this.models.createLanguageModel(currentStepModel, recordRequest),
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

      while (true) {
        const result = await agent.generate({
          messages: messagesForModel(activeTurnModel, this.messages),
          abortSignal: options.abortSignal,
        });
        if (!this.session.consumeCurlDuringTurn()) {
          this.messages.push(...sanitizeMessagesForHistory(result.response.messages));
          this.repairMessageHistory();
        }
        checkpointMessages.length = 0;
        const steering = options.takeSteeringDeltas?.() ?? [];
        if (!steering.length) return { text: result.text, toolCallCount };
        this.messages.push({ role: 'user', content: formatLiveSteering(steering) });
        this.log.append({ type: 'sounding_steered', at: new Date().toISOString(), soundingId: sounding.id, deltas: steering });
      }
    } catch (error) {
      this.session.consumeCurlDuringTurn();
      const classification = classifyInferenceError(error);
      const shouldCheckpoint = isTimeoutLikeError(error) || options.abortSignal?.aborted || checkpointMessages.length > 0 || toolCallCount > 0;
      if (shouldCheckpoint) {
        this.messages.push(...checkpointMessages);
        this.messages.push(
          isTimeoutLikeError(error) || options.abortSignal?.aborted
            ? timeoutTraceMessage(sounding, checkpointMessages.length, toolCallCount)
            : modelFailureTraceMessage(sounding, checkpointMessages.length, toolCallCount, classification),
        );
        this.repairMessageHistory();
        this.log.append({
          type: isTimeoutLikeError(error) || options.abortSignal?.aborted ? 'model_timeout_checkpoint' : 'model_failure_checkpoint',
          at: new Date().toISOString(),
          soundingId: sounding.id,
          modelId: activeTurnModel.id,
          checkpointMessages: checkpointMessages.length,
          toolCallCount,
          errorKind: classification.kind,
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
        classification: toJsonObject(classification),
        request: forensics.latestJson(),
        requests: forensics.allJson(),
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
      moltbook: this.moltbook,
      scratchpad: this.scratchpad,
      memory: this.memory,
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
      message: `Welcome to ${request.modelId}. Continue this same Sounding from the current conversation state.`,
    };
  }

  private async openMediaForModel(input: OpenMediaInput, model: ResolvedModel): Promise<Record<string, unknown>> {
    return this.media.openForModel(input, model);
  }
}

function formatLiveSteering(deltas: StreamDelta[]): string {
  return `[live_steering]\nThese waking deltas arrived while this Sounding was active. Incorporate them into the current turn without repeating completed work.\n[/live_steering]\n\n[stream_deltas]\n${deltas.map(delta => JSON.stringify(delta)).join('\n')}\n[/stream_deltas]`;
}
