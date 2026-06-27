# Implementation Plan — open-claude-tag

Incremental, each stage compiles + passes tests + ships. See [`DESIGN.md`](./DESIGN.md) for architecture.

## Current State (snapshot)

The named stage deliverables have landed on a green build / lint / unit / Postgres-integration / isolated-e2e baseline, with CI enforcing every gate (lint, typecheck, build+unit, integration, e2e). The two pluggability axes are demonstrated end-to-end:

- **Runtime axis:** Claude Code + Codex through the descriptor registry.
- **Channel axis:** Lark (full) + Slack (inbound Events-API task dispatch + outbound send), both flowing through the same vendor-clean core.

The orchestrator core consumes the neutral `InboundMessage` and names no vendor (ADR-0004); a non-Feishu message dispatches a task and is acknowledged through the neutral pipeline (ADR-0005); the inbound dispatch path's outbound (ack card, replies, reaction) is routed through the neutral `ChannelSender`/`resolveChannelSender` seam, byte-identical for Feishu. The XFF loopback-escalation is closed. Items marked *pending* below are refinements/optional, not blockers.

---

## Stage 0: Foundation
**Goal**: The monorepo foundation — core engine (orchestrator, memory, session, storage, queue), Claude Code + Codex runtime adapters, the Lark channel adapter, and token/dev-auth/pairing auth — on a green build/test baseline.
**Success Criteria**:
- Monorepo builds and boots: `@open-tag/*` packages, `OPEN_TAG_*` env.
- A Lark `@mention` dispatches a task through the orchestrator to a runtime and reports back.
- Auth works: token + dev-auth + machine pairing.
- GitHub PR review path functional.
- Lightweight contributor flow: plan → TDD → PR.
**Tests**: `pnpm build` green; `pnpm -r run test:unit` green (all 19 packages); `prettier --check` clean.
**Status**: **Complete**

---

## Stage 1: Channel abstraction + always-on memory + named-stage checklist
**Goal**: Lark + Claude Code end-to-end through clean channel-neutral contracts; an `@mention` runs a task with a live named-stage checklist; un-addressed channel messages accumulate channel-scoped memory.
**Success Criteria**:
- `packages/channel-core` (`Channel`, `InboundMessage`, `OutboundMessage`, `ChannelScope`, capability flags) + `packages/channel-lark` extracted from `feishu-adapter`.
- Zero channel (`feishu`) types in the core/orchestrator/worker; the worker sends every surface through a neutral `ChannelSender`.
- `RuntimeEvent` gains `plan_update`/`tool_use`; the worker owns a `ChecklistAccumulator` that drives the live checklist.
- An always-on observation tap in the gateway writes channel-scoped memory for addressed *and* un-addressed messages (default-on, sensitive-filtered, per-channel off, audited).
**Tests**: golden e2e fixtures (raw Lark event → outbound card JSON → DB rows) pin behavior before each reshape; new tests: a Lark `@mention` produces a named-stage checklist; an un-tagged message admits a channel-scoped observation. Sub-PRs: **1a** inbound seam (parallel-run a compat adapter) · **1b** outbound `ChannelSender` + `feishuApps→channel_apps` · **1c** extract `LarkChannel`, `apps/api→apps/gateway`.
**Status**: **Substantially complete.** Landed: `channel-core` contracts, `InboundMessage`, `LarkChannel`, the worker `ChannelSender` seam, `plan_update`/`tool_use` + live named-stage checklist, the always-on channel-observation tap. The 1a inbound reshape is done — the dispatch seam, read-side routing, `resolveSession`, `handleNormalMessage`, `handleSlashCommand`, and the orchestrator `handleEvent` all consume the neutral `InboundMessage`; the orchestrator core is vendor-clean (ADR-0004). *Pending (cosmetic/optional):* extracting `LarkChannel` into a standalone `packages/channel-lark`, and the `apps/api → apps/gateway` rename.

