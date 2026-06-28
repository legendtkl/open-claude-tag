# OpenClaudeTag

OpenClaudeTag 是一个运行在团队聊天里的 vendor-neutral 工程助手。orchestrator 核心说的是一套 neutral 的消息契约，因此有两个可插拔的轴：聊天所在的 **channel**，以及执行任务的 **runtime**。它接收一条聊天消息，经异步任务流水线分发，通过 runtime adapter（Claude Code 或 Codex）执行，并把进度回传到聊天里。当前 Lark/飞书 是功能完整的 channel；Slack 是一个可用的第二 channel（入站任务分发 + 出站发送），其 OAuth、多 workspace 安装、worker 侧完成态回传、真实端到端回复仍在推进中。

如果你要参与仓库开发，也请阅读 [AGENTS.md](./AGENTS.md)。

要让任务端到端执行，`api` 和 `worker` 必须同时运行。只启动 `api` 只能收消息并返回 ACK 卡片，任务会停在 `Request received`。

## 可插拔架构（两个轴）

channel adapter 把平台事件标准化成 neutral 的 `InboundMessage`（`packages/channel-core` 定义 `Channel` 契约）；runtime adapter 在一个 descriptor 驱动的注册表后执行任务（`packages/runtime-adapters`）。orchestrator 核心既不指名厂商也不指名 runtime（见 [`doc/decisions/0004`](./doc/decisions/0004-inbound-message-pipeline-contract.md)）。

| 轴 | 选项 | 状态 |
| --- | --- | --- |
| Channel | Lark / 飞书 | 完整 —— 事件、交互卡片、线程化反馈、表情反馈、审批、飞书任务跟踪（`LarkChannel`）。 |
| Channel | Slack | 入站分发 + 出站发送（`SlackChannel`）。经签名校验的 `POST /slack/events` 会写入 observation memory；配置 `SLACK_BOT_USER_ID` 且 @ 了 bot 时经 neutral 路径分发任务；当同时设置了 `SLACK_BOT_TOKEN` 时再通过 Slack Web API 回 ACK。OAuth / 多 workspace 安装、Socket Mode、worker 侧完成态回传，以及 Lark 专有扩展（slash 命令树、缓冲、线程/引用富化、agent 路由）尚未实现（见 [`doc/decisions/0005`](./doc/decisions/0005-neutral-non-lark-task-dispatch.md)）。 |
| Runtime | Claude Code | 完整 —— 默认 runtime。 |
| Runtime | Codex | 完整。 |
| Runtime | Coco (TRAE CLI) | 可选 —— 仅当 worker 主机上能解析到 `coco` 二进制时才注册。 |

Slack 路径有单元测试和基于 Postgres 的集成测试覆盖（通过同一个 vendor-clean 核心端到端驱动真实路由，Slack sender 用 stub 注入）；用真实 workspace 凭据的端到端 Slack 验证尚未跑过。

## 个人快速体验（零-Docker）

在自己的机器上**无需 Docker** 跑起整个栈：自动内置一个 embedded PostgreSQL，并用本地 onboarding 向导引导你连接飞书、创建第一个 agent。只需 Node.js 20+ 和 pnpm（`corepack enable`）；真实执行任务需宿主机有 Claude Code（`~/.claude` / `ANTHROPIC_*`）或 Codex（`~/.codex`）凭证。

```bash
corepack enable
pnpm install        # embedded Postgres 二进制从公共 npm 拉取
pnpm build          # 构建全部包（含 launcher CLI）
pnpm personal:up    # 内置 Postgres → migrate + seed → 起 API + Worker + Console → 自动开浏览器
```

`pnpm personal:up` 会启动一个 embedded PostgreSQL（默认 `OPEN_TAG_DB_MODE=embedded`）、执行 migration、在 `127.0.0.1` 起 API + Worker + Console、等待 `/health`，并打开 onboarding 向导。然后跟着向导走：**连接飞书 → 创建 agent → 绑定 → 上线**。

| 命令 | 作用 |
| --- | --- |
| `pnpm personal:up` | 启动整个栈（幂等） |
| `pnpm personal:status` | 查看 DB / API / Worker / Console + `/health` |
| `pnpm personal:down` | 停止全部（含 embedded Postgres） |

用 `OPEN_TAG_DB_MODE` 选数据库后端：`embedded`（默认，免 Docker）、`docker`（用 `infra/docker-compose.yaml`）、`external`（`DATABASE_URL` 指向你自己的 Postgres）。embedded 数据目录在 `~/.open-claude-tag/pgdata`。发布到 npm 后，同一启动器即 `npx open-claude-tag up`（别名 `oct up`）。

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

## 选择部署路径

- 个人零-Docker 体验（`pnpm personal:up`）：最适合一条命令在本机起整套栈并跟向导接入飞书。
- 本地源码安装：最适合贡献代码、调试和日常开发。
- 单机 Docker 部署：最适合快速自托管试用。
- 中心化部署(团队模式):一次部署服务全团队,用户机器按需通过 `@open-tag/daemon` 配对为执行节点。参见 `doc/deployment/server-mode.md`,在控制台 Machines 页面生成配对令牌。
- 隔离 worktree 模式：最适合多个分支或多个 worktree 并行运行。

