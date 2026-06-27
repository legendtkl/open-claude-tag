# 0004. InboundMessage as the inbound pipeline contract

| Field | Value |
|-------|-------|
| Status | Accepted |
| Date | 2026-06-27 |

## Context

OpenClaudeTag's thesis is a pluggable Channel abstraction: any channel adapter
(Lark, Slack, …) normalizes platform events into the vendor-neutral
`InboundMessage` and renders `OutboundMessage` back out, while the core never
names a vendor. That boundary already exists for *observation memory* — Slack
inbound (`apps/api/src/slack-events.ts`) and the Lark observation tap
(`apps/api/src/channel-observation-tap.ts`) both feed `ingestObservation` an
`InboundMessage`.

The *task* pipeline does not. The inbound task path
(`apps/api/src/server.ts` → `processEventInner` → orchestrator `handleEvent` →
`buildQueuedTaskInput` → enqueue, replying through the Feishu client) still
speaks the Lark-shaped `NormalizedEvent` end to end (~15 core non-test files,
~199 references repo-wide). As a result a second channel can be *observed* but
cannot *dispatch a task or get a reply*. Reshaping this is large and spans
multiple iterations; the risk to manage is breaking the working Feishu path.

We already have the boundary adapter:
`adaptNormalizedEvent(event: NormalizedEvent): InboundMessage`
(`packages/feishu-adapter/src/inbound-message.ts`). Crucially it preserves the
original event **by reference** in `inbound.channel.native`, so the mapping is
lossless and reversible during migration.

## Decision

Make `InboundMessage` (`@open-tag/channel-core`) the inbound contract of the
task-dispatch pipeline, migrated behind a boundary in safe slices that each keep
all tests green.

**Boundary strategy.** A channel adapter produces an `InboundMessage`. During
migration the Feishu WSClient path keeps flowing
`raw → NormalizedEvent → InboundMessage → (neutral dispatch seam) → existing behavior`:
the seam is entered with an `InboundMessage`, and the dispatch body recovers the
Feishu-native `NormalizedEvent` from `channel.native` until each downstream
consumer is migrated to read `inbound.*` directly. The recovery point moves
deeper each slice and is deleted when nothing reads `native`.

**Staged plan.**

- **1a-i (this slice).** Introduce the neutral dispatch seam that *accepts* an
  `InboundMessage`; route the addressed-message Feishu dispatch through it via
  `adaptNormalizedEvent` at the boundary, recovering the native event inside the
  seam. No behavior change. The un-addressed/observation branch and the
  document-comment branch stay on the existing path.
- **1a-ii.** Migrate the dispatch-core consumers (orchestrator intent
  classification + task-state creation, `buildQueuedTaskInput`) to read
  `inbound.*` instead of `event.*`, closing the `InboundMessage` contract gaps
  (see Consequences). Move the native-recovery point past each migrated consumer.
- **1a-iii.** Replace the outbound Feishu-client reply with a `ChannelSender`
  abstraction (`OutboundMessage` → channel render) so a non-Feishu channel can
  reply, and route the Slack task path through the same seam.
- **1b/1c.** Per `AGENTS.md` — broaden to the remaining channel surfaces
  (cards, approvals, attachments) and finish removing `NormalizedEvent` from the
  core.

**Safety strategy.** Golden characterization tests pin today's observable
behavior before any structural change and run on every slice:
`apps/api/src/__tests__/inbound-dispatch-seam-golden.test.ts` pins (1) the seam's
`channel.native` recovery contract (reference- and deep-equal), (2) the dispatch
outcome (orchestrator task row + enqueued job) is identical for the original vs
the seam-recovered event across a representative inbound matrix (@mention, slash
command, image, file, post/rich-text, referenced message). The existing
`/debug/simulate` e2e suite (`self-dev.e2e.test.ts`) remains the DB-backed
characterization of the full dispatch body.

## Consequences

- The dispatch core gains a single, named, channel-neutral entry seam; later
  slices are localized, guarded refactors rather than a big-bang rename.
- A temporary, explicit, grep-able bridge (`recoverFeishuNormalizedEvent`) lives
  at the seam until 1a-ii/iii migrate consumers off `native`.
- Dedup intentionally stays on `event.eventId`/`messageId`/`feishuAppId`; the
  adapter's `dedupeKey` (`lark:<messageId>`) is **not** adopted in 1a-i to avoid
  a behavior change.
- Known `InboundMessage` gaps to close before a *true* channel-neutral dispatch
  (all currently preserved only inside `native`): mention `name`/`index`,
  `content.raw`, command index, referenced-message warnings / per-entry metadata
  / content-type, exact chat-type semantics, Feishu reply-language semantics, and
  channel sender / app identity. Document-comment events are a separate
  normalized type not covered by `adaptNormalizedEvent`.
- **Rollback.** 1a-i is revertible by removing the single seam call site in
  `processEventInner` (restore the inline dispatch body); no schema, queue, or
  wire-format change is involved.

## Alternatives Considered

- **Big-bang rename of `NormalizedEvent` to `InboundMessage`.** Rejected:
  ~199 references, high blast radius, and a real chance of silently breaking the
  Feishu path — the explicit failure mode to avoid.
- **Route only `/debug/simulate` or only one branch through the seam first.**
  Rejected (design review): partial routing creates two divergent dispatch paths
  and *more* risk; the seam placed right after a successful `normalizeEvent`
  covers the whole addressed path in one guarded, reference-identical step.
- **A typed `InboundMessage` carrying the dispatch fields with no `native`
  escape hatch yet.** Deferred: would force closing all contract gaps at once
  (1a-ii) before any seam exists, coupling two risks. The `native` bridge lets
  the seam land first, behavior-preserving.
