# Discussion Orchestration

Discussion orchestration adds a flag-gated turn-based flow for multi-agent debate and a shared handoff primitive for directed agent-to-agent work.

## Enablement

The feature is off by default.

| Variable                           | Default                | Purpose                                                                                       |
| ---------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------- |
| `DISCUSSION_ORCHESTRATION_ENABLED` | unset / false          | Enables `/discuss`, relay routing, actor-vs-reference routing, and handoff delivery.          |
| `DISCUSSION_TRIGGER_MODE`          | `slash`                | `slash` enables only `/discuss`; `heuristic` also accepts discussion-like multi-mention text. |
| `DISCUSSION_MAX_ROUNDS`            | implementation default | Caps turn-based discussions.                                                                  |

Rollback is immediate: set `DISCUSSION_ORCHESTRATION_ENABLED=false` or unset it, then restart API/worker. In rollback mode, multi-mention routing is intentionally the old fanout behavior, including relay-looking and reference-looking messages.

## `/discuss`

Use `/discuss` in a group root message with at least two mentioned agent bots:

```text
/discuss @R2D2 正方 @Reviewer 反方 讨论是否应该采用方案 B
```

When enabled, the API creates one discussion record for `(tenantId, chatId, rootMessageId)`, snapshots participants including `feishuAppId`, creates an internal discussion session, and enqueues the first turn. Duplicate same-root app deliveries reselect the same discussion instead of creating parallel discussions.

Each turn receives the topic, participant roles, and the ordered DB transcript. The next turn is driven by committed DB state, not by Feishu render success.

## Relay Syntax

Relay routing handles messages such as:

```text
@Developer 分析这个问题，完成后让 @Reviewer review
```

Routing is layered, decided once per message and shared across all concurrent app deliveries (in-process memo keyed by message id):

1. **LLM classification** (when `OPEN_TAG_LLM_*` is configured — a small model is sufficient): one call returns `relay` / `reference` / `fanout` as strict JSON, validated against the roster of actually-mentioned agents (closed `agent_N` short codes); one targeted-feedback retry, then fall through.
2. **Deterministic lexicon** (`findRelayRoute`): sequence markers including `完成后/之后/然后/再/接着`, verb+`完`(了) forms (`合并完`, `改完了`), `搞定后/结束后`, and English `then/after/once done`; the delegate verbs `请/让/交给/艾特/at` are stripped from the relayed goal. Bare `完` only counts when immediately followed by `艾特`/`@`, so `完善` never matches.
3. **Fanout** — no detected ordering means every mentioned agent acts now (also the rollback behavior when the flag is off).

A relay decision starts only the primary agent task. Each deferred agent's delivery posts a visible **waiting ack** ("收到，等 @A 完成后我来…" — plain text, deliberately no real `<at>` tag so it cannot re-trigger the primary) and persists a **waiting contract** (`waiting_contracts`, idempotent per `(message_id, agent_id)`) instead of creating a task.

When the primary task completes, the worker consumes the contracts: each deferred agent gets one visible group message that really `<at>`-mentions its bot with the delegated goal (deterministic per-contract `uuid` so Feishu dedupes resends; atomic `waiting → woken` CAS so an agent-authored mention racing the hook cannot double-wake). The wake message re-enters the normal mention intake on the target bot — the same channel as a human `@`. Primary failure transitions contracts to `cancelled` with a visible notice. A worker reconciler expires orphaned contracts (`WAITING_CONTRACT_ORPHAN_MS`, default 5 min without a primary task; `WAITING_CONTRACT_TTL_MS`, default 24 h overall) with a visible "请重新指派" notice — contracts are never silently dropped. Legacy constraint-based relay plans created before this pipeline remain consumable by the old path.

Deployment prerequisite for the wake hop: each agent bot's Feishu app must hold the `im:message.group_at_msg.include_bot:readonly` scope so bot-sent mention messages are delivered as events.

## Actor Vs Reference

Possessive references are not treated as actors. For example:

```text
@Reviewer review @Developer 的方案
```

Only `@Reviewer` is tasked. `@Developer` is preserved as referenced context.

## Agent Handoff Tool

Agents may request a bounded handoff in the final answer:

```xml
<handoff_to_agent>{"handle":"Reviewer","goal":"review the implementation","expected_output":"risks and required fixes","mode":"return"}</handoff_to_agent>
```

`mode: "return"` marks the parent task `WAITING_DELEGATION` and wakes it through the existing delegation barrier when the child finishes.

`mode: "chain"` creates the downstream child and lets the parent complete after enqueue.

The v1 parser accepts one `handoff_to_agent` call per final answer. Its idempotency key is based on `(parentTaskId, targetAgentId, callIndex)`, currently `call-0`. If multiple handoffs in one parent turn are added later, the call index must increment by parse order.

## Exactly-Once Guarantees

- Discussion root creation is unique per `(tenantId, chatId, rootMessageId)`.
- Discussion turn completion, next-turn creation, and next-turn admission lease creation are committed atomically.
- Feishu rendering happens after commit and is idempotent by stable Feishu `uuid` plus `discussion_turns.metadata`.
- Relay handoff child IDs derive from the relay key.
- Tool handoff child IDs derive from parent task, target agent, and call index, not generated goal wording.
- Explicit child creation uses an orchestrator DB-layer advisory lock and reselects existing child/delegation state before budget reservation, so duplicate delivery does not double-count budget or create duplicate leases.

## Observability

The implementation uses structured Pino logs. Useful events include:

- discussion root creation and cancellation in `apps/api/src/server.ts`;
- skipped secondary relay/reference deliveries in the API intake path;
- discussion guard skips for stale, cancelled, or over-budget turns;
- discussion turn and closing render success in `apps/worker/src/discussion-turn-renderer.ts`;
- terminal transition retry logs when discussion commit or render fails;
- handoff delivery and enqueue retry behavior in `apps/worker/src/handoff-delivery.ts`.

Debug-only endpoints used by isolated E2E are:

- `POST /debug/latest-discussion` for discussion, participant, and turn-task inspection;
- `POST /debug/session-tasks` for message-bound task inspection;
- `POST /debug/task-status` for controlled terminal-state simulation.

Runtime health remains available through `/health`; it verifies API liveness and DB connectivity without exposing secrets.

## QA Gates

The #16 QA matrix covers:

- clean isolated DB migration setup;
- flag-off rollback E2E;
- flag-on `/discuss`, human cancel, relay, actor-vs-reference, and ordinary multi-mention E2E;
- focused worker discussion/render/handoff/recovery tests;
- gated Postgres storage discussion tests;
- gated Postgres orchestrator duplicate child handoff tests;
- workspace `pnpm test`, `pnpm typecheck`, `pnpm build`, and `git diff --check`.