## 前置依赖

| 依赖项 | 用途 | 说明 |
| --- | --- | --- |
| Node.js 20+ | 所有安装路径 | 当前仓库使用 `pnpm@9.15.4`。 |
| pnpm | 所有源码工作流 | 先执行 `corepack enable`。 |
| Docker / Docker Compose | `OPEN_TAG_DB_MODE=docker` 和 Docker 部署 | 个人启动器（`pnpm personal:up`）内置 embedded Postgres，**无需 Docker**。 |
| 飞书自建应用 | 真实飞书消息处理 | API 连接飞书所必需。 |
| Runtime 凭证 | 真实任务执行 | Claude Code 使用 `ANTHROPIC_*`；Codex 使用 `~/.codex/config.toml`。 |
| PostgreSQL 客户端工具（`psql`、`createdb`、`dropdb`） | 仅隔离 worktree 命令需要 | `pnpm db:setup:isolated` 及其他隔离生命周期命令会用到。 |
| `lark-cli` | 可选飞书开发工具 | 便于执行 `pnpm lark:doctor`、发送测试消息和查找 chat。 |

对于源码开发，macOS 或 Linux 最省事。Windows 建议使用 WSL2，因为仓库中的部分脚本依赖类 Unix shell 环境。

## 必填配置

从仓库内置示例开始：

```bash
cp .env.example .env
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

## 本地源码安装

按上面的 TL;DR 执行后，在两个终端分别运行 `pnpm dev:api` 和 `pnpm dev:worker`。

常用补充检查：

- `pnpm setup:local` 会启动本地 Postgres、执行 migration 和 seed，并构建整个仓库。
- `pnpm doctor:local` 会检查本地前置依赖，并明确告诉你还缺哪些凭证。
- `pnpm lark:doctor` 会校验本地 Feishu CLI 连通性。
- `pnpm --filter @open-tag/api test:e2e` 会执行默认 API E2E gate。

## 单机 Docker 部署（Experimental）

仓库提供了 `infra/docker-compose.yaml`，可在单机上启动 `postgres`、`api` 和 `worker`。

这条路径主要用于快速试用和单机自托管，目前仍属于 Experimental，不适合直接作为生产级部署方案。它还没有覆盖高可用、滚动升级、托管密钥或零停机发布等生产能力。

在 Docker 模式下，镜像会安装 `claude` 和 `codex` CLI。`api` / `worker` 容器会把宿主机的 `${HOME}/.claude` 和 `${HOME}/.codex` 挂载到容器内的 `/root/.claude` 和 `/root/.codex`，这样 runtime 可以直接复用宿主机已有的认证、配置、session 和 skills。示例 Compose 也会把通用任务默认 runtime 设为 `codex`，这样挂载好 Codex 配置后，新容器可以直接执行任务。
Compose 同时会把仓库根目录的 `.env` 注入到 `api` 和 `worker`，再把 `DATABASE_URL` 覆盖为 Compose 内部的 `postgres` 服务地址。

```bash
cp .env.example .env

docker compose -f infra/docker-compose.yaml up --build -d postgres
docker compose -f infra/docker-compose.yaml run --rm api pnpm db:migrate
docker compose -f infra/docker-compose.yaml run --rm api pnpm db:seed
docker compose -f infra/docker-compose.yaml up --build -d api worker

curl http://localhost:3000/health
```

说明：

- 当前 Compose 仅面向单机，并且仍应视为 experimental。它不包含反向代理、TLS 终止或密钥管理。
- `docker compose up` 不会自动执行 migration；必须在启动 `api` 和 `worker` 前手动执行。
- Docker 模式只能修改容器文件系统以及显式挂载的路径，例如 `${HOME}/.claude` 和 `${HOME}/.codex`。如果没有额外挂载，容器不能修改宿主机上的任意项目目录。
- 如果只启动 `api`，请求虽然会被接收，但队列中的任务不会真正执行。

## 隔离 Worktree 开发

当你同时运行多个 worktree 或本地分支时，优先使用仓库内置的隔离命令，不要手动复用默认端口或数据库。

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

详细验证顺序见 [doc/testing/self-dev-checklist.md](./doc/testing/self-dev-checklist.md)。

## Worktree Hook

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

## 飞书应用配置

OpenClaudeTag 通过企业自建应用连接飞书。请在 [飞书开发者后台](https://open.feishu.cn/app) 中按下面的清单完成配置：

1. 创建一个 **企业自建应用**。
2. 在 **凭证与基础信息** 中复制 `App ID` 和 `App Secret` 到 `.env`。
3. 打开 **机器人** 能力。
4. 在 **事件与回调 > 事件配置** 中选择 **长连接**，并订阅 `im.message.receive_v1`。
5. 在 **事件与回调 > 卡片回调配置** 中选择 **长连接**，并订阅 `card.action.trigger`。
6. 在 **权限管理与授权** 中添加下面列出的 scopes。
7. 在 **版本管理与发布** 中发布新版本。

必需 scopes：

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

重要：每次修改权限、事件或回调之后，都要重新发布版本，否则配置不会生效。缺少 `card.action.trigger` 时，交互卡片操作会返回错误码 `200340`。

## 飞书卡片兼容性说明

飞书交互卡片支持两种 JSON 结构：

- JSON 1.0 使用顶层 `elements` 数组，兼容性最好。
- JSON 2.0 使用 `schema: "2.0"` 和 `body.elements`，要求较新的飞书客户端。

对于表单卡片：

- 使用 `"tag": "form"`，不要使用 `"form_container"`。
- 表单内部的提交按钮必须使用 `"action_type": "form_submit"`。
- 表单外部按钮仍然要放在标准 `"tag": "action"` 容器里，并通过 `action.value` 传值。

示例：

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
        { "tag": "button", "name": "submit", "text": { "tag": "lark_md", "content": "Submit" }, "type": "primary", "action_type": "form_submit", "value": {} }
      ]
    },
    {
      "tag": "action",
      "actions": [
        { "tag": "button", "text": { "tag": "plain_text", "content": "Cancel" }, "value": {} }
      ]
    }
  ]
}
```

