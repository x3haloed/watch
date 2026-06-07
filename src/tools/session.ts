import { jsonSchema, tool } from 'ai';
import type { ResolvedModel, Sounding } from '../types.js';
import { estimateModelValue, estimateTextTokens } from '../token-estimator.js';
import type { LookoutToolContext } from './context.js';

export function createSessionTools(ctx: LookoutToolContext, sounding: Sounding) {
  return {
    curl: tool({
      description:
        'End the current self-session cleanly. Optionally append a ledger entry to the configured ledger, then clear Watch conversation history so the next Sounding re-enters from cold instructions and fresh context.',
      inputSchema: jsonSchema<{ ledgerEntry?: string }>({
        type: 'object',
        properties: {
          ledgerEntry: {
            type: 'string',
            description:
              'Optional text to append to the configured ledger before clearing context. Shape the heading/body however you want; Watch adds a separator and timestamp.',
          },
        },
        additionalProperties: false,
      }),
      execute: async ({ ledgerEntry }) => ctx.session.curl(sounding.id, ledgerEntry),
    }),
    reboot: tool({
      description:
        'Cleanly reboot Watch. This first performs curl semantics: optionally append a ledger entry, clear conversation history, then request a full daemon restart after the current Sounding returns.',
      inputSchema: jsonSchema<{ ledgerEntry?: string }>({
        type: 'object',
        properties: {
          ledgerEntry: {
            type: 'string',
            description:
              'Optional text to append to the configured ledger before clearing context and rebooting. Use this to preserve what matters before restart.',
          },
        },
        additionalProperties: false,
      }),
      execute: async ({ ledgerEntry }) => {
        const result = await ctx.session.curl(sounding.id, ledgerEntry);
        if (!result.ok) {
          return result;
        }
        const request = ctx.session.requestReboot('tool', result);
        ctx.log.append({
          type: 'reboot_requested',
          at: new Date().toISOString(),
          soundingId: sounding.id,
          ledgerPath: request.ledgerPath,
          wroteLedger: request.wroteLedger,
          clearedMessages: request.clearedMessages,
          source: 'tool',
        });
        return {
          ...result,
          reboot: true,
          next: 'Watch will restart the daemon after this Sounding completes.',
        };
      },
    }),
    handle_with_model: tool({
      description:
        'Switch the current Sounding to another model immediately. The next inference step continues on that model from the current tool result, without replaying the Sounding.',
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
        if (!ctx.models.listModelIds().includes(modelId)) {
          return { ok: false, error: `Unknown model: ${modelId}`, availableModels: ctx.models.listModelIds() };
        }
        let model: ResolvedModel;
        try {
          model = await ctx.models.resolve(modelId);
          if (!model.capabilities.tools) {
            return { ok: false, error: `Model ${modelId} is not supported by Watch because tool_call is false or unknown.` };
          }
          const fit = await ctx.contextFitFor(model);
          if (!fit.ok) {
            return {
              ok: false,
              error: `Cannot hand this Sounding to ${modelId}: its context window is too small for the current Watch session.`,
              context: fit,
              why: `Watch estimates ${fit.usedTokensEstimate} context tokens plus ${fit.maxOutputTokens} reserved output tokens, requiring about ${fit.requiredTokensEstimate} tokens. ${modelId} reports a ${fit.limitTokens} token context window.`,
              options: [
                'Call curl with a ledgerEntry to preserve what matters and clear the current session history.',
                'Choose a model with a larger context window.',
              ],
            };
          }
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
        return ctx.switchModelForCurrentSounding({ modelId, model, params: { modelId } });
      },
    }),
    session_dashboard: tool({
      description:
        'Return a minimal current session snapshot: rough context estimate, model roster, and stream subscriptions.',
      inputSchema: jsonSchema<Record<string, never>>({
        type: 'object',
        properties: {},
        additionalProperties: false,
      }),
      execute: async () => {
        const [activeModel, allAvailable, instructions] = await Promise.all([
          ctx.models.getActive(),
          ctx.models.resolveAll(),
          ctx.instructions(),
        ]);
        return {
          ok: true,
          context: await ctx.contextFitFor(activeModel),
          estimatedBreakdown: {
            instructionsTokens: estimateTextTokens(instructions),
            messageTokens: estimateModelValue(ctx.messages).tokens,
          },
          model: {
            current: activeModel.id,
            allAvailable,
          },
          streams: {
            subscriptions: ctx.streams.listSubscriptions(),
            notSubscribed: ctx.streams.listNotSubscribed(),
          },
        };
      },
    }),
  };
}
