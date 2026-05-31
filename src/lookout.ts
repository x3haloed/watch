import { ToolLoopAgent, gateway, jsonSchema, stepCountIs, tool } from 'ai';
import type { LanguageModel, ModelMessage } from 'ai';
import type { Sounding } from './types.js';
import { StreamRegistry } from './streams.js';
import { EventLog } from './event-log.js';

export class ModelReroute extends Error {
  constructor(readonly toModelId: string, readonly params: Record<string, unknown>) {
    super(`Reroute current Sounding to ${toModelId}`);
  }
}

export class Lookout {
  private readonly messages: ModelMessage[] = [];
  private activeModelId: string;

  constructor(
    private readonly streams: StreamRegistry,
    private readonly log: EventLog,
    private readonly availableModels: string[],
    initialModelId: string,
    private readonly noModel: boolean,
  ) {
    this.activeModelId = initialModelId;
  }

  get modelId(): string {
    return this.activeModelId;
  }

  async receive(sounding: Sounding): Promise<string> {
    if (this.noModel || !process.env.AI_GATEWAY_API_KEY) {
      const reason = this.noModel ? 'no-model mode is enabled' : 'AI_GATEWAY_API_KEY is not set';
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
        return await this.runOnce(currentSounding, reroute);
      } catch (error) {
        if (!(error instanceof ModelReroute)) {
          throw error;
        }

        const fromModelId = this.activeModelId;
        this.activeModelId = error.toModelId;
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
        currentSounding = { ...currentSounding, modelId: error.toModelId };
      }
    }

    throw new Error('Too many model reroutes for one Sounding');
  }

  private async runOnce(
    sounding: Sounding,
    reroute?: { fromModelId: string; toModelId: string; params: Record<string, unknown> },
  ): Promise<string> {
    const prompt = this.formatSounding(sounding, reroute);
    this.messages.push({ role: 'user', content: prompt });

    try {
      const agent = new ToolLoopAgent({
        model: gateway(this.activeModelId) as LanguageModel,
        instructions: LOOKOUT_INSTRUCTIONS,
        tools: this.createTools(sounding),
        stopWhen: stepCountIs(20),
      });

      const result = await agent.generate({
        messages: this.messages,
      });

      this.messages.push({ role: 'assistant', content: result.text });
      return result.text;
    } catch (error) {
      if (error instanceof ModelReroute) {
        this.messages.pop();
      }
      throw error;
    }
  }

  private createTools(sounding: Sounding) {
    return {
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
          if (!this.availableModels.includes(modelId)) {
            return { ok: false, error: `Unknown model: ${modelId}`, availableModels: this.availableModels };
          }
          throw new ModelReroute(modelId, { modelId });
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

  private formatSounding(
    sounding: Sounding,
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
active_model: ${this.activeModelId}
available-models:
${this.availableModels.map(model => `- ${model}`).join('\n')}
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
Use subscribe_stream and unsubscribe_stream to control your gaze.
Use handle_with_model when the current Sounding calls for a different model substrate.
Do not narrate internal routing unless it matters to an external observer.`;
