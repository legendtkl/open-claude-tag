# feishu-adapter — Agent Guide

## MUST

- `sendMessage()` content must be an object, never `JSON.stringify()`
- Slash commands must be registered in `core-types/src/slash-commands.ts`
- Keep `adaptSdkEvent()` in `apps/api/src/server.ts` in sync when modifying normalizer

## Key Files

- `card-builder.ts` — Feishu card JSON 2.0 construction (task status cards with retry actions)
- `normalizer.ts` — Event normalization, slash command detection, image extraction
- `feishu-client.ts` — Feishu REST API client (sendMessage, updateMessage, downloadImage)
- `feedback.ts` — ThreePhaseFeedback: queued -> running -> completed/failed card updates
- `dedup.ts` — Event deduplication by event_id
- `ws-client.ts` — WebSocket client for Feishu long connection
- `markdown-to-post.ts` — Markdown to Feishu post format conversion

## SDK Format Note

The SDK provides flat events; `adaptSdkEvent()` converts to nested format.
If you modify normalizer, keep `adaptSdkEvent()` in sync.
See `doc/architecture/event-pipeline.md` for details.

## Post Message Parsing

Feishu `post` content is wrapped under locale keys (`zh_cn` / `en_us`).
Read nested locale `content` before extracting text or images.

## sendMessage Content Format

`content` must be an **object**, not a JSON string — the client serializes internally:

```typescript
// CORRECT
await feishuClient.sendMessage('chat_id', chatId, {
  msg_type: 'text',
  content: { text: 'hello' },
} as any);

// WRONG — double serialization, silent failure
content: JSON.stringify({ text: 'hello' })  // BUG!
```

## Card JSON Notes

- Form containers use `"tag": "form"` (NOT `"form_container"` — that returns error 200621)
- Form submit buttons must have `"action_type": "form_submit"` to trigger callbacks with `form_value`
- Cancel/non-form buttons should be placed outside the `form` element in a standard `"tag": "action"` wrapper
- Card action callbacks require `card.action.trigger` configured as **long connection** in the developer console (without this, buttons return error 200340)

## Feishu App Configuration

- App ID: `cli_xxxxxxxxxxxxxxxx`
- Bot open_id: `ou_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`
- Required: Bot capability, `im.message.receive_v1` subscription (long connection), `im:message.*` permissions
- Required: `card.action.trigger` callback (long connection) for interactive card buttons
- Republish app version after any config changes in [Feishu Developer Console](https://open.feishu.cn/app/YOUR_APP_ID)
- Full setup guide: see `README.md` > Feishu App Setup
