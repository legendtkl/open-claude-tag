# OpenClaudeTag

> Claude Tag 的开源版本 —— 在团队聊天里 @ 一个编码 agent 就能干活。
> Vendor-neutral 且可扩展：**channel**（飞书、Slack…）与 **runtime**（Claude Code、Codex…）都可插拔。

<!--
CI 状态徽章：一旦确定 GitHub 仓库 slug，请把下面的静态 "CI" 徽章替换为实时 Actions 徽章：
[![CI](https://github.com/<owner>/<repo>/actions/workflows/ci.yml/badge.svg)](https://github.com/<owner>/<repo>/actions/workflows/ci.yml)
-->

[![CI](https://img.shields.io/badge/CI-GitHub%20Actions-2088FF?logo=githubactions&logoColor=white)](.github/workflows/ci.yml)
![Status](https://img.shields.io/badge/status-alpha-orange)
![Version](https://img.shields.io/badge/version-0.1.0-blue)
![Node](https://img.shields.io/badge/node-%E2%89%A520-339933?logo=node.js&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-green)

[English](./README.md) · [AGENTS.md（贡献者指南）](./AGENTS.md)

OpenClaudeTag 是 **Claude Tag** 的开源版本：在团队聊天里 @ 一个编码 agent，它就能干真正的
工程活 —— 读代码仓库、跑任务、开 PR —— 再把进度回传到话题线程里。相比把单一聊天平台和单一
runtime 绑死的原版，OpenClaudeTag 让这两个轴都**可插拔、可扩展**。orchestrator 核心说的是
一套 neutral 的消息契约，因此在任一轴上新增一个选项，只需实现一个契约，而不必 fork 核心：

- **Channel** —— 聊天所在的平台。当前 Lark/飞书 是功能完整的 channel；Slack 是一个可用的
  第二 channel（入站分发 + 出站发送），其 OAuth、多 workspace 安装、Socket Mode 仍在推进中。
  新增 channel 只需实现 `packages/channel-core` 里的 `Channel` 契约。
- **Runtime** —— 执行任务的引擎。Claude Code（默认）与 Codex 为完整 runtime；当宿主机存在
  `coco` 二进制时自动注册 Coco (TRAE CLI)。新增 runtime 接入 `packages/runtime-adapters`
  的 descriptor 驱动注册表即可。

它接收一条聊天消息，经异步任务流水线分发，通过 runtime adapter 执行，并把进度回传到聊天里。

> **重要：** 要让任务端到端执行，API 和 Worker 必须同时运行。只启动 API 只能收消息并返回
> ACK 卡片，任务会停在 `Request received`。

## 产品预览

OpenClaudeTag 自带本地管理控制台，用于创建 agent、绑定飞书/Lark 应用、检查群权限，并查看任务
流转状态。控制台截图来自默认浏览器里打开的真实 React 管理 UI，并通过本地 API 的脱敏代理
供数；飞书线程图基于仓库已有真实飞书 usage 截图做脱敏重绘，只保留通用任务生命周期标签，
不是原始群聊导出。名称、app ID、chat ID、task ID、secret、workspace 路径和消息内容都已
遮挡或替换为占位数据。

<img src="doc/images/product-console-bots.jpg" alt="脱敏的 OpenClaudeTag 管理控制台，展示飞书应用绑定到 agent" width="900" />

群聊体验会保留在原话题里：bot 先确认收到请求，需要时发起确认，并把完成状态回传到同一个话题。

<img src="doc/images/product-feishu-thread.jpg" alt="脱敏的飞书群聊线程，展示 OpenClaudeTag 任务生命周期" width="900" />

## 功能特性

| 特性 | 说明 |
| --- | --- |
| 多 Runtime | Claude Code 和 Codex 为完整 runtime。可按 agent 或按任务选择。 |
| 多 Channel | Lark/飞书（完整）与 Slack（入站分发 + 出站发送，experimental）共用一套 neutral 的 `Channel` 契约。 |
| 零-Docker 个人启动器 | `pnpm personal:up` 启动内置 PostgreSQL 加 API + Worker + Console，全程免 Docker（ADR-0009）。 |
| Onboarding 向导 | 本地化的安装向导引导你连接飞书、创建 agent、绑定并上线。 |
| Worktree 隔离 | 每个任务在独立的 git worktree 中运行，上下文互不干扰；过期 worktree 自动清理。 |
| 按 agent 预算上限 | 按 identity 跟踪用量窗口并对照声明的上限强制执行（`@open-tag/registry`）。 |
| Access-bundle 凭据插件 | 命名、带版本的凭据 bundle 在执行时注入 runtime 环境变量**名**；值来自 secret provider，从不落库。 |
| Ambient 主动发言 | 判别器门控的网关可在频道讨论到相关话题时主动发言。opt-in，默认关（`OPEN_TAG_AMBIENT`）。 |
| 过期线程 nudge | primary API 后台扫描器可以提醒闲置线程。opt-in，默认关（`OPEN_TAG_STALE_THREAD_SCANNER_ENABLED`，ADR-0007）。 |
| 跨 channel flag broker | 审计、`isPrivate`-safe 的跨 channel flag broker（ADR-0006）。Experimental，仅搭好骨架 —— 默认关闭，尚未接入实时事件路径。 |
| 多 agent 讨论与委派 | 轮次制多 agent 辩论，以及定向 agent 间 handoff（`@open-tag/orchestrator`）。 |
| 管理控制台 | 本地运维控制台，管理 agent、飞书绑定、chat、machine 和任务看板。 |
| 桌面端 | 一个把管理控制台包起来的 macOS Electron 外壳。 |

## 架构

### 可插拔架构（两个轴）

channel adapter 把平台事件标准化成 neutral 的 `InboundMessage`，并把 `OutboundMessage`
渲染回去（`packages/channel-core` 定义 `Channel` 契约）；runtime adapter 在一个
descriptor 驱动的注册表后执行任务（`packages/runtime-adapters`）。orchestrator 核心既不
指名厂商也不指名 runtime（见 [`doc/decisions/0004`](./doc/decisions/0004-inbound-message-pipeline-contract.md)）。

| 轴 | 选项 | 状态 |
| --- | --- | --- |
| Channel | Lark / 飞书 | 完整 —— 事件、交互卡片、线程化反馈、表情反馈、审批、飞书任务跟踪（`packages/feishu-adapter`，`LarkChannel`）。 |
| Channel | Slack | 入站分发 + 出站发送（`packages/channel-slack`，`SlackChannel`）。经签名校验的 `POST /slack/events` 路由会写入 channel-neutral 的 observation memory；当配置了 `SLACK_BOT_USER_ID` 且消息 @ 了 bot 时，会经 neutral 路径分发任务（ADR-0005）；当同时设置了 `SLACK_BOT_TOKEN` 时，再通过 Slack Web API 回 ACK。worker 还会把任务的终态完成作为 neutral 消息回传（ADR-0008）。OAuth / 多 workspace 安装、Socket Mode、更丰富的 running-card / Block Kit 对齐，以及 Lark 专有的扩展（slash 命令树、缓冲、线程/引用富化、agent 路由）尚未实现。 |
| Runtime | Claude Code | 完整 —— 默认 runtime。 |
| Runtime | Codex | 完整。 |

Slack 路径有单元测试和基于 Postgres 的集成测试覆盖，集成测试会通过同一个 vendor-clean 核心
端到端驱动真实路由（Slack sender 用 stub 注入）；但用真实 workspace 凭据的端到端 Slack 验证
尚未跑过。延后项见 [`doc/decisions/0005`](./doc/decisions/0005-neutral-non-lark-task-dispatch.md)。

### 执行流程

```mermaid
flowchart LR
  subgraph CH[Channel]
    L[Lark / 飞书<br/>WebSocket]
    S[Slack<br/>POST /slack/events]
  end

  subgraph API[apps/api]
    N[normalize → InboundMessage]
    D[dispatch / 构建上下文]
    E[enqueue]
  end

  Q[(pg-boss / PostgreSQL)]

  subgraph WK[apps/worker]
    R[runtime adapter 执行<br/>Claude Code · Codex]
  end

  SND[ChannelSender<br/>ACK · running · done · failed]

  L --> N
  S --> N
  N --> D --> E --> Q
  Q --> R --> SND
  SND -->|交互卡片 / 消息| CH
```

1. channel adapter 把消息事件投递到 `apps/api`（Lark 走 WebSocket，Slack 走
   `POST /slack/events`），并标准化成 neutral 的 `InboundMessage`。
2. API 构建任务上下文，并通过 `pg-boss`（PostgreSQL）入队。
3. `apps/worker` 出队后调用选定的 runtime adapter 执行任务。
4. OpenClaudeTag 向 channel 发送 ACK、运行中、完成或失败反馈。Lark 会渲染完整的交互任务卡片；
   Slack 路径发送入站 ACK，worker 会把终态完成作为 neutral 消息回传（ADR-0008），更丰富的
   running-card 对齐仍在推进中。

### 仓库结构

这是一个 pnpm-workspace monorepo：5 个 app 和 19 个 package。

**Apps**

| App | 职责 |
| --- | --- |
| `apps/api` | Fastify HTTP 服务、飞书 WebSocket 事件、`POST /slack/events`、debug endpoint、任务分发，以及 primary API 后台对账循环（worktree 清理、ambient、stale-thread）。 |
| `apps/worker` | `pg-boss` Worker 进程，出队并通过 runtime adapter 执行任务。 |
| `apps/console` | React + Vite 管理控制台：agent、飞书绑定、chat、machine、任务看板和 onboarding 向导。 |
| `apps/daemon` | 远程执行 daemon，通过出站 WebSocket 连接中心 server，在你本机执行任务（`@open-tag/daemon`）。 |
| `apps/desktop` | 把管理控制台包起来的 macOS Electron 桌面外壳。 |

**Packages**

| Package | 职责 |
| --- | --- |
| `packages/channel-core` | vendor-neutral 的 `Channel` 契约：`InboundMessage` / `OutboundMessage` 与 channel registry。 |
| `packages/feishu-adapter` | Lark / 飞书 `Channel`：REST 客户端、事件标准化、交互卡片构建。 |
| `packages/channel-slack` | Slack `Channel`：签名校验、事件 normalize、通过 Slack Web API 的 send/update。 |
| `packages/orchestrator` | 入站分发、任务状态机、agent 委派、多 agent 讨论（与 channel、runtime 解耦）。 |
| `packages/runtime-adapters` | descriptor 驱动的 runtime 注册表与适配器：Claude Code 和 Codex。 |
| `packages/storage` | Drizzle ORM schema、migration、PostgreSQL 访问。 |
| `packages/session` | 会话路由与生命周期、context builder/strategy、worktree 上下文、回复语言处理。 |
| `packages/memory` | observation / channel memory、敏感内容过滤、shared context、workspace memory。 |
| `packages/registry` | agent identity、manifest/sync、按 identity 的预算跟踪，以及 access-bundle 凭据注入。 |
| `packages/ambient` | 判别器门控的主动发言网关与 stale-thread 评估。 |
| `packages/cross-channel` | 审计、`isPrivate`-safe 的跨 channel flag broker 与渲染（ADR-0006）。 |
| `packages/launcher` | 个人零-Docker 启动器 CLI：embedded / docker / external DB provider，`up` / `down` / `status`。 |
| `packages/queue` | `pg-boss` 任务队列封装。 |
| `packages/scheduler` | admission scheduler（按 agent 的并发与启动速率准入）。 |
| `packages/approval` | RBAC 与审批审计服务。 |
| `packages/daemon-protocol` | daemon WebSocket 帧协议：frame、replay buffer、序号跟踪、版本管理。 |
| `packages/core-types` | 共享 type、enum、schema、id、guard（agent、event、memory、slash command）。 |
| `packages/observability` | 结构化日志与 fatal 错误处理。 |
| `packages/llm-client` | OpenAI / Anthropic 兼容的 LLM client 工厂（workdir 提取、ambient 判别器等内部流程）。 |

## 前置依赖

| 依赖项 | 用途 | 说明 |
| --- | --- | --- |
| Node.js `20+` | 所有源码工作流 | 当前仓库使用 `pnpm@9.15.4`。 |
| `pnpm` | 所有源码工作流 | 先执行 `corepack enable`。 |
| Docker / Docker Compose | `OPEN_TAG_DB_MODE=docker` 和 Docker 部署 | 个人启动器内置 embedded Postgres，**无需 Docker**。 |
| 飞书企业自建应用 | 真实飞书消息处理 | API 连接飞书所必需。 |
| Runtime 凭证 | 真实任务执行 | Claude Code 使用 `ANTHROPIC_*` / `~/.claude`；Codex 读取 `~/.codex/config.toml`。 |
| PostgreSQL 客户端工具（`psql`、`createdb`、`dropdb`） | 隔离 worktree 命令 | `pnpm db:setup:isolated` 及相关隔离生命周期命令会用到。 |
| `lark-cli` | 可选飞书开发工具 | 便于执行 `pnpm lark:doctor`、发送测试消息和查找 chat。 |

源码开发优先使用 macOS 或 Linux。Windows 建议通过 WSL2 运行，因为仓库中的部分脚本依赖
类 Unix shell 环境。

## 个人快速体验（零-Docker）

在自己的机器上**无需 Docker** 跑起整个栈：自动内置一个 embedded PostgreSQL，并用本地
onboarding 向导引导你连接飞书、创建第一个 agent。只需 Node.js 20+ 和 pnpm
（`corepack enable`）；真实执行任务需宿主机有 Claude Code（`~/.claude` / `ANTHROPIC_*`）
或 Codex（`~/.codex`）凭证。

```bash
corepack enable
pnpm install        # embedded Postgres 二进制从公共 npm 拉取
pnpm build          # 构建全部包（含 launcher CLI）
pnpm personal:up    # 内置 Postgres → migrate + seed → 起 API + Worker + Console → 自动开浏览器
```

`pnpm personal:up` 会启动一个 embedded PostgreSQL（默认 `OPEN_TAG_DB_MODE=embedded`）、
执行 migration、在 `127.0.0.1` 起 API + Worker + Console、等待 `/health`，并打开
onboarding 向导。然后跟着向导走：**连接飞书 → 创建 agent → 绑定 → 上线**。

| 命令 | 作用 |
| --- | --- |
| `pnpm personal:up` | 启动整个栈（幂等） |
| `pnpm personal:status` | 查看 DB / API / Worker / Console + `/health` |
| `pnpm personal:down` | 停止全部（含 embedded Postgres） |

用 `OPEN_TAG_DB_MODE` 选数据库后端：`embedded`（默认，免 Docker）、`docker`（用
`infra/docker-compose.yaml`）、`external`（`DATABASE_URL` 指向你自己的 Postgres）。
embedded 数据目录在 `~/.open-claude-tag/pgdata`。launcher CLI 也提供 `open-claude-tag up`
（别名 `oct up`）；该包目前是私有的（`v0.1.0`），因此 `npx open-claude-tag up` / `oct up`
这种形式要等发布到 npm 后才可用。在那之前请用 `pnpm personal:up`。

## 快速开始（Docker 或自带 Postgres）

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

基础验证：

```bash
pnpm doctor:local
curl http://localhost:3000/health
curl -X POST http://localhost:3000/debug/simulate \
  -H 'Content-Type: application/json' \
  -d '{"text":"hello"}'
```

### 部署模式

按"给谁用"来选：两条个人路径让单个用户最快跑起来；团队路径一次部署、全员共用。

**个人 —— 自己用**

- **极简 / 零-Docker** —— `pnpm personal:up` 启动内置 Postgres 加 API + Worker + Console
  并打开 onboarding 向导，全程免 Docker、无需外部数据库。见上文 *个人快速体验（零-Docker）*。
- **单机 Docker** —— 用 Docker Compose 跑 Postgres + API + Worker，适合快速自托管试用。
  见下文 *单机 Docker 部署*。
- **本地源码安装** —— 从源码起 API 和 Worker，最适合贡献代码与调试。多个分支或 worktree
  并行时使用隔离命令。

**团队 —— server + daemon 模式**

- 将 OpenClaudeTag 以中心 server 形式部署一次（Postgres + API + Worker），每个用户通过
  零凭据 daemon 把自己的机器配对为可选执行节点。绑定机器的任务绝不会静默回退到 server 本地。
  见下文 *中心化部署（团队模式）*。

### 单机 Docker 部署（Experimental）

这条路径主要用于快速试用和单机自托管，目前仍属于 experimental，还没有覆盖高可用、滚动升级、
托管密钥或零停机发布等生产能力。

在 Docker 模式下，镜像会安装 `claude` 和 `codex`。`api` / `worker` 容器会把宿主机的
`${HOME}/.claude` 和 `${HOME}/.codex` 挂载到容器内的 `/root/.claude` 和 `/root/.codex`，
这样 runtime 可以直接复用宿主机已有的认证、配置、session 和 skills。Compose 会把仓库根目录的
`.env` 注入到 `api` 和 `worker`，再把 `DATABASE_URL` 覆盖为 Compose 内部的 `postgres`
服务地址。

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
- Docker 模式只能修改容器文件系统以及显式挂载的路径，例如 `${HOME}/.claude` 和
  `${HOME}/.codex`。如果没有额外挂载，容器不能修改宿主机上的任意项目目录。
- 如果只启动 `api`，请求虽然会被接收，但队列中的任务不会真正执行。

## 配置参考

把 `.env.example` 复制成 `.env` 并按需填写。除非显式标注 **code-only**，这里记录的每个变量都
存在于 `.env.example`（注释或生效）。变量从 `process.env` 读取。

### 数据库

| 变量 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `DATABASE_URL` | 是（docker / external / 源码） | `postgresql://open-claude-tag:open-claude-tag@localhost:5432/open-claude-tag` | PostgreSQL 连接串。Node.js 17+ 建议用 `127.0.0.1` 而非 `localhost`。 |
| `OPEN_TAG_DB_MODE` | 否 | `embedded` | 启动器数据库后端：`embedded`、`docker` 或 `external`。 |

### API / 访问

| 变量 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `PORT` | 否 | `3000` | API HTTP 端口。 |
| `HOST` | 否 | `0.0.0.0` | API 绑定主机。 |
| `LOG_LEVEL` | 否 | `info` | 日志级别。 |
| `OPEN_ACCESS` | 否 | `.env.example` 为 `true`（未设 ⇒ `false`） | 为 `true` 时所有飞书发送者按 OWNER 处理（不查 RBAC）—— 适合私有单团队部署。`.env.example` 默认发 `true`；若该变量未设置，代码按 `false`（严格 RBAC）处理。设为 `false` 对多用户或对外部署强制 RBAC。 |

### 飞书

| 变量 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `FEISHU_APP_ID` | 是（真实飞书） | — | 飞书开发者后台的自建应用 App ID。 |
| `FEISHU_APP_SECRET` | 是（真实飞书） | — | 自建应用 App Secret。 |
| `FEISHU_EVENT_MODE` | 否 | `websocket` | 事件传输方式；长连接 WebSocket 模式无需公网 webhook。 |
| `FEISHU_WEBHOOK_PATH` | 否 | `/webhooks/feishu` | webhook 模式下的入站路径。 |
| `FEISHU_ENCRYPT_KEY` / `FEISHU_VERIFICATION_TOKEN` | 否 | — | webhook 模式的加密与校验（WebSocket 模式不需要）。 |

### Runtime —— Claude Code / Codex

| 变量 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `ANTHROPIC_BASE_URL` | 否 | `https://api.anthropic.com` | Claude Code 端点。 |
| `ANTHROPIC_API_KEY` | 否 | — | Claude Code key。两者都设时优先于 `ANTHROPIC_AUTH_TOKEN`。 |
| `ANTHROPIC_AUTH_TOKEN` | 否 | — | Claude Code OAuth/auth token。 |
| `OPEN_TAG_DEFAULT_RUNTIME` | 否 | `claude_code` | 通用任务的默认 runtime（`claude_code` 或 `codex`）。 |
| `OPEN_TAG_DEFAULT_MODEL` | 否 | — | 可选的默认模型覆盖。 |
| Codex | — | — | Codex 的认证与模型读取自 `~/.codex/config.toml`。 |
| `CODEX_STARTUP_TIMEOUT_MS` | 否 | `120000` | 等待 Codex 建立 API 连接的最大毫秒数（`0` 关闭）。 |

### Agent 级 LLM client（workdir 提取、ambient 判别器等）

| 变量 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `OPEN_TAG_LLM_PROVIDER` | 否 | — | `openai` 或 `anthropic` 兼容 provider。 |
| `OPEN_TAG_LLM_BASE_URL` | 否 | — | OpenAI 兼容端点。 |
| `OPEN_TAG_LLM_API_KEY` | 否 | — | LLM client API key。 |
| `OPEN_TAG_LLM_MODEL` | 否 | — | LLM client 模型。 |

### Worker

| 变量 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `WORKER_CONCURRENCY` | 否 | `5` | 单 worker 并发任务数。 |
| `OPEN_TAG_REPO_ROOT` | 否 | `process.cwd()` | 从非仓库根目录运行时覆盖仓库根（如 Docker 中）。 |
| `OPEN_TAG_DEFAULT_WORKDIR` | 否 | — | 用于给新 session 注入 `adhocWorkDir` 的绝对路径。 |
| `WORKER_AUTO_RESTART` / `WORKER_RESTART_COOLDOWN_MS` | 否 | `false` / `30000` | 检测到 worker 宕机时自动重启（仅 primary 角色）。 |
| `WORKER_EXECUTOR` / `WORKER_EXECUTOR_SESSION` | 否 | — | 设为 `tmux` 时在命名 tmux session 中运行 worker。 |

### Worktree 清理

| 变量 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `WORKTREE_RETENTION_MS` | 否 | `604800000`（7 天） | 受管 session worktree 进入可清理状态前的保留时长。 |
| `WORKTREE_CLEANUP_INTERVAL_MS` | 否 | `300000`（5 分钟） | 过期 worktree 清理的后台扫描间隔。 |

### Server / daemon（团队模式）

| 变量 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `SERVER_PUBLIC_URL` | 使用 daemon 时 | — | daemon 拨号用的公网 base URL；渲染进配对卡片。 |
| `DAEMON_GATEWAY_PORT` | 否 | `3001` | worker 托管的 daemon 网关端口（配对 REST + daemon WebSocket）。 |
| `DAEMON_GATEWAY_PUBLIC` | 否 | `false` | 是否公开绑定网关（仅在 TLS 反代之后）。 |
| `OPEN_TAG_DAEMON_MAX_CONCURRENT_DISPATCHES` | 否 | — | 单 daemon 派发上限；满载时 daemon 以 `busy` 拒绝。 |

### Slack（experimental）

| 变量 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `SLACK_SIGNING_SECRET` | 启用 Slack 时 | — | 启用并签名校验 `POST /slack/events` 路由。 |
| `SLACK_BOT_USER_ID` | 分发任务时 | — | 设置后，@ 这个 bot 会经 neutral 路径分发任务。 |
| `SLACK_BOT_TOKEN` | 出站回传时 | — | 用于入站 ACK 的 Slack Web API token；worker 也会读取它来回传任务的终态完成（ADR-0008）。 |

### 特性开关

| 变量 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `OPEN_TAG_CHANNEL_MEMORY` | 否 | 开 | channel observation memory（"跟读频道"）。只有字面值 `disabled` 才关闭。 |
| `OPEN_TAG_AMBIENT` / `OPEN_TAG_AMBIENT_CHANNELS` | 否 | 关 | 判别器门控的主动发言（opt-in）及其频道白名单。 |
| `OPEN_TAG_STALE_THREAD_SCANNER_ENABLED` / `OPEN_TAG_STALE_THREAD_CHANNELS` | 否 | 关 | 过期线程 nudge 扫描器（opt-in，ADR-0007）及其频道白名单。 |
| `OPEN_TAG_CROSS_CHANNEL_ENABLED` | 否 | 关 | 跨 channel flag broker 总开关（ADR-0006）。Experimental：broker 已实现，但尚未接入实时事件路径。 |
| `OPEN_TAG_CHANNEL_MEMORY_MAX_PER_SCOPE` / `OPEN_TAG_CHANNEL_MEMORY_TTL_MS` | 否 | — | channel-memory 裁剪上限（**code-only** 调优项，不在 `.env.example`）。 |
| `BUFFER_UNTIL_AT` | 否 | `false` | 为 `true` 时只有 @ 才创建任务，期间消息被缓冲。 |

## 飞书应用配置

OpenClaudeTag 通过企业自建应用连接飞书。请在 [飞书开发者后台](https://open.feishu.cn/app)
中按下面的清单完成配置：

### 1. 创建应用并获取凭证

1. 创建一个 **企业自建应用**。
2. 在 **凭证与基础信息** 中复制 `App ID` 和 `App Secret` 到 `.env`。

### 2. 添加 Bot 能力

1. 在左侧菜单点击 **添加应用能力**。
2. 选择 **机器人** 卡片并点击 **配置**。

### 3. 配置事件订阅（长连接）

1. 进入 **事件与回调**。
2. 在 **事件配置** 中选择 **长连接**。
3. 点击 **添加事件**，订阅 `im.message.receive_v1`。

### 4. 配置卡片回调（长连接）

卡片回调用于响应确认、取消、重试、审批等交互按钮。缺少这个回调时，卡片按钮会返回错误码
`200340`。

1. 在同一个 **事件与回调** 页面中，找到 **回调配置** 区域，它独立于事件配置。
2. 选择 **长连接**。
3. 点击 **添加回调**，订阅 `card.action.trigger`。

### 5. 配置权限

在 **权限管理与授权** 中添加：

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

### 6. 发布应用

1. 在 **版本管理与发布** 中创建一个新版本。
2. 填写版本号与 release notes。
3. 提交审核并发布。

> **重要：** 只要修改了权限、事件或回调配置，就必须重新发布新版本，否则变更不会生效。

### 卡片 JSON 兼容性说明

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

## Slack 配置（Experimental）

Slack 是一个可用的第二 channel，支持入站任务分发和出站 ACK，但目前**部分/实验性**：OAuth、
多 workspace 安装、Socket Mode、更丰富的 running-card / Block Kit 对齐都尚未实现，也还没有用真实
workspace 凭据做过端到端验证。（worker 侧的终态完成回传是存在的 —— 见 ADR-0008。）

1. 设置 `SLACK_SIGNING_SECRET`。这会注册并签名校验 `POST /slack/events` 路由；不设则不挂载
   该路由。
2. 设置 `SLACK_BOT_USER_ID`。@ 这个 bot 用户会经与 Lark 相同的 vendor-neutral 路径分发任务
   （ADR-0005）。
3. 设置 `SLACK_BOT_TOKEN` 用于出站回传 —— 用于入站 ACK 的 Slack Web API token；worker 也会
   读取它来回传任务的终态完成（ADR-0008）。

把 Slack 应用的 Events API 请求 URL 指向 `https://<your-host>/slack/events`。延后项见
[`doc/decisions/0005`](./doc/decisions/0005-neutral-non-lark-task-dispatch.md)。

## 使用方式

Bot 运行后，在飞书群聊或单聊中 @Bot 即可交互。

任务反馈默认进入话题线程。Bot 的第一条回复会锚定用户消息，因此 ACK、运行中更新、溢出卡片、
文本兜底和最终完成通知都会留在同一个飞书话题里，不会散落到群聊主时间线。该话题中的后续消息会
复用同一个 session；启用飞书任务跟踪时，也会复用同一个已关联的飞书任务。Runtime 最终回复只会
渲染原始请求中出现过的人类用户 `{{mention:open_id:name}}` 占位符；Bot mention、伪造 open ID
和不安全占位符都会被移除。

**自然语言** — 直接描述任务或提问：

```
@Bot 理解一下这个 repo 是做什么的
@Bot 为项目 ~/github/stock-agent 更新 README
@Bot 英伟达 H20 和 L20 对比
```

<img src="doc/images/usage-natural-language.png" width="600" />
<img src="doc/images/usage-external-project.png" width="600" />

**Self-dev** — 让 bot 改进自己的仓库（owner-only 的 `/dev` 任务始终在 server 本地、针对 bot
自己的 monorepo 运行）：

<img src="doc/images/usage-self-dev.png" width="600" />

**Slash 命令** — 结构化操作：

| 命令 | 说明 |
| --- | --- |
| `/project add <name> <path>` | 注册外部项目 |
| `/project use <name>` | 将当前 session 绑定到指定项目 |
| `/session list` | 列出所有 session |
| `/status` | 查看当前 session 信息 |
| `/help` | 显示所有可用命令 |

仅 Owner 可用：`/schedule`、`/project`、`/chat`、`/merge-pr`，以及 `/session worktrees` /
`/session clean` worktree 子命令。所有命令均支持 `--help`。

**核心能力：**

- **外部项目** — 通过 `/project add` 注册本地仓库，然后用自然语言开发。
- **多 Runtime** — 每个 agent 有默认 runtime；也可在工作目录确认卡片中按任务选择，或在任务
  卡片上用 Codex 重试。
- **Session 隔离** — 每个任务在独立的 git worktree 中运行，上下文互不干扰。
- **线程化反馈** — 飞书任务卡片、兜底消息和完成通知都会留在来源话题中。
- **任务跟踪复用** — 启用任务跟踪后，同一飞书话题的后续请求复用同一个飞书任务项。

## 开发流程

常用命令：

| 任务 | 命令 |
| --- | --- |
| 安装依赖 | `pnpm install` |
| 本地初始化 | `pnpm setup:local` |
| 本地环境体检 | `pnpm doctor:local` |
| 构建所有包 | `pnpm build` |
| Lint | `pnpm lint` |
| 类型检查 | `pnpm typecheck` |
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

自动清理过期 worktree：

- primary API 进程会在后台循环清理过期的受管 session worktree。
- 使用 `WORKTREE_RETENTION_MS` 配置保留时长，使用 `WORKTREE_CLEANUP_INTERVAL_MS` 配置扫描间隔。
- 默认保留时长为 7 天，默认扫描间隔为 5 分钟。
- external project 只会清理 `<projectPath>/.worktrees/dev-*` 下的受管 git worktree。
- 指向项目根目录的 external project direct-path fallback 永远不会被自动删除。
- external project 清理走 `git worktree remove`，不会删除底层 git branch。

详细的 worktree 安全验证顺序见 [doc/testing/self-dev-checklist.md](./doc/testing/self-dev-checklist.md)。

## Worktree Hook

会创建 worktree 的 session（self-dev 与外部项目 session）支持在固定路径放置可选的 shell hook，
可用于把凭据/配置拷进 worktree、预热缓存或在清理前导出日志，无需修改 runtime-adapter 代码。

**配置方式。** 把脚本放在 worktree 的"母仓库"（执行 `git worktree add` 的那个仓库）下：

```
<sourceRoot>/.open-claude-tag/worktree-hooks/pre.sh   # 在 worktree 创建后执行
<sourceRoot>/.open-claude-tag/worktree-hooks/post.sh  # 在 worktree 删除前执行
```

`sourceRoot` 在 self-dev 场景下是 OpenClaudeTag 仓库根，在外部项目 session 中是外部项目根目录。
脚本不存在时静默 no-op；不需要可执行位（通过 `bash` 调用）。

**脚本可用环境变量**（cwd 固定为 worktree 目录，60 秒超时）：

| 变量 | 含义 |
| --- | --- |
| `WORKTREE_PATH` | worktree 绝对路径 |
| `REPO_ROOT` | 上文 `sourceRoot`，按 session 类型变化 |
| `SESSION_ID` | session id（按路径清理时退化为 `dev-<shortId>` 后缀） |
| `BRANCH_NAME` | worktree 分支名，为空时是空串 |
| `WORKTREE_HOOK_PHASE` | `"pre"` 或 `"post"` |

**失败语义。**

- `pre` 非零退出 — 半成品 worktree 会被回滚（`git worktree remove --force` + `git branch -D`），
  原始错误以 `cause` 形式向上抛出。可借此保证缺少依赖时 session 永远不会进入 ready 状态。
- `post` 非零退出 — `warn` 级别记录后吞掉。worktree 清理路径必须能跑完，所以坏掉的 `post.sh`
  不会卡住清理。

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

完整参考（生命周期表、`REPO_ROOT` 与 `OPEN_TAG_DEFAULT_WORKDIR` 的区别、各调用点）：
[doc/architecture/worktree-hooks.md](./doc/architecture/worktree-hooks.md)。

## 测试与验证

代码变更推荐验证流程：

```bash
pnpm build
pnpm test
pnpm --filter @open-tag/api test:e2e
```

在 worktree 中，优先使用隔离 gate：

```bash
docker compose -f infra/docker-compose.yaml up postgres -d
pnpm db:setup:isolated
pnpm test:integration:isolated
pnpm test:e2e:isolated     # 需要一个已运行的隔离 API
```

`POST /debug/simulate` 可以在不接入飞书的情况下覆盖完整事件链路：

```bash
curl -X POST http://localhost:3000/debug/simulate \
  -H 'Content-Type: application/json' \
  -d '{"text":"hello"}'
```

**Live runtime E2E（opt-in）。** `pnpm test:runtime:e2e` 通过 REAL 的 Codex 和 Claude Code
runtime adapter（用真实的 `@openai/codex-sdk` 和 `@anthropic-ai/claude-agent-sdk`）跑一个
trivial 的 `chat_reply` 任务。它**不**属于默认套件，需要真实的 `~/.codex` / `~/.claude`
凭证，并会产生真实、计费的模型调用。没有凭证的 runtime 会被报告为 skip 而非 fail。每个 runtime
的前置条件见 [AGENTS.md](./AGENTS.md) 的 "Live Runtime E2E" 一节（Codex 需 unset proxy；
Claude Code 需要可达 `api.anthropic.com` 的 HTTPS proxy）。

对于 Docker 模式，除了确认服务启动，还要确认任务真的可以执行。完整的单机验证步骤是：

1. 用 Compose 启动 `postgres`、`api` 和 `worker`。
2. 调用 `/health`。
3. 通过 `/debug/simulate` 发送调试任务。
4. 在 `tasks`、`task_runs` 和 `messages` 中确认任务完成并落库。

## 使用 Claude Code 辅助部署

使用内置的 `/deploy-local` skill，可以在对话中完成全流程引导部署。在仓库根目录启动 Claude Code
会话后执行：

```
/deploy-local
```

Claude Code 会依次运行 `pnpm doctor:local`、引导你配置 `.env`、启动 Postgres、执行迁移、
拉起服务，并逐步指引你完成飞书开发者后台配置。它会自动处理以下常见问题：

- **5432 端口被其他 Docker 容器占用** — 先停止冲突容器，再启动 Compose 的 Postgres 服务。
- **pgdata volume 是其他项目的残留** — 执行 `docker compose down -v` 重建 volume，确保
  `open-claude-tag` 用户被正确创建。
- **`DATABASE_URL` 使用 `localhost` 在 Node.js 17+ 失败** — Node 默认把 `localhost` 解析为
  `::1`（IPv6），但 Docker 只绑定 `127.0.0.1`；改用 `127.0.0.1` 即可。
- **多个旧 Worker 进程残留** — 按名称杀掉所有匹配进程后再启动新的，避免旧进程继续消费任务。
- **Runtime 选择** — 如果 Anthropic API 余额不足，在 `.env` 中设置
  `OPEN_TAG_DEFAULT_RUNTIME=codex` 并重启 Worker；也可在工作目录确认卡片中按任务选择 runtime。

本地开发不需要公网地址或内网穿透。OpenClaudeTag 使用飞书 WebSocket 长连接，服务主动连接飞书，
不需要配置 Webhook URL。

## 中心化部署（团队模式）

无需每个用户本地跑全套服务：将 OpenClaudeTag 以中心 server 形式部署一次（Docker Compose：
Postgres + API + Worker），用户按需把自己的机器配对为执行节点：

1. 部署 server：参见 [`doc/deployment/server-mode.md`](./doc/deployment/server-mode.md)。
2. 打开管理控制台的 Machines 页面，生成一次性配对令牌。
3. 在自己机器上执行 `npx @open-tag/daemon@latest --server-url <url> --token <token> --background`。
4. 在控制台将 agent 或 chat 绑定到该机器。

daemon 不持有任何飞书/数据库凭据，仅出站连接（支持 `HTTPS_PROXY`，可穿透 NAT/公司网络），
使用你本机的 Claude Code / Codex 凭据执行任务。中心 API 持有唯一的飞书 WSClient；绑定机器的
任务绝不会静默回退到 server 本地，`/dev` self-dev 任务始终在 server 本地运行。设计与决策记录：
[`doc/deployment/server-mode.md`](./doc/deployment/server-mode.md)。

## 故障排查

| 现象 | 原因 | 修复方式 |
| --- | --- | --- |
| 卡片按钮返回 `200340` | 未配置 Long Connection 卡片回调 | 在 **回调配置** 中添加 `card.action.trigger` 并使用 **长连接** |
| 创建卡片返回 `200621`，并提示 `not support tag: form_container` | 表单标签错误 | 使用 `"tag": "form"`，不要使用 `"form_container"` |
| Bot 收不到消息 | 未配置事件订阅 | 在 **事件配置** 中添加 `im.message.receive_v1` 并使用 **长连接** |
| 配置修改后不生效 | 飞书应用版本未重新发布 | 在 **版本管理与发布** 中创建并发布新版本 |
| 任务停留在 `Request received` | Worker 未启动 | 在另一个终端执行 `pnpm dev:worker` 或启动 `worker` 容器 |
| E2E 与本地其他实例冲突 | 共享端口或数据库互相影响 | 使用 `pnpm dev:api:isolated`、`pnpm dev:worker:isolated` 与 `pnpm test:e2e:isolated` |
| 从旧版本的本地 Postgres 配置升级后，本地初始化出现 Postgres 认证错误 | 现有 Docker volume 里仍保留旧数据库或用户初始化数据 | 先执行一次 `docker compose -f infra/docker-compose.yaml down -v`，再重新运行 `pnpm setup:local` 或 Compose 的 migration 步骤 |
| `db:migrate` 报 `ECONNREFUSED`，但 Postgres 容器已在运行 | 容器刚启动，`pg_isready` 尚未通过 | 等待 Postgres 就绪再执行迁移：`until docker exec infra-postgres-1 pg_isready -U open-claude-tag; do sleep 1; done` |
| `db:migrate` 报 `role "open-claude-tag" does not exist` | Postgres 使用了其他项目的旧 volume 启动，初始化被跳过 | 执行 `docker compose -f infra/docker-compose.yaml down -v` 清空 volume 后重启 |
| `DATABASE_URL` 填 `localhost`，迁移仍然连接失败 | Node.js 17+ 把 `localhost` 解析为 `::1`，但 Docker 只监听 `127.0.0.1` | 将 `DATABASE_URL` 中的 `localhost` 改为 `127.0.0.1` |
| 设置 `OPEN_TAG_DEFAULT_RUNTIME=codex` 后 Worker 仍在使用 `claude_code` | 旧的 Worker 进程仍在运行 | 重启前先执行 `pkill -9 -f "apps/worker"` 杀掉所有旧进程 |
| 报错 `Claude Code returned an error result: Credit balance is too low` | Anthropic 账户余额不足 | 在 `.env` 中添加 `OPEN_TAG_DEFAULT_RUNTIME=codex` 并重启 Worker，或为 Anthropic 账户充值 |

## 设计与决策

完整的设计说明见 [`doc/architecture/technical-design.md`](./doc/architecture/technical-design.md)。

架构深入文档：

- [`doc/architecture/admin-console.md`](./doc/architecture/admin-console.md) — 管理控制台架构
- [`doc/architecture/event-pipeline.md`](./doc/architecture/event-pipeline.md) — 飞书 / 事件流水线
- [`doc/architecture/task-cards.md`](./doc/architecture/task-cards.md) — 任务卡片生命周期
- [`doc/architecture/discussion-orchestration.md`](./doc/architecture/discussion-orchestration.md) — 多 agent 讨论与委派
- [`doc/architecture/admission-scheduler.md`](./doc/architecture/admission-scheduler.md) — admission scheduler
- [`doc/architecture/agent-bot-setup.md`](./doc/architecture/agent-bot-setup.md) — agent / bot 配置
- [`doc/architecture/pr-polling.md`](./doc/architecture/pr-polling.md) — PR 轮询
- [`doc/architecture/worktree-hooks.md`](./doc/architecture/worktree-hooks.md) — worktree hooks
- [`doc/deployment/server-mode.md`](./doc/deployment/server-mode.md) — server + daemon 团队模式

架构决策记录（[`doc/decisions/`](./doc/decisions/README.md)）：

- [ADR-0001](./doc/decisions/0001-lighten-self-dev-flow.md) — 精简 self-dev 流程（分级 + 按需设计 + ADR）
- [ADR-0002](./doc/decisions/0002-document-comment-session-resume.md) — 文档评论 session resume
- [ADR-0003](./doc/decisions/0003-chat-memory-index-detail-store.md) — chat memory 索引与明细存储
- [ADR-0004](./doc/decisions/0004-inbound-message-pipeline-contract.md) — 以 `InboundMessage` 作为入站流水线契约
- [ADR-0005](./doc/decisions/0005-neutral-non-lark-task-dispatch.md) — 为非 lark 入站设的最小独立 neutral 分发路径
- [ADR-0006](./doc/decisions/0006-cross-channel-flag-broker.md) — 经 broker、审计、`isPrivate`-safe 的跨 channel flagging
- [ADR-0007](./doc/decisions/0007-stale-thread-nudge-scanner.md) — 过期线程 nudge 扫描器：审计日志幂等 + 同频道私聊 nudge
- [ADR-0008](./doc/decisions/0008-neutral-ack-in-place-terminal-update.md) — 把 neutral ACK 句柄传下去让 worker 原地更新
- [ADR-0009](./doc/decisions/0009-embedded-postgres-db-provider.md) — DB-provider 抽象 + embedded-Postgres（零-Docker）provider

## 贡献

- [`doc/contributing/pr-guidelines.md`](./doc/contributing/pr-guidelines.md) — PR / MR 内容规范
- [`AGENTS.md`](./AGENTS.md) — 贡献者与 agent 指南（变更流程、验证规则、编码陷阱）
- [`.github/pull_request_template.md`](./.github/pull_request_template.md) — PR 模板

非纯文档变更在 commit 或开 PR 前必须通过 lint、build、单元测试、Postgres 集成测试和 API E2E。
代码、注释、文档和 PR/MR 文本一律用英文。绝不提交凭据。

## License

基于 [MIT License](./LICENSE) 发布。
