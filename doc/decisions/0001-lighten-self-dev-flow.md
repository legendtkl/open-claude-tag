# 0001. Lighten the self-dev flow (tiers + design-on-demand + ADRs)

| Field | Value |
|-------|-------|
| Status | Accepted |
| Date | 2026-06-17 |

## Context

The `self-dev` change cycle (proposal + design + tasks + validation + archive)
was applied uniformly to every iteration change regardless of blast radius.
Symptoms:

- A one-line fix paid the same ceremony as an architectural change.
- `design.md` was effectively mandatory even when a change had no real
  architectural fork (the workflow always "continued to design.md" after the
  confirmation gate), although only `tasks` was strictly required to start
  implementation.
- Decision rationale lived in write-once-then-archived proposals (over a hundred
  archived changes), with no durable, navigable record of *why* a decision was
  made.

A `fast-dev` skill already existed for narrow changes, but the routing boundary
between it and `self-dev` was described loosely in prose and only shipped for the
`codex` runtime. A lighter doc-first model — tiered effort plus Architecture
Decision Records — keeps only the parts of the ceremony that earn their weight.

## Decision

Adopt the lightest viable option ("tier the flow + add ADRs"):

1. **Tier by blast radius.** Document one authoritative routing rule in
   `AGENTS.md`: narrow/low-risk changes use `fast-dev`; schema, migrations,
   auth/permissions, secrets, deployment/release, queue/worker/runtime, Feishu
   event handling, daemon gateway, and broad/architectural changes use full
   `self-dev`. A `fast-dev` change that grows into a tier-2 area stops and
   escalates to `self-dev`.
2. **`design.md` on demand.** Within `self-dev`, produce `design.md` only when a
   change has a genuine architectural decision; otherwise go proposal → tasks.
3. **ADRs for decisions.** Record architectural / cross-cutting decisions as
   ADRs under `doc/decisions/` (this file is the first). Prefer a concise ADR
   over sprawling `design.md` prose.
4. **Parity + consistency.** Add a `.claude` copy of `fast-dev` so both runtimes
   route identically, and keep the **design-on-demand, ADR, and tier-routing
   wording** consistent across the three self-dev workflow copies (`.claude`
   skill, `.codex` skill, and `packages/runtime-adapters/workflows/
   self-dev-common.md`). This is scoped to that shared wording, not full
   byte-parity: the copies keep their existing intentional differences —
   notably the Codex copy's high-level `Technical Approach` framing versus the
   file-level `Technical Implementation Plan` in the other two.

This change dogfoods rule (2): it has no architectural fork beyond what this ADR
records, so it ships **without** a `design.md`.

## Consequences

- Small changes are cheaper: fast-dev for narrow work, no forced `design.md`.
- Decision history becomes durable and navigable in `doc/decisions/` instead of
  being buried in archived proposals.
- New maintenance surface: the routing rule and the three self-dev copies must be
  kept consistent; mitigated by a verification step that greps the shared wording.
- Relies on agent judgement for "is there an architectural decision?"; the
  routing rule makes that an explicit, written gate rather than an implicit one.
- The underlying workflow files and skills keep their structure, so the change is
  incremental and reversible.

## Alternatives Considered

- **Add ADRs but keep every change's full proposal+design+tasks packet (option
  2).** Rejected as a first step: it still pays the full proposal+design+tasks
  ceremony for small changes, which is the main pain.
- **Replace the proposal-packet model with a living-doc + ADR model (option 3).**
  Rejected as too high-blast-radius for now: it would touch the `/dev`-injected
  `self-dev-common.md`, the self-dev skills, and the archive tooling at once.
  Left open as a future step if the lighter flow proves the model.
- **Drop the spec-driven packet entirely.** Rejected at the time: the living
  capability specs were treated as a valuable single source of truth worth
  keeping.
