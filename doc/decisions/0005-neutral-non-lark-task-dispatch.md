# 0005. A minimal separate neutral dispatch path for non-lark inbound

| Field | Value |
|-------|-------|
| Status | Accepted |
| Date | 2026-06-27 |

## Context

ADR-0004 made `InboundMessage` the inbound task-pipeline contract and migrated
the Feishu (lark) addressed-message dispatch behind a neutral seam in safe
slices. After 1a-i…1a-iii the building blocks are neutral: `resolveSession`,
orchestrator `handleEvent`, the queued-task ACK sender resolved by
`channel.kind` (`resolveChannelSender`), and a `SlackChannel` that implements the
`Channel` contract. The Slack route (`POST /slack/events`) verifies signatures
and feeds accepted messages into channel-neutral observation memory only — it
never dispatches a task.

The remaining blocker is the dispatch body itself. The lark dispatch
(`dispatchInboundMessageViaFeishuNative`, ~378 lines) is production-critical and
full of lark-native assumptions: it recovers a `NormalizedEvent` from
`channel.native`, enriches threads/references via Feishu REST, runs agent access
control, discussion / deferred-mention sub-handlers, a buffer gate, the
slash-command tree, an "OK" reaction, `buildFeishuTaskSourceTopicKey`, and
`upgradeRootProvisionalSession`. None of these have a neutral equivalent yet.
`buildQueuedTaskInput` is likewise lark-only — it requires a `NormalizedEvent`
and builds a `feishuContext` into the job constraints.

The goal of this slice: a verifiable "Slack message → task created → ACK routed
to a Slack sender" path, without touching the lark path (it must stay
byte-identical) and verifiable without live Slack credentials.

## Decision

Add a small, separate **neutral dispatch path** for non-lark inbound rather than
unifying the 378-line lark body. The lark body is left 100% untouched.

- `dispatchNeutralMessage(message, ctx)` (`apps/api/src/neutral-dispatch.ts`) is
  a pure orchestration function over injected deps (`resolveSession`,
  `createTask`, `transitionTask`, `enqueue`, `resolveSender`, `logger`) so it
  unit-tests with stubs and carries **no** resolver/Feishu-context shape.
- Steps: resolve the neutral session → create the task via the orchestrator with
  a **deterministic** task id → move the task to `QUEUED` (idempotent) → enqueue
  (the **durable boundary**) → send a neutral `{kind:'text'}` ACK **best-effort**
  through the kind-resolved sender.
- `buildNeutralQueuedTask` builds a minimal neutral `TaskJobData` directly (no
  `NormalizedEvent`, no `feishuContext`).
- The **seam** is the entry point, not a branch inside the lark body: the lark
  WSClient path keeps routing through `dispatchInboundMessageViaFeishuNative`; the
  Slack route routes addressed messages to `dispatchNeutralMessage`.
- The Slack sender slot in `resolveChannelSender` is made **injectable**:
  `ChannelSenderResolutionContext.feishuAppContext` becomes optional and a
  `slackSender?` field is added. The `lark` factory stays fail-closed (throws
  without a `feishuAppContext`); the `slack` factory returns the injected sender
  or throws "not configured yet". Production wires a `SlackChannel`-backed sender
  only when `SLACK_BOT_TOKEN` is present; tests inject a recording stub.
- Addressing gate (safe-by-default, opt-in): a Slack message dispatches a task
  only when `SLACK_BOT_USER_ID` is configured **and** the message @-mentions that
  id. With the env unset (production default) Slack behavior is unchanged
  (observation only).

### Failure semantics (resolved in the Codex design gate)

The first design marked the task `FAILED` and rethrew on any post-creation error,
which the review showed could permanently lose a task (terminal `FAILED` + a
`received` dedup claim that blocks the in-window retry, while a >5-min retry hits
the deterministic id and never re-enqueues). The accepted ordering instead makes
**enqueue the durable boundary**:

1. create task (`PENDING`, deterministic id);
2. move to `QUEUED` (idempotent — a recovery redelivery that finds the task
   already advanced swallows the invalid-transition);
3. `enqueue` (idempotent per task id) — on failure **propagate**, never mark the
   task terminal and never close the dedup claim, so a stale-claim redelivery
   re-runs and re-enqueues;
4. ACK **best-effort after** the durable enqueue — a send failure is logged and
   never loses or fails the task.

The route closes the dedup claim (`markEventProcessed`) only after the dispatch
returns, i.e. only after a durable enqueue.

> **Amended by [ADR-0008](0008-neutral-ack-in-place-terminal-update.md).** To
> capture the ack-message handle for in-place terminal updates, the ACK is now
> sent BEFORE the enqueue, but ONLY on the `task_created` path (a `task_duplicate`
> recovery no longer re-ACKs). Enqueue stays the durable boundary and the ACK
> stays best-effort; see ADR-0008 for the ordering, the serialized handle, and the
> residual orphan-on-enqueue-failure tradeoff.

## Consequences

- The lark path and the 26-case golden seam tests are untouched and stay green;
  the change is purely additive.
- The task-id key is fully scoped
  (`kind:installationId:scopeId:dedupeKey`) so two Slack workspaces sharing a
  Slack event id cannot collide on one task row.
- Namespace isolation holds: `resolveSession` keys non-lark sessions under the
  channel kind (`slack:…`), disjoint from lark's `feishu:…`, so a Slack message
  cannot resolve or mutate a lark session.
- No new core→vendor coupling: `dispatchNeutralMessage` lives in the API
  composition root and depends only on neutral interfaces.

### Deferred (noted, out of scope here)

lark topology/task-list tracking, the OK reaction, discussion / deferred-mention
intake, the buffer gate, the slash-command tree, agent access control / routing
(Slack tasks run with the default agent — acceptable because the path is opt-in
and inert by default), thread/reference enrichment, provisional-session topic
aliasing, SDK-session resume, DM auto-addressing (normalization keeps only
`scope.isPrivate`, which conflates DM and private channel, so addressing is
mention-only for now), and the **worker-side Slack outbound completion** (the
worker's card-PATCH path is lark-specific; the ACK is the immediate feedback and
completion delivery for Slack is a later stage).

## Alternatives Considered

- **Unify the lark body into one kind-agnostic dispatcher now.** Rejected for
  this slice: high blast radius against a production-critical path with no neutral
  equivalents for its lark-only extras; it would risk the lark byte-identity
  constraint.
- **Thread the resolved sender (or resolver context) into
  `dispatchNeutralMessage`.** Rejected per design review: inject a
  `resolveSender(kind)` function instead, so neutral dispatch never learns the
  resolver's context shape.
- **Mark the task `FAILED` and rethrow on any post-creation error.** Rejected
  (design review): can permanently lose a task; replaced by the durable-enqueue
  ordering above.
