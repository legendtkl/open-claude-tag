# 0007. Stale-thread nudge scanner: audit-log idempotency + same-channel private nudge

| Field | Value |
|-------|-------|
| Status | Accepted |
| Date | 2026-06-27 |

## Context

Stage 5's final proactive behavior is a **stale-thread scanner**: notice when a
conversation/thread the bot was involved in has gone quiet while still in an
unresolved, awaiting-a-human state, and — for opted-in channels only — surface a
single gated, audited, idempotent nudge to the thread's OWN channel.

This reuses the established proactive-posting shape (default-OFF two-layer gate,
fail-closed, audited, injected budget — the ambient post gate ADR-0006 family) but
introduces three real forks worth recording:

1. **What "stale + unresolved" means** on the current schema.
2. **How to make the nudge idempotent** ("once per stale thread") without a
   migration.
3. **Whether a private (DM) thread may be nudged in its own channel.**

The schema offers no dedicated "thread last-activity" or "awaiting" column; the
durable signals are `tasks.status`, `tasks.updatedAt`, `sessions.updatedAt`, and
`sessions.scope`.

## Decision

- **Unresolved signal = `tasks.status = 'waiting_approval'` only.** This is the one
  state that genuinely awaits a human (the worker posted a clarify/confirmation
  card and parked the task; it transitions only to terminal states).
  `waiting_delegation` is excluded — it awaits a delegated sub-agent (it
  transitions back to `queued`), not a human. `pending`/`queued`/`running` are
  transient in-flight states. Conservative-waiting-only for v1.
- **Stale clock = `max(task.updatedAt, session.updatedAt)`**, computed at the IO
  edge. Using the session timestamp too means a user reply that touched the
  session (but not the parked task) correctly resets staleness, so the scanner
  never nudges after the user has already spoken.
- **Idempotency via the audit log (no migration).** "Already handled this stale
  episode" is a prior `stale_thread.nudge` audit row for the task whose
  `createdAt >= lastActivityAt`. Any recorded outcome (`sent`, `send_failed`, a
  budget decline) counts: **one attempt per stale episode**. After genuine
  activity the task/session `updatedAt` advances past the old audit, so a fresh
  stall re-qualifies. This is durable (survives restarts) and needs no marker
  column.
- **Same-channel private nudge is allowed.** The nudge posts INTO the thread's own
  channel (`session.chatId`) only — never another channel — so it is NOT
  cross-channel leakage; the cross-channel broker's private exclusions
  (private → OTHER channel) do not apply. A private (p2p/DM) thread is eligible,
  gated by the same per-channel allowlist as a group.
- **Sendable-scope allowlist (fail-closed).** Only the canonical chat scopes
  `p2p` / `group-main` / `group-manual` are nudged. Every other scope is excluded —
  including ones that share the Feishu session-key namespace but are NOT a sendable
  chat: `thread` (chatId is the parent chat, not the thread), `doc-comment` (chatId
  is a `doc:*` ref), `discussion`, `delegated-child`, and any future scope. The
  candidate loader additionally restricts to the `feishu:` session-key namespace
  (the only background-deliverable vendor today), so a non-Lark session is never
  delivered through the Feishu sender.
- **Pure core lives in `@open-tag/ambient`** (`findStaleThreads` +
  `evaluateStaleThreadNudge`), not a new package — it is the same proactive family
  and reuses the ambient budget seam. The IO edge (`apps/api/stale-thread-scanner.ts`)
  queries candidates, enforces the allowlist + dedupe, audits, and delivers via
  `resolveChannelSender`. It is wired into the existing reconciler tick
  (primary-API-only), additive and error-isolated, and is a complete no-op when
  `OPEN_TAG_STALE_THREAD_SCANNER_ENABLED` is off.

## Consequences

- Default-OFF airtight: the global flag off ⇒ no query/audit/send. The per-channel
  allowlist is required even when the global flag is on. A non-allowlisted or
  already-handled thread is skipped silently (no audit), bounding audit growth —
  mirroring the ambient tap's non-allowlisted / shed no-ops.
- Race control without a migration: the reconciler tick is re-entrancy-guarded
  (no overlapping ticks) and primary-API-only, so the check-then-send dedupe is
  not subject to overlapping-tick or multi-process races under the deployment
  invariant. A multi-primary deployment would need an advisory lock — recorded as
  a deliberate, documented limitation rather than built now.
- A transiently-failed send is audited `send_failed` and counts as the one attempt
  for that episode (it will retry only after genuine activity). Acceptable for a
  best-effort, low-stakes nudge; keeps audit volume bounded.
- Loop-safe: the nudge is bot-authored and delivered directly (never re-enters the
  inbound pipeline, which also skips non-user senders); it updates no task/session
  row, so it cannot reset staleness and oscillate; every nudge carries a neutral
  `[reminder]` marker for identifiability.
- Audit detail records only neutral scope identifiers (kind/scopeId/scope/isPrivate/
  sessionId/timing) — never the task goal or any message content.

## Alternatives Considered

- **Marker column (`tasks.stale_nudged_at` / `sessions.stale_nudged_at`)** for
  idempotency — rejected to avoid a migration; the audit log already provides a
  durable, episode-correct dedupe source.
- **In-memory once-ledger** — rejected: lost on restart, would re-nudge after every
  deploy.
- **A new `@open-tag/stale-thread` package** mirroring `@open-tag/cross-channel` —
  rejected: it is the same proactive-posting family and reuses the ambient budget
  seam, so a new package would add ceremony without isolation benefit.
- **Including long-idle `running`/`pending` tasks** as "stalled" — rejected for v1:
  those are not awaiting-human; flagging them risks nudging on tasks that are
  simply executing or crashed.
- **Postgres advisory lock per candidate** — deferred: unnecessary under the
  single-primary reconciler invariant; the re-entrancy guard covers the realistic
  in-process race.
