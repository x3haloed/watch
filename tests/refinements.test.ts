import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MemoryLattice } from '../src/memory-lattice.js';
import { RefinementStore, type RefinementEvidenceRef } from '../src/refinements.js';
import { createMemoryTools } from '../src/tools/memory.js';
import type { LookoutToolContext } from '../src/tools/context.js';

function harness() {
  const root = mkdtempSync(join(tmpdir(), 'watch-refinements-'));
  const memory = new MemoryLattice(root);
  const refinements = new RefinementStore(root, (reference: RefinementEvidenceRef) => {
    if (reference.kind === 'lattice') return memory.get(reference.id) ? { resolved: true } : { resolved: false, reason: 'lattice record not found' };
    return { resolved: false, reason: 'unsupported test evidence' };
  });
  return { root, memory, refinements };
}

const authorship = { authorKind: 'agent' as const, profileId: 'test', model: 'test-model', entryPoint: 'test' };

test('refinements stay prospective, evidenced, and append-only', () => {
  const { root, memory, refinements } = harness();
  try {
    const trigger = memory.captureEpisode({ kind: 'test', text: 'Observed attractor capture before the proposed change.' });
    const created = refinements.create({ trigger: 'A retrieved orientation overrode current evidence.', targetRef: 'seed-crystal:orientation-1', hypothesis: 'Narrower activation language will reduce capture.', testCondition: 'Judge later fresh-thread contact.', evidenceRefs: [{ kind: 'lattice', id: trigger.id }], authorship });
    assert.equal(created.status, 'proposed');
    assert.throws(() => refinements.evaluate({ id: created.id, verdict: 'confirmed', contact: 'No change.', outcome: 'Unsupported.', evidenceRefs: [{ kind: 'lattice', id: trigger.id }] }), /status proposed/);

    const before = memory.captureEpisode({ kind: 'test', text: 'Exact language before revision.' });
    const applied = refinements.apply({ id: created.id, change: 'Revised activation language.', beforeSnapshot: { kind: 'lattice', id: before.id } });
    assert.equal(applied.status, 'awaiting_contact');
    assert.throws(() => refinements.evaluate({ id: created.id, verdict: 'confirmed', contact: 'Later contact.', outcome: 'Seemed better.', evidenceRefs: [] }), /at least one evidence/);

    const firstContact = memory.captureEpisode({ kind: 'test', text: 'Contact did not exercise the orientation.' });
    assert.equal(refinements.evaluate({ id: created.id, verdict: 'inconclusive', contact: 'Unexercised contact.', outcome: 'Keep open.', evidenceRefs: [{ kind: 'lattice', id: firstContact.id }] }).status, 'inconclusive');
    const confirmation = memory.captureEpisode({ kind: 'test', text: 'Later contact exercised the revision without prompting.' });
    assert.equal(refinements.evaluate({ id: created.id, verdict: 'confirmed', contact: 'Independent later contact.', outcome: 'Revision held.', evidenceRefs: [{ kind: 'lattice', id: confirmation.id }] }).status, 'confirmed');
    assert.deepEqual(new RefinementStore(root, () => ({ resolved: true })).history(created.id).map(record => record.version), [1, 2, 3, 4]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('refinement rollback and unresolved evidence enforce lifecycle invariants', () => {
  const { root, memory, refinements } = harness();
  try {
    assert.throws(() => refinements.create({ trigger: 'Unsupported.', targetRef: 'memory:case', hypothesis: 'Maybe.', testCondition: 'Later.', evidenceRefs: [{ kind: 'lattice', id: 'missing' }], authorship }), /unresolved refinement evidence/);
    const created = refinements.create({ trigger: 'A change is worth testing.', targetRef: 'memory:case', hypothesis: 'It may help.', testCondition: 'Observe later contact.', authorship });
    assert.throws(() => refinements.apply({ id: created.id, change: 'Unsupported.', beforeSnapshot: { kind: 'lattice', id: 'missing' } }), /unresolved refinement evidence/);
    assert.equal(refinements.get(created.id)?.version, 1);
    const before = memory.captureEpisode({ kind: 'test', text: 'Before-state snapshot.' });
    refinements.apply({ id: created.id, change: 'Reversible change.', beforeSnapshot: { kind: 'lattice', id: before.id } });
    assert.throws(() => refinements.rollback({ id: created.id, rationale: 'No evidence.', evidenceRefs: [] }), /at least one evidence/);
    const evidence = memory.captureEpisode({ kind: 'test', text: 'Later contact showed a misleading pull.' });
    assert.equal(refinements.rollback({ id: created.id, rationale: 'Misleading pull.', evidenceRefs: [{ kind: 'lattice', id: evidence.id }] }).status, 'rolled_back');
    assert.throws(() => refinements.relinquish(created.id, 'Already closed.'), /terminal status rolled_back/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('memory tools expose the prospective refinement contract', () => {
  const { root, refinements } = harness();
  try {
    const tools = createMemoryTools({ refinements } as unknown as LookoutToolContext);
    assert.deepEqual(Object.keys(tools).filter(name => name.startsWith('refinement_')).sort(), [
      'refinement_apply', 'refinement_create', 'refinement_evaluate', 'refinement_get', 'refinement_list', 'refinement_relinquish', 'refinement_rollback',
    ]);
    assert.match(String(tools.refinement_create.description), /does not claim that a change worked/);
    assert.match(String(tools.refinement_evaluate.description), /later contact/);
    assert.match(String(tools.refinement_rollback.description), /actual reversal/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
