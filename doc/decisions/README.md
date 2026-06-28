# Architecture Decision Records (ADRs)

This directory holds OpenClaudeTag's Architecture Decision Records. An ADR captures
**why** an architectural or cross-cutting decision was made, so the reasoning
survives without digging through chat logs.

ADRs are the lightweight record for architectural decisions. In the `self-dev`
workflow, write one **on demand** — only when a change has a genuine
architectural fork. See `AGENTS.md` → "Change Workflow".

> For the synthesized, end-to-end architecture overview that ties these
> point-decisions together, see
> [`doc/architecture/technical-design.md`](../architecture/technical-design.md).

## When to write an ADR

Write one for:

- An architectural or implementation fork-in-the-road decision (choosing one of
  several viable options).
- A decision that reverses an earlier one.
- A convention that affects multiple files or packages.

Do **not** write one for routine implementation details or naming choices.

## Format

One file per decision, named `NNNN-kebab-case-title.md`. `NNNN` is a four-digit,
**monotonically increasing, never-reused** number (the next ADR is always
highest + 1). Do not use date prefixes — the number reflects order, not date.

```markdown
# NNNN. <Title>

| Field | Value |
|-------|-------|
| Status | Proposed / Accepted / Superseded by ADR-NNNN |
| Date | YYYY-MM-DD |

## Context

Why this decision came up — background, constraints, motivation.

## Decision

What was decided. Be specific.

## Consequences

Results of adopting it — positive, negative, and follow-ups.

## Alternatives Considered

Other options evaluated, and briefly why they were not chosen.
```

## Supersede rules

When a decision is reversed, **do not delete** the original ADR. Change its
`Status` to `Superseded by ADR-NNNN` and write a new ADR that overrides it. The
history of decisions stays auditable.

## Index

| ADR | Title | Status |
|-----|-------|--------|
| [0001](0001-lighten-self-dev-flow.md) | Lighten the self-dev flow (tiers + design-on-demand + ADRs) | Accepted |
| [0002](0002-document-comment-session-resume.md) | Document Comment Session Resume | Accepted |
| [0003](0003-chat-memory-index-detail-store.md) | Chat Memory Index And Detail Store | Accepted |
| [0004](0004-inbound-message-pipeline-contract.md) | InboundMessage as the inbound pipeline contract | Accepted |
| [0005](0005-neutral-non-lark-task-dispatch.md) | A minimal separate neutral dispatch path for non-lark inbound | Accepted |
| [0006](0006-cross-channel-flag-broker.md) | Brokered, audited, isPrivate-safe cross-channel flagging | Accepted |
| [0007](0007-stale-thread-nudge-scanner.md) | Stale-thread nudge scanner: audit-log idempotency + same-channel private nudge | Accepted |
| [0008](0008-neutral-ack-in-place-terminal-update.md) | Thread the neutral ACK handle so the worker updates it in place | Accepted |
| [0009](0009-embedded-postgres-db-provider.md) | DB-provider abstraction with an embedded-Postgres (zero-Docker) provider | Accepted |
| [0010](0010-remove-coco-runtime.md) | Remove the Coco (TRAE CLI) runtime adapter | Accepted |
| [0011](0011-remove-keyword-intent-classifier.md) | Remove the keyword intent classifier | Accepted |
| [0012](0012-credential-storage-models.md) | Credential storage models: runtimeEnv (stored, masked) vs access-bundle (never stored) | Accepted |