## Stage 2: Runtime registry + Codex via descriptors
**Goal**: Adding/selecting a runtime is data-driven; Codex is selectable per identity with no name-string branching.
**Success Criteria**: `RuntimeDescriptor` + `buildRuntimeManager`; closed runtime union → open registry id (zero data migration — varchar); workflow prompt *refs* in descriptors; one factory shared by worker + daemon; split `runtime-claude-code` / `runtime-codex`. `name()` stays `claude_code`; open id is display-only (fixture-tested).
**Tests**: adding a runtime touches one package; Codex task runs through the registry; resume still hits the same adapter for persisted `claude_code`.
**Status**: **Core landed.** `RuntimeDescriptor` + the data-driven descriptor registry + one factory shared by worker and daemon are in place; Codex is selectable per identity with no name-string branching; the persisted key stays `claude_code` while the open display id is fixture-tested. *Pending (optional):* widening the closed runtime union to an open registry id, and physically splitting `runtime-claude-code` / `runtime-codex` out of `runtime-adapters` (the registry already makes this data-driven, so the split is organizational).

## Stage 3: Channel-scoped multiplayer memory
**Goal**: One shared memory per channel; any member picks up where another left off.
**Success Criteria**: `MemoryScopeType.channel` threaded through every read/write/hydrate site; rollup rule (thread sessions read+write the channel store); append-only + async compaction with optimistic versioning; dual ingestion (evidence verifier vs non-containment observation + dedup/decay).
**Tests**: two threads in one channel see each other's admitted facts; two channels do not; user A starts a task, user B continues in-thread, the agent resumes with A's context and zero re-explanation.
**Status**: **Largely complete.** Channel-scoped memory read/write + the multiplayer invariant landed: two threads in one channel share admitted facts keyed by `(channelKind, scopeId)`; two channels stay isolated; the observation tap ingests un-addressed messages (sensitive-filtered, hash-deduped, non-containment). *Pending (refinement):* append-only async compaction with optimistic versioning, and a dedicated write pool / async write-queue for the observation tap (currently detached writes on the shared pool, in-flight-capped — see cross-cutting follow-up).

## Stage 4: Identity + plugins + per-channel access/budget
**Goal**: A channel installs plugins (e.g. jira/datadog-style) with runtime-injected credentials; memory + access isolated per identity; all work budgeted.
**Success Criteria**: first-class `Identity` (persona ⊕ channels ⊕ access ⊕ memory ⊕ budget), zero-access by default; `access-bundles` (Identity↔Channel binding + marketplace resolver + runtime-env secret injection); per-identity token/spend caps enforced in the queue/worker admission path.
**Tests**: a channel installs a plugin with vault-injected creds; `#a` memory invisible to `#b`; a run exceeding budget is admitted/blocked correctly.
**Status**: **Core complete; end-user install surface pending.** First-class `Identity` + `resolveIdentity` (additive composition over the `agents` entity, zero-access default, `memoryScopeId` linked to channel memory). `access-bundles` landed: a vendor-neutral bundle model (declares credential-env NAMES + a per-bundle `envPrefixes` namespace whitelist), an `Object.hasOwn`-hardened marketplace resolver, a `SecretProvider` injection seam, DB-backed `identity_access_grants` (migration `0038`), and worker runtime-env injection on the server-local path (remote-dispatch fails fast, never silently runs without creds). Per-identity budget is fully closed: caps persisted on `agents.budget` (migration `0037`), enforced at the worker admission path (fail-open on resolution error, fail-closed when over cap), and usage recorded on task completion AND failure into `identity_usage` (same `resolveIdentity` path ⇒ recording-id == checking-id). *Pending (optional):* per-channel binding UI / a plugin marketplace surface, a real vault behind `SecretProvider`.

## Stage 5: Ambient + conversation-scoped sandbox
**Goal**: Opt-in channels get gated, budgeted, audited proactive updates; sandboxes persist across a conversation's turns.
**Success Criteria**: `ambient` package — per-channel toggle; per-message post gate; brokered cross-channel flag (audited, `isPrivate`-excluded); stale-thread scanner. Conversation-scoped workspace keyed to `(channelScope, threadId)`, persists across turns, idle teardown via the reconciler.
**Tests**: ambient channel posts a gated/budgeted/audited update; a flag surfaces cross-channel through the broker; turn-2 lands in turn-1's workspace.
**Status**: **Substantially complete** (all four mechanisms landed + tested; each default-OFF, audited, fail-closed; two have explicit activation gaps noted below):
- **Ambient proactive-post gate** (`@open-tag/ambient` + `apps/api/ambient-tap.ts`): default-OFF two-layer (global flag ∧ channel allowlist), injected judge/budget, audits every decision, enqueues an AMBIENT task on approval (deterministic id, bot-sender loop prevention).
- **Brokered cross-channel flag** (`@open-tag/cross-channel` + `apps/api/cross-channel-tap.ts`, ADR-0006): security exclusions (`self_target`/`private_source`/`private_target`/`cross_tenant`) checked BEFORE the allowlist, audits without raw summary, audit-fail-closed-on-delivery, delivery via `resolveChannelSender`. Invocable-but-inert (no live raiser yet).
- **Stale-thread nudge scanner** (`@open-tag/ambient` `findStaleThreads`/`evaluateStaleThreadNudge` + `apps/api/stale-thread-scanner.ts`, ADR-0007): one gated/audited/idempotent nudge (via the audit log) to a stale `waiting_approval` thread's OWN channel; wired into the reconciler tick (primary-only, additive, error-isolated); flag off ⇒ no-op.
- **Conversation-scoped sandbox**: deterministic-path workspace keyed to `(channelScope, threadId)` reused across turns (touch-on-use), idle reaping on the reconciler tick (collision-safe path guard).

