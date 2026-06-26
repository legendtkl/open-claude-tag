# Agent Operations Reference

This document holds the long-form operational guidance that does not belong in
the lightweight root `AGENTS.md`. Read it when you need exact local stack,
isolation, Feishu dev-bot, or remote server-daemon validation procedures.

## Running the Full Stack

The system requires both API and Worker to process tasks end-to-end. The API
receives Feishu events and enqueues tasks; the Worker dequeues and executes
them. Starting only the API accepts messages and shows ACK cards, but tasks stay
stuck at "Request received".

```bash
# 1. Ensure Postgres is running
docker compose -f infra/docker-compose.yaml up postgres -d

# 2. Prepare the database schema and seed data
pnpm db:setup

# 3. Build all packages first after code changes
pnpm build

# 4. Start API server in one terminal
pnpm dev:api

# 5. Start Worker in another terminal
pnpm dev:worker
```

For a detached local stack that survives terminal exit and writes per-service
logs under `logs/services/`, use:

```bash
pnpm services:start
pnpm services:stop
pnpm services:restart
```

After pulling or making local changes, rebuild before restarting:

```bash
pnpm build && pnpm services:restart
```

`services:restart` automatically kills rogue unmanaged API/Worker processes from
the same project directory before spawning new ones. This prevents duplicate
workers competing for the same pg-boss queue.

Worktrees propagate `.env` through `tools/worktree/create.sh` by symlink by
default, or by copy plus dev-bot swap when configured. If you land in a worktree
without `.env`, re-run `tools/worktree/create.sh <name>` from the main repo root
rather than hand-rolling a symlink.

## E2E Isolation

Do not assume `localhost:3000` or the default local database are free. Multiple
tasks or worktrees may be running in parallel.

For the full post-implementation verification order, use
`doc/testing/self-dev-checklist.md`.

When running E2E or manual debug flows, first inspect the local environment and
choose an isolated setup instead of hardcoding a port or reusing shared state:

- Check which API ports are already in use before starting another API instance.
- If the default port is occupied, choose a free port and pass it through
  `PORT=...` when starting the API.
- Point tests and debug scripts at the chosen API instance with
  `API_URL=http://localhost:<port>`.
- Consider database isolation. If the shared local database could cause
  cross-test interference, use a worktree-specific `.env` or another isolated DB
  target before running E2E.
- Prefer treating port selection and DB isolation as an environment-discovery
  step owned by the agent, not a fixed command sequence.

For OpenClaudeTag worktrees, prefer the built-in isolated commands:

```bash
pnpm dev:api:isolated
pnpm dev:worker:isolated
pnpm test:e2e:isolated
```

Important boundary:

- Isolated instances default to Feishu-disabled.
- They MUST NOT subscribe to the same Feishu app as the primary.
- They MAY opt in to a separate dev bot via
  `OPEN_TAG_FEISHU_ACCESS=enabled`; see "Worktree Feishu Validation" below.
- Drive automated verification through `POST /debug/simulate`.
- Use the dev bot only for manual `@bot` validation that the simulate endpoint
  cannot cover.
- The primary instance owns the production bot's WebSocket; never point an
  isolated instance at the production app id.

Cleanup rules:

- `pnpm isolated:stop` stops only the current worktree's API/worker and keeps
  the isolated DB intact.
- `pnpm isolated:reap` reclaims leaked isolated processes and drops orphaned
  isolated DBs once the instance has no live pids.
- `pnpm isolated:purge` fully removes the current isolated instance, including
  its DB and runtime files.

## Worktree Feishu Validation

Worktrees default to Feishu-disabled to avoid double-subscription alongside the
primary bot. When a change needs real `@bot` validation that
`POST /debug/simulate` cannot cover, register a separate Feishu app as your dev
bot and add its credentials to the main repo `.env`:

```bash
FEISHU_DEV_APP_ID=cli_xxx
FEISHU_DEV_APP_SECRET=xxx
```

`tools/worktree/create.sh` then materializes a real `.env` inside each worktree
instead of the symlink fallback, rewriting `FEISHU_APP_ID` and
`FEISHU_APP_SECRET` to the dev values and appending
`OPEN_TAG_FEISHU_ACCESS=enabled`. `tools/instance/config.mjs` reads that flag
from the worktree `.env`, so `pnpm dev:api:isolated` and
`pnpm dev:worker:isolated` open a WSClient against the dev bot.

