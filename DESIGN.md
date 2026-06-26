# open-claude-tag — Design

> An open, vendor-neutral re-implementation of [Claude Tag](https://www.anthropic.com/news/introducing-claude-tag): a resident AI teammate that lives in a team chat channel, is summoned by `@mention`, keeps per-channel shared memory, works in the open, and can follow up proactively.
>
> Claude Tag hard-locks two axes — **runtime = Claude** and **channel = Slack**. open-claude-tag turns both into clean, pluggable abstractions: **Runtime** (Claude Code + Codex) and **Channel** (Lark/Feishu first).

---

## 1. Status

| Stage | Scope | State |
|---|---|---|
| **0** | Foundation — monorepo, core engine, runtime adapters, Lark adapter, auth, green build/test baseline | ✅ **Done** |
| 1 | `Channel` abstraction + always-on observation memory + named-stage checklist (Lark + Claude Code end-to-end) | ▶ next |
| 2 | `Runtime` registry + Codex via descriptors | planned |
| 3 | Channel-scoped multiplayer memory + invariants | planned |
| 4 | First-class Identity + plugins + per-channel access/budget | planned |
| 5 | Ambient (3 triggers) + conversation-scoped sandbox | planned |
| 6 | `channel-slack` (proves the abstraction) | optional |

Detailed, testable stages live in [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md).

---

## 2. Claude Tag — the philosophy we emulate

| # | Principle | What it forces here |
|---|---|---|
| 1 | **A shared teammate, not a private assistant** | Memory + identity keyed to a **channel scope**, never a user id. Continuity key = `(scopeId, threadId)`, never `sender.id`. |
| 2 | **Meet people where work happens** | The Channel adapter *is* the front door; no first-class web UI for the core loop. |
| 3 | **Tag-to-delegate is the primary affordance** | Channel detects addressing; orchestrator breaks work into named stages; everything reports to the same thread. |
| 4 | **Work in the open** | A live, human-named **stage checklist**, fed by structured runtime events (not a progress spinner). |
| 5 | **Access is a property of the channel** | Provision a zero-access identity, then attach scoped access bundles. |
| 6 | **Memory isolation is a safety boundary** | Hard per-channel isolation; cross-channel reads only via an explicit, audited, brokered path. |
| 7 | **Credentials are runtime-injected** | Secrets flow through the workspace runtime env; plugins carry env-var *names* only. |
| 8 | **Async-first, long-running** | Durable waiting-contracts; approval is a durable webhook→resume round-trip, never an in-memory promise. |
| 9 | **Ephemeral per-conversation sandbox** | Workspace keyed to the conversation, persists across turns, torn down on idle. |
| 10 | **Proactivity is opt-in, gated, audited; spend-capped** | Ambient *posting* behind a per-channel toggle + budget; memory-*following* is always-on. |

**The load-bearing split:** *following the channel* (passively accumulating channel memory from un-addressed human activity) is **always-on**; *posting unprompted* (ambient) is **opt-in**. Without the always-on observe→memory loop, "team memory" degrades to "the agent's own run history."

---

## 3. Current architecture

A pnpm monorepo. A channel-side **gateway** (`apps/api`) ingests events and dispatches; a **worker** (`apps/worker`) is the real driver that runs runtime adapters and sends results back; an optional **daemon** (`apps/daemon`) hosts remote/ephemeral runtimes. PostgreSQL (drizzle) + pg-boss for state and queue.

```
Lark WS ─▶ apps/api (normalizeEvent) ─▶ NormalizedEvent ─▶ orchestrator
   ─▶ classify intent / select runtime ─▶ Task (storage) ─▶ pg-boss queue
   ─▶ apps/worker ─▶ RuntimeManager.getHealthy(name) ─▶ RuntimeAdapter.prepare/execute
   ─▶ AsyncGenerator<RuntimeEvent> ─▶ card builder ─▶ Lark client
```

| Area | Responsibility | Axis maturity |
|---|---|---|
| `packages/core-types` | Zod models: `NormalizedEvent`, `TaskSpec`, `RuntimeEvent`, `MemoryItem` | — |
| `packages/runtime-adapters` | `RuntimeAdapter` + `RuntimeManager` + registry + Claude Code / Codex / Coco adapters | **runtime ~80% abstracted** |
| `packages/feishu-adapter` | Lark REST client, event normalization, card builder | **channel ~30% abstracted** (the work of §4.2) |
| `packages/orchestrator` | Intent classification, runtime selection, FSM, delegation | channel/runtime-agnostic brain |
| `packages/memory` | `sharedContextEntries` (multiplayer memory), `memoryEntries`, sensitive filter | centerpiece — needs always-on ingestion + channel scope |
| `packages/session` / `approval` / `scheduler` / `queue` / `storage` / `registry` / `llm-client` / `observability` | session/context, RBAC+audit, admission control, pg-boss, drizzle schema, agent manifests, provider-agnostic LLM client, logging | mostly reusable |
| `apps/api` → `apps/gateway` | Lark WS host, ingest, admin, dispatch | refactor target |
| `apps/worker` | The driver; sends cards/comments/handoffs; holds channel clients | refactor target (generalize to a `ChannelSender`) |
| `apps/daemon` / `apps/console` | remote runtime host / ops CLI | keep |

Authentication: **token + dev-auth + machine pairing** (see §6).

---

## 4. Target architecture (the evolution)

```
 channel adapters (channel-lark, channel-slack*)  ──InboundMessage──▶  orchestrator / core
        ▲  OutboundMessage                                                   │ enqueue (pg-boss)
        │                                                                    ▼
 channel-neutral gateway  ──always-on observation tap──▶  worker (ChannelSender · ChecklistAccumulator)
                                                                │ RuntimeAdapter contract
                                  runtime-core (RuntimeManager · RuntimeDescriptor · RuntimeEvent)
                                  ├─ runtime-claude-code   ├─ runtime-codex   └─ RemoteRuntime → daemon
                       memory (per-channel multiplayer) · session · identity · approval/audit · ambient · plugins
              * future adapters; the abstraction must already accommodate them.
```

Dependency direction is strictly downward; a CI lint keeps `channel.native` reads confined to `channel-*` packages so the core can't silently re-couple to Lark.

### 4.2 Channel abstraction (the work that does not exist cleanly today)

Pragmatic-strict: a neutral core model + a typed `native` escape hatch + capability flags, **symmetric on inbound and outbound**.

```ts
interface ChannelCapabilities {
  supportsCards; supportsStreamingEdit; supportsThreads; supportsForms; supportsApprovalButtons;
  supportsAttachmentsIn; supportsAttachmentsOut;
  maxOutboundChars; maxOutboundElements; maxUpdateRateHz;   // drive segmentation / coalescing / degradation
}
interface ChannelScope { kind; scopeId /*isolation unit = channel*/; installationId; threadId?; isPrivate }
interface InboundMessage {
  channel: { kind; native: unknown };          // escape hatch (CI-lint-fenced)
  eventId; messageId; eventType: 'created'|'updated'|'deleted'|'reaction'|'interaction';  // event semantics
  occurredAt; dedupeKey;
  conversation: ConversationRef;               // neutral threading: { scopeId, threadId?, reply?:{rootId,parentId} }
  scope: ChannelScope; sender: { id; isBot };
  content: { type; text?; command?; interaction?; mentions; attachments; referenced? };
}
type OutboundMessage =
  | { kind:'text' } | { kind:'checklist'; steps; status } | { kind:'result'; artifacts? }
  | { kind:'approval'; prompt } /*request only; answer returns as inbound 'interaction'*/
  | { kind:'form' } | { kind:'comment' } | { kind:'discussion' } | { kind:'handoff' }
  | { kind:'native'; payload } | { kind:'error' };
interface Channel {
  kind; capabilities(); start(sink); normalize(raw): InboundMessage | null;
  extractAddressingSignals(msg): AddressingSignal[];   // channel emits neutral mention tokens; core does roster matching
  send(to, msg, opts?): DeliveryRef; update(ref, msg, { revision }): DeliveryRef;  // logical-message model: logicalMessageId + revision; low revision dropped
  uploadArtifact(file): RemoteRef; fetchAttachment(att, dir): LocalFile;
  resolveScope(msg); healthcheck();
}
```

A `LarkChannel` wraps today's normalizer + card builder; `renderOutbound` must cover every surface the worker uses (running-card, done-segments, document-comment, discussion, handoff, workdir-confirm form). A future `SlackChannel` satisfies the *same* interface with different capability flags (`maxUpdateRateHz: 1`, Block Kit). **Approval is not an in-memory promise**: `send({kind:'approval'})` → user taps a button → arrives as a separate inbound `interaction` → orchestrator → resume (survives restarts; supports "wait for days").

### 4.3 Runtime abstraction

`RuntimeAdapter` is already transport- and channel-neutral. The evolution adds a **descriptor** + data-driven registry, feeds **pre-materialized attachments** (drop the channel image downloader), and adds the structured events the checklist/approval need.

```ts
interface RuntimeAdapter {
  name(): string;            // PERSISTED key, e.g. 'claude_code' (sessions.runtimeBackend compares it — never rename)
  descriptor(): RuntimeDescriptor;   // descriptor().id is the open display/registry id, e.g. 'claude-code'
  prepare(spec, ws): RuntimeHandle;
  execute(handle, spec, opts?: { permissions?: AsyncIterable<PermissionDecision> }): AsyncGenerator<RuntimeEvent>;
  resume(sdkSessionId, prompt, ws, opts?): AsyncGenerator<RuntimeEvent>;
  cancel(executionId); healthcheck();
}
// RuntimeEvent (existing) + structured variants required for "show your work" & mid-run approval:
//   + { type:'plan_update'; steps:[{id,title,status}] }   // from TodoWrite/tool_use, no longer flattened to 'reasoning'
//   + { type:'tool_use'; name; summary; status }
//   + { type:'permission_request'; id; tool; input; riskLevel }   // answer via execute(...).permissions, persisted (survives restart)
interface RuntimeDescriptor {
  id; displayName;
  capabilities: { resume; enforcesReadOnly; interactivePermission; sandboxModes; imageInput; modelSelection };
  credentialEnv: CredentialField[];   // env-var NAMES only
  workflowPrompts: { selfDev?; readonly?; default? };  // refs resolved by workflow-loader, not inline content
}
```

`ClaudeCodeRuntime` and `CodexRuntime` both satisfy this; `CocoAdapter`/`RemoteRuntimeAdapter` prove a 3rd/remote runtime drops in. `WorkspaceContext` carries a `conversationKey` and `isolation: 'worktree' | 'inplace'` (configurable per channel/identity, default worktree).

### 4.5 Memory model — per-channel, multiplayer, always-on following

- **Always-on observation→memory loop** (the "follows the channel" behavior): every inbound message (addressed *or not*) on a memory-enabled channel passes a cheap extractor that writes channel-scoped memory. **Default-on**; only proactive *posting* is opt-in.
- **Channel scoping**: a `channel` memory scope keyed by `channelScope.scopeId`, threaded through every read/write/hydrate site (today it defaults to the thread/session, so two threads in one channel see isolated memory — that is the bug to fix). Thread sessions read+write the single channel store.
- **Consistency**: append-only entries + async compaction with optimistic versioning; hydrate reads the latest visible snapshot; compaction never overwrites newly-admitted facts.
- **Dual ingestion**: agent-asserted facts keep the evidence verifier (high bar); passively-observed human statements use a non-containment path with dedup + decay. A sensitive-info filter gates both.
- **Hard isolation**: queries scoped by `(scopeType='channel', scopeId)`. Cross-channel reads only via the brokered, audited flag path (§4.7), never silent; `isPrivate` scopes excluded by default.
- **Default-on with safeguards** (user-confirmed): channel-following is enabled by default with the sensitive filter + per-channel off switch + full audit. Privacy notice in-channel is expected.

### 4.7 Ambient (deferred to Stage 5) — three triggers, durable, budgeted

(a) per-message post gate (cheap LLM/heuristic, fires only if worth-saying and within budget); (b) brokered cross-channel flag (explicit grant, audited source+target, `isPrivate`-excluded); (c) stale-thread scanner (cron over open threads / waiting-contracts). **Per-identity spend caps apply to ALL work, not just ambient.** Durable async via waiting-contracts + reconciler.

### 4.8 Identity (first-class)

`Identity = { id, persona (soul), boundChannels, accessBundleRef, memoryScopeId, budget }`, provisioned **zero-access**. Memory and access bundles key to the Identity↔Channel binding. (First iteration may carry only id/channels/runtime/memory-scope/active; access bundles + budget land with plugins in Stage 4.)

### 4.9 Plugins — MCP transport + Claude-Code-style packaging + a thin access-bundle layer

No custom RPC registry. Both runtimes already load Claude-Code-style plugins + MCP. New code is only: a marketplace mirror, an access-bundle binding (Identity↔Channel → plugins + credential refs), and runtime-env secret injection at `prepare()`. Secrets never touch the plugin payload or the channel.

---

## 5. Key decisions (user-confirmed)

| # | Decision | Rationale |
|---|---|---|
| a | npm scope `@open-tag`, env prefix `OPEN_TAG_`, product name `open-claude-tag` | — |
| c | Channel first impl = **Lark**; runtime first impls = **Claude Code + Codex** | match Claude Tag's surface, then open the axes |
| d | **Pragmatic-strict** Channel abstraction with a typed `native` escape hatch + capability flags | leak-proof across Lark/Slack without over-abstracting |
| e | Approval = **durable inbound `interaction` → resume**, not an in-memory promise | survives restarts; matches async-first |
| f | Memory-**following is always-on** (default-on, sensitive-filtered, per-channel off, audited); only **posting** is opt-in | the single biggest Claude-Tag-fidelity point |
| g | Plugins = **MCP + Claude-Code packaging + access bundles**; no custom registry | reuse runtime loaders; runtime-injected credentials |
| h | Execution = **local worker**, `worktree` isolation **configurable** (default on); daemon seam kept for remote/ephemeral | simplest first; isolation protects concurrent runs |
| i | **Lightweight process** — no OpenSpec / spec-driven flow; plain plan → TDD → PR | keep the repo and contributor flow simple |

---

## 6. Known issues / follow-ups

- **Auth (security):** authentication is token + dev-auth + machine pairing. A **XFF-spoofing loopback-escalation** path exists (an edge proxy *appends* rather than *overwrites* the inbound `X-Forwarded-For`, and the loopback check trusts its first segment) — **fix before any public/production deployment** (edge proxy should overwrite inbound XFF, or the loopback check should read the last hop). `dev-auth` is off by default and documented as "trusted hosts only."
- **Codex runtime tier:** Codex's resume/read-only/interactive-permission guarantees are weaker than Claude Code's; encoded via `RuntimeDescriptor.capabilities` (best-effort, fewer guarantees).
- **Open product questions:** memory reconciliation on channel-membership change; ambient defaults + per-identity budget; whether the brokered cross-channel flag ships in the first ambient cut; marketplace governance / third-party plugin vetting.
