import { estimateModelValue, estimateTextTokens } from './token-estimator.js';
import type { JsonObject, Sounding, WatchEvent } from './types.js';
import type { WatchRuntime } from './runtime.js';

export type VisualizationImpact = {
  id: string;
  soundingId: string;
  at: string;
  p: number;
  finishP: number;
  inputMass: number;
  replayMass: number;
  userMass: number;
  toolResultMass: number;
  toolCallMass: number;
  assistantMass: number;
  newShare: number;
  outputMass: number;
  status: 'started' | 'updated' | 'finished' | 'failed';
};

export type VisualizationOutputPacket = {
  id: string;
  soundingId: string;
  at: string;
  p: number;
  amp: number;
  mass: number;
  kind: 'assistant_output' | 'tool_result' | 'tool_call' | 'error';
};

export type VisualizationState = {
  activeSoundings: number;
  subscriberCount: number;
  mode: 'idle' | 'listening' | 'queued' | 'thinking' | 'digesting' | 'tool_call' | 'tool_result' | 'output' | 'error';
  queued: number;
  digestion: number;
  thinking: number;
  pressure: number;
  output: number;
  tool: number;
  call: number;
};

export type VisualizationSnapshot = {
  meta: {
    startedAt: string;
    lastAt: string;
    impactCount: number;
    packetCount: number;
  };
  impacts: VisualizationImpact[];
  outputPackets: VisualizationOutputPacket[];
  state: VisualizationState;
};

export type VisualizationEvent =
  | { type: 'visualization.snapshot'; at: string; snapshot: VisualizationSnapshot }
  | { type: 'visualization.impact'; at: string; impact: VisualizationImpact }
  | { type: 'visualization.output_packet'; at: string; packet: VisualizationOutputPacket }
  | { type: 'visualization.reset'; at: string; reason: string }
  | { type: 'visualization.state'; at: string; state: VisualizationState };

type VisualizationSubscriber = (event: VisualizationEvent) => void;

type SoundingAccumulator = {
  sounding: Sounding;
  startedAtMs: number;
  inputTokens: number;
  replayTokens: number;
  userTokens: number;
  deltaTokens: number;
  toolCallTokens: number;
  toolResultTokens: number;
  assistantTokens: number;
  outputTokens: number;
};

export class WatchVisualizationHub {
  private readonly subscribers = new Set<VisualizationSubscriber>();
  private readonly activeSoundings = new Map<string, SoundingAccumulator>();
  private readonly impacts: VisualizationImpact[] = [];
  private readonly outputPackets: VisualizationOutputPacket[] = [];
  private unsubscribeRuntime: (() => void) | undefined;
  private startedAt = nowIso();
  private lastAt = this.startedAt;
  private sequence = 0;
  private soundQueued = false;

  constructor(private readonly runtime: WatchRuntime) {}

  subscribe(subscriber: VisualizationSubscriber): () => void {
    this.subscribers.add(subscriber);
    if (this.subscribers.size === 1) {
      this.start();
    }
    subscriber({ type: 'visualization.snapshot', at: nowIso(), snapshot: this.snapshot() });

    return () => {
      this.subscribers.delete(subscriber);
      if (this.subscribers.size === 0) {
        this.stop();
      } else {
        this.emitState();
      }
    };
  }

  close(): void {
    this.stop();
    this.subscribers.clear();
  }

  private start(): void {
    this.startedAt = nowIso();
    this.lastAt = this.startedAt;
    this.unsubscribeRuntime = this.runtime.subscribeEvents(event => this.processWatchEvent(event));
    this.emit({ type: 'visualization.reset', at: this.startedAt, reason: 'subscribed' });
    this.emitState();
  }

  private stop(): void {
    this.unsubscribeRuntime?.();
    this.unsubscribeRuntime = undefined;
    this.activeSoundings.clear();
    this.impacts.splice(0);
    this.outputPackets.splice(0);
    this.soundQueued = false;
  }

  private processWatchEvent(event: WatchEvent): void {
    if (event.type === 'sounding_started') {
      this.recordSoundingStarted(event.sounding);
      return;
    }
    if (event.type === 'model_step_finished') {
      this.recordModelStep(event.soundingId, event.step);
      return;
    }
    if (event.type === 'model_finished') {
      this.recordModelFinished(event.soundingId, event.result);
      return;
    }
    if (event.type === 'sounding_finished') {
      this.recordSoundingFinished(event.soundingId, event.text);
      return;
    }
    if (event.type === 'sounding_failed' || event.type === 'model_unavailable' || event.type === 'model_error') {
      this.recordSoundingFailed(event.soundingId);
      return;
    }
    if (event.type === 'model_failure_backoff') {
      this.emitState();
      return;
    }
    if (event.type === 'control_message' && event.command === 'sound') {
      this.soundQueued = true;
      this.emitState();
    }
  }

