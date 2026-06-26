# Admin Console

OpenClaudeTag ships a local operator console for managing first-class agents,
Feishu bot bindings, chats, and Feishu task boards without editing YAML or SQL
for common changes.

## Start Locally

Run the API first, then the console:

```bash
pnpm dev:api
pnpm dev:console
```

For an isolated worktree, point the console at the isolated API:

```bash
API_URL=http://localhost:<api-port> pnpm dev:console
```

The console binds to `127.0.0.1` by default. The Vite dev server proxies
`/admin/*` and `/health` to the API.

The admin API is local-only by default. Requests from non-loopback addresses are
rejected unless `OPEN_TAG_ADMIN_TOKEN` is configured and callers pass either
`Authorization: Bearer <token>` or `x-open-claude-tag-admin-token: <token>`.

## Managed Objects

- Agents: routable identities with a stable `name`, human-facing
  `displayName`, description, runtime, and status. Profile rows are
  internal backing configuration and are not exposed as a first-class console
  object.
- Bots: Feishu app registrations and active agent bindings.
- Chats: readable chat display names, linked task board names, observed agent
  activity, runtime, and Feishu jump links.
- Task Boards: Feishu task tracking spaces created by `/chat init`,
  including readable task list names, status counts, and local task drill-downs.

Agent work directories are intentionally not configured on the Agent page. Task
and chat configuration own workdir selection; new sessions fall back to the
system default directory when no task or chat directory is available.

## Secret Boundary

Feishu app secrets can be entered into the local console and stored in
`feishu_apps.app_secret`, or referenced through an environment variable such as
`FEISHU_REVIEWER_APP_SECRET` or `env:FEISHU_REVIEWER_APP_SECRET`. Admin API
responses never return the stored secret value; they expose only
`appSecretRef` and `hasStoredSecret`.

After adding or editing a Feishu app registration, the API process reloads the
multi-app runtime and reconnects WebSocket clients in-process. The Worker
refreshes Feishu clients from the database before task feedback, so app
registration and secret updates do not require a service restart.

If a new stored secret is invalid, the API keeps the previous WebSocket clients
running and logs the reload failure.

## Feishu Jump Actions

Chat rows expose backend-generated Feishu AppLinks:

```text
https://applink.feishu.cn/client/chat/open?openChatId=<chat_id>
```

Task board rows expose a task list AppLink when a tasklist GUID is known:

```text
https://applink.feishu.cn/client/todo/task_list?guid=<tasklist_guid>
```

The frontend renders these links as jump actions and does not construct Feishu
links itself.

## Board Drill-Downs

The admin API enriches task board DTOs with linked tasks from
`feishu_task_links`, joined to local `tasks` and `sessions`. The console groups
those linked tasks by the last synced Feishu tracking status, falling back to the
local task status when no Feishu status has been recorded yet.

Readable names are stored locally:

- `chat_configs.display_name` stores the Feishu chat display name when known.
- `feishu_task_tracking_spaces.name` stores the Feishu task list name when known.

If historical rows do not have names, the API falls back to short IDs and can
infer a chat name from task list names that follow the `<chat name>任务看板`
convention.
