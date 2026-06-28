# Agent Bot Setup

OpenClaudeTag can bind one internal agent to one Feishu app bot. The internal
`agents` row remains authoritative; the Feishu app is the visible bot identity.

## Manual Feishu App Setup

1. Create a Feishu app in the Feishu developer console.
2. Enable bot capability and add required permissions for messaging and card
   updates. Feishu task tracking additionally requires chat-member and task
   scopes. Document-comment mention support is opt-in with
   `OPEN_TAG_FEISHU_DOCUMENT_COMMENTS=enabled` and also requires
   `docs:event:subscribe`, `docs:document.comment:read`, and
   `docs:document.comment:create`.
3. Configure event delivery as WebSocket for the app.
4. Register the app in the local console, or insert/sync a `feishu_apps` row.
   The secret can be stored locally in `app_secret` or referenced from an
   environment variable with `app_secret_ref`.
5. For SQL setup with an environment reference:

```sql
insert into feishu_apps (tenant_key, app_id, app_secret_ref, event_mode, status)
values ('default', 'cli_xxx', 'FEISHU_REVIEWER_APP_SECRET', 'websocket', 'enabled');
```

`app_secret_ref` may also use the `env:NAME` form. The API and Worker resolve it
from process environment.

For SQL setup with a stored local secret:

```sql
insert into feishu_apps (tenant_key, app_id, app_secret_ref, app_secret, event_mode, status)
values ('default', 'cli_xxx', 'stored', '<app_secret>', 'websocket', 'enabled');
```

Admin APIs never return `app_secret`; they expose only `app_secret_ref` and a
boolean storage indicator. Runtime reload is hot: the API reconnects WebSocket
clients after app changes, and the Worker refreshes Feishu clients from the
database before task feedback.

## Agent Registration

Agent manifests live under `registry/agents/*.yaml`. After adding or updating a
manifest, run:

```text
/agent sync
```

Use `/agent list` and `/agent info <handle>` to confirm the agent is active.

## Binding A Bot

Bind an enabled Feishu app to an active agent:

```text
/agent bind-bot <handle> <app_id>
```

Unbind without deleting history:

```text
/agent unbind-bot <handle>
```

Set a chat-level default route for virtual agents:

```text
/agent default <handle>
```

Mutating `/agent` commands require `MANAGE_AGENTS` or owner role.

## Validation

Use debug simulate in an isolated instance:

```bash
curl -X POST "$API_URL/debug/simulate" \
  -H 'Content-Type: application/json' \
  -d '{
    "text": "hello",
    "feishuAppId": "<feishu_apps.id>",
    "expectedAgentHandle": "reviewer",
    "skipTaskExecution": true
  }'
```

For virtual handle routing through the default bot:

```bash
curl -X POST "$API_URL/debug/simulate" \
  -H 'Content-Type: application/json' \
  -d '{
    "text": "review this",
    "virtualAgentHandle": "reviewer",
    "expectedAgentHandle": "reviewer",
    "skipTaskExecution": true
  }'
```

Do not place the primary bot and a dev bot in the same validation chat. Both
apps would receive the same Feishu message and process it independently.

For a complete new-bot verification flow, including one-click permission
approval, active binding, WebSocket lifecycle checks, document ACL setup,
full-document comments, and referenced text comments, see
`doc/testing/new-feishu-bot-verification.md`.