## 使用方式

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

## 使用 Claude Code 辅助部署

使用内置的 `/deploy-local` skill，可以在对话中完成全流程引导部署。在仓库根目录启动 Claude Code 会话后执行：

```
/deploy-local
```

Claude Code 会依次运行 `pnpm doctor:local`、引导你配置 `.env`、启动 Postgres、执行迁移、拉起服务，并逐步指引你完成飞书开发者后台配置。它会自动处理以下常见问题：

- **5432 端口被其他 Docker 容器占用** — 先停止冲突容器，再启动 Compose 的 Postgres 服务。
- **pgdata volume 是其他项目的残留** — 执行 `docker compose down -v` 重建 volume，确保 `open-claude-tag` 用户被正确创建。
- **`DATABASE_URL` 使用 `localhost` 在 Node.js 17+ 失败** — Node 默认把 `localhost` 解析为 `::1`（IPv6），但 Docker 只绑定 `127.0.0.1`；改用 `127.0.0.1` 即可。
- **多个旧 Worker 进程残留** — 按名称杀掉所有匹配进程后再启动新的，避免旧进程继续消费任务。
- **Runtime 选择** — 如果 Anthropic API 余额不足，在 `.env` 中设置 `OPEN_TAG_DEFAULT_RUNTIME=codex` 并重启 Worker；也可在工作目录确认卡片中按任务选择 runtime。

本地开发不需要公网地址或内网穿透。OpenClaudeTag 使用飞书 WebSocket 长连接，服务主动连接飞书，不需要配置 Webhook URL。

## 故障排查

| 现象 | 原因 | 修复方式 |
| --- | --- | --- |
| 卡片按钮返回 `200340` | 未配置卡片回调 | 在 **卡片回调配置** 中以 **长连接** 方式添加 `card.action.trigger` |
| 卡片创建返回 `200621`，并提示 `not support tag: form_container` | 卡片 tag 错误 | 改为使用 `"tag": "form"` |
| Bot 收不到消息 | 没有订阅事件 | 在 **事件配置** 中以 **长连接** 方式添加 `im.message.receive_v1` |
| 改动没有生效 | 应用版本没有重新发布 | 修改配置后重新创建并发布新版本 |
| 消息已 ACK，但任务一直不结束 | Worker 没启动 | 启动 `pnpm dev:worker` 或 `worker` 容器 |
| 从旧的 `legacy` 默认值升级后，本地初始化出现 Postgres 认证错误 | 现有 Docker volume 里仍保留旧数据库/用户初始化数据 | 先执行一次 `docker compose -f infra/docker-compose.yaml down -v`，再重新运行 `pnpm setup:local` 或 Compose 的 migration 步骤 |
| `db:migrate` 报 `ECONNREFUSED`，但 Postgres 容器已在运行 | 容器刚启动，`pg_isready` 尚未通过 | 等待 Postgres 就绪再执行迁移：`until docker exec infra-postgres-1 pg_isready -U open-claude-tag; do sleep 1; done` |
| `db:migrate` 报 `role "open-claude-tag" does not exist` | Postgres 使用了其他项目的旧 volume 启动，初始化被跳过 | 执行 `docker compose -f infra/docker-compose.yaml down -v` 清空 volume 后重启 |
| `DATABASE_URL` 填 `localhost`，迁移仍然连接失败 | Node.js 17+ 把 `localhost` 解析为 `::1`，但 Docker 只监听 `127.0.0.1` | 将 `DATABASE_URL` 中的 `localhost` 改为 `127.0.0.1` |
| 设置 `OPEN_TAG_DEFAULT_RUNTIME=codex` 后 Worker 仍在使用 `claude_code` | 旧的 Worker 进程仍在运行 | 重启前先执行 `pkill -9 -f "apps/worker"` 杀掉所有旧进程 |
| 报错 `Claude Code returned an error result: Credit balance is too low` | Anthropic 账户余额不足 | 在 `.env` 中添加 `OPEN_TAG_DEFAULT_RUNTIME=codex` 并重启 Worker，或为 Anthropic 账户充值 |