  private recordSoundingStarted(sounding: Sounding): void {
    this.soundQueued = false;
    const deltaTokens = estimateModelValue(sounding.deltas).tokens;
    const accumulator: SoundingAccumulator = {
      sounding,
      startedAtMs: Date.parse(sounding.at) || Date.now(),
      inputTokens: estimateModelValue(sounding).tokens,
      replayTokens: 0,
      userTokens: inboxTokens(sounding),
      deltaTokens,
      toolCallTokens: 0,
      toolResultTokens: 0,
      assistantTokens: 0,
      outputTokens: 0,
    };
    this.activeSoundings.set(sounding.id, accumulator);
    this.emitImpact(accumulator, 'started');
    this.emitState();
  }

  private recordModelStep(soundingId: string, step: JsonObject): void {
    const accumulator = this.activeSoundings.get(soundingId);
    if (!accumulator) {
      return;
    }
    const content = Array.isArray(step.content) ? step.content : [];
    let emittedPacket = false;
    for (const part of content) {
      if (!isRecord(part)) {
        continue;
      }
      const type = typeof part.type === 'string' ? part.type : '';
      if (type === 'tool-call') {
        const tokens = estimateModelValue(part).tokens;
        accumulator.toolCallTokens += tokens;
        this.emitOutputPackets(accumulator, 'tool_call', tokens);
        emittedPacket = true;
      } else if (type === 'tool-result') {
        const tokens = estimateModelValue(part).tokens;
        accumulator.toolResultTokens += tokens;
        this.emitOutputPackets(accumulator, 'tool_result', tokens);
        emittedPacket = true;
      } else if (type === 'text' && typeof part.text === 'string') {
        const tokens = estimateTextTokens(part.text);
        accumulator.assistantTokens += tokens;
        accumulator.outputTokens = Math.max(accumulator.outputTokens, tokens);
        this.emitOutputPackets(accumulator, 'assistant_output', tokens);
        emittedPacket = true;
      }
    }

    const usageOutput = usageOutputTokens(step.usage);
    if (usageOutput > 0) {
      accumulator.outputTokens = Math.max(accumulator.outputTokens, usageOutput);
    }
    if (emittedPacket || usageOutput > 0) {
      this.emitImpact(accumulator, 'updated');
      this.emitState();
    }
  }

  private recordModelFinished(soundingId: string, result: JsonObject): void {
    const accumulator = this.activeSoundings.get(soundingId);
    if (!accumulator) {
      return;
    }
    const usageOutput = usageOutputTokens(result.usage);
    if (usageOutput > 0) {
      accumulator.outputTokens = Math.max(accumulator.outputTokens, usageOutput);
      this.emitImpact(accumulator, 'updated');
    }
  }

  private recordSoundingFinished(soundingId: string, text: string): void {
    const accumulator = this.activeSoundings.get(soundingId);
    if (!accumulator) {
      return;
    }
    const tokens = estimateTextTokens(text);
    accumulator.assistantTokens = Math.max(accumulator.assistantTokens, tokens);
    accumulator.outputTokens = Math.max(accumulator.outputTokens, tokens);
    this.emitOutputPackets(accumulator, 'assistant_output', accumulator.outputTokens);
    this.emitImpact(accumulator, 'finished');
    this.activeSoundings.delete(soundingId);
    this.emitState();
  }

  private recordSoundingFailed(soundingId: string): void {
    const accumulator = this.activeSoundings.get(soundingId);
    if (!accumulator) {
      return;
    }
    this.emitOutputPackets(accumulator, 'error', Math.max(12, accumulator.inputTokens * 0.02));
    this.emitImpact(accumulator, 'failed');
    this.activeSoundings.delete(soundingId);
    this.emitState();
  }

  private emitImpact(accumulator: SoundingAccumulator, status: VisualizationImpact['status']): void {
    const at = nowIso();
    const totalNewTokens =
      accumulator.userTokens +
      accumulator.deltaTokens +
      accumulator.toolCallTokens +
      accumulator.toolResultTokens +
      accumulator.assistantTokens;
    const totalTokens = Math.max(1, totalNewTokens + accumulator.replayTokens);
    const impact: VisualizationImpact = {
      id: `${accumulator.sounding.id}:${status}:${this.sequence++}`,
      soundingId: accumulator.sounding.id,
      at,
      p: elapsedSeconds(accumulator.startedAtMs),
      finishP: elapsedSeconds(Date.now()),
      inputMass: mass(accumulator.inputTokens),
      replayMass: mass(accumulator.replayTokens),
      userMass: mass(accumulator.userTokens),
      toolResultMass: mass(accumulator.toolResultTokens),
      toolCallMass: mass(accumulator.toolCallTokens),
      assistantMass: mass(accumulator.assistantTokens),
      newShare: clamp01(totalNewTokens / totalTokens),
      outputMass: mass(accumulator.outputTokens),
      status,
    };
    pushCapped(this.impacts, impact, 240);
    this.emit({ type: 'visualization.impact', at, impact });
  }

