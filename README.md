# OpenClaudeTag

> Vendor-neutral engineering assistant for team chat — pluggable **channels** and **runtimes**.

<!--
CI status badge: once the GitHub repository slug is known, replace the static
"CI" badge below with the live Actions badge:
[![CI](https://github.com/<owner>/<repo>/actions/workflows/ci.yml/badge.svg)](https://github.com/<owner>/<repo>/actions/workflows/ci.yml)
-->

[![CI](https://img.shields.io/badge/CI-GitHub%20Actions-2088FF?logo=githubactions&logoColor=white)](.github/workflows/ci.yml)
![Status](https://img.shields.io/badge/status-alpha-orange)
![Version](https://img.shields.io/badge/version-0.1.0-blue)
![Node](https://img.shields.io/badge/node-%E2%89%A520-339933?logo=node.js&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-green)

[简体中文 / Chinese](./README.zh-CN.md) · [AGENTS.md (contributor guide)](./AGENTS.md)

OpenClaudeTag is a vendor-neutral engineering assistant for team chat. The
orchestrator core speaks a neutral message contract, so two axes are pluggable:
the **channel** the chat lives in and the **runtime** that executes the task. It
receives a chat message, routes work through an async task pipeline, executes the
task through a runtime adapter (Claude Code or Codex), and reports progress back
to the chat. Lark/Feishu is the fully-featured channel today; Slack is a second,
working channel (inbound task dispatch + outbound send), with OAuth,
multi-workspace install, and Socket Mode still in progress.

> **Important:** both the API and the Worker must be running for end-to-end
> execution. Starting only the API will accept messages and show ACK cards, but
> tasks stay stuck at `Request received`.

## Features

| Feature | Summary |
| --- | --- |
| Multi-runtime | Claude Code and Codex are full runtimes. Pick per agent or per task. |
| Multi-channel | Lark/Feishu (full) and Slack (inbound dispatch + outbound send, experimental) behind one neutral `Channel` contract. |
| Zero-Docker personal launcher | `pnpm personal:up` boots an embedded PostgreSQL plus API + Worker + Console with no Docker (ADR-0009). |
| Onboarding wizard | A localhost setup wizard walks you through connecting Feishu, creating an agent, binding, and going live. |
| Worktree isolation | Each task runs in its own git worktree with independent context; stale worktrees are auto-cleaned. |
| Per-agent budget caps | Per-identity usage windows are tracked and enforced against declared caps (`@open-tag/registry`). |
| Access-bundle credential plugins | Named, versioned credential bundles inject runtime env-var **names** at execution time; values come from a secret provider, never stored. |
| Ambient proactive posting | A judge-gated gate can proactively post when the channel is talking about something relevant. Opt-in, default off (`OPEN_TAG_AMBIENT`). |
| Stale-thread nudges | A primary-API background scanner can nudge idle threads. Opt-in, default off (`OPEN_TAG_STALE_THREAD_SCANNER_ENABLED`, ADR-0007). |
| Cross-channel flag broker | An audited, `isPrivate`-safe broker for flagging across channels (ADR-0006). Experimental and scaffolded — gated off by default and not yet wired into the live event path. |
| Multi-agent discussion & delegation | Turn-based multi-agent debate plus directed agent-to-agent handoff (`@open-tag/orchestrator`). |
| Admin console | Local operator console for agents, Feishu bindings, chats, machines, and task boards. |
| Desktop app | A macOS Electron shell that wraps the admin console. |

## Architecture

### Pluggable architecture (two axes)

A channel adapter normalizes platform events into a neutral `InboundMessage` and
renders an `OutboundMessage` back out (`packages/channel-core` defines the
`Channel` contract); a runtime adapter executes a task behind a descriptor-driven
registry (`packages/runtime-adapters`). The orchestrator core names neither a
vendor nor a runtime (see [`doc/decisions/0004`](./doc/decisions/0004-inbound-message-pipeline-contract.md)).

| Axis | Option | Status |
| --- | --- | --- |
| Channel | Lark / Feishu | Full — events, interactive cards, threaded feedback, reactions, approvals, and Feishu Task tracking (`packages/feishu-adapter`, `LarkChannel`). |
| Channel | Slack | Inbound dispatch + outbound send (`packages/channel-slack`, `SlackChannel`). A signature-verified `POST /slack/events` route feeds channel-neutral observation memory and, when `SLACK_BOT_USER_ID` is set and the bot is @mentioned, dispatches a task through the neutral path (ADR-0005); when `SLACK_BOT_TOKEN` is also set, it ACKs through the Slack Web API. The worker also delivers the task's terminal completion as a neutral message (ADR-0008). OAuth / multi-workspace install, Socket Mode, richer running-card / Block Kit parity, and the Lark-only extras (slash-command tree, buffering, thread/reference enrichment, agent routing) are not built yet. |
| Runtime | Claude Code | Full — the default runtime. |
| Runtime | Codex | Full. |

The Slack path is covered by unit and Postgres-backed integration tests that drive
the real route end to end through the same vendor-clean core (with a stubbed Slack
sender); live end-to-end Slack with real workspace credentials has not been run
yet. See [`doc/decisions/0005`](./doc/decisions/0005-neutral-non-lark-task-dispatch.md)
for the deferred items.

### Execution flow

```mermaid
flowchart LR
  subgraph CH[Channel]
    L[Lark / Feishu<br/>WebSocket]
    S[Slack<br/>POST /slack/events]
  end

  subgraph API[apps/api]
    N[normalize → InboundMessage]
    D[dispatch / build context]
    E[enqueue]
  end

  Q[(pg-boss / PostgreSQL)]

  subgraph WK[apps/worker]
    R[runtime adapter execute<br/>Claude Code · Codex]
  end

  SND[ChannelSender<br/>ACK · running · done · failed]

  L --> N
  S --> N
  N --> D --> E --> Q
  Q --> R --> SND
  SND -->|interactive cards / messages| CH
```

1. A channel adapter delivers a message event to `apps/api` (Lark via WebSocket;
   Slack via `POST /slack/events`) and normalizes it into a neutral
   `InboundMessage`.
2. The API builds task context and enqueues work through `pg-boss` (PostgreSQL).
3. `apps/worker` dequeues the task and runs the selected runtime adapter.
4. OpenClaudeTag sends ACK, running, done, or failed updates back to the channel.
   Lark renders full interactive task cards; the Slack path sends the inbound ACK
   and the worker delivers the terminal completion as a neutral message
   (ADR-0008), with richer running-card parity still in progress.

### Repository layout

This is a pnpm-workspace monorepo: 5 apps and 19 packages.

**Apps**

| App | Responsibility |
| --- | --- |
| `apps/api` | Fastify HTTP server, Feishu WebSocket events, `POST /slack/events`, debug endpoints, task dispatch, and the primary-API background reconciler (worktree cleanup, ambient, stale-thread). |
| `apps/worker` | `pg-boss` worker process that dequeues and executes tasks via runtime adapters. |
| `apps/console` | React + Vite admin console for agents, Feishu bindings, chats, machines, task boards, and the onboarding wizard. |
| `apps/daemon` | Remote execution daemon that runs tasks on your machine via an outbound WebSocket to a central server (`@open-tag/daemon`). |
| `apps/desktop` | macOS Electron desktop shell wrapping the admin console. |

**Packages**

| Package | Responsibility |
| --- | --- |
| `packages/channel-core` | Vendor-neutral `Channel` contract: `InboundMessage` / `OutboundMessage` and the channel registry. |
| `packages/feishu-adapter` | Lark / Feishu `Channel`: REST client, event normalizer, interactive card builder. |
| `packages/channel-slack` | Slack `Channel`: signature verify, event normalize, send/update via the Slack Web API. |
| `packages/orchestrator` | Inbound dispatch, task state machine, agent delegation, and multi-agent discussion (channel- and runtime-agnostic). |
| `packages/runtime-adapters` | Descriptor-driven runtime registry and adapters: Claude Code and Codex. |
| `packages/storage` | Drizzle ORM schema, migrations, and PostgreSQL access. |
| `packages/session` | Session routing and lifecycle, context builder/strategy, worktree context, reply-language handling. |
| `packages/memory` | Observation / channel memory, sensitive-content filter, shared context, and workspace memory. |
| `packages/registry` | Agent identity, manifest/sync, per-identity budget tracking, and access-bundle credential injection. |
| `packages/ambient` | Judge-gated proactive-post gate and stale-thread evaluation. |
| `packages/cross-channel` | Audited, `isPrivate`-safe cross-channel flag broker and rendering (ADR-0006). |
| `packages/launcher` | Personal zero-Docker launcher CLI: embedded / docker / external DB providers, `up` / `down` / `status`. |
| `packages/queue` | `pg-boss` task-queue wrapper. |
| `packages/scheduler` | Admission scheduler (per-agent concurrency and start-rate admission). |
| `packages/approval` | RBAC and the approval audit service. |
| `packages/daemon-protocol` | Daemon WebSocket frame protocol: frames, replay buffer, sequence tracking, versioning. |
| `packages/core-types` | Shared types, enums, schemas, ids, and guards (agents, events, memory, slash commands). |
| `packages/observability` | Structured logging and fatal-error handlers. |
| `packages/llm-client` | OpenAI / Anthropic-compatible LLM client factory (workdir extraction, ambient judge, and other internal flows). |

## Prerequisites

| Requirement | Needed for | Notes |
| --- | --- | --- |
| Node.js `20+` | All source-based workflows | The repo currently uses `pnpm@9.15.4`. |
| `pnpm` | All source-based workflows | Enable with `corepack enable`. |
| Docker / Docker Compose | `OPEN_TAG_DB_MODE=docker` and Docker deployment | NOT required for the personal launcher, which provisions an embedded Postgres. |
| Feishu self-built app | Real Feishu message handling | Required for the API to connect to Feishu. |
| Runtime credentials | Real task execution | Claude Code uses `ANTHROPIC_*` / `~/.claude`; Codex reads `~/.codex/config.toml`. |
| PostgreSQL client tools (`psql`, `createdb`, `dropdb`) | Isolated worktree commands | Needed by `pnpm db:setup:isolated` and related isolated lifecycle commands. |
| `lark-cli` | Optional Feishu dev tooling | Useful for `pnpm lark:doctor`, test messages, and chat lookup. |

macOS or Linux is the easiest path for source development. On Windows, use WSL2
because several scripts assume a Unix-like shell environment.

## Personal Quick Start (zero-Docker)

Run the whole stack on your own machine with **no Docker**: an embedded
PostgreSQL is provisioned automatically, and a localhost setup wizard walks you
through connecting Feishu and creating your first agent. Only Node.js 20+ and
pnpm (`corepack enable`) are required; for real task execution, have Claude Code
(`~/.claude` / `ANTHROPIC_*`) or Codex (`~/.codex`) credentials on the host.

```bash
corepack enable
pnpm install        # the embedded Postgres binary is fetched from public npm
pnpm build          # builds all packages, including the launcher CLI
pnpm personal:up    # embedded Postgres -> migrate + seed -> start API + Worker + Console -> open the browser
```

`pnpm personal:up` boots an embedded PostgreSQL (default
`OPEN_TAG_DB_MODE=embedded`), runs migrations, starts the API + Worker + Console
on `127.0.0.1`, waits for `/health`, and opens the onboarding wizard. Then follow
the wizard: **connect Feishu → create an agent → bind → go live**.

| Command | Action |
| --- | --- |
| `pnpm personal:up` | Start the full stack (idempotent) |
| `pnpm personal:status` | Show DB / API / Worker / Console + `/health` |
| `pnpm personal:down` | Stop everything, including the embedded Postgres |

Pick the database backend with `OPEN_TAG_DB_MODE`: `embedded` (default, no
Docker), `docker` (use `infra/docker-compose.yaml`), or `external` (point
`DATABASE_URL` at your own Postgres). The embedded data directory is
`~/.open-claude-tag/pgdata`. The launcher CLI also exposes `open-claude-tag up`
(alias `oct up`); the package is private today (`v0.1.0`), so the
`npx open-claude-tag up` / `oct up` form only becomes available once it is
published to npm. Until then, use `pnpm personal:up`.

## Quick Start (Docker or your own Postgres)

```bash
# 1. Enable pnpm and install dependencies
corepack enable
pnpm install

# 2. Create your .env from the example and fill in required values
cp .env.example .env
# Edit .env — at minimum set FEISHU_APP_ID and FEISHU_APP_SECRET

# 3. Bootstrap Postgres, run migrations, seed data, and build
pnpm setup:local

# 4. Start API and Worker in separate terminals
pnpm dev:api
pnpm dev:worker
```

Basic verification:

```bash
pnpm doctor:local
curl http://localhost:3000/health
curl -X POST http://localhost:3000/debug/simulate \
  -H 'Content-Type: application/json' \
  -d '{"text":"hello"}'
```

Choose a path:

- Personal zero-Docker (`pnpm personal:up`): one command to run the full stack
  locally with the onboarding wizard.
- Local source install: best for contributors and debugging.
- Single-host Docker deployment: best for a quick self-hosted trial.
- Server-centralized (team mode): deploy once, let users pair their own machines.
- Isolated worktree mode: best when multiple branches or worktrees run in parallel.

### Single-Host Docker Deployment (Experimental)

This path is intended for quick trials and single-host self-hosting. It is still
experimental and is not hardened for HA, rolling upgrades, managed secrets, or
zero-downtime deploys.

In Docker mode, the images install `claude` and `codex`, and the `api` / `worker`
containers mount `${HOME}/.claude` and `${HOME}/.codex` into `/root/.claude` and
`/root/.codex` so the runtimes can reuse host-side auth, config, sessions, and
skills. The Compose file loads the repo `.env` into `api` and `worker`, then
overrides `DATABASE_URL` to point at the Compose `postgres` service.

```bash
cp .env.example .env

docker compose -f infra/docker-compose.yaml up --build -d postgres
docker compose -f infra/docker-compose.yaml run --rm api pnpm db:migrate
docker compose -f infra/docker-compose.yaml run --rm api pnpm db:seed
docker compose -f infra/docker-compose.yaml up --build -d api worker

curl http://localhost:3000/health
```

Notes:

- Migrations are not applied automatically during `docker compose up`; run them
  explicitly before starting `api` and `worker`.
- Docker mode can only modify files inside the container filesystem and explicitly
  mounted paths such as `${HOME}/.claude` and `${HOME}/.codex`. It cannot modify
  arbitrary host project directories unless you bind-mount them into the containers.
- If you only start `api`, requests will be accepted but queued tasks will not
  execute.

## Configuration Reference

Copy `.env.example` to `.env` and fill in the values you need. Every variable
documented here exists (commented or active) in `.env.example` unless explicitly
marked **code-only**. Variables are read from `process.env`.

### Database

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `DATABASE_URL` | Yes (docker / external / source) | `postgresql://open-claude-tag:open-claude-tag@localhost:5432/open-claude-tag` | PostgreSQL connection string. Use `127.0.0.1` rather than `localhost` on Node.js 17+. |
| `OPEN_TAG_DB_MODE` | No | `embedded` | Launcher database backend: `embedded`, `docker`, or `external`. |

### API / access

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `PORT` | No | `3000` | API HTTP port. |
| `HOST` | No | `0.0.0.0` | API bind host. |
| `LOG_LEVEL` | No | `info` | Log verbosity. |
| `OPEN_ACCESS` | No | `true` in `.env.example` (unset ⇒ `false`) | When `true`, all Feishu senders are treated as OWNER (no RBAC lookup) — good for a private single-team deployment. `.env.example` ships `true`; if the var is unset the code treats it as `false` (strict RBAC). Set `false` to enforce strict RBAC for multi-user or public-facing deployments. |

### Feishu

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `FEISHU_APP_ID` | Yes (real Feishu) | — | Self-built app ID from the Feishu Developer Console. |
| `FEISHU_APP_SECRET` | Yes (real Feishu) | — | Self-built app secret. |
| `FEISHU_EVENT_MODE` | No | `websocket` | Event transport; the long-connection WebSocket mode needs no public webhook. |
| `FEISHU_WEBHOOK_PATH` | No | `/webhooks/feishu` | Inbound path when running in webhook mode. |
| `FEISHU_ENCRYPT_KEY` / `FEISHU_VERIFICATION_TOKEN` | No | — | Webhook-mode encryption and verification (not needed for WebSocket mode). |

### Runtime — Claude Code / Codex

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `ANTHROPIC_BASE_URL` | No | `https://api.anthropic.com` | Claude Code endpoint. |
| `ANTHROPIC_API_KEY` | No | — | Claude Code key. Takes precedence over `ANTHROPIC_AUTH_TOKEN` if both are set. |
| `ANTHROPIC_AUTH_TOKEN` | No | — | Claude Code OAuth/auth token. |
| `OPEN_TAG_DEFAULT_RUNTIME` | No | `claude_code` | Default runtime for general tasks (`claude_code` or `codex`). |
| `OPEN_TAG_DEFAULT_MODEL` | No | — | Optional default model override. |
| Codex | — | — | Codex auth and model are read from `~/.codex/config.toml`. |
| `CODEX_STARTUP_TIMEOUT_MS` | No | `120000` | Max ms to wait for Codex to establish its API connection (`0` disables). |

### Agent-level LLM client (workdir extraction, ambient judge, etc.)

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `OPEN_TAG_LLM_PROVIDER` | No | — | `openai` or `anthropic`-compatible provider. |
| `OPEN_TAG_LLM_BASE_URL` | No | — | OpenAI-compatible endpoint. |
| `OPEN_TAG_LLM_API_KEY` | No | — | LLM client API key. |
| `OPEN_TAG_LLM_MODEL` | No | — | LLM client model. |

### Worker

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `WORKER_CONCURRENCY` | No | `5` | Concurrent tasks per worker. |
| `OPEN_TAG_REPO_ROOT` | No | `process.cwd()` | Override the repo root when running from another directory (e.g. in Docker). |
| `OPEN_TAG_DEFAULT_WORKDIR` | No | — | Absolute path used to seed `adhocWorkDir` for new sessions. |
| `WORKER_AUTO_RESTART` / `WORKER_RESTART_COOLDOWN_MS` | No | `false` / `30000` | Auto-restart the worker when detected down (primary role only). |
| `WORKER_EXECUTOR` / `WORKER_EXECUTOR_SESSION` | No | — | Set to `tmux` to run the worker in a named tmux session. |

### Worktree cleanup

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `WORKTREE_RETENTION_MS` | No | `604800000` (7 days) | Retention before a managed session worktree is eligible for cleanup. |
| `WORKTREE_CLEANUP_INTERVAL_MS` | No | `300000` (5 min) | Background scan interval for stale-worktree cleanup. |

### Server / daemon (team mode)

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `SERVER_PUBLIC_URL` | When daemons are used | — | Public base URL daemons dial; rendered into pairing cards. |
| `DAEMON_GATEWAY_PORT` | No | `3001` | Worker-hosted daemon gateway port (pairing REST + daemon WebSocket). |
| `DAEMON_GATEWAY_PUBLIC` | No | `false` | Bind the gateway publicly (only behind a TLS reverse proxy). |
| `OPEN_TAG_DAEMON_MAX_CONCURRENT_DISPATCHES` | No | — | Per-daemon dispatch cap; the daemon rejects with `busy` when full. |

### Slack (experimental)

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `SLACK_SIGNING_SECRET` | To enable Slack | — | Enables and signature-verifies the `POST /slack/events` route. |
| `SLACK_BOT_USER_ID` | To dispatch tasks | — | When set, an @mention of this bot dispatches a task through the neutral path. |
| `SLACK_BOT_TOKEN` | For outbound delivery | — | Slack Web API token for the inbound ACK; the worker also reads it to deliver the task's terminal completion (ADR-0008). |

### Feature flags

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `OPEN_TAG_CHANNEL_MEMORY` | No | on | Channel observation memory ("following the channel"). Only the literal value `disabled` turns it off. |
| `OPEN_TAG_AMBIENT` / `OPEN_TAG_AMBIENT_CHANNELS` | No | off | Judge-gated proactive posting (opt-in) and its channel allowlist. |
| `OPEN_TAG_STALE_THREAD_SCANNER_ENABLED` / `OPEN_TAG_STALE_THREAD_CHANNELS` | No | off | Stale-thread nudge scanner (opt-in, ADR-0007) and its channel allowlist. |
| `OPEN_TAG_CROSS_CHANNEL_ENABLED` | No | off | Cross-channel flag broker master switch (ADR-0006). Experimental: the broker is implemented but not yet wired into the live event path. |
| `OPEN_TAG_CHANNEL_MEMORY_MAX_PER_SCOPE` / `OPEN_TAG_CHANNEL_MEMORY_TTL_MS` | No | — | Channel-memory pruning caps (**code-only** tuning knobs; not in `.env.example`). |
| `BUFFER_UNTIL_AT` | No | `false` | When `true`, only @mentions create tasks; intervening messages are buffered. |

## Feishu App Setup

OpenClaudeTag connects to Feishu through a self-built enterprise app. Configure
the app in the [Feishu Developer Console](https://open.feishu.cn/app) with this
checklist:

### 1. Create App & Obtain Credentials

1. Create an **Enterprise Self-Built App**.
2. Copy `App ID` and `App Secret` from **Credentials & Basic Info** into `.env`.

### 2. Add Bot Capability

1. In the left sidebar, click **Add App Capability**.
2. Select the **Bot** card and click **Configure**.

### 3. Configure Event Subscription (Long Connection)

1. Navigate to **Events & Callbacks**.
2. Under **Event Configuration**, select **Long Connection**.
3. Click **Add Event** and subscribe to `im.message.receive_v1`.

### 4. Configure Card Action Callback (Long Connection)

Card callbacks allow the app to respond to interactive buttons such as confirm,
cancel, retry, and approval actions. Without this callback, card buttons return
error code `200340`.

1. In the same **Events & Callbacks** page, find the **Callback Configuration**
   section, which is separate from Event Configuration.
2. Select **Long Connection**.
3. Click **Add Callback** and subscribe to `card.action.trigger`.

### 5. Configure Permissions

In **Permissions & Scopes**, add:

| Scope | Description |
| --- | --- |
| `im:message.p2p_msg:readonly` | Receive direct messages |
| `im:message.group_at_msg:readonly` | Receive group messages that @mention the bot |
| `im:message:send_as_bot` | Send messages as bot |
| `im:message:update` | Update task status cards |
| `im:message.reactions:write_only` | Add and remove processing reactions |
| `im:message:readonly` | Read referenced message content |
| `im:resource` | Access message resources such as images and files |
| `im:chat:read` | Access chat information |
| `im:chat.members:read` | Access chat members |
| `task:tasklist:read` | Read task board task lists |
| `task:tasklist:writeonly` | Create and update task board lists and members |
| `task:custom_field:read` | Read task board custom fields |
| `task:custom_field:writeonly` | Create task board custom fields and options |
| `task:section:read` | Read task board sections |
| `task:section:writeonly` | Create task board sections |
| `task:task:write` | Create, update, and move task board tasks |

### 6. Publish the App

1. In **Version Management & Release**, create a new version.
2. Fill in the version number and release notes.
3. Submit for review and publish.

> **Important:** after any configuration change, including permissions, events,
> or callbacks, publish a new app version or the changes will not take effect.

### Card JSON Compatibility Notes

Feishu interactive cards have two common JSON structures:

- **JSON 1.0** uses a top-level `elements` array and is broadly compatible.
- **JSON 2.0** uses `schema: "2.0"` with `body.elements` and requires newer
  Feishu versions.

For form-based cards:

- Use `"tag": "form"` instead of `"form_container"`.
- Form containers require **Feishu V6.6+** support.
- A submit button inside the form must use `"action_type": "form_submit"` so
  callbacks include `form_value`.
- Buttons outside the form should be wrapped in `"tag": "action"` and use
  `action.value`.

Example form card structure:

```json
{
  "config": { "wide_screen_mode": true },
  "header": { "title": { "tag": "plain_text", "content": "Title" }, "template": "blue" },
  "elements": [
    {
      "tag": "form",
      "name": "my_form",
      "elements": [
        { "tag": "input", "name": "field1", "label": { "tag": "plain_text", "content": "Label" }, "default_value": "value" },
        { "tag": "select_static", "name": "field2", "initial_option": "opt1", "options": [] },
        { "tag": "button", "name": "submit", "text": { "tag": "lark_md", "content": "Submit" }, "type": "primary", "action_type": "form_submit", "value": { "action": "submit" } }
      ]
    },
    {
      "tag": "action",
      "actions": [
        { "tag": "button", "text": { "tag": "plain_text", "content": "Cancel" }, "value": { "action": "cancel" } }
      ]
    }
  ]
}
```

## Slack Setup (Experimental)

Slack is a working second channel for inbound task dispatch and outbound ACK, but
it is **partial / experimental**: OAuth, multi-workspace install, Socket Mode, and
richer running-card / Block Kit parity are not built yet, and a live end-to-end run
with real workspace credentials has not been performed. (Worker-side terminal
completion delivery does exist — see ADR-0008.)

1. Set `SLACK_SIGNING_SECRET`. This registers and signature-verifies the
   `POST /slack/events` route; without it the route is not mounted.
2. Set `SLACK_BOT_USER_ID`. An @mention of this bot user then dispatches a task
   through the same vendor-neutral path as Lark (ADR-0005).
3. Set `SLACK_BOT_TOKEN` for outbound delivery — the Slack Web API token for the
   inbound ACK; the worker also reads it to deliver the task's terminal completion
   (ADR-0008).

Point your Slack app's Events API request URL at `https://<your-host>/slack/events`.
See [`doc/decisions/0005`](./doc/decisions/0005-neutral-non-lark-task-dispatch.md)
for the deferred items.

## Usage

Once the bot is running, @mention it in a group chat or send a direct message.

Task feedback is threaded by default. The first bot reply anchors to the user's
message, so ACK, running updates, overflow cards, text fallbacks, and final
completion notifications stay in the same Feishu topic instead of spreading across
the main chat. Follow-up messages in that topic reuse the same session and, when
Feishu Task tracking is enabled, the same linked Feishu task item. Final runtime
replies only render `{{mention:open_id:name}}` placeholders for human users that
were mentioned in the original request; bot mentions, invented open IDs, and
unsafe placeholders are stripped.

**Natural language** — describe a task or ask a question:

```
@Bot explain what this repo does
@Bot update the README for ~/github/stock-agent
@Bot compare NVIDIA H20 vs L20
```

<img src="doc/images/usage-natural-language.png" width="600" />
<img src="doc/images/usage-external-project.png" width="600" />

**Self-dev** — ask the bot to improve its own repository (owner-only `/dev`
tasks run server-local against the bot's own monorepo):

<img src="doc/images/usage-self-dev.png" width="600" />

**Slash commands** — structured actions:

| Command | Description |
| --- | --- |
| `/project add <name> <path>` | Register an external project |
| `/project use <name>` | Bind the current session to a project |
| `/session list` | List all sessions |
| `/status` | Show current session info |
| `/help` | Show all available commands |

Owner-only commands: `/schedule`, `/project`, `/chat`, `/merge-pr`, plus the
`/session worktrees` / `/session clean` worktree subcommands. All commands support
`--help`.

**Key capabilities:**

- **External projects** — register any local repo with `/project add`, then work
  on it via natural language.
- **Multi-runtime** — each agent has a default runtime; pick one per task in the
  workdir confirmation card or retry with Codex from the task card.
- **Session isolation** — each task runs in its own git worktree with independent
  context.
- **Threaded feedback** — Feishu task cards, fallbacks, and completion
  notifications stay in the source topic.
- **Task tracking reuse** — follow-ups in one Feishu topic share the same Feishu
  Task tracking item when tracking is enabled.

## Development Workflow

Common commands:

| Task | Command |
| --- | --- |
| Install deps | `pnpm install` |
| Local bootstrap | `pnpm setup:local` |
| Local doctor | `pnpm doctor:local` |
| Build all packages | `pnpm build` |
| Lint | `pnpm lint` |
| Type check | `pnpm typecheck` |
| Run all tests | `pnpm test` |
| Run API E2E | `pnpm --filter @open-tag/api test:e2e` |
| Start API | `pnpm dev:api` |
| Start Worker | `pnpm dev:worker` |
| Start isolated API | `pnpm dev:api:isolated` |
| Start isolated Worker | `pnpm dev:worker:isolated` |
| Run isolated E2E | `pnpm test:e2e:isolated` |
| Setup isolated DB | `pnpm db:setup:isolated` |

When multiple worktrees or branches are active at the same time, prefer the
built-in isolated commands instead of manually reusing the default port or
database:

```bash
pnpm db:setup:isolated
pnpm dev:api:isolated
pnpm dev:worker:isolated
pnpm test:e2e:isolated
```

Useful cleanup commands:

```bash
pnpm isolated:ps
pnpm isolated:stop
pnpm isolated:reap
pnpm isolated:purge
```

Automatic stale-worktree cleanup:

- The primary API process runs a background cleanup loop for managed session
  worktrees.
- Configure retention with `WORKTREE_RETENTION_MS` and the scan interval with
  `WORKTREE_CLEANUP_INTERVAL_MS`.
- The default retention is 7 days and the default scan interval is 5 minutes.
- External-project cleanup only targets managed git worktrees under
  `<projectPath>/.worktrees/dev-*`.
- External-project direct-path fallback sessions are never auto-deleted.
- External-project cleanup uses `git worktree remove`; it does not delete the
  underlying git branch.

The detailed worktree-safe verification order is documented in
[doc/testing/self-dev-checklist.md](./doc/testing/self-dev-checklist.md).

## Worktree Hooks

Sessions that create a git worktree (self-dev and external-project sessions) can
run optional shell hooks at fixed paths. Use them to copy credentials into the
worktree, warm caches, or snapshot logs before cleanup — without modifying
runtime-adapter code.

**Configuration.** Drop scripts at the source repo (the repo whose
`git worktree add` produced the worktree):

```
<sourceRoot>/.open-claude-tag/worktree-hooks/pre.sh   # runs after worktree creation
<sourceRoot>/.open-claude-tag/worktree-hooks/post.sh  # runs before worktree removal
```

`sourceRoot` is the OpenClaudeTag repo for self-dev sessions and the external
project root for external sessions. Missing scripts are a silent no-op; the
executable bit is not required (invoked via `bash`).

**Environment passed to each script** (cwd is the worktree directory; 60 s timeout):

| Variable | Value |
| --- | --- |
| `WORKTREE_PATH` | Absolute path of the worktree |
| `REPO_ROOT` | Same as `sourceRoot` above (varies by session type) |
| `SESSION_ID` | Full session id (or `dev-<shortId>` suffix during path-based cleanup) |
| `BRANCH_NAME` | Worktree branch, empty string when null |
| `WORKTREE_HOOK_PHASE` | `"pre"` or `"post"` |

**Failure semantics.**

- `pre` non-zero exit — the partial worktree is rolled back
  (`git worktree remove --force` + `git branch -D`) and the session aborts with
  the original error attached as `cause`. Use this to guarantee a missing
  dependency never lets a session enter a ready state.
- `post` non-zero exit — logged at `warn` and swallowed. Worktree removal must
  always finish, so a broken `post.sh` cannot block cleanup.

**Example — copy AK credentials before each run** (`<OpenClaudeTag>/.open-claude-tag/worktree-hooks/pre.sh`):

```bash
#!/usr/bin/env bash
set -euo pipefail

# In external-project sessions $REPO_ROOT points at the user's project, not
# OpenClaudeTag — resolve the OpenClaudeTag home explicitly so the same hook works
# in both flows.
OPEN_TAG_HOME="${OPEN_TAG_HOME:-$HOME/open-claude-tag}"

for src in "$OPEN_TAG_HOME/.anthropic" "$OPEN_TAG_HOME/.codex"; do
  [ -d "$src" ] && cp -r "$src" "$WORKTREE_PATH/"
done
```

Full reference (lifecycle table, `REPO_ROOT` vs `OPEN_TAG_DEFAULT_WORKDIR`,
integration points): [doc/architecture/worktree-hooks.md](./doc/architecture/worktree-hooks.md).

## Testing

Recommended verification flow for code changes:

```bash
pnpm build
pnpm test
pnpm --filter @open-tag/api test:e2e
```

In worktrees, prefer the isolated gates:

```bash
docker compose -f infra/docker-compose.yaml up postgres -d
pnpm db:setup:isolated
pnpm test:integration:isolated
pnpm test:e2e:isolated     # expects an isolated API to be running
```

`POST /debug/simulate` exercises the full event pipeline without Feishu:

```bash
curl -X POST http://localhost:3000/debug/simulate \
  -H 'Content-Type: application/json' \
  -d '{"text":"hello"}'
```

**Live runtime E2E (opt-in).** `pnpm test:runtime:e2e` runs one trivial
`chat_reply` task through the REAL Codex and Claude Code runtime adapters (via the
real `@openai/codex-sdk` and `@anthropic-ai/claude-agent-sdk`). It is **not** part
of the default suite, needs real `~/.codex` / `~/.claude` credentials, and makes
real, billable model calls. A runtime with no credentials is reported as skipped,
not failed. See the "Live Runtime E2E" section of [AGENTS.md](./AGENTS.md) for
per-runtime prerequisites (Codex with proxy unset; Claude Code with an HTTPS proxy
reachable to `api.anthropic.com`).

For Docker mode, verify both startup and execution. A complete single-host check is:

1. Start `postgres`, `api`, and `worker` with Compose.
2. Call `/health`.
3. Send a debug task through `/debug/simulate`.
4. Confirm task completion in `tasks`, `task_runs`, and `messages`.

## Deploying with Claude Code

You can use the built-in `/deploy-local` skill to walk through the full local
deployment interactively. Start a Claude Code session in the repo root and run:

```
/deploy-local
```

Claude Code will run `pnpm doctor:local`, guide you through `.env` setup, start
Postgres, run migrations, launch the services, and step you through Feishu
Developer Console configuration. Common issues it handles automatically:

- Port 5432 occupied by another Docker container — stops the conflicting container
  before starting the Compose Postgres service.
- Stale `pgdata` volume from a different project — runs `docker compose down -v`
  to reinitialize the volume so the `open-claude-tag` user is created correctly.
- `DATABASE_URL` using `localhost` instead of `127.0.0.1` — Node.js 17+ resolves
  `localhost` to `::1` (IPv6) by default; the fix is to use `127.0.0.1` in
  `DATABASE_URL`.
- Multiple stale worker processes accumulating across restarts — kills all
  matching processes by name before starting a fresh worker.
- Choosing a runtime — if your Anthropic API balance is insufficient for
  `claude_code`, set `OPEN_TAG_DEFAULT_RUNTIME=codex` in `.env` and restart the
  worker. You can also pick a runtime per task in the workdir confirmation card.

No public URL or tunnel is required for local development. OpenClaudeTag uses
Feishu WebSocket long connection, so the service connects outbound to Feishu and
no inbound webhook is needed.

## Server-Centralized Deployment (Team Mode)

Instead of every user running the full stack locally, deploy OpenClaudeTag once as
a central server (Docker Compose: Postgres + API + Worker) and let users pair their
own machines as optional execution targets:

1. Deploy the server: see [`doc/deployment/server-mode.md`](./doc/deployment/server-mode.md).
2. Open the admin console's Machines page and generate a one-time pairing token.
3. On your machine: `npx @open-tag/daemon@latest --server-url <url> --token <token> --background`.
4. Bind agents or chats to your machine in the console.

The daemon holds no Feishu or database credentials, connects outbound only (works
behind NAT/corporate proxies via `HTTPS_PROXY`), and executes tasks with your local
Claude Code / Codex setup. The central API owns the only Feishu WSClient; a
machine-bound task never silently falls back to server-local, and `/dev` self-dev
tasks always run server-local. Design and decision log:
[`doc/deployment/server-mode.md`](./doc/deployment/server-mode.md).

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Card buttons return `200340` | Card callback not configured for long connection | Add `card.action.trigger` in **Callback Configuration** with **Long Connection** mode |
| Card creation returns `200621` with `not support tag: form_container` | Wrong form tag name | Use `"tag": "form"` instead of `"form_container"` |
| Bot receives no messages | Event subscription not configured | Add `im.message.receive_v1` in **Event Configuration** with **Long Connection** mode |
| Changes do not take effect | Feishu app version not republished | Create and publish a new version in **Version Management & Release** |
| Tasks stay at `Request received` | Worker is not running | Start `pnpm dev:worker` in a second terminal or start the `worker` container |
| E2E conflicts with another local instance | Shared port or DB collision | Use `pnpm dev:api:isolated`, `pnpm dev:worker:isolated`, and `pnpm test:e2e:isolated` |
| Local bootstrap fails with Postgres auth errors after upgrading from an older local Postgres setup | Existing Docker volume still contains old database or user initialization | Run `docker compose -f infra/docker-compose.yaml down -v` once, then rerun `pnpm setup:local` or the Compose migration steps |
| `db:migrate` fails with `ECONNREFUSED` even though Postgres container is running | Container started but `pg_isready` not yet passing | Wait for `pg_isready` before running migrations: `until docker exec infra-postgres-1 pg_isready -U open-claude-tag; do sleep 1; done` |
| `db:migrate` fails with `role "open-claude-tag" does not exist` | Postgres started with a stale volume from a different project | Run `docker compose -f infra/docker-compose.yaml down -v` to wipe the volume, then restart |
| `DATABASE_URL` with `localhost` fails on Node.js 17+ | Node resolves `localhost` to `::1` (IPv6) but Docker only binds `127.0.0.1` | Change `localhost` to `127.0.0.1` in `DATABASE_URL` |
| Worker keeps using `claude_code` after setting `OPEN_TAG_DEFAULT_RUNTIME=codex` | Old worker process still running from a previous start | Kill all worker processes (`pkill -9 -f "apps/worker"`) before restarting |
| `Claude Code returned an error result: Credit balance is too low` | Anthropic API account has insufficient credits | Add `OPEN_TAG_DEFAULT_RUNTIME=codex` to `.env` and restart the worker, or top up your Anthropic account |

## Design & Decisions

A comprehensive design write-up lives at
[`doc/architecture/technical-design.md`](./doc/architecture/technical-design.md).

Architecture deep-dives:

- [`doc/architecture/admin-console.md`](./doc/architecture/admin-console.md) — admin console architecture
- [`doc/architecture/event-pipeline.md`](./doc/architecture/event-pipeline.md) — Feishu / event pipeline
- [`doc/architecture/task-cards.md`](./doc/architecture/task-cards.md) — task card lifecycle
- [`doc/architecture/discussion-orchestration.md`](./doc/architecture/discussion-orchestration.md) — multi-agent discussion & delegation
- [`doc/architecture/admission-scheduler.md`](./doc/architecture/admission-scheduler.md) — admission scheduler
- [`doc/architecture/agent-bot-setup.md`](./doc/architecture/agent-bot-setup.md) — agent / bot setup
- [`doc/architecture/pr-polling.md`](./doc/architecture/pr-polling.md) — PR polling
- [`doc/architecture/worktree-hooks.md`](./doc/architecture/worktree-hooks.md) — worktree hooks
- [`doc/deployment/server-mode.md`](./doc/deployment/server-mode.md) — server + daemon team mode

Architecture Decision Records ([`doc/decisions/`](./doc/decisions/README.md)):

- [ADR-0001](./doc/decisions/0001-lighten-self-dev-flow.md) — Lighten the self-dev flow (tiers + design-on-demand + ADRs)
- [ADR-0002](./doc/decisions/0002-document-comment-session-resume.md) — Document comment session resume
- [ADR-0003](./doc/decisions/0003-chat-memory-index-detail-store.md) — Chat memory index and detail store
- [ADR-0004](./doc/decisions/0004-inbound-message-pipeline-contract.md) — `InboundMessage` as the inbound pipeline contract
- [ADR-0005](./doc/decisions/0005-neutral-non-lark-task-dispatch.md) — A minimal separate neutral dispatch path for non-lark inbound
- [ADR-0006](./doc/decisions/0006-cross-channel-flag-broker.md) — Brokered, audited, `isPrivate`-safe cross-channel flagging
- [ADR-0007](./doc/decisions/0007-stale-thread-nudge-scanner.md) — Stale-thread nudge scanner: audit-log idempotency + same-channel private nudge
- [ADR-0008](./doc/decisions/0008-neutral-ack-in-place-terminal-update.md) — Thread the neutral ACK handle so the worker updates it in place
- [ADR-0009](./doc/decisions/0009-embedded-postgres-db-provider.md) — DB-provider abstraction with an embedded-Postgres (zero-Docker) provider

## Contributing

- [`doc/contributing/pr-guidelines.md`](./doc/contributing/pr-guidelines.md) — PR / MR content guidelines
- [`AGENTS.md`](./AGENTS.md) — contributor and agent guide (change workflow, verification rules, coding pitfalls)
- [`.github/pull_request_template.md`](./.github/pull_request_template.md) — PR template

Non-doc-only changes must pass lint, build, unit tests, Postgres integration, and
API E2E before commit or PR. Always use English for code, comments, docs, and
PR/MR text. Never commit credentials.

## License

Released under the [MIT License](./LICENSE).
