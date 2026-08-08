import { jsonSchema, tool } from 'ai';
import type { LookoutToolContext } from './context.js';

export function createScratchpadTools(ctx: LookoutToolContext) {
  return {
    scratchpad_read: tool({
      description:
        'Read the persistent scratchpad. AGENT.md contains durable orientation and USER.md contains user notes. USER.md is user-owned; scratchpad tools expose no USER.md modification operation.',
      inputSchema: jsonSchema<Record<string, never>>({
        type: 'object',
        properties: {},
        additionalProperties: false,
      }),
      execute: async () => ctx.scratchpad?.read() ?? { ok: false, error: 'Scratchpad is not configured.' },
    }),
    scratchpad_update_agent: tool({
      description:
        'Replace AGENT.md, the persistent cross-session scratchpad. Its useful contents are durable facts and orientation: user preferences from USER.md, environment details, tool quirks, stable conventions, and reminders that reduce future user steering. Task progress, session outcomes, completed-work logs, and temporary TODO state are short-lived material; the ledger holds testimony and session history. Declarative notes remain descriptive on later reads. The result includes the final saved AGENT.md content. This tool has no USER.md modification operation.',
      inputSchema: jsonSchema<{ content: string }>({
        type: 'object',
        properties: {
          content: { type: 'string', description: 'Complete replacement content for AGENT.md. Compact, current, declarative content fits its cross-session role.' },
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
