import { randomUUID } from 'node:crypto';
import type { ControlRequest, ControlResponse, JsonObject, Sounding, WatchConfig, WatchEvent } from './types.js';
import { EventLog } from './event-log.js';
import { Lookout, type RestModelBlockedNotice, type RestModelNotice } from './lookout.js';
import { StreamRegistry } from './streams.js';
import { ModelRegistry } from './model-registry.js';
import { DiscordBridge } from './discord.js';
import { MoltbookBridge } from './moltbook.js';
import { GazeStore } from './gaze-state.js';
import { Scratchpad } from './scratchpad.js';
import { CameraStreamBridge, registerCameraStreams } from './camera-streams.js';
import { DesktopCaptureBridge } from './stream-primitives.js';
import { classifyInferenceError, type InferenceErrorClassification } from './lookout-helpers.js';
import { captureInputFromWatchEvent, MemoryLattice } from './memory-lattice.js';

const MODEL_FAILURE_BACKOFF_BASE_MS = 30_000;
const MODEL_FAILURE_BACKOFF_MAX_MS = 5 * 60_000;

export class WatchRuntime {
  private readonly streams: StreamRegistry;
  private readonly log: EventLog;
  private readonly lookout: Lookout;
  private readonly models: ModelRegistry;
  private readonly discord: DiscordBridge;
  private readonly moltbook: MoltbookBridge;
  private readonly gazeStore: GazeStore;
  private readonly scratchpad: Scratchpad | undefined;
  private readonly memory: MemoryLattice;
  private readonly cameraStreams: CameraStreamBridge[];
  private readonly desktopCaptureBridge: DesktopCaptureBridge | undefined;
  private lastSoundingAt = Date.now();
  private running = false;
  private tickTimer: NodeJS.Timeout | undefined;
  private clockTimer: NodeJS.Timeout | undefined;
  private lastClockSecond = '';
  private soundingActive = false;
  private soundQueued = false;
  private queuedTrigger: Sounding['trigger'] = 'delta';
  private currentSounding: Sounding | undefined;
  private activeAbortController: AbortController | undefined;
  private noToolSoundings = 0;
  private modelFailureCount = 0;
  private modelBackoffUntil = 0;
  private readonly restingModelId: string | undefined;
  private pendingRestModelNotice: RestModelNotice | undefined;
  private pendingRestModelBlockedNotice: RestModelBlockedNotice | undefined;
  private capturingEvent = false;

  constructor(private readonly config: WatchConfig, private readonly requestReboot: (source: 'tool' | 'control') => void = () => {}) {
    this.gazeStore = new GazeStore(config.instanceRoot);
    this.scratchpad = config.scratchpad.enabled === false ? undefined : new Scratchpad(config.instanceRoot, config.scratchpad);
    this.log = new EventLog(config.instanceRoot);
    this.memory = new MemoryLattice(config.instanceRoot);
    this.log.subscribe(event => this.captureEventEpisode(event));
    this.streams = new StreamRegistry(
      config.webApiStreams,
      config.instanceRoot,
      this.gazeStore.streams,
      snapshot => this.gazeStore.updateStreams(snapshot),
      !this.scratchpad
        ? undefined
        : { path: this.scratchpad.paths.userPath, maxChars: this.scratchpad.paths.userMaxChars },
      undefined,
      config.sseStreams,
      this.log,
    );
    this.cameraStreams = registerCameraStreams(config.cameraStreams, this.streams, this.log);
    if (config.desktopCapture && config.desktopCapture.enabled !== false) {
      this.streams.registerBufferedStream(config.desktopCapture.name || 'desktop:capture', {
        subscribed: config.desktopCapture.subscribed ?? true,
        waking: config.desktopCapture.waking ?? false,
        maxPayloads: config.desktopCapture.maxBufferedChunks ?? 3,
      });
      this.desktopCaptureBridge = new DesktopCaptureBridge(config.desktopCapture, this.streams, this.log);
    } else {
      this.desktopCaptureBridge = undefined;
    }
    this.models = ModelRegistry.load(config.instanceRoot, config.defaultModel, config.availableModels);
    this.discord = new DiscordBridge(
      config.discord,
      this.streams,
      this.log,
      this.gazeStore.discord,
      policy => this.gazeStore.updateDiscord(policy),
    );
    this.moltbook = new MoltbookBridge(
      config.moltbook,
      this.streams,
      this.log,
      this.gazeStore.moltbook,
      state => this.gazeStore.updateMoltbook(state),
    );
    this.gazeStore.updateStreams(this.streams.snapshot());
    this.gazeStore.updateDiscord(this.discord.snapshotPolicy());
    this.gazeStore.updateMoltbook(this.moltbook.snapshotState());
    this.restingModelId = config.restingModel ?? config.defaultModel;
    this.lookout = new Lookout(
      this.streams,
      this.log,
      this.models,
      config.noModel,
      config.instanceRoot,
      this.restingModelId,
      config.restAfterNoToolSoundings,
      config.ledgerPath,
      config.estimatedTokenWarningThreshold,
      this.discord,
      this.moltbook,
      this.scratchpad,
      [config.moltbook?.apiKeyEnv ?? 'MOLTBOOK_API_KEY'],
    );
  }

