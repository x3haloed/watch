import { jsonSchema, tool } from 'ai';
import type { LookoutToolContext } from './context.js';

export function createScratchpadTools(ctx: LookoutToolContext) {
  return {
    scratchpad_read: tool({
      description:
        'Read the persistent scratchpad. AGENT.md is your current durable orientation; USER.md is notes from the user to you. USER.md is user-owned and cannot be modified through scratchpad tools.',
      inputSchema: jsonSchema<Record<string, never>>({
        type: 'object',
        properties: {},
        additionalProperties: false,
      }),
      execute: async () => ctx.scratchpad?.read() ?? { ok: false, error: 'Scratchpad is not configured.' },
    }),
    scratchpad_update_agent: tool({
      description:
        'Replace AGENT.md, your persistent scratchpad across sessions. Save durable facts and current orientation that will still matter later: user preferences from USER.md, environment details, tool quirks, stable conventions, and reminders that reduce future user steering. Do NOT save task progress, session outcomes, completed-work logs, or temporary TODO state. If a fact will be stale in a week, it does not belong in AGENT.md. Use the ledger for testimony/session history. Write notes as declarative facts, not instructions to yourself. The result reads back the final saved AGENT.md content so you can verify the write stuck. This tool cannot modify USER.md.',
      inputSchema: jsonSchema<{ content: string }>({
        type: 'object',
        properties: {
          content: { type: 'string', description: 'Complete replacement content for AGENT.md. Keep it compact, current, and declarative.' },
        },
        required: ['content'],
        additionalProperties: false,
      }),
      execute: async ({ content }) => {
        if (!ctx.scratchpad) {
          return { ok: false, error: 'Scratchpad is not configured.' };
        }
        const result = ctx.scratchpad.updateAgent(content, ctx.memory);
        ctx.log.append({
          type: 'memory_updated',
          at: new Date().toISOString(),
          target: 'scratchpad',
          payload: { file: 'AGENT.md', chars: content.trim().length, capturedMemoryIds: result.captured.map(record => record.id) },
        });
        for (const record of result.captured) {
          ctx.log.append({
            type: 'memory_captured',
            at: new Date().toISOString(),
            memoryId: record.id,
            layer: record.layer,
            kind: record.kind,
            source: 'scratchpad_update_agent',
            provenance: record.provenance,
          });
        }
        return result;
      },
    }),
  };
}