  private emitOutputPackets(accumulator: SoundingAccumulator, kind: VisualizationOutputPacket['kind'], tokens: number): void {
    const packetCount = Math.max(1, Math.min(18, Math.ceil(Math.sqrt(Math.max(1, tokens)) / 2)));
    const packetMass = mass(tokens / packetCount);
    for (let index = 0; index < packetCount; index += 1) {
      const at = nowIso();
      const packet: VisualizationOutputPacket = {
        id: `${accumulator.sounding.id}:${kind}:${this.sequence++}`,
        soundingId: accumulator.sounding.id,
        at,
        p: elapsedSeconds(accumulator.startedAtMs) + index * 0.08,
        amp: packetMass,
        mass: packetMass,
        kind,
      };
      pushCapped(this.outputPackets, packet, 600);
      this.emit({ type: 'visualization.output_packet', at, packet });
    }
  }

  private emitState(): void {
    const at = nowIso();
    this.emit({ type: 'visualization.state', at, state: this.currentState() });
  }

  private snapshot(): VisualizationSnapshot {
    return {
      meta: {
        startedAt: this.startedAt,
        lastAt: this.lastAt,
        impactCount: this.impacts.length,
        packetCount: this.outputPackets.length,
      },
      impacts: [...this.impacts],
      outputPackets: [...this.outputPackets],
      state: this.currentState(),
    };
  }

  private currentState(): VisualizationState {
    return stateFrom([...this.activeSoundings.values()], this.impacts, this.outputPackets, this.soundQueued, this.subscribers.size);
  }

  private emit(event: VisualizationEvent): void {
    this.lastAt = event.at;
    for (const subscriber of this.subscribers) {
      subscriber(event);
    }
  }
}

function stateFrom(
  activeAccumulators: SoundingAccumulator[],
  impacts: VisualizationImpact[],
  packets: VisualizationOutputPacket[],
  soundQueued: boolean,
  subscriberCount: number,
): VisualizationState {
  const activeSoundings = activeAccumulators.length;
  const recentImpacts = impacts.slice(-24);
  const recentPackets = packets.slice(-48);
  const replay = recentImpacts.reduce((sum, impact) => sum + impact.replayMass + impact.inputMass * 0.35, 0);
  const output = recentPackets.reduce((sum, packet) => sum + packet.mass, 0);
  const tool = recentImpacts.reduce((sum, impact) => sum + impact.toolResultMass, 0);
  const call = recentImpacts.reduce((sum, impact) => sum + impact.toolCallMass, 0);
  const mode = modeFrom(activeSoundings, soundQueued, subscriberCount, recentPackets);
  return {
    activeSoundings,
    subscriberCount,
    mode,
    queued: soundQueued ? 1 : 0,
    digestion: 0,
    thinking: activeSoundings ? 1 : 0,
    pressure: clamp01(0.12 + replay / 20 + activeSoundings * 0.12),
    output: clamp01(output / 18),
    tool: clamp01(tool / 12),
    call: clamp01(call / 12),
  };
}

function modeFrom(
  activeSoundings: number,
  soundQueued: boolean,
  subscriberCount: number,
  recentPackets: VisualizationOutputPacket[],
): VisualizationState['mode'] {
  const now = Date.now();
  const freshPackets = recentPackets.filter(packet => now - Date.parse(packet.at) < 4_500);
  const latestPacket = freshPackets.at(-1);
  if (latestPacket?.kind === 'error') return 'error';
  if (latestPacket?.kind === 'tool_call') return 'tool_call';
  if (latestPacket?.kind === 'tool_result') return 'tool_result';
  if (latestPacket?.kind === 'assistant_output') return 'output';
  if (activeSoundings > 0) return 'thinking';
  if (soundQueued) return 'queued';
  return subscriberCount > 0 ? 'listening' : 'idle';
}

function inboxTokens(sounding: Sounding): number {
  return sounding.deltas
    .filter(delta => delta.stream === 'inbox')
    .reduce((sum, delta) => sum + estimateModelValue(delta.payload).tokens, 0);
}

function usageOutputTokens(usage: unknown): number {
  if (!isRecord(usage)) {
    return 0;
  }
  return numberValue(usage.outputTokens) || numberValue(usage.output_tokens);
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function mass(tokens: number): number {
  return clamp01(Math.log10(1 + Math.max(0, tokens)) / 5.2);
}

function elapsedSeconds(startedAtMs: number): number {
  return Math.max(0, (Date.now() - startedAtMs) / 1000);
}

function pushCapped<T>(items: T[], item: T, limit: number): void {
  items.push(item);
  while (items.length > limit) {
    items.shift();
  }
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function nowIso(): string {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
