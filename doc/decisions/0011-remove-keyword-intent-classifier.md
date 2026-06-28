# 0011. Remove the keyword intent classifier

| Field | Value |
|-------|-------|
| Status | Accepted |
| Date | 2026-06-28 |

## Context

`classifyIntent` (a pure synchronous bilingual keyword/substring heuristic) mapped
each inbound message to an `IntentType` (`chat_reply` / `analysis` / `research` /
`ops_task` / `self_improvement`) stored as `tasks.taskType`. An audit of its
downstream consumers showed it was almost entirely vestigial:

- It costs nothing (no LLM), so "remove to save latency/cost" was never the point.
- The execution-affecting decisions do **not** come from it: the read-vs-write
  workspace mode is a separate LLM classifier (`write-intent-classifier.ts`), and
  the `self_dev` server-local gate is set by the `/dev` slash command and PR polling
  — `classifyIntent` never emits `SELF_DEV`.
- `selectRuntime(intent)` always returned `'auto'` (its argument was unused), and the
  `approvalRequired = intent === SELF_IMPROVEMENT` flag was only ever written, never
  read.
- `analysis` / `research` / `chat_reply` have no execution branch; they differ only
  in a Feishu Task tracking shortcut and a cosmetic ACK/label string.

Modern agentic runtimes (Claude Code / Codex) decide their own approach from the goal
text, so a per-message intent taxonomy adds maintenance surface without changing
behavior.

## Decision

Remove `classifyIntent` / `selectRuntime` (and the dead `approvalRequired` flag).
`handleEvent` now produces only:

- `OPS_TASK` (→ direct reply) for an ops slash command that reaches it
  (`/new`, `/status`, `/session`, `/compact`, `/forget`, `/reset`, `/help`), and
- `CHAT_REPLY` for every other message (→ task; the runtime decides its own approach).

`runtimeHint` is always `null`; the result keeps `runtime: 'auto'` so `task-dispatch`
still preserves the session's persisted runtime. The document-comment path is
simplified the same way (`taskType = CHAT_REPLY`).

**Keep the `IntentType` enum values** `ANALYSIS` / `RESEARCH` / `SELF_IMPROVEMENT`.
They remain valid persisted `taskType` labels, are still part of `TaskSpecSchema`,
are still produced by agent delegation (`ANALYSIS`), and are read by the Feishu
tracking gate — so only the *producer* (the keyword classifier) is removed, not the
enum. No `taskType` migration.

To avoid regressing no-LLM Feishu Task tracking (messages that used to be force-tracked
as `analysis`/`research` now flow through the `chat_reply` tracking sub-classifier),
the analysis/research vocabulary (`explain` / `why` / `architecture` / `design` /
`review` / `performance` / 原理 / 文档 / …) is folded into that sub-classifier's
keyword fallback.

## Consequences

- One fewer classifier to maintain; inbound dispatch is "ops command → direct reply,
  else chat_reply task".
- Behavior is unchanged for execution: read-vs-write and `self_dev` gating were always
  independent of this classifier.
- The only observable change is cosmetic (ACK cards / admin listings show `chat_reply`
  instead of `analysis`/`research`) plus slightly different track/skip decisions for
  analysis-style messages, mitigated by the enriched tracking keyword fallback.
- Legacy `analysis`/`research`/`self_improvement` `taskType` rows stay valid.

## Alternatives Considered

- **Keep the classifier as-is.** Rejected: dead/decorative surface area with no
  behavioral value.
- **Remove the `IntentType` enum values too (+ a `taskType` backfill).** Rejected:
  `taskType` is a label, legacy rows are valid, `ANALYSIS` is still produced by agent
  delegation, and the tracking gate references them — narrowing would break valid data
  for no gain.
- **Replace it with an LLM intent classifier.** Rejected: the load-bearing decisions
  already have dedicated paths; a general intent taxonomy is not needed.
