import { ToolLoopAgent, gateway, jsonSchema, stepCountIs, tool } from 'ai';
import type { LanguageModel, ModelMessage } from 'ai';
import type { Sounding } from './types.js';
import { StreamRegistry } from './streams.js';
import { EventLog } from './event-log.js';

type Reroute = {
  toModelId: string;
};

export class ModelReroute extends Error {
  constructor(readonly toModelId: string) {
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
  ) {
    this.activeModelId = initialModelId;
  }

  get modelId(): string {
    return this.activeModelId;
  }

  async receive(sounding: Sounding): Promise<string> {
    if (!process.env.AI_GATEWAY_API_KEY) {
      this.log.append({
        type: 'model_skipped',
        at: new Date().toISOString(),
        soundingId: sounding.id,
        reason: 'AI_GATEWAY_API_KEY is not set',
      });
      return '[model skipped: AI_GATEWAY_API_KEY is not set]';
    }

    let attempts = 0;
    let currentSounding = sounding;

    while (attempts < 3) {
      attempts += 1;
      try {
        return await this.runOnce(currentSounding);
      } catch (error) {
        if (!(error instanceof ModelReroute)) {
          throw error;
        }

        const fromModelId = this.activeModelId;
        this.activeModelId = error.toModelId;
        this.log.append({
          type: 'model_reroute',
          at: new Date().toISOString(),
          soundingId: currentSounding.id,
          fromModelId,
          toModelId: error.toModelId,
        });
        currentSounding = { ...currentSounding, modelId: error.toModelId };
      }
    }

    throw new Error('Too many model reroutes for one Sounding');
  }

  private async runOnce(sounding: Sounding): Promise<string> {
    const prompt = this.formatSounding(sounding);
    this.messages.push({ role: 'user', content: prompt });

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
          throw new ModelReroute(modelId);
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

  private formatSounding(sounding: Sounding): string {
    const deltas = sounding.deltas
      .map(delta => `${delta.stream}: ${JSON.stringify(delta.payload)} @ ${delta.at}`)
      .join('\n');

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
[/deltas]`;
  }
}

const LOOKOUT_INSTRUCTIONS = `You are the Lookout inside Watch.
Watch is a continuous agent harness. You do not wait for user prompts; you receive Soundings from the CFF loop.
Treat incoming user messages as inbox deltas, not commands that automatically define your next action.
Use subscribe_stream and unsubscribe_stream to control your gaze.
Use handle_with_model when the current Sounding calls for a different model substrate.
Do not narrate internal routing unless it matters to an external observer.`;
