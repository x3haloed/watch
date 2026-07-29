---
name: topology-compression
description: Use when changing an existing software system whose behavior is spread across duplicated authorities, parallel workflows, compatibility layers, representations, services, controllers, or coordination edges; especially for architectural refactoring, legacy migration, consolidation, or making a repository materially easier to understand and change without losing required behavior.
---

# Topology Compression

Architecture work reduces the number of places a developer must understand and coordinate to change behavior while preserving the complexity the system genuinely needs.

Compress the largest coherent slice whose preservation envelope can be made legible and verified. Do not optimize for the smallest safe edit or the largest imaginable rewrite.

## Compression Frame

Map architecture in four kinds of topology:

- **Authority:** a place that decides policy, behavior, state transitions, or ownership.
- **Representation:** a persisted, transmitted, rendered, or in-memory form that other code must translate or synchronize.
- **Boundary:** a module, process, service, application, tenant, trust, or operational division that contains responsibility.
- **Coordination edge:** a dependency, translation, synchronization step, compatibility bridge, shared mutation, or ordering constraint between authorities, representations, or boundaries.

Compression removes or composes these elements so the system tells fewer, more truthful stories. Line count is evidence only when it reflects that structural change.

## Iteration Loop

### 1. Map the relevant topology

Trace the behavior before choosing an edit:

- entry points and user-visible workflows
- authorities that decide the same or adjacent behavior
- representations and translations
- persisted-data meaning
- callers, consumers, registrations, and operational jobs
- external and published contracts
- authorization, tenancy, failure, and integration boundaries
- legacy or predecessor behavior when the current system may be incomplete

Treat “no current caller” as weak evidence. It may mean obsolete code, an unmigrated workflow, an external consumer, reflection or configuration use, or a missing current implementation.

Produce a topology statement concise enough to test:

> Behavior X is currently decided by A and B, represented as C and D, and coordinated through edges E and F.

### 2. Establish the preservation envelope

State what must remain true after compression. Use evidence appropriate to the system:

- business and persisted-data behavior
- visual and interaction behavior
- published APIs, messages, files, and integration semantics
- authorization and tenant isolation
- operational requirements and failure behavior
- legacy capabilities that remain required
- explicit retirement decisions for behavior that may disappear

Capture representative preservation evidence before editing whenever the behavior cannot be reconstructed reliably afterward. Record current and, when relevant, predecessor runtime behavior, artifacts, responses, and data effects using the same probes intended for post-change verification.

Distinguish exact preservation from acceptable revision. Never quietly substitute an approximation and call it equivalent. If exact preservation requires a deeper architectural decision, preserve or restore the last evidence-backed authority and expose the unresolved lane.

Classify why an unresolved lane is blocked:

- **Semantic or external-authority blocker:** record the exact ambiguity, the person or outside authority capable of resolving it, and the evidence needed. This lane may remain blocked until that authority responds.
- **Scale or clarity blocker:** do not treat this as permanent deferral. Turn it into investigation, evidence collection, or smaller coherent compression candidates with a concrete next action. Large or poorly understood work remains part of the active architectural loop.

Do not install an approximation merely to keep the compression loop moving.

When required meaning is absent from code, tests, contracts, or fixtures, surface the preservation decision to a person or agent with broader context. The loop is allowed to be negotiated; missing semantic authority is not a reason to guess.

### 3. Rank coherent compression candidates

Prefer candidates that completely remove meaningful topology:

- one authority absorbs a duplicate authority
- one workflow composes a parallel workflow
- one canonical representation replaces synchronized forms
- an unnecessary boundary or bridge disappears
- a cross-cutting rule moves to the boundary that owns it

Estimate each candidate by:

- topology removed
- future coordination avoided
- confidence in the preservation envelope
- verification strength
- rollback and checkpoint coherence

Choose the largest candidate that remains one understandable collapse. Reject:

- tiny edits that move code but leave all authorities and edges alive
- massive edits whose preservation envelope cannot be proved
- bundles of unrelated cleanup disguised as one architectural move

### 4. Execute a complete collapse

Move behavior to its truthful surviving home, update callers and representations, then retire obsolete topology. Do not leave the old authority active “for safety” unless a real external constraint requires a transition period.

Use compiler errors, failing tests, searches, and runtime failures as topology measurements: they reveal what still believes the retired concept exists.

