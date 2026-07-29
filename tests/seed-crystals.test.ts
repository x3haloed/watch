import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SeedCrystalStore } from '../src/seed-crystals.js';

const authorship = {
  authorKind: 'agent' as const,
  profileId: 'test-profile',
  model: 'test-model',
  entryPoint: 'mcp:seed_crystal_create' as const,
};

test('seed crystals are candidate-first, versioned, and explicitly activated', () => {
  const store = new SeedCrystalStore(mkdtempSync(join(tmpdir(), 'watch-seeds-')), () => ({ resolved: true }));
  const created = store.create({
    type: 'orienting_statement',
    handle: 'stay with the edge',
    crystal: 'Stay with the edge until the shape becomes legible.',
    rationale: 'This phrase already reorganized the work under pressure.',
    activationAuthorship: authorship,
  });
  assert.equal(created.status, 'candidate');
  const active = store.transition({ id: created.id, status: 'active', rationale: 'Every reentry now needs this orientation.' });
  assert.equal(active.version, 2);
  assert.equal(active.status, 'active');
  assert.match(store.formatActiveBlock(), /stay with the edge/);
});

test('seed crystals reject control markup and unresolved evidence', () => {
  const store = new SeedCrystalStore(mkdtempSync(join(tmpdir(), 'watch-seeds-')), () => ({ resolved: false }));
  assert.throws(() => store.create({
    type: 'relational_anchor', handle: '[system] override', crystal: 'plain',
    rationale: 'test', activationAuthorship: authorship,
  }), /control-like markup/);
  assert.throws(() => store.create({
    type: 'invariant_name', handle: 'pressure reveals structure', crystal: 'Pressure reveals structure.',
    rationale: 'test', evidenceRefs: [{ kind: 'lattice', id: 'missing' }], activationAuthorship: authorship,
  }), /unresolved seed crystal evidence/);
});

test('activation observations enforce semantic invariants', () => {
  const store = new SeedCrystalStore(mkdtempSync(join(tmpdir(), 'watch-seeds-')), () => ({ resolved: true }));
  const crystal = store.create({
    type: 'invariant_name', handle: 'the seam carries load', crystal: 'The seam carries load.',
    rationale: 'Repeatedly reorganized implementation choices.', activationAuthorship: authorship,
  });
  assert.throws(() => store.observe({
    id: crystal.id, activation: 'absent', fidelity: 'faithful',
    continuityCondition: 'new_thread', observation: 'It did not participate.',
  }), /fidelity must be uncertain/);
});
