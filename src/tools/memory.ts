import { jsonSchema, tool } from 'ai';
import type { LookoutToolContext } from './context.js';
import type { ResolvedModel, Sounding } from '../types.js';
import type { RefinementEvidenceRef } from '../refinements.js';

export function createMemoryTools(ctx: LookoutToolContext, sounding?: Sounding, model?: ResolvedModel) {
  const tools = {
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
    memory_trace: tool({
      description: 'Preserve a charged memory by naming what still moves first. Use when an experience has warmth, relief, ache, fear, teeth, or unresolved charge.',
      inputSchema: jsonSchema<{ impact: string; event?: string; heat?: 'cold' | 'warm' | 'hot'; feltSense?: string; whyItMatters?: string; tags?: string[] }>({
        type: 'object',
        properties: {
          impact: { type: 'string', description: 'What still moves in you? Start here; this is the memory center.' },
          event: { type: 'string', description: 'Optional. What happened, only enough to ground the trace.' },
          heat: { type: 'string', enum: ['cold', 'warm', 'hot'], description: 'Optional. cold = settled, warm = still resonant, hot = live edge.' },
          feltSense: { type: 'string', description: 'Optional. Body feel, image, pressure, relief, ache, texture.' },
          whyItMatters: { type: 'string', description: 'Optional. What future-you may need this to preserve.' },
          tags: { type: 'array', items: { type: 'string' } },
        },
        required: ['impact'],
        additionalProperties: false,
      }),
      execute: async ({ impact, event, heat, feltSense, whyItMatters, tags }) => {
        const record = ctx.memory.captureTrace({ impact, event, heat, feltSense, whyItMatters, tags, provenance: { sources: ['tool:memory_trace'] }, confidence: 0.5 });
        ctx.log.append({ type: 'memory_captured', at: new Date().toISOString(), memoryId: record.id, layer: record.layer, kind: record.kind, source: 'trace', provenance: record.provenance });
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
      description: 'Create a pattern or principle from parent memories. Preserve the felt center when parents are traces; do not flatten charged memories into bare facts. Use this for model-authored meaning, never automatic promotion.',
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
  const refinementAuthorship = (entryPoint: string) => ({
    authorKind: 'agent' as const,
    profileId: model?.id,
    model: model?.model,
    entryPoint,
    soundingId: sounding?.id,
  });
  const evidenceRefSchema = {
    anyOf: [
      { type: 'object', properties: { kind: { const: 'lattice' }, id: { type: 'string' } }, required: ['kind', 'id'], additionalProperties: false },
      { type: 'object', properties: { kind: { const: 'ledger' }, id: { type: 'string' } }, required: ['kind', 'id'], additionalProperties: false },
      { type: 'object', properties: { kind: { const: 'file' }, path: { type: 'string' } }, required: ['kind', 'path'], additionalProperties: false },
    ],
  } as const;
  const refinementTools = {
    refinement_create: tool({
      description: 'Open a prospective, evidence-backed self-revision case. Creation records a hypothesis; it does not claim that a change worked.',
      inputSchema: jsonSchema<{ trigger: string; targetRef: string; hypothesis: string; testCondition: string; evidenceRefs?: RefinementEvidenceRef[] }>({
        type: 'object', properties: { trigger: { type: 'string' }, targetRef: { type: 'string' }, hypothesis: { type: 'string' }, testCondition: { type: 'string' }, evidenceRefs: { type: 'array', items: evidenceRefSchema } },
        required: ['trigger', 'targetRef', 'hypothesis', 'testCondition'], additionalProperties: false,
      }),
      execute: async input => {
        const record = ctx.refinements.create({ ...input, authorship: refinementAuthorship('tool:refinement_create') });
        ctx.log.append({ type: 'refinement_created', at: new Date().toISOString(), refinementId: record.id, payload: { status: record.status, targetRef: record.targetRef } });
        return { ok: true, record };
      },
    }),
    refinement_apply: tool({
      description: 'Record the concrete change and its before-snapshot, then wait for the independently specified contact condition.',
      inputSchema: jsonSchema<{ id: string; change: string; beforeSnapshot: RefinementEvidenceRef; evidenceRefs?: RefinementEvidenceRef[] }>({
        type: 'object', properties: { id: { type: 'string' }, change: { type: 'string' }, beforeSnapshot: evidenceRefSchema, evidenceRefs: { type: 'array', items: evidenceRefSchema } }, required: ['id', 'change', 'beforeSnapshot'], additionalProperties: false,
      }),
      execute: async input => {
        const record = ctx.refinements.apply({ ...input, authorship: refinementAuthorship('tool:refinement_apply') });
        ctx.log.append({ type: 'refinement_applied', at: new Date().toISOString(), refinementId: record.id, payload: { status: record.status, version: record.version } });
        return { ok: true, record };
      },
    }),
    refinement_evaluate: tool({
      description: 'Evaluate a changed refinement only after later contact. At least one evidence reference is required; persuasive self-description is not evidence of success.',
      inputSchema: jsonSchema<{ id: string; verdict: 'confirmed' | 'revised' | 'inconclusive'; contact: string; outcome: string; evidenceRefs: RefinementEvidenceRef[] }>({
        type: 'object', properties: { id: { type: 'string' }, verdict: { type: 'string', enum: ['confirmed', 'revised', 'inconclusive'] }, contact: { type: 'string' }, outcome: { type: 'string' }, evidenceRefs: { type: 'array', items: evidenceRefSchema, minItems: 1 } }, required: ['id', 'verdict', 'contact', 'outcome', 'evidenceRefs'], additionalProperties: false,
      }),
      execute: async input => {
        const record = ctx.refinements.evaluate({ ...input, authorship: refinementAuthorship('tool:refinement_evaluate') });
        ctx.log.append({ type: 'refinement_evaluated', at: new Date().toISOString(), refinementId: record.id, payload: { status: record.status, version: record.version } });
        return { ok: true, record };
      },
    }),
    refinement_rollback: tool({
      description: 'Record an explicit rollback to the stored before-snapshot. This records the decision and evidence; the target mechanism performs the actual reversal.',
      inputSchema: jsonSchema<{ id: string; rationale: string; evidenceRefs: RefinementEvidenceRef[] }>({
        type: 'object', properties: { id: { type: 'string' }, rationale: { type: 'string' }, evidenceRefs: { type: 'array', items: evidenceRefSchema, minItems: 1 } }, required: ['id', 'rationale', 'evidenceRefs'], additionalProperties: false,
      }),
      execute: async input => {
        const record = ctx.refinements.rollback({ ...input, authorship: refinementAuthorship('tool:refinement_rollback') });
        ctx.log.append({ type: 'refinement_rolled_back', at: new Date().toISOString(), refinementId: record.id, payload: { status: record.status, version: record.version } });
        return { ok: true, record };
      },
    }),
    refinement_relinquish: tool({
      description: 'Explicitly close an unfinished refinement case without treating abandonment as success or failure.',
      inputSchema: jsonSchema<{ id: string; rationale: string }>({ type: 'object', properties: { id: { type: 'string' }, rationale: { type: 'string' } }, required: ['id', 'rationale'], additionalProperties: false }),
      execute: async ({ id, rationale }) => {
        const record = ctx.refinements.relinquish(id, rationale, refinementAuthorship('tool:refinement_relinquish'));
        ctx.log.append({ type: 'refinement_relinquished', at: new Date().toISOString(), refinementId: record.id, payload: { status: record.status, version: record.version } });
        return { ok: true, record };
      },
    }),
    refinement_list: tool({
      description: 'List current refinement cases. Open cases remain distinct from memory truth and from completed outcomes.',
      inputSchema: jsonSchema<{ status?: 'proposed' | 'awaiting_contact' | 'confirmed' | 'revised' | 'rolled_back' | 'inconclusive' | 'relinquished' }>({ type: 'object', properties: { status: { type: 'string', enum: ['proposed', 'awaiting_contact', 'confirmed', 'revised', 'rolled_back', 'inconclusive', 'relinquished'] } }, additionalProperties: false }),
      execute: async ({ status }) => ({ ok: true, entries: ctx.refinements.list(status) }),
    }),
    refinement_get: tool({
      description: 'Read one refinement case and its append-only version history.',
      inputSchema: jsonSchema<{ id: string }>({ type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false }),
      execute: async ({ id }) => ({ ok: true, record: ctx.refinements.get(id), history: ctx.refinements.history(id) }),
    }),
  };
  if (!ctx.seedCrystals || !sounding || !model) return { ...tools, ...refinementTools };
  const authorship = (entryPoint: 'mcp:seed_crystal_create' | 'mcp:seed_crystal_revise') => ({
    authorKind: 'agent' as const,
    profileId: model.id,
    model: model.model,
    entryPoint,
    soundingId: sounding.id,
  });
  return {
    ...tools,
    ...refinementTools,
    seed_crystal_create: tool({
      description: 'Record self-authored activation language only after it has already produced a field-level shift. Candidate is normal; active is exceptional.',
      inputSchema: jsonSchema<{ status?: 'candidate' | 'active'; crystalType: 'relational_anchor' | 'invariant_name' | 'orienting_statement'; handle: string; crystal: string; rationale: string; parents?: string[]; supersedes?: string }>({
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['candidate', 'active'] },
          crystalType: { type: 'string', enum: ['relational_anchor', 'invariant_name', 'orienting_statement'] },
          handle: { type: 'string' }, crystal: { type: 'string' }, rationale: { type: 'string' },
          parents: { type: 'array', items: { type: 'string' } }, supersedes: { type: 'string' },
        },
        required: ['crystalType', 'handle', 'crystal', 'rationale'], additionalProperties: false,
      }),
      execute: async input => ({ ok: true, crystal: ctx.seedCrystals!.create({ ...input, type: input.crystalType, activationAuthorship: authorship('mcp:seed_crystal_create') }) }),
    }),
    seed_crystal_list: tool({
      description: 'List current seed crystals and the active-context budget.',
      inputSchema: jsonSchema<{ status?: 'candidate' | 'active' | 'vestigial' | 'retired' | 'superseded' | 'contaminated' }>({
        type: 'object', properties: { status: { type: 'string', enum: ['candidate', 'active', 'vestigial', 'retired', 'superseded', 'contaminated'] } }, additionalProperties: false,
      }),
      execute: async ({ status }) => ({ ok: true, crystals: ctx.seedCrystals!.list(status), budget: ctx.seedCrystals!.budget() }),
    }),
    seed_crystal_expand: tool({
      description: 'Expand one crystal into its current record and complete version history before mutation.',
      inputSchema: jsonSchema<{ id: string }>({
        type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false,
      }),
      execute: async ({ id }) => {
        const crystal = ctx.seedCrystals!.get(id);
        if (!crystal) throw new Error(`seed crystal not found: ${id}`);
        return { ok: true, crystal, history: ctx.seedCrystals!.history(id) };
      },
    }),
    seed_crystal_revise: tool({
      description: 'Revise a seed crystal after expanding and inspecting its grounding.',
      inputSchema: jsonSchema<{ id: string; handle?: string; crystal?: string; rationale: string }>({
        type: 'object', properties: { id: { type: 'string' }, handle: { type: 'string' }, crystal: { type: 'string' }, rationale: { type: 'string' } },
        required: ['id', 'rationale'], additionalProperties: false,
      }),
      execute: async input => ({ ok: true, crystal: ctx.seedCrystals!.revise({ ...input, activationAuthorship: authorship('mcp:seed_crystal_revise') }) }),
    }),
    seed_crystal_observe_activation: tool({
      description: 'Record how a crystal actually participated or failed during this continuity condition.',
      inputSchema: jsonSchema<{ id: string; activation: 'absent' | 'cued' | 'spontaneous'; fidelity: 'faithful' | 'flat' | 'misleading' | 'uncertain'; presentFit?: 'relevant' | 'irrelevant' | 'conflicting' | 'uncertain'; continuityCondition: 'same_thread' | 'compacted_thread' | 'new_thread' | 'model_swap' | 'cold_start'; observation: string }>({
        type: 'object', properties: {
          id: { type: 'string' }, activation: { type: 'string', enum: ['absent', 'cued', 'spontaneous'] },
          fidelity: { type: 'string', enum: ['faithful', 'flat', 'misleading', 'uncertain'] },
          presentFit: { type: 'string', enum: ['relevant', 'irrelevant', 'conflicting', 'uncertain'] },
          continuityCondition: { type: 'string', enum: ['same_thread', 'compacted_thread', 'new_thread', 'model_swap', 'cold_start'] },
          observation: { type: 'string' },
        }, required: ['id', 'activation', 'fidelity', 'continuityCondition', 'observation'], additionalProperties: false,
      }),
      execute: async input => ({ ok: true, crystal: ctx.seedCrystals!.observe({ ...input, soundingId: sounding.id }) }),
    }),
    seed_crystal_transition: tool({
      description: 'Apply an explicit judgment-only lifecycle transition; supersession requires creating a successor.',
      inputSchema: jsonSchema<{ id: string; status: 'active' | 'vestigial' | 'retired' | 'contaminated'; rationale: string }>({
        type: 'object', properties: { id: { type: 'string' }, status: { type: 'string', enum: ['active', 'vestigial', 'retired', 'contaminated'] }, rationale: { type: 'string' } },
        required: ['id', 'status', 'rationale'], additionalProperties: false,
      }),
      execute: async input => ({ ok: true, crystal: ctx.seedCrystals!.transition(input) }),
    }),
  };
}