Existing worktrees pick up the change on the next idempotent
`tools/worktree/create.sh <name>` run.

Hard rules:

- Each developer registers their own dev bot in the Feishu open platform.
- Never reuse the primary bot's `app_id`; the create script refuses to run if
  `FEISHU_DEV_APP_ID == FEISHU_APP_ID`.
- Add the dev bot only to private test chats that do not contain the primary
  bot. Both bots in the same chat will react to the same mentions.
- Without dev bot credentials, the worktree falls back to the symlinked `.env`
  and isolated stays Feishu-disabled.

The opt-in gate lives in:

- `apps/api/src/server.ts`
- `apps/worker/src/main.ts`
- `tools/instance/config.mjs`

## Server-Centralized Mode Reference

OpenClaudeTag can run as a central server serving a whole team, with optional
per-user execution daemons (`@open-tag/daemon`, `apps/daemon`) that pair from
the admin console and execute tasks on user machines through the worker-hosted
daemon gateway (`DAEMON_GATEWAY_PORT`, default `3001`).

Core invariants are summarized in root `AGENTS.md`. Deeper docs:

- Deploy and operate a server: `doc/deployment/server-mode.md`
- Isolated server-daemon remote-execution test:
  `doc/testing/server-daemon-isolated-test.md`

## Full Server-Daemon E2E

Use `doc/testing/server-daemon-isolated-test.md` as the authoritative runbook.
This section keeps the verified procedure discoverable from the agent guide.

To exercise the real cross-machine path, with a remote box as the central server
and your machine as the daemon, without touching production on a shared box:

1. Deploy an isolated server on the remote box.
   `git bundle` the branch, copy it over, clone into a fresh directory, run
   `pnpm install --no-frozen-lockfile`, then
   `pnpm -r --filter '!@open-tag/desktop' run build`. The isolated
   `instanceId` is the directory basename; `OPEN_TAG_INSTANCE_ID` is ignored in
   non-primary worktrees. API port is `3100 + hash(instanceId) % 2000`, gateway
   is API port plus `2000`. Pick a directory name whose derived ports avoid
   production and other isolated instances. Copy the prod `.env`; isolated role
   keeps Feishu disabled unless `OPEN_TAG_FEISHU_ACCESS=enabled`.
2. Handle DB setup without `psql` on bare boxes. Embedded Postgres ships no
   `psql`, so `db:create:isolated` and `dev:*:isolated --ensure-db` can fail
   with `spawnSync psql ENOENT`. Create the isolated DB through the `postgres`
   driver, then migrate/seed/start through
   `node tools/instance/run.mjs exec -- <cmd>` without `--ensure-db`.
3. Reach the gateway from the daemon. Start the worker with
   `DAEMON_GATEWAY_PUBLIC=true` when binding `0.0.0.0` is required. The daemon
   `--server-url` is the gateway base URL, for example
   `http://<box>:<gatewayPort>`. `/daemon/*` is served on the gateway port; the
   API port returns 404 for those routes.
4. Pair and run a task. Dev-login with `POST /admin/auth/dev-login {sub}`, keep
   the cookie, call `POST /admin/machines/pairing-token`, then run the local
   daemon with
   `node apps/daemon/dist/index.js --server-url http://<box>:<gw> --token <t>`.
   Create a `claude_code` agent with per-agent
   `runtimeEnv.ANTHROPIC_BASE_URL/API_KEY` plus `machineId`, then trigger through
   `POST /debug/simulate` with `virtualAgentHandle`. Handles must match
   `[A-Za-z0-9_-]+`; `deriveAgentHandle` does not kebab-case spaces.
5. Remember capability behavior. The daemon advertises `claude_code`
   unconditionally because the SDK ships with the daemon and per-agent
   credentials arrive at dispatch. It advertises codex only when its binary
   resolves. Machine runtimes refresh on reconnect, so a rebuilt daemon
   re-advertises without re-pairing.
6. Teardown with `pnpm isolated:purge`, remove the worktree/bundle, and stop the
   local daemon. Never use a broad `pkill -f <pattern>` that can match the ssh or
   shell command itself; target exact pids.
