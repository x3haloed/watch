import { randomUUID } from 'node:crypto';
import type { ControlRequest, ControlResponse, Sounding, WatchConfig } from './types.js';
import { EventLog } from './event-log.js';
import { Lookout } from './lookout.js';
import { StreamRegistry } from './streams.js';
import { ModelRegistry } from './model-registry.js';

export class WatchRuntime {
  private readonly streams = new StreamRegistry();
  private readonly log: EventLog;
  private readonly lookout: Lookout;
  private readonly models: ModelRegistry;
  private lastSoundingAt = Date.now();
  private running = false;
  private tickTimer: NodeJS.Timeout | undefined;
  private clockTimer: NodeJS.Timeout | undefined;
  private lastClockSecond = '';
  private soundingActive = false;
  private soundQueued = false;
  private queuedTrigger: Sounding['trigger'] = 'delta';

  constructor(private readonly config: WatchConfig) {
    this.log = new EventLog(config.repoRoot);
    this.models = ModelRegistry.load(config.repoRoot, config.defaultModel, config.availableModels);
    this.lookout = new Lookout(this.streams, this.log, this.models, config.noModel);
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.log.append({ type: 'daemon_started', at: new Date().toISOString(), pid: process.pid, config: this.config });
    this.clockTimer = setInterval(() => this.sampleClock(), 250);
    this.tickTimer = setInterval(() => void this.maybeSound(), 100);
  }

  async stop(reason = 'control request'): Promise<void> {
    this.running = false;
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.clockTimer) clearInterval(this.clockTimer);
    this.log.append({ type: 'daemon_stopped', at: new Date().toISOString(), reason });
  }

  async handle(request: ControlRequest): Promise<ControlResponse> {
    this.log.append({
      type: 'control_message',
      at: new Date().toISOString(),
      command: request.command,
      payload: request.command === 'send' ? { source: request.source ?? 'cli' } : undefined,
    });

    if (request.command === 'send') {
      const accepted = this.streams.push('inbox', {
        source: request.source ?? 'cli',
        message: request.message,
      });
      if (accepted) {
        this.log.append({
          type: 'stream_buffered',
          at: new Date().toISOString(),
          stream: 'inbox',
          payload: { source: request.source ?? 'cli' },
        });
      }
      return { ok: true, data: { accepted } };
    }

    if (request.command === 'status') {
      return {
        ok: true,
        data: {
          pid: process.pid,
          modelId: this.lookout.modelId,
          availableModels: this.models.listModelIds(),
          activeModel: await this.models.getActive(),
          subscriptions: this.streams.listSubscriptions(),
          minCffMs: this.config.minCffMs,
          maxCffMs: this.config.maxCffMs,
          noModel: this.config.noModel,
          soundingActive: this.soundingActive,
          soundQueued: this.soundQueued,
          pendingDeltas: this.streams.hasPending(),
        },
      };
    }

    if (request.command === 'sound') {
      void this.sound('manual');
      return { ok: true };
    }

    if (request.command === 'stop') {
      await this.stop();
      return { ok: true };
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

    const elapsed = Date.now() - this.lastSoundingAt;
    const trigger = elapsed >= this.config.maxCffMs ? 'heartbeat' : 'delta';
    if ((elapsed >= this.config.minCffMs && this.streams.hasPending()) || elapsed >= this.config.maxCffMs) {
      void this.sound(trigger);
    }
  }

  private async sound(trigger: Sounding['trigger']): Promise<void> {
    if (this.soundingActive) {
      this.soundQueued = true;
      this.queuedTrigger = this.queuedTrigger === 'heartbeat' || trigger === 'heartbeat' ? 'heartbeat' : trigger;
      return;
    }

    this.soundingActive = true;
    let nextTrigger: Sounding['trigger'] | undefined = trigger;

    try {
      while (nextTrigger) {
        this.soundQueued = false;
        const activeTrigger = nextTrigger;
        nextTrigger = undefined;

        const model = await this.models.getActive();
        const now = Date.now();
        const popAt = new Date(now);
        const deltas = this.streams.popDeltas({ now: popAt, capabilities: model.capabilities });
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
        this.lastSoundingAt = now;
        this.log.append({ type: 'sounding_started', at: new Date().toISOString(), sounding });

        const text = await this.lookout.receive(sounding);
        this.log.append({
          type: 'sounding_finished',
          at: new Date().toISOString(),
          soundingId: sounding.id,
          modelId: this.lookout.modelId,
          text,
        });

        if (this.soundQueued || this.streams.hasPending()) {
          nextTrigger = this.queuedTrigger;
          this.queuedTrigger = 'delta';
        }
      }
    } finally {
      this.soundingActive = false;
    }
  }
}
