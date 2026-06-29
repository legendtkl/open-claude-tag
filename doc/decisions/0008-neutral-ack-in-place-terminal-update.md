# 0008. Thread the neutral ACK handle so the worker updates it in place

| Field | Value |
|-------|-------|
| Status | Accepted |
| Date | 2026-06-27 |

## Context

A neutral-dispatched (non-lark, e.g. Slack) task posts a "Task queued" ACK at
dispatch (ADR-0005), then the worker delivers the terminal outcome. The worker
posted a SEPARATE terminal message, so a Slack task showed two messages (a stale
"Task queued" plus a result), unlike lark, whose worker UPDATES the original ack
card in place through running → done/failed for a single live message.

The blocker was purely plumbing: the worker had no handle on the ack message to
edit. The channel's `send` returns a `DeliveryRef` (Slack: channel id + message
`ts`), but ADR-0005's dispatch DISCARDED it, and it was produced AFTER the
durable enqueue, so it never reached the job the worker reads.

## Decision

Capture the ack-message handle at dispatch and thread a serializable form into
the job so the worker updates that same message in place.

- **Capture + ordering.** In `dispatchNeutralMessage`, send the ACK BEFORE the
  enqueue and capture its handle — but ONLY on the `task_created` path. This
  amends ADR-0005's "ACK best-effort AFTER the durable enqueue" ordering (see the
  amendment note there). `createTask` is `onConflictDoNothing` on a deterministic
  task id, so EXACTLY ONE dispatch per task is `task_created` ⇒ exactly one ACK
  is ever posted. A `task_duplicate` (recovery redelivery) re-enqueues
  idempotently and does NOT re-ACK.
- **Serializable handle.** `constraints.ackDelivery = { kind, scopeId, messageId }`
  — plain strings that survive the JSON round-trip through pg-boss. `scopeId` is
  the conversation the ack landed in (the channel id); `messageId` is the posted
  message's physical id (Slack `ts`). Captured vendor-neutrally — never by
  reaching into a channel's `native`.
- **Worker update vs send.** `NeutralChannelFeedback` gains an optional `ackRef`
  reconstructed from `constraints.ackDelivery`
  (`{ kind, logicalMessageId, revision: 0, physicalIds: [messageId],
  native: { channel: scopeId } }`, exactly what `SlackChannel.update` reads). The
  terminal `deliver()` calls `sender.update(ackRef, msg)` when present, else
  `sender.send(conversation, msg)`. Both are best-effort (warn + swallow); an
  `update` failure is NOT retried as a send, so a partial edit can't double-post.
  This decision added only the single in-place TERMINAL update; intermediate
  running updates were deferred. See the Slack Milestone 2 amendment below, which
  adds the running phase on the same handle.

### Durability + the orphan edge

Enqueue stays the durable boundary: the ACK is best-effort (a failure yields no
handle and never blocks the enqueue), and an enqueue failure still propagates
(task never marked `FAILED`, dedup claim released for a recovery retry).

Same-task dispatch is serialized by the route's held atomic dedup claim
(`checkAndRecordEvent` inserts `status='received'` `ON CONFLICT DO NOTHING`; a
concurrent same-key delivery sees the held claim and never enters dispatch). So
two dispatches for one task never run concurrently, and the captured handle can
never be raced out of the enqueued job by a concurrent duplicate.

The one residual edge is SEQUENTIAL and accepted as a documented tradeoff: if the
`task_created` ACK posts but its enqueue then THROWS, the claim is released and
the Slack retry returns `task_duplicate` (no ACK, enqueue succeeds with no
handle) → the worker posts a fresh terminal message and the first "Task queued"
is left orphaned. This is rare (enqueue is a local insert), cosmetic, and the
task still completes correctly. Closing it would require persisting the handle on
the task row; a DB column was deliberately avoided for a cosmetic edge.

### Amendment (Slack Milestone 2): running-phase in-place updates

This decision originally added only the terminal in-place update and left
intermediate running updates lark-only. Milestone 2 reverses that deferral: the
worker now also updates the SAME ack message to a live RUNNING card while the task
runs, so a neutral task shows the full queued → running → done/failed lifecycle on
one message (a neutral equivalent of lark's `ThreePhaseFeedback`).

- **Seam.** `NeutralChannelFeedback` gains `updateRunning(snapshot)`, driven from
  the worker's existing runtime-event loop (the `updateRunningCard` closure, which
  already maintains the running description / progress / recent-activity / workdir
  snapshot). It renders the snapshot as a `text` outbound (reusing the channel's
  markdown section path — no channel-adapter change) and edits it onto the ackRef
  via the same no-throw `deliver()`. The lark `ThreePhaseFeedback` /
  `updateRunningFeedbackCard` path is untouched.
- **Rate cap (leading-edge).** Running updates are coalesced to the channel's
  `maxUpdateRateHz` (Slack = 1, i.e. ≥1000ms between running edits) by a
  leading-edge gate: the first update in each open window is sent and intermediate
  updates are DROPPED — there is no trailing timer, so it never queues work or
  exceeds the cap. This drops intermediate running snapshots rather than always
  showing the latest; that is an accepted tradeoff (it mirrors lark's existing
  `RUNNING_CARD_UPDATE_INTERVAL_MS` time-gate and avoids trailing-timer/cleanup
  complexity), and the terminal update always reflects the true final state. The
  window advances on every gated ATTEMPT, not only on success: each `chat.update`
  counts against the cap, and the common failure mode here is being rate-limited,
  so retrying a failed update at the full event rate would hammer the very endpoint
  the cap protects.
- **Terminal bypasses the gate.** `updateDone` / `updateFailed` do NOT consult the
  running rate gate — the terminal update always flushes. A terminal `chat.update`
  can therefore immediately follow a running one; if Slack rate-limits that
  terminal edit, the pre-existing best-effort/no-retry contract (above) leaves the
  card on the last running snapshot. This is an accepted, rare, cosmetic edge
  (no worse than a lost terminal pre-M2, which left the stale "Task queued"); a
  delayed terminal retry is deliberately deferred.
- **No handle / no sender.** With no `ackRef` (no ACK posted) `updateRunning`
  no-ops and the terminal still falls back to a fresh send; with no per-team Slack
  sender the worker never builds the feedback, so there are no running updates and
  the terminal is skipped — both unchanged from the M1 behavior.
- **No capability change.** The running card is markdown via `text`
  (`supportsStreamingEdit` is already true); no channel capability flag flips.

## Consequences

- A Slack task now shows ONE live-updating message (UX parity with lark).
- The lark path and `buildQueuedTaskInput` are untouched; `ackDelivery` is written
  only by the neutral path, so lark job data is byte-identical and the golden /
  feedback tests stay green.
- Back-compat: older queued jobs and a failed ACK carry no `ackDelivery`, so the
  worker falls back to a fresh terminal message (today's behavior).

## Alternatives Considered

- **Add a `tasks.ackDeliveryRef` DB column.** Rejected: a migration for a
  cosmetic edge; the job-data/constraints path already carries the handle and the
  dedup claim makes the concurrent race unreachable.
- **Keep ACK-after-enqueue and patch the job payload post-enqueue.** Rejected:
  pg-boss `send` is `ON CONFLICT DO NOTHING` (no payload merge) and a separate
  job-row UPDATE races the worker pickup; sending on `task_created` before the
  enqueue is simpler and matches the lark house pattern (lark creates its ack card
  before enqueue too).
- **Fall back to a fresh send when `update` throws.** Rejected: a partial edit
  could then double-post; a single swallowed update is safer.