  get instanceRoot(): string {
    return this.config.instanceRoot;
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.log.append({ type: 'daemon_started', at: new Date().toISOString(), pid: process.pid, config: this.config });
    void this.discord.start();
    this.moltbook.start();
    for (const bridge of this.cameraStreams) {
      bridge.start();
    }
    if (this.desktopCaptureBridge) {
      this.desktopCaptureBridge.start();
    }
    this.clockTimer = setInterval(() => this.sampleClock(), 250);
    this.tickTimer = setInterval(() => void this.maybeSound(), 100);
  }

  async stop(reason = 'control request'): Promise<void> {
    this.running = false;
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.clockTimer) clearInterval(this.clockTimer);
    this.soundQueued = false;
    this.activeAbortController?.abort(reason);
    this.lookout.stopTerminalSessions(reason);
    for (const bridge of this.cameraStreams) {
      bridge.stop(reason);
    }
    if (this.desktopCaptureBridge) {
      this.desktopCaptureBridge.stop();
    }
    await this.discord.stop(reason);
    this.moltbook.stop();
    this.log.append({ type: 'daemon_stopped', at: new Date().toISOString(), pid: process.pid, reason });
  }

  subscribeEvents(subscriber: (event: WatchEvent) => void): () => void {
    return this.log.subscribe(subscriber);
  }

  eventTail(limit = 300): WatchEvent[] {
    return this.log.tail(limit);
  }

  async status(): Promise<JsonObject> {
    return {
      pid: process.pid,
      running: this.running,
      modelId: this.lookout.modelId,
      restingModelId: this.restingModelId,
      restAfterNoToolSoundings: this.config.restAfterNoToolSoundings,
      estimatedTokenWarningThreshold: this.config.estimatedTokenWarningThreshold,
      noToolSoundings: this.noToolSoundings,
      availableModels: this.models.listModelIds(),
      activeModel: await this.models.getActive(),
      subscriptions: this.streams.listSubscriptions(),
      discord: this.discord.getAttention(),
      moltbook: this.moltbook.getAttention(),
      gazeState: this.gazeStore.snapshot(),
      scratchpad: this.scratchpad?.read() ?? { ok: false, enabled: false },
      memory: { recent: this.memory.recent(10) },
      minCffMs: this.config.minCffMs,
      maxCffMs: this.config.maxCffMs,
      modelTimeoutMs: this.config.modelTimeoutMs,
      noModel: this.config.noModel,
      soundingActive: this.soundingActive,
      soundQueued: this.soundQueued,
      currentSounding: this.currentSounding,
      modelFailureCount: this.modelFailureCount,
      modelBackoffUntil: this.modelBackoffUntil > Date.now() ? new Date(this.modelBackoffUntil).toISOString() : undefined,
      pendingDeltas: this.streams.hasPending(),
    };
  }

  enqueueInboxMessage(message: string, source = 'cli', metadata?: JsonObject): { accepted: boolean } {
    const accepted = this.streams.push('inbox', {
      medium: source,
      source,
      message,
      metadata,
    });
    if (accepted) {
      this.log.append({
        type: 'stream_buffered',
        at: new Date().toISOString(),
        stream: 'inbox',
        payload: { source, message, metadata },
      });
    }
    return { accepted };
  }

  async handle(request: ControlRequest): Promise<ControlResponse> {
    if (request.command !== 'status') {
      this.log.append({
        type: 'control_message',
        at: new Date().toISOString(),
        command: request.command,
        payload: request.command === 'send' ? { source: request.source ?? 'cli' } : undefined,
      });
    }

    if (request.command === 'send') {
      const { accepted } = this.enqueueInboxMessage(request.message, request.source ?? 'cli');
      return { ok: true, data: { accepted } };
    }

    if (request.command === 'status') {
      return { ok: true, data: await this.status() };
    }

    if (request.command === 'sound') {
      void this.sound('manual');
      return { ok: true };
    }

    if (request.command === 'stop') {
      await this.stop();
      return { ok: true };
    }

    if (request.command === 'reboot') {
      const result = await this.lookout.curlFromSystem('control:reboot', request.ledgerEntry);
      if (!result.ok) {
        return result;
      }
      this.log.append({
        type: 'reboot_requested',
        at: new Date().toISOString(),
        soundingId: 'control:reboot',
        ledgerPath: result.ledgerPath,
        wroteLedger: result.wroteLedger,
        clearedMessages: result.clearedMessages,
        source: 'control',
      });
      this.initiateReboot('control');
      return { ok: true, data: { message: 'Reboot sequence initiated. Daemon will restart.', curl: result } };
    }

    return { ok: false, error: 'Unknown command' };
  }

  private sampleClock(): void {
    const now = new Date();
    const second = now.toISOString().slice(0, 19);
    if (second === this.lastClockSecond) {
      return;
    }
    this.lastClockSecond = second;
    const accepted = this.streams.push('clock', {
      iso: now.toISOString(),
      epochMs: now.getTime(),
    });
    if (accepted) {
      this.log.append({
        type: 'stream_buffered',
        at: new Date().toISOString(),
        stream: 'clock',
        payload: { iso: now.toISOString(), epochMs: now.getTime() },
      });
    }
  }

  private async maybeSound(): Promise<void> {
    if (!this.running) {
      return;
    }

    const now = Date.now();
    if (now < this.modelBackoffUntil) {
      return;
    }

    const elapsed = now - this.lastSoundingAt;
    const trigger = elapsed >= this.config.maxCffMs ? 'heartbeat' : 'delta';
    if ((elapsed >= this.config.minCffMs && this.streams.hasWakingPending()) || elapsed >= this.config.maxCffMs) {
      void this.sound(trigger);
    }
  }

  private async sound(trigger: Sounding['trigger']): Promise<void> {
    if (this.soundingActive) {
      this.soundQueued = true;
      this.queuedTrigger = this.queuedTrigger === 'heartbeat' || trigger === 'heartbeat' ? 'heartbeat' : trigger;
      return;
    }
    if (trigger === 'manual') {
      this.clearModelFailureBackoff();
    } else if (Date.now() < this.modelBackoffUntil) {
      return;
    }

    this.soundingActive = true;
    let nextTrigger: Sounding['trigger'] | undefined = trigger;

    try {
      while (nextTrigger) {
        if (!this.running) {
          break;
        }
        this.soundQueued = false;
        const activeTrigger = nextTrigger;
        nextTrigger = undefined;
        const now = Date.now();
        const popAt = new Date(now);
        await this.desktopCaptureBridge?.finishSegmentAndPush();

        const model = await this.models.getActive();
        const availability = this.config.noModel ? { ok: true as const } : await this.models.checkAvailable(model);
        const deltas = await this.streams.popDeltas({ now: popAt, capabilities: model.capabilities });
        for (const delta of deltas) {
          this.log.append({ type: 'stream_delta', at: new Date().toISOString(), delta });
        }

        const sounding: Sounding = {
          id: randomUUID(),
          at: popAt.toISOString(),
          lastFlickerMs: now - this.lastSoundingAt,
          trigger: activeTrigger,
          deltas,
          modelId: model.id,
          model,
        };
        this.currentSounding = sounding;
        this.lastSoundingAt = now;
        this.log.append({ type: 'sounding_started', at: new Date().toISOString(), sounding });

        if (!availability.ok) {
          this.log.append({
            type: 'model_unavailable',
            at: new Date().toISOString(),
            soundingId: sounding.id,
            modelId: model.id,
            reason: availability.reason,
          });
          this.pushErrorStream({
            severity: 'error',
            source: 'inference',
            kind: 'model_unavailable',
            modelId: model.id,
            soundingId: sounding.id,
            message: availability.reason,
          });
          this.log.append({
            type: 'sounding_failed',
            at: new Date().toISOString(),
            soundingId: sounding.id,
            modelId: model.id,
            error: { name: 'ModelUnavailable', message: availability.reason },
          });
          this.desktopCaptureBridge?.startSegment();
          this.beginModelFailureBackoff(model.id, availability.reason, sounding.id);
          break;
        }

        try {
          this.activeAbortController = new AbortController();
          const restModelNotice = this.consumeRestModelNotice(model.id);
          const restModelBlockedNotice = this.consumeRestModelBlockedNotice();
          const result = await this.lookout.receive(sounding, {
            abortSignal: this.activeAbortController.signal,
            timeoutMs: this.config.modelTimeoutMs,
            restModelNotice,
            restModelBlockedNotice,
          });
          await this.recordToolActivity(result.toolCallCount);
          this.clearModelFailureBackoff();
          this.log.append({
            type: 'sounding_finished',
            at: new Date().toISOString(),
            soundingId: sounding.id,
            modelId: this.lookout.modelId,
            text: result.text,
          });
          const reboot = this.lookout.consumeRebootRequest();
          if (reboot) {
            this.initiateReboot(reboot.source);
          }
        } catch (error) {
          const classification = classifyInferenceError(error);
          if (isAbortError(error) || this.activeAbortController?.signal.aborted) {
            this.log.append({
              type: 'model_aborted',
              at: new Date().toISOString(),
              soundingId: sounding.id,
              modelId: this.lookout.modelId,
              reason: abortReason(this.activeAbortController?.signal.reason),
            });
          }
          this.log.append({
            type: 'sounding_failed',
            at: new Date().toISOString(),
            soundingId: sounding.id,
            modelId: this.lookout.modelId,
            error: errorToJson(error),
            classification: classificationToJson(classification),
          });
          this.pushErrorStream({
            severity: isAbortError(error) ? 'warning' : 'error',
            source: 'inference',
            kind: isAbortError(error) ? 'model_aborted' : classification.kind,
            modelId: this.lookout.modelId,
            soundingId: sounding.id,
            message: errorMessage(error),
            retryable: classification.retryable,
            statusCode: classification.statusCode,
            providerErrorCode: classification.providerErrorCode,
            providerErrorMessage: classification.providerErrorMessage,
          });
          this.beginModelFailureBackoff(this.lookout.modelId, errorMessage(error), sounding.id, classification);
        } finally {
          this.activeAbortController = undefined;
          this.desktopCaptureBridge?.startSegment();
        }

        if (this.running && Date.now() >= this.modelBackoffUntil && (this.soundQueued || this.streams.hasWakingPending())) {
          nextTrigger = this.queuedTrigger;
          this.queuedTrigger = 'delta';
        }
      }
    } finally {
      this.soundingActive = false;
      this.currentSounding = undefined;
    }
  }

  private beginModelFailureBackoff(modelId: string, reason: string, soundingId?: string, classification?: InferenceErrorClassification): void {
    this.modelFailureCount += 1;
    const delayMs = classification?.retryable === false
      ? MODEL_FAILURE_BACKOFF_MAX_MS
      : Math.min(
          MODEL_FAILURE_BACKOFF_MAX_MS,
          MODEL_FAILURE_BACKOFF_BASE_MS * 2 ** Math.max(0, this.modelFailureCount - 1),
        );
    this.modelBackoffUntil = Date.now() + delayMs;
    this.soundQueued = false;
    this.queuedTrigger = 'delta';
    this.log.append({
      type: 'model_failure_backoff',
      at: new Date().toISOString(),
      modelId,
      failures: this.modelFailureCount,
      delayMs,
      until: new Date(this.modelBackoffUntil).toISOString(),
      reason,
      classification: classification ? classificationToJson(classification) : undefined,
    });
    this.pushErrorStream({
      severity: 'warning',
      source: 'runtime',
      kind: classification?.retryable === false ? 'non_retryable_model_failure_backoff' : 'model_failure_backoff',
      modelId,
      soundingId,
      message: reason,
      delayMs,
      until: new Date(this.modelBackoffUntil).toISOString(),
      retryable: classification?.retryable,
      statusCode: classification?.statusCode,
      providerErrorCode: classification?.providerErrorCode,
      providerErrorMessage: classification?.providerErrorMessage,
    });
  }

  private clearModelFailureBackoff(): void {
    this.modelFailureCount = 0;
    this.modelBackoffUntil = 0;
  }

  private async recordToolActivity(toolCallCount: number): Promise<void> {
    if (toolCallCount > 0) {
      this.noToolSoundings = 0;
      return;
    }

    this.noToolSoundings += 1;
    await this.maybeRestoreRestingModel();
  }

  private async maybeRestoreRestingModel(): Promise<void> {
    const threshold = this.config.restAfterNoToolSoundings;
    const restingModelId = this.restingModelId;
    if (!restingModelId || threshold <= 0 || this.noToolSoundings < threshold || this.lookout.modelId === restingModelId) {
      return;
    }

    const fromModelId = this.lookout.modelId;
    try {
      const restingModel = await this.models.resolve(restingModelId);
      const context = await this.lookout.contextFitFor(restingModel);
      if (!context.ok) {
        this.log.append({
          type: 'model_auto_restore_blocked',
          at: new Date().toISOString(),
          fromModelId,
          toModelId: restingModelId,
          noToolSoundings: this.noToolSoundings,
          context,
        });
        this.pushErrorStream({
          severity: 'warning',
          source: 'runtime',
          kind: 'model_auto_restore_blocked',
          modelId: restingModelId,
          message: `Could not restore resting model ${restingModelId}: context does not fit.`,
          context,
        });
        this.pendingRestModelBlockedNotice = {
          fromModelId,
          toModelId: restingModelId,
          noToolSoundings: this.noToolSoundings,
          context,
        };
        return;
      }

      await this.models.switchTo(restingModelId);
      this.log.append({
        type: 'model_auto_restored',
        at: new Date().toISOString(),
        fromModelId,
        toModelId: restingModelId,
        noToolSoundings: this.noToolSoundings,
      });
      this.pendingRestModelNotice = {
        fromModelId,
        toModelId: restingModelId,
        noToolSoundings: this.noToolSoundings,
      };
      this.noToolSoundings = 0;
    } catch (error) {
      this.log.append({
        type: 'model_auto_restore_failed',
        at: new Date().toISOString(),
        fromModelId,
        toModelId: restingModelId,
        noToolSoundings: this.noToolSoundings,
        error: errorToJson(error),
      });
      this.pushErrorStream({
        severity: 'error',
        source: 'runtime',
        kind: 'model_auto_restore_failed',
        modelId: restingModelId,
        message: errorMessage(error),
      });
    }
  }

  private pushErrorStream(payload: Record<string, unknown>): void {
    const accepted = this.streams.push('errors', payload);
    if (accepted) {
      this.log.append({
        type: 'stream_buffered',
        at: new Date().toISOString(),
        stream: 'errors',
        payload: {
          source: payload.source,
          kind: payload.kind,
          severity: payload.severity,
          modelId: payload.modelId,
          message: payload.message,
          retryable: payload.retryable,
          statusCode: payload.statusCode,
          providerErrorCode: payload.providerErrorCode,
        },
      });
    }
  }

  private consumeRestModelNotice(modelId: string): RestModelNotice | undefined {
    if (!this.pendingRestModelNotice || modelId !== this.pendingRestModelNotice.toModelId) {
      return undefined;
    }

    const notice = this.pendingRestModelNotice;
    this.pendingRestModelNotice = undefined;
    return notice;
  }

  private consumeRestModelBlockedNotice(): RestModelBlockedNotice | undefined {
    const notice = this.pendingRestModelBlockedNotice;
    this.pendingRestModelBlockedNotice = undefined;
    return notice;
  }

  private initiateReboot(source: 'tool' | 'control'): void {
    this.running = false;
    this.soundQueued = false;
    this.requestReboot(source);
  }

  private captureEventEpisode(event: WatchEvent): void {
    if (this.capturingEvent) {
      return;
    }
    const input = captureInputFromWatchEvent(event as unknown as { type: string } & JsonObject);
    if (!input) {
      return;
    }
    this.capturingEvent = true;
    try {
      const record = this.memory.captureEpisode(input);
      this.log.append({ type: 'memory_captured', at: new Date().toISOString(), memoryId: record.id, layer: record.layer, kind: record.kind, source: event.type, provenance: record.provenance });
    } finally {
      this.capturingEvent = false;
    }
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name);
}

function abortReason(reason: unknown): string {
  return typeof reason === 'string' ? reason : reason instanceof Error ? reason.message : 'aborted';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorToJson(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const record = error as Error & Record<string, unknown>;
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      statusCode: typeof record.statusCode === 'number' ? record.statusCode : undefined,
      responseBody: typeof record.responseBody === 'string' ? record.responseBody : undefined,
      isRetryable: typeof record.isRetryable === 'boolean' ? record.isRetryable : undefined,
    };
  }
  return { value: String(error) };
}

function classificationToJson(classification: InferenceErrorClassification): Record<string, unknown> {
  return {
    kind: classification.kind,
    retryable: classification.retryable,
    statusCode: classification.statusCode,
    providerErrorCode: classification.providerErrorCode,
    providerErrorMessage: classification.providerErrorMessage,
  };
}
