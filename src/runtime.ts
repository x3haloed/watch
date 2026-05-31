import { randomUUID } from 'node:crypto';
import type { ControlRequest, ControlResponse, Sounding, WatchConfig } from './types.js';
import { EventLog } from './event-log.js';
import { Lookout } from './lookout.js';
import { StreamRegistry } from './streams.js';

export class WatchRuntime {
  private readonly streams = new StreamRegistry();
  private readonly log: EventLog;
  private readonly lookout: Lookout;
  private lastSoundingAt = Date.now();
  private running = false;
  private tickTimer: NodeJS.Timeout | undefined;
  private clockTimer: NodeJS.Timeout | undefined;
  private lastClockSecond = '';

  constructor(private readonly config: WatchConfig) {
    this.log = new EventLog(config.repoRoot);
    this.lookout = new Lookout(this.streams, this.log, config.availableModels, config.modelId);
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
      const delta = this.streams.push('inbox', {
        source: request.source ?? 'cli',
        message: request.message,
      });
      if (delta) {
        this.log.append({ type: 'stream_delta', at: new Date().toISOString(), delta });
      }
      return { ok: true, data: { accepted: Boolean(delta) } };
    }

    if (request.command === 'status') {
      return {
        ok: true,
        data: {
          pid: process.pid,
          modelId: this.lookout.modelId,
          subscriptions: this.streams.listSubscriptions(),
          minCffMs: this.config.minCffMs,
          maxCffMs: this.config.maxCffMs,
          pendingDeltas: this.streams.hasPending(),
        },
      };
    }

    if (request.command === 'sound') {
      await this.sound('manual');
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
    const delta = this.streams.push('clock', {
      iso: now.toISOString(),
      epochMs: now.getTime(),
    });
    if (delta) {
      this.log.append({ type: 'stream_delta', at: new Date().toISOString(), delta });
    }
  }

  private async maybeSound(): Promise<void> {
    if (!this.running) {
      return;
    }

    const elapsed = Date.now() - this.lastSoundingAt;
    if ((elapsed >= this.config.minCffMs && this.streams.hasPending()) || elapsed >= this.config.maxCffMs) {
      await this.sound(elapsed >= this.config.maxCffMs ? 'heartbeat' : 'delta');
    }
  }

  private async sound(trigger: Sounding['trigger']): Promise<void> {
    const now = Date.now();
    const sounding: Sounding = {
      id: randomUUID(),
      at: new Date(now).toISOString(),
      lastFlickerMs: now - this.lastSoundingAt,
      trigger,
      deltas: this.streams.drain(),
      modelId: this.lookout.modelId,
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
  }
}