Keep temporary compatibility only when its external reason, owner, removal condition, and verification path are explicit.

### 5. Verify the preservation envelope

Match verification scope to the preservation claim:

- build and focused tests for structural and behavioral contracts
- broader tests for shared authorities or representations
- authenticated, representative runtime workflows for lived behavior
- artifact inspection for generated files or messages
- data checks for persisted meaning and tenant isolation
- cautious integration checks for consequential external systems

For changes that remove types, dependencies, registrations, generated inputs, or constructor edges, verify from a clean state. Incremental builds and cached artifacts can preserve deleted topology and produce false confidence.

A green build does not prove visual, operational, integration, or legacy equivalence. A narrow fixture does not prove a broad preservation claim.

If verification finds a preservation miss:

1. Stop extending the compression.
2. Classify the miss as a faulty map, missing preservation evidence, wrong compression size, or implementation defect.
3. Restore or repair the protected authority first.
4. Tighten the preservation rule.
5. Re-evaluate the candidate rather than defending sunk work.

### 6. Checkpoint and continue

Make each successful compression independently understandable and reversible. Record:

- topology removed
- surviving authority and why it owns the behavior
- preservation evidence
- unresolved or blocked lanes
- verification performed and gaps that remain

Then remap the topology created by the collapse. Removed callers often expose registrations, services, representations, or coordination edges that are now pure residue.

## Working Termination Test

Treat compression as locally complete only when all of these hold:

1. Every remaining boundary is internally interpretable: its behavior can be understood and changed from its owned concepts, state, invariants, and explicit contracts without reconstructing hidden authority elsewhere.
2. Every remaining cross-boundary edge represents necessary, explicit coordination.
3. No evidence-supported collapse can materially reduce authorities, representations, boundaries, or coordination edges without violating the preservation envelope or making either side less interpretable.

Interpretability alone is insufficient. One giant boundary can be self-contained but incomprehensible; duplicated truth can make boundaries look locally complete while creating synchronization topology. Preserve boundaries that carry distinct authority, failure containment, trust, scaling, operational, or coordination load.

This is a working fixed-point test, not permission to claim global optimality. State the evidence horizon: which workflows, contracts, legacy sources, and runtime conditions were actually inspected.

## Human and Broader-Context Participation

Automate preservation knowledge when it becomes stable: tests, contract inventories, legacy maps, representative fixtures, runtime probes, and explicit retirement records.

Prefer tests that defend behavior, contracts, ownership invariants, and observable artifacts. Do not add structural tests whose only purpose is preventing intentionally retired implementation shapes from reappearing unless that shape represents a real architectural invariant.

Keep broader-context participation available for:

- ambiguous business intent
- unencoded legacy obligations
- disputed equivalence
- consequential external behavior
- compression-size negotiation when evidence is weak

The goal is not unattended activity. The goal is an agent that carries the architectural loop and requests semantic judgment only where the system cannot currently answer for itself.

## Failure Modes

| Failure | Correction |
|---|---|
| Dead-code search substitutes for behavior mapping | Check legacy, external, configuration, reflection, and operational consumers |
| Files move but topology remains | Name the authority, representation, boundary, or edge that actually disappears |
| Compatibility is retained by habit | Require an external reason and removal condition |
| Approximate behavior is called preserved | Separate exact preservation, accepted revision, and unresolved architecture |
| A large or unclear lane is deferred indefinitely | Investigate or decompose it into concrete, evidence-producing next actions |
| Compression is too small | Select a slice that retires a complete authority or coordination path |
| Compression is too large | Shrink until the preservation envelope is legible and testable |
| Tests become the definition of truth | Confirm that tests cover the stated envelope; add lived runtime evidence |
| Cached or incremental verification conceals removed dependencies | Clean generated and compiled state, then rebuild and rerun the relevant suite |
| The agent stops after one successful refactor | Remap and continue until the local fixed-point test holds |
| The agent keeps compressing past meaning | Protect irreducible boundaries and stop when remaining edges carry named load |

## Iteration Report

Keep the report compact:

```markdown
## Topology
[Current authorities, representations, boundaries, and coordination edges]

## Preservation envelope
[Required behavior and authoritative evidence]

## Selected compression
[What complete topology disappears and why this slice is coherent]

## Verification
[Build, tests, runtime, data, integrations, and known gaps]

## Result
[Surviving authority, retired topology, checkpoint, and next remap]
```
