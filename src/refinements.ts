import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { refinementsPath } from './paths.js';

export type RefinementStatus = 'proposed' | 'awaiting_contact' | 'confirmed' | 'revised' | 'rolled_back' | 'inconclusive' | 'relinquished';
export type RefinementEvidenceRef = { kind: 'lattice'; id: string } | { kind: 'ledger'; id: string } | { kind: 'file'; path: string };
export type RefinementEvidenceResolution = { resolved: true } | { resolved: false; reason: string };
export type RefinementAuthorship = {
  authorKind: 'agent' | 'human' | 'system';
  profileId?: string;
  model?: string;
  entryPoint: string;
  soundingId?: string;
  threadId?: string;
};
export type RefinementCase = {
  id: string; version: number; status: RefinementStatus; trigger: string; targetRef: string;
  hypothesis: string; testCondition: string; change?: string; beforeSnapshot?: RefinementEvidenceRef;
  contact?: string; outcome?: string; rollback?: string; evidenceRefs: RefinementEvidenceRef[];
  authorship: RefinementAuthorship;
  transition: { action: 'create' | 'apply' | 'evaluate' | 'rollback' | 'relinquish'; authorship: RefinementAuthorship };
  createdAt: string; updatedAt: string;
};
export type CreateRefinementInput = Pick<RefinementCase, 'trigger' | 'targetRef' | 'hypothesis' | 'testCondition' | 'authorship'> & { evidenceRefs?: RefinementEvidenceRef[] };

const TERMINAL_STATUSES = new Set<RefinementStatus>(['confirmed', 'revised', 'rolled_back', 'relinquished']);

export class RefinementStore {
  private readonly path: string;

  constructor(rootDir: string, private readonly resolveEvidence: (reference: RefinementEvidenceRef) => RefinementEvidenceResolution) {
    this.path = refinementsPath(rootDir);
    mkdirSync(dirname(this.path), { recursive: true });
  }

  create(input: CreateRefinementInput): RefinementCase {
    this.requireResolved(input.evidenceRefs ?? []);
    const at = new Date().toISOString();
    const record: RefinementCase = {
      id: randomUUID(), version: 1, status: 'proposed', trigger: required(input.trigger, 'trigger'),
      targetRef: required(input.targetRef, 'targetRef'), hypothesis: required(input.hypothesis, 'hypothesis'),
      testCondition: required(input.testCondition, 'testCondition'), evidenceRefs: uniqueEvidence(input.evidenceRefs ?? []),
      authorship: input.authorship, transition: { action: 'create', authorship: input.authorship }, createdAt: at, updatedAt: at,
    };
    this.append(record);
    return record;
  }

  apply(input: { id: string; change: string; beforeSnapshot: RefinementEvidenceRef; evidenceRefs?: RefinementEvidenceRef[]; authorship?: RefinementAuthorship }): RefinementCase {
    const current = this.require(input.id);
    requireStatus(current, ['proposed'], 'apply');
    this.requireResolved([input.beforeSnapshot, ...(input.evidenceRefs ?? [])]);
    return this.transition(current, { status: 'awaiting_contact', change: required(input.change, 'change'), beforeSnapshot: input.beforeSnapshot, evidenceRefs: uniqueEvidence([...current.evidenceRefs, ...(input.evidenceRefs ?? [])]), transition: { action: 'apply', authorship: input.authorship ?? current.authorship } });
  }

  evaluate(input: { id: string; verdict: 'confirmed' | 'revised' | 'inconclusive'; contact: string; outcome: string; evidenceRefs: RefinementEvidenceRef[]; authorship?: RefinementAuthorship }): RefinementCase {
    const current = this.require(input.id);
    requireStatus(current, ['awaiting_contact', 'inconclusive'], 'evaluate');
    if (input.evidenceRefs.length === 0) throw new Error('evaluation requires at least one evidence reference');
    this.requireResolved(input.evidenceRefs);
    return this.transition(current, { status: input.verdict, contact: required(input.contact, 'contact'), outcome: required(input.outcome, 'outcome'), evidenceRefs: uniqueEvidence([...current.evidenceRefs, ...input.evidenceRefs]), transition: { action: 'evaluate', authorship: input.authorship ?? current.authorship } });
  }

  rollback(input: { id: string; rationale: string; evidenceRefs: RefinementEvidenceRef[]; authorship?: RefinementAuthorship }): RefinementCase {
    const current = this.require(input.id);
    requireStatus(current, ['awaiting_contact', 'confirmed', 'inconclusive'], 'roll back');
    if (!current.beforeSnapshot) throw new Error('refinement has no beforeSnapshot to roll back to');
    if (input.evidenceRefs.length === 0) throw new Error('rollback requires at least one evidence reference');
    this.requireResolved(input.evidenceRefs);
    return this.transition(current, { status: 'rolled_back', rollback: required(input.rationale, 'rationale'), evidenceRefs: uniqueEvidence([...current.evidenceRefs, ...input.evidenceRefs]), transition: { action: 'rollback', authorship: input.authorship ?? current.authorship } });
  }

  relinquish(id: string, rationale: string, authorship?: RefinementAuthorship): RefinementCase {
    const current = this.require(id);
    if (TERMINAL_STATUSES.has(current.status)) throw new Error(`cannot relinquish refinement in terminal status ${current.status}`);
    return this.transition(current, { status: 'relinquished', outcome: required(rationale, 'rationale'), transition: { action: 'relinquish', authorship: authorship ?? current.authorship } });
  }

  get(id: string): RefinementCase | undefined { return this.records().find(record => record.id === id); }
  list(status?: RefinementStatus): RefinementCase[] { return this.records().filter(record => !status || record.status === status).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
  history(id: string): RefinementCase[] { return this.readAll().filter(record => record.id === id).sort((a, b) => a.version - b.version); }

  private records(): RefinementCase[] {
    const byId = new Map<string, RefinementCase>();
    for (const record of this.readAll()) byId.set(record.id, record);
    return [...byId.values()];
  }
  private readAll(): RefinementCase[] {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, 'utf8').split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line) as RefinementCase]; } catch { return []; } });
  }
  private require(id: string): RefinementCase {
    const record = this.get(id);
    if (!record) throw new Error(`refinement not found: ${id}`);
    return record;
  }
  private transition(current: RefinementCase, patch: Partial<RefinementCase>): RefinementCase {
    const record = { ...current, ...patch, id: current.id, version: current.version + 1, createdAt: current.createdAt, updatedAt: new Date().toISOString() };
    this.append(record);
    return record;
  }
  private requireResolved(references: RefinementEvidenceRef[]): void {
    for (const reference of references) {
      const result = this.resolveEvidence(reference);
      if (!result.resolved) throw new Error(`unresolved refinement evidence ${JSON.stringify(reference)}: ${result.reason}`);
    }
  }
  private append(record: RefinementCase): void { appendFileSync(this.path, `${JSON.stringify(record)}\n`, 'utf8'); }
}

function requireStatus(record: RefinementCase, allowed: RefinementStatus[], action: string): void {
  if (!allowed.includes(record.status)) throw new Error(`cannot ${action} refinement in status ${record.status}`);
}
function required(value: string, name: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${name} must not be empty`);
  return trimmed;
}
function uniqueEvidence(refs: RefinementEvidenceRef[]): RefinementEvidenceRef[] {
  const seen = new Set<string>();
  return refs.filter(ref => { const key = JSON.stringify(ref); if (seen.has(key)) return false; seen.add(key); return true; });
}