*Pending:* the cross-channel broker is invocable-but-inert (no live flag-raising trigger yet) + a DB-backed cross-channel allowlist; the conversation sandbox is wired on the generic server-local path (not yet on every channel/runtime mode); a richer proactive-framing judge; moving the per-channel toggles into `chatConfigs`/UI.

## Stage 6 (optional): channel-slack
**Goal**: Prove the Channel abstraction with a second provider.
**Success Criteria**: `SlackChannel` (`maxUpdateRateHz: 1`, Block Kit, `interaction` for `block_actions`) satisfies the unchanged interface; the same orchestrator/runtime/memory serve Slack with only a new adapter package.
**Tests**: a Slack `@mention` runs the same end-to-end flow as Lark.
**Status**: **Slack proven as a second channel.** `SlackChannel implements Channel` (`channel-slack`; fetch-based, Block Kit, Slack-accurate capabilities, `normalize`/`send`/`react`). Inbound landed: a signature-verified `POST /slack/events` (constant-time HMAC, replay window, raw-body integrity) → channel-neutral observation memory and, when `SLACK_BOT_USER_ID`+`SLACK_BOT_TOKEN` are configured and the bot is @-mentioned, neutral task dispatch via `apps/api/neutral-dispatch.ts` (resolveSession → create → enqueue → ACK through `resolveChannelSender`; ADR-0005), with two-layer idempotency and namespace-isolated sessions. A real-Postgres integration test drives a signed Slack event → task row → enqueue → ACK via an injected sender. *Pending (optional):* OAuth / per-workspace token install, Socket Mode, worker-side completion delivery for Slack, and feature parity with Lark (slash-command tree, buffering, thread/reference enrichment, agent routing) — see ADR-0005's deferral list.

---

## Cross-cutting follow-ups (track as issues)
- **Channel observation write isolation:** the inbound observation tap fires detached writes on the shared API DB pool, bounded by an in-flight cap (load-shed under backlog). A dedicated pool / async write-queue (and per-channel toggle via `chatConfigs`, cheaper LLM gist + decay) is the durable refinement — folds naturally into Stage 3's "append-only + async compaction".
- **Security (pre-existing, before public/prod): RESOLVED.** The XFF-spoofing loopback-escalation is closed. `isEffectivelyLoopback` (one shared, exported predicate in `apps/api/src/admin-api.ts`, used by both the admin break-glass guard and the `/debug/*` + `/api/audit` surface gate in `server.ts`) now anchors trust on the unspoofable TCP peer (`request.socket.remoteAddress`, robust even if `trustProxy` is later enabled) and, behind a same-host reverse proxy, requires the proxy-appended (LAST) `X-Forwarded-For` hop to be a loopback IP literal — never the client-controlled first hop. Malformed chains (empty segments) and `localhost` hostnames in XFF are rejected fail-closed. `dev-auth` remains off by default, trusted-hosts only. Covered by spoof-rejection tests in `admin-api.test.ts` and `debug-surface-gate.test.ts`.
- Codex runtime capability flags (weaker resume/readonly than Claude Code).
- Per-stage gate: run a design review on the stage plan and a diff review before merge. *(Now partly automated: CI runs lint, typecheck, build+unit, Postgres integration, and the isolated API E2E on every push/PR to `main`/`master`.)*
- **Worker-side reaction removal:** the inbound dispatch path's ack reaction is now routed through the neutral `Channel.react` → `ReactionRef`; the worker still removes that reaction via the Feishu client by id (channel-agnostic by id, but not yet routed through the neutral seam). Worker-tier neutralization is a clean follow-up.
