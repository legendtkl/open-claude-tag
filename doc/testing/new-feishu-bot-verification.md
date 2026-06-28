# New Feishu Bot Verification

Use this runbook when creating a new Feishu app bot, binding it to a OpenClaudeTag
agent, or validating real document-comment mention intake.

## Preconditions

- Use a dedicated dev or local E2E Feishu app. Do not reuse the production app
  from an isolated worktree.
- Run API and Worker from the same OpenClaudeTag instance and database.
- Set `OPEN_TAG_FEISHU_ACCESS=enabled` only for the validation run.
- Authenticate `lark-cli` as a user that can access the target document:

```bash
lark-cli doctor
lark-cli auth login --scope "docs:document.comment:read"
lark-cli auth login --scope "docs:document.comment:create"
```

If a command returns a missing-scope error, follow the `lark-cli` hint for the
user or bot identity in use. Bot app scopes must be approved in the Feishu
developer console and the app must be published or reinstalled as required by
Feishu.

## App Capability And Permission Checklist

The Feishu app must have:

- Bot capability enabled.
- Event delivery set to WebSocket.
- Message receive, send, card update, reaction, and chat metadata permissions
  required by the default OpenClaudeTag permission inventory.
- Chat member permission (`im:chat.members:read`) when Feishu task tracking is
  enabled.
- Document comment permissions:
  - `docs:event:subscribe`
  - `docs:document.comment:read`
  - `docs:document.comment:create`
- The `drive.notice.comment_add_v1` event subscription.

Document-comment permissions and event subscription are checked and auto-ensured
only when `OPEN_TAG_FEISHU_DOCUMENT_COMMENTS=enabled`. The personal quick-start
bot-message flow can pass with the default message-only permission inventory.

Use the console "one-click Feishu bot" setup or the Feishu app permission check
from the console. The generated permission-apply URL should include the
document-comment scopes above when document-comment support is enabled and they
are missing. The permission check covers application scopes only; it does not
prove that event subscription, app publishing, installation, bot availability, or
document ACLs are complete.

## Local Two-Bot Seed Path

For local or isolated same-topic validation, put only test bot credentials in
the gitignored `.env`:

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

Prepare the isolated database and seed both apps, agents, and active bindings:

```bash
pnpm db:setup:isolated
pnpm lark:setup-two-bot-e2e
```

Start the services with Feishu access enabled:

```bash
OPEN_TAG_FEISHU_ACCESS=enabled pnpm dev:api:isolated
OPEN_TAG_FEISHU_ACCESS=enabled pnpm dev:worker:isolated
```

## Console Registration Path

Use this path for a newly created Feishu app:

1. Create or register the Feishu app from the console Feishu Apps page.
2. Run the permission check.
3. If required permissions are missing, open the generated permission-apply URL
   and approve the missing scopes in the Feishu developer console.
4. Publish or reinstall the Feishu app if Feishu requires it.
5. Create or choose an active OpenClaudeTag agent.
6. Bind the Feishu app to that agent from the console Agents or Feishu Apps
   workflow.

Registration alone should not start a persisted app WebSocket. A persisted app
should become event-enabled only after it has an active bot binding.

## WebSocket Lifecycle Checks

Set `API_URL` to the instance under test:

```bash
export API_URL=http://127.0.0.1:4999
export FEISHU_APP_ID=cli_xxx
```

Before binding the app, confirm that the app exists but is not connected:

```bash
curl -s "$API_URL/health" |
  jq '.feishu.apps[] | select(.appId == env.FEISHU_APP_ID) |
    {appId, botName, botOpenId, eventMode, status, wsStatus, hasActiveBotBinding}'
```

Expected result before binding:

```json
{
  "eventMode": "websocket",
  "status": "healthy",
  "wsStatus": "disabled",
  "hasActiveBotBinding": false
}
```

After binding, the same health query should show:

```json
{
  "eventMode": "websocket",
  "status": "healthy",
  "wsStatus": "live",
  "hasActiveBotBinding": true
}
```

After unbinding or deleting the Feishu app from the console, health should no
longer show a live WebSocket for that app. Deleting the app removes active bot
bindings and disables the persisted app row, then the admin mutation reloads the
runtime and stops stale WebSocket clients.

API logs should include runtime reload and WebSocket lifecycle messages around
the mutation. The health response is the source of truth for teardown because
normal WebSocket close is not logged as a separate success line.

```text
Reloading Feishu app runtime
Feishu app runtime reloaded
Feishu WSClient starting...
Skipping Feishu WSClient for app without active bot binding
```

