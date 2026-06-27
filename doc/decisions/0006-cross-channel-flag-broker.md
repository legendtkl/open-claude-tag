# 0006. Brokered, audited, isPrivate-safe cross-channel flagging

| Field | Value |
|-------|-------|
| Status | Accepted |
| Date | 2026-06-27 |

## Context

A defining Claude-Tag behavior is that the assistant, aware of activity across
channels, can surface a signal raised in ONE channel to ANOTHER — but only
through a controlled broker that is opt-in, audited, and excludes private
channels (Stage 5: "brokered cross-channel flag, audited, `isPrivate`-excluded").
Surfacing one channel's content into another is inherently leak-prone: a private
channel's signal must never escape, and a tenant's signal must never cross into a
different tenant. The existing `packages/ambient` proactive-post gate already
establishes the house style for a security-sensitive, opt-in, fail-closed,
injected-dependency, audited gate (default-OFF two-layer: global flag ∧ per-channel
allowlist; `apps/api/src/ambient-tap.ts` wires it in).

## Decision

Add a new vendor-neutral package `@open-tag/cross-channel` exposing a **pure**
core `evaluateCrossChannelFlag(flag, candidates, deps)`, plus a thin IO edge
`apps/api/src/cross-channel-tap.ts` (`brokerCrossChannelFlag`) that delivers
approved flags via `resolveChannelSender`.

- **New package, not folded into `ambient`.** The broker is a distinct concern
  (cross-scope delivery vs. in-channel proactive posting) with its own contracts;
  a small dedicated package mirroring `ambient`'s shape keeps each cohesive.
- **Two-layer default-OFF gate.** A global master switch
  (`OPEN_TAG_CROSS_CHANNEL_ENABLED`, default false) ∧ a per-(source,target)
  allowlist resolver. With the switch off the IO edge is a **complete no-op** (no
  candidate resolution, no audit, no send) — proven by test.
- **Hard, fail-closed security exclusions checked BEFORE the allowlist**, so an
  over-broad or buggy allowlist can never cause a leak: `self_target` (never
  deliver back to source), `private_source` (a private channel's signal never
  leaks out), `private_target` (never deliver into a private channel),
  `cross_tenant` (different `installationId` blocked unless same-tenant-only is
  explicitly disabled — private exclusions still win). A thrown allowlist resolver
  is `config_error` (fail-closed).
- **Every decision is audited** (deliver AND decline) through an injected sink as
  `cross_channel.flag_decision` (mirrors `ambient.post_decision`). The audit
  records scope keys (which leak was blocked) but **never the raw `summary`** (only
  its length), and drops `raisedBy`/`sourceRef` from declines (kept only on
  approved same-tenant non-private deliveries) so a blocked flag cannot leak
  raiser ids or message/doc refs through the audit table.
- **Audit-fail-closed-on-delivery** (a deliberate strengthening over `ambient`,
  justified by leak risk): if recording an approved delivery throws, that target
  is downgraded to NOT delivered (`audit_failed`). A failed send is corrected in
  the audit trail as `cross_channel.flag_delivery` / `send_failed`.
- **Trust boundary.** The pure core trusts its injected scopes by contract (as
  `evaluateAmbientPost` trusts its adapted `AmbientInbound`). The IO edge MUST
  build `flag.sourceScope` and all candidate scopes from trusted channel metadata
  (registry / `Channel.resolveScope`), never from user-controlled event fields.
- **Injected allowlist, no DB table.** The allowlist is injected (interim env,
  mirroring `OPEN_TAG_AMBIENT_CHANNELS`); a DB-backed allowlist/ledger is a
  follow-up. The audit reuses the existing `audit_events` table.
- **Bounded.** Candidates are clamped to `MAX_CANDIDATES` (64) to cap audit/send
  amplification. No relevance judge / budget in the core this slice (relevance is
  a quality filter, not a security control; delivery is a single neutral message,
  not an LLM turn) — both are additive follow-up seams.
- **Loop prevention.** `self_target` drops the source; every delivered message
  carries a `[cross-channel]` marker; any future live raiser MUST skip bot/app
  senders (mirrors `tapAmbient`). The feature is invocable but inert this slice —
  "what raises a flag" is a documented follow-up seam, NOT wired into the
  always-on inbound path.

## Consequences

- A reusable, vendor-neutral, leak-safe primitive for cross-channel signalling
  that is off by default and changes no existing behavior.
- The audit answers "was a flag from scope X delivered/declined to scope Y and
  why", not "what did it say" — auditability without a content-leak surface.
- Audit reads inherit the existing admin/owner + loopback gate on `/api/audit`.
- Follow-ups: a live flag-raising trigger, a DB-backed allowlist, an optional
  relevance judge/budget, and cross-channel delivery enrichment.

## Alternatives Considered

- **Fold into `@open-tag/ambient`.** Rejected: different concern; would muddy a
  cohesive package.
- **Let the broker query channels for candidates.** Rejected: it would make the
  core impure and untestable and move the trust boundary inside the core; instead
  candidates are injected by the trusted IO edge.
- **Store the flag summary in the audit detail.** Rejected: a declined
  private-source flag would leak its content into the audit table; only the length
  is recorded.
- **Best-effort audit (mirror `ambient` exactly).** Rejected for deliveries:
  cross-channel delivery is leak-sensitive, so an unauditable delivery is
  suppressed (`audit_failed`).
- **A new `cross_channel_allowlist` table now.** Deferred: injecting the allowlist
  matches `ambient`'s interim env approach and avoids a migration for this slice.
