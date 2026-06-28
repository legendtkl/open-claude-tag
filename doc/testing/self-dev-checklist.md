# Self-Dev Verification Checklist

This document is the detailed verification checklist for OpenClaudeTag self-dev changes. `AGENTS.md` keeps the high-level summary and points here for the worktree-safe execution order.

## Scope

Use this checklist after implementing a code change in a OpenClaudeTag worktree.

It is intended for:

- Self-dev feature work
- Bug fixes
- Refactors that affect runtime behavior
- Any change that is not docs-only

## Required Gates

Before commit or PR, the following gates must pass:

1. `pnpm lint`
2. `pnpm build`
3. `pnpm test`
4. Postgres integration (storage + admin API)
5. API E2E

For worktrees, satisfy the Postgres integration gate with the isolated wrapper:

```bash
pnpm test:integration:isolated
```

This still represents the same Postgres integration requirement as:

```bash
pnpm test:integration
```

(which needs `DATABASE_URL` in the shell; the isolated wrapper injects the worktree's derived database instead).

For worktrees, satisfy the API E2E gate with the isolated wrapper:

```bash
pnpm test:e2e:isolated
```

This still represents the same API E2E requirement as:

```bash
pnpm --filter @open-tag/api test:e2e
```

The isolated wrapper is preferred because worktrees may run in parallel and must not reuse the default local port or database blindly.

## Standard Worktree Flow

Run the following sequence after finishing implementation.

### 1. Ensure Postgres is available

```bash
docker compose -f infra/docker-compose.yaml up postgres -d
```

### 2. Prepare the isolated database when needed

Run this on a new worktree, after isolated state was purged, or whenever schema or seed data changes:

```bash
pnpm db:setup:isolated
```

### 3. Start the isolated API

```bash
pnpm dev:api:isolated
```

### 4. Start the isolated Worker when the change needs real task execution

Start the Worker when the change touches queue dispatch, runtime adapters, worker execution, approval flow, task progression, or any end-to-end path that depends on dequeued jobs.

```bash
pnpm dev:worker:isolated
```

You do not need the Worker for the current API E2E suite when tests use `skipTaskExecution: true`, but you should still run it for manual validation when the feature depends on real task execution.

### 5. Run the required verification gates

```bash
pnpm lint
pnpm build
pnpm test
pnpm test:integration:isolated
pnpm test:e2e:isolated
```

## Important Notes

- `pnpm test:e2e:isolated` does not start the API for you. Start `pnpm dev:api:isolated` first.
- `pnpm test:e2e:isolated` and `pnpm test:integration:isolated` do not run database migration or seed for you. Prepare the isolated database explicitly with `pnpm db:setup:isolated` when needed.
- `pnpm test:integration:isolated` needs only Postgres and the migrated isolated database — no API or Worker process. Prefer running it BEFORE starting the isolated Worker: a live worker's background sweeps (admission rescheduler, delegation reconcile) mutate the same database and can race integration fixtures.
- The API E2E suite talks to the running API via `API_URL` and validates the slash-command flow through `POST /debug/simulate`.
- In worktrees, prefer the isolated wrapper instead of manually inventing ad-hoc ports or database names.
- Do not use Feishu entry points to restart isolated worktree services.

## When Manual Validation Is Also Required

In addition to the automated gates above, run a manual isolated flow when the change affects:

- Worker-side execution
- Queue delivery and dequeue behavior
- Feishu card lifecycle updates
- Runtime-specific behavior that the current API E2E suite does not execute
- Background polling or long-running services

Recommended manual setup:

```bash
pnpm dev:api:isolated
pnpm dev:worker:isolated
```

Then exercise the feature through the relevant debug endpoint, test script, or Feishu-facing dev tooling.

### Real `@bot` validation via dev bot (optional)

When the change affects user-facing Feishu interactions (mentions, threading, group root replies, card actions in a real chat) and `POST /debug/simulate` is not enough, validate against a real Feishu `@bot` from the isolated worktree. This requires a one-time dev-bot setup — see root `AGENTS.md` "Worktree Feishu Validation".

Once the main `.env` declares `FEISHU_DEV_APP_ID` / `FEISHU_DEV_APP_SECRET`, the worktree flow is:

1. From the main repo root: `tools/worktree/create.sh <name>` (or re-run for an existing worktree). The script writes a real `.env` with `FEISHU_APP_ID/SECRET` swapped to the dev bot and `OPEN_TAG_FEISHU_ACCESS=enabled` appended.
2. Confirm: `grep -E '^FEISHU_APP_ID|^OPEN_TAG_FEISHU_ACCESS' .env` inside the worktree should show the dev `app_id` and `enabled`.
3. `pnpm dev:api:isolated` and `pnpm dev:worker:isolated`.
4. Watch the API log for `Feishu WSClient starting...` followed by `[ws] ws client ready`, and note the `botOpenId` printed alongside — it must be the **dev** bot's open_id, not the primary bot's.
5. `@` the dev bot from a private test chat that does NOT contain the primary bot.
6. Stop with `pnpm isolated:stop` when done.

Hard rule: never point an isolated worktree at the production `FEISHU_APP_ID` — `tools/worktree/create.sh` refuses to run if `FEISHU_DEV_APP_ID == FEISHU_APP_ID`, and you should not bypass it by hand-editing the worktree `.env`.

### Real two-bot Feishu validation (optional, on-demand)

Use this only when a change needs real same-topic behavior across two Feishu bot identities, such as multi-agent context sharing, quoted images, mention routing, or one agent reviewing another agent's output. This is not required for ordinary unit, integration, or `POST /debug/simulate` coverage.

For the personal quick-start stack, prefer the stored-secret web-UI path:

```bash
API_URL=http://127.0.0.1:3820 pnpm lark:personal-two-bot-e2e
```

The default command is a no-side-effect readiness check over `/health`, the admin
bot registry, and message-flow permissions. To run the visible Feishu E2E after
operator confirmation, add `--execute`; it creates a private test chat, sends one
`@bot` message, and prints the chat/message/task evidence.

For isolated worktrees seeded from env credentials, use the legacy path below.

1. Put the two local test bot credentials in the gitignored `.env` of the worktree, or in the main repo `.env` when the worktree `.env` is a symlink:

   ```bash
   FEISHU_LOCAL_E2E_BOT1_APP_ID=cli_xxx
   FEISHU_LOCAL_E2E_BOT1_APP_SECRET=...
   FEISHU_LOCAL_E2E_BOT1_AGENT_HANDLE=codex-mac
   FEISHU_LOCAL_E2E_BOT1_AGENT_DISPLAY_NAME=OpenClaudeTagBot1

   FEISHU_LOCAL_E2E_BOT2_APP_ID=cli_yyy
   FEISHU_LOCAL_E2E_BOT2_APP_SECRET=...
   FEISHU_LOCAL_E2E_BOT2_AGENT_HANDLE=reviewer
   FEISHU_LOCAL_E2E_BOT2_AGENT_DISPLAY_NAME=OpenClaudeTagBot2
   ```

2. Prepare and seed the current isolated database:
   ```bash
   pnpm db:setup:isolated
   pnpm lark:setup-two-bot-e2e
   ```
   The setup command stores `app_secret_ref=env:<secret-var>` and never stores the secret values in Git or DB rows. It refuses to run outside an isolated instance unless `ALLOW_PRIMARY_FEISHU_LOCAL_E2E=true` is deliberately set.
3. Start Feishu access explicitly for this validation run:
   ```bash
   OPEN_TAG_FEISHU_ACCESS=enabled pnpm dev:api:isolated
   OPEN_TAG_FEISHU_ACCESS=enabled pnpm dev:worker:isolated
   ```
4. In a private validation chat that contains the two local test bots but not the production or shared devbox bot, exercise a real same-topic flow:
   ```text
   @OpenClaudeTagBot1 解读一下这个图片
   @OpenClaudeTagBot2 评价一下上面 codex-mac 的回复
   ```
5. Stop the isolated services with `pnpm isolated:stop` when done.

### New Feishu bot verification (optional, on-demand)

When a change affects Feishu bot onboarding, app permissions, WebSocket
lifecycle, active bot bindings, or document-comment mentions, follow
[`new-feishu-bot-verification.md`](new-feishu-bot-verification.md). That runbook
covers console registration, local two-bot seeding, permission approval,
document ACL setup, full-document comment E2E, referenced text comment E2E, and
unbind/delete WebSocket teardown checks.

## Cleanup

Use the isolated lifecycle commands as needed:

```bash
pnpm isolated:stop
pnpm isolated:reap
pnpm isolated:purge
```

Behavior summary:

- `pnpm isolated:stop` stops only the current worktree services
- `pnpm isolated:reap` cleans up leaked isolated processes and orphaned databases
- `pnpm isolated:purge` removes the current isolated instance completely, including runtime files and database

## PR Recording

When filling the PR checklist, record the API E2E and Postgres integration gates as passed even if you ran them through:

```bash
pnpm test:integration:isolated
pnpm test:e2e:isolated
```

These isolated wrappers are the worktree-safe way to satisfy the required verification.