## Document Access Setup

Resolve a wiki URL to the underlying file token and type:

```bash
export DOC_URL="https://your-org.feishu.cn/wiki/<wiki-node-token>"
export DOC_TOKEN="$(lark-cli wiki +node-get --as user --node-token "$DOC_URL" --jq '.data.obj_token' | tail -n 1)"
export DOC_TYPE="$(lark-cli wiki +node-get --as user --node-token "$DOC_URL" --jq '.data.obj_type' | tail -n 1)"
```

If the document is private, add the bot open ID as a document collaborator. This
is a document ACL step; application scopes alone do not grant access to a user's
document.

```bash
export BOT_OPEN_ID=ou_xxx

lark-cli drive permission.members create --as user \
  --token "$DOC_TOKEN" \
  --type "$DOC_TYPE" \
  --data "$(jq -nc --arg member "$BOT_OPEN_ID" \
    '{member_id:$member, member_type:"openid", perm:"view", type:"user"}')" \
  --yes \
  --json
```

## Full-Document Comment E2E

Create a full-document comment that mentions the bot:

```bash
export MARKER="CC-DOC-COMMENT-E2E-$(date +%s)"

COMMENT_PAYLOAD="$(jq -nc \
  --arg bot "$BOT_OPEN_ID" \
  --arg marker "$MARKER" \
  '{file_type:"docx", reply_elements:[
    {type:"mention_user", mention_user:$bot},
    {type:"text", text:(" " + $marker + " verify document comment intake")}
  ]}')"

lark-cli drive file.comments create_v2 --as user \
  --file-token "$DOC_TOKEN" \
  --data "$COMMENT_PAYLOAD" \
  --json
```

Expected API evidence:

- `Received Feishu document comment event`
- `Document comment task enqueued`
- `Document comment ack reaction added`

Expected Worker evidence:

- The task starts under the agent bound to the receiving app.
- The final result is delivered through the Feishu Drive comment reply API.
- If Feishu rejects direct replies for a full-document comment section with
  `1069302`, the Worker creates a new full-document comment mentioning the
  requester.

Read back comments and confirm the marker and final response:

```bash
lark-cli drive file.comments list --as user \
  --file-token "$DOC_TOKEN" \
  --file-type "$DOC_TYPE" \
  --user-id-type open_id \
  --need-reaction \
  --json
```

## Referenced Text Comment E2E

The Drive comment create API can create a full-document comment or a block
anchor, but it does not precisely simulate selecting a text range such as
`industry research` in the Feishu document UI. Validate quoted or referenced
text comments through the real document page:

1. Open the document URL as the same user used for validation.
2. Select the target text, for example `industry research`.
3. Click the comment action next to the selection.
4. Mention the bot and include a unique marker:

   ```text
   @OpenClaudeTagBot1 CC-DOC-QUOTE-E2E-<timestamp> verify quoted comment intake
   ```

5. Send the comment.
6. Confirm the same API and Worker evidence as the full-document comment E2E.
7. Confirm the visible task acknowledgement reaction appears on the source
   comment reply.
8. Confirm the final response appears in the same comment thread, or as the
   fallback full-document comment if Feishu disables replies for that section.

Use Chrome or the Feishu desktop client for this step when the goal is to prove
selected-text behavior. Close the browser tab after the check.

## Chat Mention Smoke Test

For a normal chat mention smoke test, use a private validation chat that
contains the test bot but not the production bot:

```text
@OpenClaudeTagBot1 CC-CHAT-E2E-<timestamp> reply with the current agent handle
```

Expected evidence:

- The API receives the message under the test app ID.
- The task is routed to the agent bound to that app.
- Task card updates are sent by the same bot identity.

Do not add the production bot, shared devbox bot, and local test bot to the same
private validation chat unless the test specifically needs multi-bot behavior.
Each Feishu app in the chat receives the same message and can process it
independently.

## Pass Criteria

The new bot is verified when all of these are true:

- Permission check passes or all missing scopes have been approved and the app
  has been republished or reinstalled.
- The app does not hold a live WebSocket before binding.
- The app holds a live WebSocket after binding to an active agent.
- Unbinding or deleting the app stops the live WebSocket.
- Full-document comment mention creates a task, gets an immediate acknowledgement
  reaction, and receives a final document comment response.
- Referenced text comment mention follows the same task and response path.
- The queued task prompt includes the source Feishu document URL and tells the
  agent that Lark-related skills can read the document.
- Worker output uses the same Feishu app client that received the event.
