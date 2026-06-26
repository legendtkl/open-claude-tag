# Event Pipeline

## Flow

```
Feishu WS event
  -> MultiFeishuAppRuntime app context
  -> adaptSdkEvent()        # SDK flat -> normalizer nested format
  -> normalizeEvent()        # Uses the receiving app bot_open_id
  -> checkAndRecordEvent()   # Dedup by (feishu_app_id, event_id)
  -> resolveAgentRoute()     # bound bot -> @agent:<handle> -> chat default -> built-in
  -> resolveSession()        # Map chatId -> sessionId
  -> touchSession()          # Update activity timestamp
  -> store message           # Insert into messages with agent_id + feishu_app_id
  -> dispatch:
    +-- command -> handleSlashCommand() -> direct reply
    +-- normal -> handleEvent() (orchestrator)
        +-- OPS_TASK -> direct reply
        +-- all others -> create task with agent_id + feishu_app_id
            -> send initial task card through the receiving app
            -> persist tasks.feedbackMessageId
            -> enqueue -> worker picks up -> AI execution -> PATCH same task card
            +-- image message: selected runtime preserved, imageAttachment in job constraints
               -> selected RuntimeAdapter.prepare() downloads image -> workspace/image.<ext>
               -> TASK.md and SDK input reference the image file for AI analysis
```

## Agent Routing

The internal `agents` row is authoritative. A Feishu bot binding is only the
ingress/egress identity for one enabled Feishu app.

Routing precedence is:

1. Active bot binding for the receiving `feishu_apps.id`.
2. Virtual handle in message text: `@agent:<handle>`.
3. Chat default agent in `chat_configs.default_agent_id`.
4. Built-in `open-claude-tag` agent.

Tasks, user messages, assistant messages, queue jobs, callbacks, retries, and
scheduled tasks carry the resolved `agentId` and `feishuAppId`. Private agents
are rejected before task creation.

## Multi-App Runtime

The API loads all enabled rows from `feishu_apps`, resolves `app_secret_ref`
from environment variables or falls back to the stored `app_secret`, fetches
missing bot info, and starts one dispatcher for each healthy WebSocket app that
is either an environment fallback app or a persisted app with an active bot
binding. Health output reports per-app status without secrets.

Admin app or binding mutations trigger an in-process reload. The API initializes
the new runtime, closes old WebSocket clients, and starts only the event-enabled
apps from the new snapshot. Deleting or unbinding a persisted app therefore
removes its live WebSocket client.

The Worker also loads enabled Feishu apps, using env secret refs or stored
secrets. Feedback for a task with `feishuAppId` must use that exact app client.
The Worker refreshes its client registry from the database before feedback and
forces a refresh when a task references an unknown app. If the app client cannot
be resolved, feedback is skipped with a logged error and does not fall back to
an unrelated bot.

Manual setup and `/agent bind-bot` workflow are documented in
`doc/architecture/agent-bot-setup.md`.

## Backend Delegation

Agents do not communicate by mentioning each other as Feishu bots. Delegation is
an explicit backend relationship:

```
parent task (caller agent)
  -> agent_delegations row
  -> child task (callee agent, delegationDepth=1)
  -> bounded delegationPackage in task constraints
  -> result/error stored back on agent_delegations
```

The delegated child task receives a bounded package containing goal, context
summary, constraints, expected output, caller metadata, and permission scope. It
does not receive the caller agent's SDK session or full message history. MVP
delegation rejects nested depth greater than one.

## Card Action Callback

```
Feishu card action callback
  -> EventDispatcher `card.action.trigger`
  -> validate task-card callback payload
  -> load original task + session + latest task run runtime
  -> create a new task linked via tasks.parentTaskId
  -> reply to the clicked card with a new queued task card
  -> enqueue follow-up job without mutating the original completed/failed card
```

## SDK Format Adaptation

The official `@larksuiteoapi/node-sdk` `EventDispatcher` passes event data in a **flat structure**:

```json
{ "schema": "2.0", "event_id": "...", "message": {...}, "sender": {...} }
```

Our `normalizeEvent()` expects a **nested structure**:

```json
{ "header": { "event_id": "..." }, "event": { "message": {...}, "sender": {...} } }
```

`adaptSdkEvent()` in `apps/api/src/server.ts` bridges this gap. If you change the SDK or normalizer, keep this adapter in sync.

## Image Message Handling

1. `normalizeEvent()` extracts `imageKey` + `imageMessageId` from content JSON `{"image_key": "img_xxx"}`
2. Orchestrator detects image attachments while preserving automatic, explicit, or session runtime selection
3. Default goal: "Please analyze this image" if no text accompanies the image
4. `imageAttachment: { imageKey, messageId }` flows through job queue constraints -> `taskSpec.context`
5. The selected runtime adapter downloads image via `FeishuClient.downloadImage()`, saves to `workspace/image.<ext>` using detected image bytes
6. TASK.md gets `Image: ./image.<ext> (spec.goal)` appended; Codex also receives the path as SDK `local_image` input, and Claude Code receives SDK image content
7. Download failures are non-fatal: logged as warn, task proceeds text-only

Required Feishu permission: `im:message.file:read`

## Intent Classification

`packages/orchestrator/src/intent-classifier.ts` uses keyword matching:

- All non-OPS intents (CHAT_REPLY, CODE_TASK, ANALYSIS, etc.) create tasks for worker/AI processing
- Only OPS_TASK (slash commands) returns direct replies
- Messages with code keywords (write, fix, implement...) -> `CODE_TASK` -> runtime: codex
- Short messages (< 20 chars) without keywords -> `CHAT_REPLY` -> runtime: claude_code
- Note: substring matching means "debug" matches "bug" keyword. This is known behavior.
