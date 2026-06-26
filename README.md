# OpenClaudeTag

OpenClaudeTag is a Feishu-native engineering assistant for group chat. It receives Feishu messages, routes work through an async task pipeline, executes tasks through Claude Code or Codex, and reports progress back to the chat.

- [English](#english)
- [中文](#中文)
- [AGENTS.md](./AGENTS.md)
- [简体中文补充文档](./README.zh-CN.md)

## English

### Overview

OpenClaudeTag is a modular monorepo for running an engineering agent inside Feishu group chat. `apps/api` receives Feishu events and enqueues tasks, `apps/worker` dequeues and executes them, and PostgreSQL stores task, runtime, and session state.

Important: both API and Worker must be running for end-to-end execution. Starting only the API will accept messages and show ACK cards, but tasks will remain stuck at `Request received`.

### Architecture

Repository layout:

| Area | Responsibility |
| --- | --- |
| `apps/api` | Fastify HTTP server, Feishu WebSocket events, debug endpoints, task dispatch |
| `apps/worker` | `pg-boss` worker process that executes queued tasks via runtime adapters |
| `packages/feishu-adapter` | Feishu REST client, event normalization, card builder |
| `packages/orchestrator` | Intent classification and task state machine |
| `packages/runtime-adapters` | Claude Code and Codex runtime integration |
| `packages/storage` | Drizzle schema, migrations, PostgreSQL access |
| `packages/session` / `packages/memory` / `packages/approval` | Session routing, memory handling, approval flow |
| `packages/queue` / `packages/observability` / `packages/registry` | Queue wrapper, logging and metrics, service registration |

Execution flow:

1. Feishu delivers a message event to `apps/api`.
2. The API normalizes the event, builds task context, and enqueues work through `pg-boss`.
3. `apps/worker` dequeues the task and runs the selected runtime adapter.
4. OpenClaudeTag sends ACK, running, done, or failed updates back to Feishu.

### Prerequisites

| Requirement | Needed for | Notes |
| --- | --- | --- |
| Node.js `20+` | All source-based workflows | The repo currently uses `pnpm@9.15.4`. |
| `pnpm` | All source-based workflows | Enable with `corepack enable`. |
| Docker / Docker Compose | Local PostgreSQL and Docker deployment | Required unless you bring your own Postgres. |
| Feishu self-built app | Real Feishu message handling | Required for API to connect to Feishu. |
| Runtime credentials | Real task execution | Claude Code uses `ANTHROPIC_*`; Codex reads `~/.codex/config.toml`. |
| PostgreSQL client tools (`psql`, `createdb`, `dropdb`) | Isolated worktree commands | Needed by `pnpm db:setup:isolated` and related isolated lifecycle commands. |
| `lark-cli` | Optional Feishu dev tooling | Useful for `pnpm lark:doctor`, test messages, and chat lookup. |

macOS or Linux is the easiest path for source development. On Windows, use WSL2 because several scripts assume a Unix-like shell environment.

### Quick Start

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

Minimum variables for the API to boot (already present in `.env.example`, just fill in the values):

```bash
DATABASE_URL=postgresql://open-claude-tag:open-claude-tag@localhost:5432/open-claude-tag
FEISHU_APP_ID=cli_xxxxx
FEISHU_APP_SECRET=xxxxx
```

Common runtime variables:

```bash
# Claude Code runtime
ANTHROPIC_BASE_URL=https://api.anthropic.com
ANTHROPIC_AUTH_TOKEN=your-token

# Agent-level LLM client used by some internal flows
OPEN_TAG_LLM_PROVIDER=openai
OPEN_TAG_LLM_BASE_URL=https://your-openai-compatible-endpoint
OPEN_TAG_LLM_API_KEY=your-api-key
OPEN_TAG_LLM_MODEL=your-model
```

Codex runtime configuration is read from `~/.codex/config.toml`.

Optional variables:

```bash
# Override the repo root when running from a different directory (defaults to process.cwd())
OPEN_TAG_REPO_ROOT=/path/to/OpenClaudeTag
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

- Local source install: best for contributors and debugging.
- Single-host Docker deployment: best for a quick self-hosted trial.
- Isolated worktree mode: best when multiple branches or worktrees run in parallel.

Single-host Docker deployment is available through `infra/docker-compose.yaml`.

#### Single-Host Docker Deployment (Experimental)

This path is intended for quick trials and single-host self-hosting. It is still experimental and is not hardened for HA, rolling upgrades, managed secrets, or zero-downtime deploys.

In Docker mode, the images install `claude` and `codex`, and the `api` / `worker` containers mount `${HOME}/.claude` and `${HOME}/.codex` into `/root/.claude` and `/root/.codex` so the runtimes can reuse host-side auth, config, sessions, and skills. The Compose file loads the repo `.env` into `api` and `worker`, then overrides `DATABASE_URL` to point at the Compose `postgres` service.

```bash
cp .env.example .env

docker compose -f infra/docker-compose.yaml up --build -d postgres
docker compose -f infra/docker-compose.yaml run --rm api pnpm db:migrate
docker compose -f infra/docker-compose.yaml run --rm api pnpm db:seed
docker compose -f infra/docker-compose.yaml up --build -d api worker

curl http://localhost:3000/health
```

Notes:

- Migrations are not applied automatically during `docker compose up`; run them explicitly before starting `api` and `worker`.
- Docker mode can only modify files inside the container filesystem and explicitly mounted paths such as `${HOME}/.claude` and `${HOME}/.codex`. It cannot modify arbitrary host project directories unless you bind-mount them into the containers.
- If you only start `api`, requests will be accepted but queued tasks will not execute.

### Feishu App Setup

OpenClaudeTag connects to Feishu through a self-built enterprise app. Configure the app in the [Feishu Developer Console](https://open.feishu.cn/app) with this checklist:

#### 1. Create App & Obtain Credentials

1. Create an **Enterprise Self-Built App**.
2. Copy `App ID` and `App Secret` from **Credentials & Basic Info** into `.env`.

#### 2. Add Bot Capability

1. In the left sidebar, click **Add App Capability**.
2. Select the **Bot** card and click **Configure**.

#### 3. Configure Event Subscription (Long Connection)

1. Navigate to **Events & Callbacks**.
2. Under **Event Configuration**, select **Long Connection**.
3. Click **Add Event** and subscribe to `im.message.receive_v1`.

#### 4. Configure Card Action Callback (Long Connection)

Card callbacks allow the app to respond to interactive buttons such as confirm, cancel, retry, and approval actions. Without this callback, card buttons return error code `200340`.

1. In the same **Events & Callbacks** page, find the **Callback Configuration** section, which is separate from Event Configuration.
2. Select **Long Connection**.
3. Click **Add Callback** and subscribe to `card.action.trigger`.

#### 5. Configure Permissions

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

#### 6. Publish the App

1. In **Version Management & Release**, create a new version.
2. Fill in the version number and release notes.
3. Submit for review and publish.

Important: after any configuration change, including permissions, events, or callbacks, publish a new app version or the changes will not take effect.

#### Card JSON Compatibility Notes

Feishu interactive cards have two common JSON structures:

- **JSON 1.0** uses a top-level `elements` array and is broadly compatible.
- **JSON 2.0** uses `schema: "2.0"` with `body.elements` and requires newer Feishu versions.

For form-based cards:

- Use `"tag": "form"` instead of `"form_container"`.
- Form containers require **Feishu V6.6+** support.
- A submit button inside the form must use `"action_type": "form_submit"` so callbacks include `form_value`.
- Buttons outside the form should be wrapped in `"tag": "action"` and use `action.value`.

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

### Usage

Once the bot is running, @mention it in a group chat or send a direct message.

Task feedback is threaded by default. The first bot reply anchors to the user's
message, so ACK, running updates, overflow cards, text fallbacks, and final
completion notifications stay in the same Feishu topic instead of spreading
across the main chat. Follow-up messages in that topic reuse the same session
and, when Feishu Task tracking is enabled, the same linked Feishu task item.
Final runtime replies only render `{{mention:open_id:name}}` placeholders for
human users that were mentioned in the original request; bot mentions,
invented open IDs, and unsafe placeholders are stripped.

**Natural language** — describe a task or ask a question:

```
@Bot explain what this repo does
@Bot update the README for ~/github/stock-agent
@Bot compare NVIDIA H20 vs L20
```

<img src="doc/images/usage-natural-language.png" width="600" />
<img src="doc/images/usage-external-project.png" width="600" />

**Slash commands** — structured actions:

| Command | Description |
| --- | --- |
| `/project add <name> <path>` | Register an external project |
| `/project use <name>` | Bind the current session to a project |
| `/session list` | List all sessions |
| `/status` | Show current session info |
| `/help` | Show all available commands |

Owner-only commands: `/schedule`, `/project`, `/chat`, `/merge-pr`, plus the `/session worktrees` / `/session clean` worktree subcommands. All commands support `--help`.

**Key capabilities:**

- **External projects** — register any local repo with `/project add`, then work on it via natural language
- **Multi-runtime** — each agent has a default runtime; pick one per task in the workdir confirmation card or retry with Codex from the task card
- **Session isolation** — each task runs in its own git worktree with independent context
- **Threaded feedback** — Feishu task cards, fallbacks, and completion notifications stay in the source topic
- **Task tracking reuse** — follow-ups in one Feishu topic share the same Feishu Task tracking item when tracking is enabled

### Development Workflow

Common commands:

| Task | Command |
| --- | --- |
| Install deps | `pnpm install` |
| Local bootstrap | `pnpm setup:local` |
| Local doctor | `pnpm doctor:local` |
| Build all packages | `pnpm build` |
| Run all tests | `pnpm test` |
| Run API E2E | `pnpm --filter @open-tag/api test:e2e` |
| Start API | `pnpm dev:api` |
| Start Worker | `pnpm dev:worker` |
| Start isolated API | `pnpm dev:api:isolated` |
| Start isolated Worker | `pnpm dev:worker:isolated` |
| Run isolated E2E | `pnpm test:e2e:isolated` |
| Setup isolated DB | `pnpm db:setup:isolated` |

When multiple worktrees or branches are active at the same time, prefer the built-in isolated commands instead of manually reusing the default port or database:

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

- The primary API process runs a background cleanup loop for managed session worktrees.
- Configure retention with `WORKTREE_RETENTION_MS` and the scan interval with `WORKTREE_CLEANUP_INTERVAL_MS`.
- The default retention is 7 days and the default scan interval is 5 minutes.
- External-project cleanup only targets managed git worktrees under `<projectPath>/.worktrees/dev-*`.
- External-project direct-path fallback sessions are never auto-deleted.
- External-project cleanup uses `git worktree remove`; it does not delete the underlying git branch.

The detailed worktree-safe verification order is documented in [doc/testing/self-dev-checklist.md](./doc/testing/self-dev-checklist.md).

### Worktree Hooks

Sessions that create a git worktree (self-dev and external-project sessions) can run optional shell hooks at fixed paths. Use them to copy credentials into the worktree, warm caches, or snapshot logs before cleanup — without modifying runtime-adapter code.

**Configuration.** Drop scripts at the source repo (the repo whose `git worktree add` produced the worktree):

```
<sourceRoot>/.open-claude-tag/worktree-hooks/pre.sh   # runs after worktree creation
<sourceRoot>/.open-claude-tag/worktree-hooks/post.sh  # runs before worktree removal
```

`sourceRoot` is the OpenClaudeTag repo for self-dev sessions and the external project root for external sessions. Missing scripts are a silent no-op; the executable bit is not required (invoked via `bash`).

**Environment passed to each script** (cwd is the worktree directory; 60 s timeout):

| Variable | Value |
| --- | --- |
| `WORKTREE_PATH` | Absolute path of the worktree |
| `REPO_ROOT` | Same as `sourceRoot` above (varies by session type) |
| `SESSION_ID` | Full session id (or `dev-<shortId>` suffix during path-based cleanup) |
| `BRANCH_NAME` | Worktree branch, empty string when null |
| `WORKTREE_HOOK_PHASE` | `"pre"` or `"post"` |

**Failure semantics.**

- `pre` non-zero exit — the partial worktree is rolled back (`git worktree remove --force` + `git branch -D`) and the session aborts with the original error attached as `cause`. Use this to guarantee a missing dependency never lets a session enter a ready state.
- `post` non-zero exit — logged at `warn` and swallowed. Worktree removal must always finish, so a broken `post.sh` cannot block cleanup.

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

Full reference (lifecycle table, `REPO_ROOT` vs `OPEN_TAG_DEFAULT_WORKDIR`, integration points): [doc/architecture/worktree-hooks.md](./doc/architecture/worktree-hooks.md).

### Testing

Recommended verification flow for code changes:

```bash
pnpm build
pnpm test
pnpm --filter @open-tag/api test:e2e
```

`POST /debug/simulate` exercises the full event pipeline without Feishu:

```bash
curl -X POST http://localhost:3000/debug/simulate \
  -H 'Content-Type: application/json' \
  -d '{"text":"hello"}'
```

For Docker mode, verify both startup and execution. A complete single-host check is:

1. Start `postgres`, `api`, and `worker` with Compose.
2. Call `/health`.
3. Send a debug task through `/debug/simulate`.
4. Confirm task completion in `tasks`, `task_runs`, and `messages`.

### Deploying with Claude Code

You can use the built-in `/deploy-local` skill to walk through the full local deployment interactively. Start a Claude Code session in the repo root and run:

```
/deploy-local
```

Claude Code will run `pnpm doctor:local`, guide you through `.env` setup, start Postgres, run migrations, launch the services, and step you through Feishu Developer Console configuration. Common issues it handles automatically:

- Port 5432 occupied by another Docker container — stops the conflicting container before starting the Compose Postgres service.
- Stale `pgdata` volume from a different project — runs `docker compose down -v` to reinitialize the volume so the `open-claude-tag` user is created correctly.
- `DATABASE_URL` using `localhost` instead of `127.0.0.1` — Node.js 17+ resolves `localhost` to `::1` (IPv6) by default; the fix is to use `127.0.0.1` in `DATABASE_URL`.
- Multiple stale worker processes accumulating across restarts — kills all matching processes by name before starting a fresh worker.
- Choosing a runtime — if your Anthropic API balance is insufficient for `claude_code`, set `OPEN_TAG_DEFAULT_RUNTIME=codex` in `.env` and restart the worker. You can also pick a runtime per task in the workdir confirmation card.

No public URL or tunnel is required for local development. OpenClaudeTag uses Feishu WebSocket long connection, so the service connects outbound to Feishu and no inbound webhook is needed.

### Server-Centralized Deployment (Team Mode)

Instead of every user running the full stack locally, deploy OpenClaudeTag once as a central server (Docker Compose: Postgres + API + Worker) and let users pair their own machines as optional execution targets:

1. Deploy the server: see `doc/deployment/server-mode.md`.
2. Open the admin console's Machines page and generate a one-time pairing token.
3. On your machine: `npx @open-tag/daemon@latest --server-url <url> --token <token> --background`.
4. Bind agents or chats to your machine in the console.

The daemon holds no Feishu or database credentials, connects outbound only (works behind NAT/corporate proxies via `HTTPS_PROXY`), and executes tasks with your local Claude Code / Codex setup. Design and decision log: `doc/deployment/server-mode.md`.

### Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Card buttons return `200340` | Card callback not configured for long connection | Add `card.action.trigger` in **Callback Configuration** with **Long Connection** mode |
| Card creation returns `200621` with `not support tag: form_container` | Wrong form tag name | Use `"tag": "form"` instead of `"form_container"` |
| Bot receives no messages | Event subscription not configured | Add `im.message.receive_v1` in **Event Configuration** with **Long Connection** mode |
| Changes do not take effect | Feishu app version not republished | Create and publish a new version in **Version Management & Release** |
| Tasks stay at `Request received` | Worker is not running | Start `pnpm dev:worker` in a second terminal or start the `worker` container |
| E2E conflicts with another local instance | Shared port or DB collision | Use `pnpm dev:api:isolated`, `pnpm dev:worker:isolated`, and `pnpm test:e2e:isolated` |
| Local bootstrap fails with Postgres auth errors after upgrading from older `legacy` defaults | Existing Docker volume still contains old database or user initialization | Run `docker compose -f infra/docker-compose.yaml down -v` once, then rerun `pnpm setup:local` or the Compose migration steps |
| `db:migrate` fails with `ECONNREFUSED` even though Postgres container is running | Container started but `pg_isready` not yet passing | Wait for `pg_isready` before running migrations: `until docker exec infra-postgres-1 pg_isready -U open-claude-tag; do sleep 1; done` |
| `db:migrate` fails with `role "open-claude-tag" does not exist` | Postgres started with a stale volume from a different project | Run `docker compose -f infra/docker-compose.yaml down -v` to wipe the volume, then restart |
| `DATABASE_URL` with `localhost` fails on Node.js 17+ | Node resolves `localhost` to `::1` (IPv6) but Docker only binds `127.0.0.1` | Change `localhost` to `127.0.0.1` in `DATABASE_URL` |
| Worker keeps using `claude_code` after setting `OPEN_TAG_DEFAULT_RUNTIME=codex` | Old worker process still running from a previous start | Kill all worker processes (`pkill -9 -f "apps/worker"`) before restarting |
| `Claude Code returned an error result: Credit balance is too low` | Anthropic API account has insufficient credits | Add `OPEN_TAG_DEFAULT_RUNTIME=codex` to `.env` and restart the worker, or top up your Anthropic account |

## 中文

### 项目概览

OpenClaudeTag 是一个运行在飞书群聊中的工程助手。`apps/api` 负责接收飞书事件并入队任务，`apps/worker` 负责出队并执行任务，PostgreSQL 用来保存任务、运行状态和 session 数据。

重要说明：要让任务端到端执行，API 和 Worker 必须同时运行。只启动 API 只能收消息并返回 ACK 卡片，任务会停在 `Request received`。

### 架构概览

仓库结构：

| 区域 | 职责 |
| --- | --- |
| `apps/api` | Fastify HTTP 服务、飞书 WebSocket 事件、debug endpoint、任务分发 |
| `apps/worker` | 通过 `pg-boss` 执行排队任务的 Worker 进程 |
| `packages/feishu-adapter` | 飞书 REST 客户端、事件标准化、卡片构建 |
| `packages/orchestrator` | 意图分类与任务状态机 |
| `packages/runtime-adapters` | Claude Code 与 Codex 运行时集成 |
| `packages/storage` | Drizzle schema、migration、PostgreSQL 访问 |
| `packages/session` / `packages/memory` / `packages/approval` | 会话路由、记忆处理、审批流 |
| `packages/queue` / `packages/observability` / `packages/registry` | 队列封装、日志指标、服务注册 |

执行流程：

1. 飞书把消息事件投递到 `apps/api`。
2. API 标准化事件、构建任务上下文，并通过 `pg-boss` 入队。
3. `apps/worker` 出队后调用选定的 runtime adapter 执行任务。
4. OpenClaudeTag 向飞书发送 ACK、运行中、完成或失败反馈。

### 环境要求

| 依赖项 | 用途 | 说明 |
| --- | --- | --- |
| Node.js `20+` | 所有源码工作流 | 当前仓库使用 `pnpm@9.15.4`。 |
| `pnpm` | 所有源码工作流 | 先执行 `corepack enable`。 |
| Docker / Docker Compose | 本地 PostgreSQL 和 Docker 部署 | 如果你自带 Postgres，可以不使用 Docker。 |
| 飞书企业自建应用 | 真实飞书消息处理 | API 连接飞书所必需。 |
| Runtime 凭证 | 真实任务执行 | Claude Code 使用 `ANTHROPIC_*`；Codex 读取 `~/.codex/config.toml`。 |
| PostgreSQL 客户端工具（`psql`、`createdb`、`dropdb`） | 隔离 worktree 命令 | `pnpm db:setup:isolated` 及相关隔离命令会用到。 |
| `lark-cli` | 可选飞书开发工具 | 便于执行 `pnpm lark:doctor`、发送测试消息和查找 chat。 |

源码开发优先使用 macOS 或 Linux。Windows 建议通过 WSL2 运行，因为仓库中的部分脚本依赖类 Unix shell 环境。

### 快速开始

```bash
# 1. 启用 pnpm 并安装依赖
corepack enable
pnpm install

# 2. 从示例创建 .env 并填写必填项
cp .env.example .env
# 编辑 .env — 至少填写 FEISHU_APP_ID 和 FEISHU_APP_SECRET

# 3. 启动 Postgres、执行 migration、seed 并构建
pnpm setup:local

# 4. 在两个终端分别启动 API 和 Worker
pnpm dev:api
pnpm dev:worker
```

API 至少需要这些变量才能启动（`.env.example` 中已有这些字段，填入值即可）：

```bash
DATABASE_URL=postgresql://open-claude-tag:open-claude-tag@localhost:5432/open-claude-tag
FEISHU_APP_ID=cli_xxxxx
FEISHU_APP_SECRET=xxxxx
```

常见 runtime 相关变量：

```bash
# Claude Code runtime
ANTHROPIC_BASE_URL=https://api.anthropic.com
ANTHROPIC_AUTH_TOKEN=your-token

# 一些内部流程会使用的 agent 级 LLM client
OPEN_TAG_LLM_PROVIDER=openai
OPEN_TAG_LLM_BASE_URL=https://your-openai-compatible-endpoint
OPEN_TAG_LLM_API_KEY=your-api-key
OPEN_TAG_LLM_MODEL=your-model
```

Codex runtime 配置读取自 `~/.codex/config.toml`。

可选变量：

```bash
# 当运行目录不是仓库根目录时，指定仓库路径（默认取 process.cwd()）
OPEN_TAG_REPO_ROOT=/path/to/OpenClaudeTag
```

基础验证：

```bash
pnpm doctor:local
curl http://localhost:3000/health
curl -X POST http://localhost:3000/debug/simulate \
  -H 'Content-Type: application/json' \
  -d '{"text":"hello"}'
```

选择部署路径：

- 本地源码安装：最适合贡献代码和调试。
- 单机 Docker 部署：最适合快速自托管试用。
- 隔离 worktree 模式：最适合多个分支或多个 worktree 并行运行。

单机 Docker 路径使用 `infra/docker-compose.yaml`。

#### 单机 Docker 部署（Experimental）

这条路径主要用于快速试用和单机自托管，目前仍属于 experimental，还没有覆盖高可用、滚动升级、托管密钥或零停机发布等生产能力。

在 Docker 模式下，镜像会安装 `claude` 和 `codex`。`api` / `worker` 容器会把宿主机的 `${HOME}/.claude` 和 `${HOME}/.codex` 挂载到容器内的 `/root/.claude` 和 `/root/.codex`，这样 runtime 可以直接复用宿主机已有的认证、配置、session 和 skills。Compose 会把仓库根目录的 `.env` 注入到 `api` 和 `worker`，再把 `DATABASE_URL` 覆盖为 Compose 内部的 `postgres` 服务地址。

```bash
cp .env.example .env

docker compose -f infra/docker-compose.yaml up --build -d postgres
docker compose -f infra/docker-compose.yaml run --rm api pnpm db:migrate
docker compose -f infra/docker-compose.yaml run --rm api pnpm db:seed
docker compose -f infra/docker-compose.yaml up --build -d api worker

curl http://localhost:3000/health
```

说明：

- `docker compose up` 不会自动执行 migration；必须在启动 `api` 和 `worker` 前手动执行。
- Docker 模式只能修改容器文件系统以及显式挂载的路径，例如 `${HOME}/.claude` 和 `${HOME}/.codex`。如果没有额外挂载，容器不能修改宿主机上的任意项目目录。
- 如果只启动 `api`，请求虽然会被接收，但队列中的任务不会真正执行。

### 飞书应用配置

OpenClaudeTag 通过企业自建应用连接飞书。请在 [飞书开发者后台](https://open.feishu.cn/app) 中按下面的清单完成配置：

#### 1. 创建应用并获取凭证

1. 创建一个 **企业自建应用**。
2. 在 **凭证与基础信息** 中复制 `App ID` 和 `App Secret` 到 `.env`。

#### 2. 添加 Bot 能力

1. 在左侧菜单点击 **Add App Capability**。
2. 选择 **Bot** 卡片并点击 **Configure**。

#### 3. 配置事件订阅（Long Connection）

1. 进入 **Events & Callbacks**。
2. 在 **Event Configuration** 中选择 **Long Connection**。
3. 点击 **Add Event**，订阅 `im.message.receive_v1`。

#### 4. 配置卡片回调（Long Connection）

卡片回调用于响应确认、取消、重试、审批等交互按钮。缺少这个回调时，卡片按钮会返回错误码 `200340`。

1. 在同一个 **Events & Callbacks** 页面中，找到 **Callback Configuration** 区域，它独立于 Event Configuration。
2. 选择 **Long Connection**。
3. 点击 **Add Callback**，订阅 `card.action.trigger`。

#### 5. 配置权限

在 **Permissions & Scopes** 中添加：

| Scope | 说明 |
| --- | --- |
| `im:message.p2p_msg:readonly` | 接收单聊消息 |
| `im:message.group_at_msg:readonly` | 接收群聊中 @bot 的消息 |
| `im:message:send_as_bot` | 以 bot 身份发消息 |
| `im:message:update` | 更新任务状态卡片 |
| `im:message.reactions:write_only` | 添加和移除处理中表情反馈 |
| `im:message:readonly` | 读取引用消息内容 |
| `im:resource` | 访问图片、文件等消息资源 |
| `im:chat:read` | 访问群聊元数据 |
| `im:chat.members:read` | 访问群成员信息 |
| `task:tasklist:read` | 读取任务看板清单 |
| `task:tasklist:writeonly` | 创建和更新任务看板清单及成员 |
| `task:custom_field:read` | 读取任务看板自定义字段 |
| `task:custom_field:writeonly` | 创建任务看板自定义字段和选项 |
| `task:section:read` | 读取任务看板分组 |
| `task:section:writeonly` | 创建任务看板分组 |
| `task:task:write` | 创建、更新和移动任务看板任务 |

#### 6. 发布应用

1. 在 **Version Management & Release** 中创建一个新版本。
2. 填写版本号与 release notes。
3. 提交审核并发布。

重要说明：只要修改了权限、事件或回调配置，就必须重新发布新版本，否则变更不会生效。

#### 卡片 JSON 兼容性说明

飞书交互卡片常见有两种 JSON 结构：

- **JSON 1.0** 使用顶层 `elements` 数组，兼容性更广。
- **JSON 2.0** 使用 `schema: "2.0"` 与 `body.elements`，要求更高版本的飞书客户端。

对于表单卡片：

- 必须使用 `"tag": "form"`，不要使用 `"form_container"`。
- 表单容器需要 **Feishu V6.6+** 支持。
- 表单内部的提交按钮必须使用 `"action_type": "form_submit"`，这样回调里才会带上 `form_value`。
- 表单外部按钮应放在 `"tag": "action"` 中，并通过 `action.value` 传值。

表单卡片示例：

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

### 使用方式

Bot 运行后，在飞书群聊或单聊中 @Bot 即可交互。

任务反馈默认进入话题线程。Bot 的第一条回复会锚定用户消息，因此 ACK、运行中更新、溢出卡片、文本兜底和最终完成通知都会留在同一个飞书话题里，不会散落到群聊主时间线。该话题中的后续消息会复用同一个 session；启用飞书任务跟踪时，也会复用同一个已关联的飞书任务。Runtime 最终回复只会渲染原始请求中出现过的人类用户 `{{mention:open_id:name}}` 占位符；Bot mention、伪造 open ID 和不安全占位符都会被移除。

**自然语言** — 直接描述任务或提问：

```
@Bot 理解一下这个 repo 是做什么的
@Bot 为项目 ~/github/stock-agent 更新 README
@Bot 英伟达 H20 和 L20 对比
```

<img src="doc/images/usage-natural-language.png" width="600" />
<img src="doc/images/usage-external-project.png" width="600" />

**Slash 命令** — 结构化操作：

| 命令 | 说明 |
| --- | --- |
| `/project add <name> <path>` | 注册外部项目 |
| `/project use <name>` | 将当前 session 绑定到指定项目 |
| `/session list` | 列出所有 session |
| `/status` | 查看当前 session 信息 |
| `/help` | 显示所有可用命令 |

仅 Owner 可用：`/schedule`、`/project`、`/chat`、`/merge-pr`，以及 `/session worktrees` / `/session clean` worktree 子命令。所有命令均支持 `--help`。

**核心能力：**

- **外部项目** — 通过 `/project add` 注册本地仓库，然后用自然语言开发
- **多 Runtime** — 每个 agent 有默认 runtime；也可在工作目录确认卡片中按任务选择，或在任务卡片上用 Codex 重试
- **Session 隔离** — 每个任务在独立的 git worktree 中运行，上下文互不干扰
- **线程化反馈** — 飞书任务卡片、兜底消息和完成通知都会留在来源话题中
- **任务跟踪复用** — 启用任务跟踪后，同一飞书话题的后续请求复用同一个飞书任务项

### 开发流程

常用命令：

| 任务 | 命令 |
| --- | --- |
| 安装依赖 | `pnpm install` |
| 本地初始化 | `pnpm setup:local` |
| 本地环境体检 | `pnpm doctor:local` |
| 构建所有包 | `pnpm build` |
| 运行全部测试 | `pnpm test` |
| 运行 API E2E | `pnpm --filter @open-tag/api test:e2e` |
| 启动 API | `pnpm dev:api` |
| 启动 Worker | `pnpm dev:worker` |
| 启动隔离 API | `pnpm dev:api:isolated` |
| 启动隔离 Worker | `pnpm dev:worker:isolated` |
| 运行隔离 E2E | `pnpm test:e2e:isolated` |
| 初始化隔离数据库 | `pnpm db:setup:isolated` |

如果本地同时存在多个 worktree 或分支，优先使用内建的隔离命令，不要手动复用默认端口或数据库：

```bash
pnpm db:setup:isolated
pnpm dev:api:isolated
pnpm dev:worker:isolated
pnpm test:e2e:isolated
```

常用清理命令：

```bash
pnpm isolated:ps
pnpm isolated:stop
pnpm isolated:reap
pnpm isolated:purge
```

更完整的 worktree 安全验证顺序见 [doc/testing/self-dev-checklist.md](./doc/testing/self-dev-checklist.md)。

### Worktree Hook

会创建 worktree 的 session（self-dev 与外部项目 session）支持在固定路径放置可选的 shell hook，可用于把凭据/配置拷进 worktree、预热缓存或在清理前导出日志，无需修改 runtime-adapter 代码。

**配置方式。** 把脚本放在 worktree 的"母仓库"（执行 `git worktree add` 的那个仓库）下：

```
<sourceRoot>/.open-claude-tag/worktree-hooks/pre.sh   # 在 worktree 创建后执行
<sourceRoot>/.open-claude-tag/worktree-hooks/post.sh  # 在 worktree 删除前执行
```

`sourceRoot` 在 self-dev 场景下是 OpenClaudeTag 仓库根，在外部项目 session 中是外部项目根目录。脚本不存在时静默 no-op；不需要可执行位（通过 `bash` 调用）。

**脚本可用环境变量**（cwd 固定为 worktree 目录，60 秒超时）：

| 变量 | 含义 |
| --- | --- |
| `WORKTREE_PATH` | worktree 绝对路径 |
| `REPO_ROOT` | 上文 `sourceRoot`，按 session 类型变化 |
| `SESSION_ID` | session id（按路径清理时退化为 `dev-<shortId>` 后缀） |
| `BRANCH_NAME` | worktree 分支名，为空时是空串 |
| `WORKTREE_HOOK_PHASE` | `"pre"` 或 `"post"` |

**失败语义。**

- `pre` 非零退出 — 半成品 worktree 会被回滚（`git worktree remove --force` + `git branch -D`），原始错误以 `cause` 形式向上抛出。可借此保证缺少依赖时 session 永远不会进入 ready 状态。
- `post` 非零退出 — `warn` 级别记录后吞掉。worktree 清理路径必须能跑完，所以坏掉的 `post.sh` 不会卡住清理。

**示例 — 在每次任务前拷贝 AK 凭据**（`<OpenClaudeTag>/.open-claude-tag/worktree-hooks/pre.sh`）：

```bash
#!/usr/bin/env bash
set -euo pipefail

# 在外部项目 session 中 $REPO_ROOT 指向用户项目而非 OpenClaudeTag，
# 所以独立解析 OPEN_TAG_HOME，让同一个 hook 在两种 session 下都能工作。
OPEN_TAG_HOME="${OPEN_TAG_HOME:-$HOME/open-claude-tag}"

for src in "$OPEN_TAG_HOME/.anthropic" "$OPEN_TAG_HOME/.codex"; do
  [ -d "$src" ] && cp -r "$src" "$WORKTREE_PATH/"
done
```

完整参考（生命周期表、`REPO_ROOT` 与 `OPEN_TAG_DEFAULT_WORKDIR` 的区别、各调用点）：[doc/architecture/worktree-hooks.md](./doc/architecture/worktree-hooks.md)。

### 测试与验证

代码变更推荐验证流程：

```bash
pnpm build
pnpm test
pnpm --filter @open-tag/api test:e2e
```

`POST /debug/simulate` 可以在不接入飞书的情况下覆盖完整事件链路：

```bash
curl -X POST http://localhost:3000/debug/simulate \
  -H 'Content-Type: application/json' \
  -d '{"text":"hello"}'
```

对于 Docker 模式，除了确认服务启动，还要确认任务真的可以执行。完整的单机验证步骤是：

1. 用 Compose 启动 `postgres`、`api` 和 `worker`。
2. 调用 `/health`。
3. 通过 `/debug/simulate` 发送调试任务。
4. 在 `tasks`、`task_runs` 和 `messages` 中确认任务完成并落库。

### 中心化部署(团队模式)

无需每个用户本地跑全套服务:将 OpenClaudeTag 以中心 server 形式部署一次(Docker Compose:Postgres + API + Worker),用户按需把自己的机器配对为执行节点:

1. 部署 server:参见 `doc/deployment/server-mode.md`。
2. 打开管理控制台的 Machines 页面,生成一次性配对令牌。
3. 在自己机器上执行 `npx @open-tag/daemon@latest --server-url <url> --token <token> --background`。
4. 在控制台将 agent 或 chat 绑定到该机器。

daemon 不持有任何飞书/数据库凭据,仅出站连接(支持 `HTTPS_PROXY`,可穿透 NAT/公司网络),使用你本机的 Claude Code / Codex 凭据执行任务。设计与决策记录:`doc/deployment/server-mode.md`。

### 故障排查

| 现象 | 原因 | 修复方式 |
| --- | --- | --- |
| 卡片按钮返回 `200340` | 未配置 Long Connection 卡片回调 | 在 **Callback Configuration** 中添加 `card.action.trigger` 并使用 **Long Connection** |
| 创建卡片返回 `200621`，并提示 `not support tag: form_container` | 表单标签错误 | 使用 `"tag": "form"`，不要使用 `"form_container"` |
| Bot 收不到消息 | 未配置事件订阅 | 在 **Event Configuration** 中添加 `im.message.receive_v1` 并使用 **Long Connection** |
| 配置修改后不生效 | 飞书应用版本未重新发布 | 在 **Version Management & Release** 中创建并发布新版本 |
| 任务停留在 `Request received` | Worker 未启动 | 在另一个终端执行 `pnpm dev:worker` 或启动 `worker` 容器 |
| E2E 与本地其他实例冲突 | 共享端口或数据库互相影响 | 使用 `pnpm dev:api:isolated`、`pnpm dev:worker:isolated` 与 `pnpm test:e2e:isolated` |
| 从旧的 `legacy` 默认值升级后，本地初始化出现 Postgres 认证错误 | 现有 Docker volume 里仍保留旧数据库或用户初始化数据 | 先执行一次 `docker compose -f infra/docker-compose.yaml down -v`，再重新运行 `pnpm setup:local` 或 Compose 的 migration 步骤 |
