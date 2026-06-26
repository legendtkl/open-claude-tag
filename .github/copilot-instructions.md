# OpenClaudeTag Copilot Review Instructions

Focus review comments on correctness, error handling, test coverage, and backward compatibility. Prefer OpenClaudeTag-specific risks over generic style advice.

## Highest-Priority Checks

### 1. `sendMessage` content must stay unstringified
`feishuClient.sendMessage()` serializes `content` internally. Flag any call that passes `JSON.stringify(...)` into `content`.

### 2. Always call `createQueue()` before `boss.send()`
In pg-boss v10, `boss.send()` can return `null` if the queue was never created. New queue send paths must create the queue first.

### 3. Image messages must preserve selected runtime
Codex and Claude Code can both receive prepared image inputs. Review image-message routing changes for regressions that override explicit or session runtime selection.

### 4. Post messages must read nested locale content
Feishu post messages can store text inside locale keys such as `zh_cn` and `en_us`. Review parsers for regressions that only read top-level fields.

### 5. Task card updates need a safe fallback
Feishu PATCH card updates must use conservative JSON card schemas. If a richer update can fail, the code should send a plain-text fallback so tasks do not appear stuck near completion.

## Architecture Constraints

### Event adaptation is required
The Feishu SDK dispatcher emits a flat event shape. `adaptSdkEvent()` in `apps/api/src/server.ts` converts it into the nested `header` + `event` shape expected by `normalizeEvent()`. Do not bypass or remove that adaptation layer.

### Keep the queue-backed execution path intact
Normal flow is:

`Feishu WS -> adaptSdkEvent() -> normalizeEvent() -> dedup -> resolveSession() -> orchestrator -> task queue -> worker -> runtime -> reply`

Only `OPS_TASK` intent returns a direct reply. All other intents must keep going through the task queue.

### Runtime adapter constraints matter
`ClaudeCodeAdapter` uses the SDK query API rather than spawning the Claude CLI. Review runtime changes for dead code, missing error handling, or behavior that breaks resume/worktree flow.

## Verification Expectations

- Expect `pnpm build`, `pnpm test`, and appropriate unit test coverage for implementation changes.
- Expect `pnpm --filter @open-tag/api test:e2e` for non-docs changes, especially when `/dev`, `/reload`, `/schedule`, permissions, task routing, or Feishu event handling are affected.
- Treat missing or weakened tests as a review issue when behavior changes.

## Review Style

- Favor concrete findings over speculative nits.
- Check for descriptive failures, structured logging, and no silent exception swallowing.
- Prefer Zod validation at external boundaries and avoid unnecessary `any` outside Feishu SDK edge cases.

## Repo Snapshot

OpenClaudeTag is a pnpm workspace with `apps/api`, `apps/worker`, and packages including `feishu-adapter`, `orchestrator`, `runtime-adapters`, `queue`, `session`, `storage`, `approval`, and `memory`.
