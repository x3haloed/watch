import { jsonSchema, tool } from 'ai';
import type { LookoutToolContext } from './context.js';

export function createMemoryTools(ctx: LookoutToolContext) {
  return {
    memory_note: tool({
      description: 'Capture an experience that may matter later. This stores an episode, not curated scratchpad truth.',
      inputSchema: jsonSchema<{ kind: string; text: string; summary?: string; tags?: string[] }>({
        type: 'object',
        properties: {
          kind: { type: 'string' },
          text: { type: 'string' },
          summary: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
        },
        required: ['kind', 'text'],
        additionalProperties: false,
      }),
      execute: async ({ kind, text, summary, tags }) => {
        const record = ctx.memory.captureEpisode({ kind, text, summary, tags, provenance: { sources: ['tool:memory_note'] }, confidence: 0.5 });
        ctx.log.append({ type: 'memory_captured', at: new Date().toISOString(), memoryId: record.id, layer: record.layer, kind: record.kind, source: 'manual', provenance: record.provenance });
        return { ok: true, record };
      },
    }),
    memory_search: tool({
      description: 'Search lattice memories. Results are candidates, not guaranteed truth.',
      inputSchema: jsonSchema<{ query: string; layer?: 'episode' | 'pattern' | 'principle'; limit?: number }>({
        type: 'object',
        properties: {
          query: { type: 'string' },
          layer: { type: 'string', enum: ['episode', 'pattern', 'principle'] },
          limit: { type: 'number' },
        },
        required: ['query'],
        additionalProperties: false,
      }),
      execute: async ({ query, layer, limit }) => ({ ok: true, entries: ctx.memory.search(query, { layer, limit }) }),
    }),
    memory_reinforce: tool({
      description: 'Mark a retrieved memory as used, cited, or successful.',
      inputSchema: jsonSchema<{ id: string; outcome?: 'used' | 'success' | 'cited' }>({
        type: 'object',
        properties: {
          id: { type: 'string' },
          outcome: { type: 'string', enum: ['used', 'success', 'cited'] },
        },
        required: ['id'],
        additionalProperties: false,
      }),
      execute: async ({ id, outcome }) => {
        const record = ctx.memory.reinforce(id, outcome);
        ctx.log.append({ type: 'memory_reinforced', at: new Date().toISOString(), memoryId: record.id, outcome: outcome ?? 'used' });
        return { ok: true, record };
      },
    }),
    memory_mark_irrelevant: tool({
      description: 'Mark a retrieved memory as noise for this context.',
      inputSchema: jsonSchema<{ id: string; reason: string }>({
        type: 'object',
        properties: { id: { type: 'string' }, reason: { type: 'string' } },
        required: ['id', 'reason'],
        additionalProperties: false,
      }),
      execute: async ({ id, reason }) => {
        const record = ctx.memory.markIrrelevant(id, reason);
        ctx.log.append({ type: 'memory_irrelevant', at: new Date().toISOString(), memoryId: record.id, reason });
        return { ok: true, record };
      },
    }),
    memory_distill: tool({
      description: 'Create a pattern or principle from parent memories. Use this for model-authored meaning, never automatic promotion.',
      inputSchema: jsonSchema<{ layer: 'pattern' | 'principle'; parents: string[]; text: string; rationale: string; kind?: string; tags?: string[] }>({
        type: 'object',
        properties: {
          layer: { type: 'string', enum: ['pattern', 'principle'] },
          parents: { type: 'array', items: { type: 'string' } },
          text: { type: 'string' },
          rationale: { type: 'string' },
          kind: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
        },
        required: ['layer', 'parents', 'text', 'rationale'],
        additionalProperties: false,
      }),
      execute: async ({ layer, parents, text, rationale, kind, tags }) => {
        const record = ctx.memory.distill({ layer, parents, text, rationale, kind, tags });
        ctx.log.append({ type: 'memory_distilled', at: new Date().toISOString(), memoryId: record.id, layer: record.layer, parents: record.parents });
        return { ok: true, record };
      },
    }),
    memory_contradict: tool({
      description: 'Mark a memory as contradicted and attach evidence.',
      inputSchema: jsonSchema<{ id: string; evidence: string; rationale: string }>({
        type: 'object',
        properties: { id: { type: 'string' }, evidence: { type: 'string' }, rationale: { type: 'string' } },
        required: ['id', 'evidence', 'rationale'],
        additionalProperties: false,
      }),
      execute: async ({ id, evidence, rationale }) => {
        const record = ctx.memory.contradict(id, evidence, rationale);
        ctx.log.append({ type: 'memory_contradicted', at: new Date().toISOString(), memoryId: record.id, rationale });
        return { ok: true, record };
      },
    }),
    memory_mark_stale: tool({
      description: 'Mark a memory as stale so it stops appearing as ordinary active context.',
      inputSchema: jsonSchema<{ id: string; reason: string }>({
        type: 'object',
        properties: { id: { type: 'string' }, reason: { type: 'string' } },
        required: ['id', 'reason'],
        additionalProperties: false,
      }),
      execute: async ({ id, reason }) => {
        const record = ctx.memory.markStale(id, reason);
        ctx.log.append({ type: 'memory_stale', at: new Date().toISOString(), memoryId: record.id, reason });
        return { ok: true, record };
      },
    }),
    memory_propose_scratchpad_update: tool({
      description: 'Propose curated scratchpad text from stable memories. This does not edit the scratchpad.',
      inputSchema: jsonSchema<{ memoryIds: string[]; text: string; rationale: string }>({
        type: 'object',
        properties: {
          memoryIds: { type: 'array', items: { type: 'string' } },
          text: { type: 'string' },
          rationale: { type: 'string' },
        },
        required: ['memoryIds', 'text', 'rationale'],
        additionalProperties: false,
      }),
      execute: async ({ memoryIds, text, rationale }) => {
        const record = ctx.memory.proposeScratchpadUpdate({ memoryIds, text, rationale });
        ctx.log.append({ type: 'memory_scratchpad_proposed', at: new Date().toISOString(), memoryId: record.id, memoryIds });
        return { ok: true, record };
      },
    }),
  };
}
