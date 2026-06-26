# Implementation Plan — open-claude-tag

Incremental, each stage compiles + passes tests + ships. See [`DESIGN.md`](./DESIGN.md) for architecture.

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
**Status**: Core landed (channel-core, InboundMessage, LarkChannel, ChannelSender seam, plan_update/live checklist, channel observation write+tap); purity refactors pending (full 1a orchestrator reshape, channel-lark extraction)

## Stage 2: Runtime registry + Codex via descriptors
**Goal**: Adding/selecting a runtime is data-driven; Codex is selectable per identity with no name-string branching.
**Success Criteria**: `RuntimeDescriptor` + `buildRuntimeManager`; closed runtime union → open registry id (zero data migration — varchar); workflow prompt *refs* in descriptors; one factory shared by worker + daemon; split `runtime-claude-code` / `runtime-codex`. `name()` stays `claude_code`; open id is display-only (fixture-tested).
**Tests**: adding a runtime touches one package; Codex task runs through the registry; resume still hits the same adapter for persisted `claude_code`.
**Status**: Descriptor + data-driven registry landed; union→open-id + package split pending

## Stage 3: Channel-scoped multiplayer memory
**Goal**: One shared memory per channel; any member picks up where another left off.
**Success Criteria**: `MemoryScopeType.channel` threaded through every read/write/hydrate site; rollup rule (thread sessions read+write the channel store); append-only + async compaction with optimistic versioning; dual ingestion (evidence verifier vs non-containment observation + dedup/decay).
**Tests**: two threads in one channel see each other's admitted facts; two channels do not; user A starts a task, user B continues in-thread, the agent resumes with A's context and zero re-explanation.
**Status**: In Progress — channel-scoped memory read + multiplayer invariant landed

## Stage 4: Identity + plugins + per-channel access/budget
**Goal**: A channel installs plugins (e.g. jira/datadog-style) with runtime-injected credentials; memory + access isolated per identity; all work budgeted.
**Success Criteria**: first-class `Identity` (persona ⊕ channels ⊕ access ⊕ memory ⊕ budget), zero-access by default; `access-bundles` (Identity↔Channel binding + marketplace resolver + runtime-env secret injection); per-identity token/spend caps enforced in the queue/worker admission path.
**Tests**: a channel installs a plugin with vault-injected creds; `#a` memory invisible to `#b`; a run exceeding budget is admitted/blocked correctly.
**Status**: In Progress — first-class `Identity` type + `resolveIdentity` landed (additive composition over the agents entity; zero-access default; `memoryScopeId` linked to channel memory). Pending: `access-bundles` (plugins + runtime-injected creds), per-identity budget enforcement, DB-backed channel binding.

## Stage 5: Ambient + conversation-scoped sandbox
**Goal**: Opt-in channels get gated, budgeted, audited proactive updates; sandboxes persist across a conversation's turns.
**Success Criteria**: `ambient` package — per-channel toggle; per-message post gate; brokered cross-channel flag (audited, `isPrivate`-excluded); stale-thread scanner. Conversation-scoped workspace keyed to `(channelScope, threadId)`, persists across turns, idle teardown via the reconciler.
**Tests**: ambient channel posts a gated/budgeted/audited update; a flag surfaces cross-channel through the broker; turn-2 lands in turn-1's workspace.
**Status**: In Progress — opt-in proactive-post gate landed (`ambient` package; default-OFF two-layer; fail-closed; injected judge/budget) AND wired into the inbound path (`apps/api/ambient-tap.ts` `tapAmbient`): the un-addressed branch now evaluates the gate, audits every decision, and on approval enqueues an AMBIENT-flagged task through the existing dispatch path (idempotent deterministic id, seed-card delivery, bot-sender loop prevention). Airtight per-channel default-OFF (global flag ∧ explicit channel allowlist). Pending: brokered cross-channel flag, stale-thread scanner, per-identity budget enforcement, richer proactive-framing judge, per-channel toggle moved into `chatConfigs`/UI, conversation-scoped sandbox.

## Stage 6 (optional): channel-slack
**Goal**: Prove the Channel abstraction with a second provider.
**Success Criteria**: `SlackChannel` (`maxUpdateRateHz: 1`, Block Kit, `interaction` for `block_actions`) satisfies the unchanged interface; the same orchestrator/runtime/memory serve Slack with only a new adapter package.
**Tests**: a Slack `@mention` runs the same end-to-end flow as Lark.
**Status**: In Progress — `SlackChannel implements Channel` landed (`channel-slack` package; fetch-based, Block Kit, type-level interface proof; Slack-accurate capabilities). Pending: inbound Socket Mode/Events wiring + signature verify, OAuth per-workspace tokens, full Block Kit forms/files, outbound segmentation/coalescing.

---

## Cross-cutting follow-ups (track as issues)
- **Channel observation write isolation:** the inbound observation tap fires detached writes on the shared API DB pool, bounded by an in-flight cap (load-shed under backlog). A dedicated pool / async write-queue (and per-channel toggle via `chatConfigs`, cheaper LLM gist + decay) is the durable refinement — folds naturally into Stage 3's "append-only + async compaction".
- **Security (pre-existing, before public/prod):** fix the XFF-spoofing loopback-escalation — edge proxy must overwrite (not append) inbound `X-Forwarded-For`, or the loopback check must read the last hop. `dev-auth` is off by default, trusted-hosts only.
- Codex runtime capability flags (weaker resume/readonly than Claude Code).
- Per-stage gate: run a design review on the stage plan and a diff review before merge.
