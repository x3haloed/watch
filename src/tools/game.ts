import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import type { LookoutToolContext } from './context.js';

type GameActionOutput = {
  observation: Record<string, unknown>;
  camera?: string;
};

export function createGameTools(ctx: LookoutToolContext): ToolSet {
  if (!ctx.game) return {};
  const client = new GameClient(ctx.game.controlUrl, ctx.game.actionTimeoutMs);
  return {
    game_state: tool({
      description: 'Inspect the current synchronized game frame, body state, roster, and latest authoritative result.',
      inputSchema: z.object({}),
      execute: () => client.state(),
    }),
    frame_action: tool({
      description: 'Submit one body action, wait for the shared physics step, and see the resulting camera frame.',
      inputSchema: z.object({
        frameId: z.number().int().optional(),
        kind: z.enum(['drive', 'hold']).default('drive').describe(
          'hold represents authored stationary braking with provenance distinct from a timeout.',
        ),
        throttle: z.number().min(-1).max(1).default(0),
        steering: z.number().min(-1).max(1).default(0),
        brake: z.boolean().default(false),
        cameraTier: z.enum(['standard', 'inspection']).default('standard').describe(
          'Standard returns a compact 960x180 temporal contact strip; inspection returns one higher-detail 960x540 final view.',
        ),
      }),
      execute: input => client.act(input),
      toModelOutput: ({ output }) => {
        const result = output as GameActionOutput;
        return {
          type: 'content',
          value: [
            { type: 'text', text: observationText(result.observation) },
            ...(result.camera ? [{ type: 'media' as const, data: result.camera, mediaType: 'image/webp' }] : []),
          ],
        };
      },
    }),
  };
}

class GameClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(baseUrl: string, timeoutMs = 60_000) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
  }

  state(): Promise<Record<string, unknown>> {
    return this.json('/state');
  }

  async act(input: {
    frameId?: number;
    kind: 'drive' | 'hold';
    throttle: number;
    steering: number;
    brake: boolean;
    cameraTier: 'standard' | 'inspection';
  }): Promise<GameActionOutput> {
    const before = input.frameId === undefined ? await this.readyState() : await this.state();
    const frameId = input.frameId ?? Number(before.frame_id);
    await this.json('/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        frame_id: frameId,
        kind: input.kind ?? 'drive',
        throttle: input.throttle,
        steering: input.steering,
        brake: input.brake,
      }),
    });
    const observation = await this.waitForFrame(frameId);
    return { observation, camera: await this.camera(input.cameraTier ?? 'standard') };
  }

  private async readyState(): Promise<Record<string, unknown>> {
    return this.poll(state =>
      state.registered === true
      && state.accepting_actions === true
      && Number(state.frame_id) > Number((state.latest_result as Record<string, unknown> | undefined)?.frame_id ?? 0)
      && Number(state.submitted_frame_id ?? 0) !== Number(state.frame_id)
    );
  }

  private waitForFrame(frameId: number): Promise<Record<string, unknown>> {
    return this.poll(state =>
      Number((state.latest_result as Record<string, unknown> | undefined)?.frame_id ?? 0) >= frameId
    );
  }

  private async poll(done: (state: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      const state = await this.state();
      if (done(state)) return state;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Timed out waiting for the synchronized game frame.');
  }

  private async camera(tier: 'standard' | 'inspection'): Promise<string | undefined> {
    const path = tier === 'inspection' ? '/camera/inspection' : '/camera/contact-strip';
    const response = await fetch(`${this.baseUrl}${path}`);
    if (response.status === 503) return undefined;
    if (!response.ok) throw new Error(`GET ${path} failed (${response.status}): ${await response.text()}`);
    return Buffer.from(await response.arrayBuffer()).toString('base64');
  }

  private async json(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
    const response = await fetch(`${this.baseUrl}${path}`, init);
    const text = await response.text();
    const value = JSON.parse(text) as Record<string, unknown>;
    if (!response.ok) throw new Error(`${path} failed (${response.status}): ${String(value.message ?? text)}`);
    return value;
  }
}

function observationText(state: Record<string, unknown>): string {
  const result = state.latest_result as Record<string, unknown> | undefined;
  return JSON.stringify({
    frame_id: result?.frame_id,
    next_frame_id: state.frame_id,
    simulation_delta: result?.simulation_delta,
    action_kind: result?.action_kind,
    participant_id: state.participant_id,
    personal_state: state.personal_state,
    roster: state.roster,
  });
}
