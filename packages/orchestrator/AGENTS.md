# orchestrator — Agent Guide

## MUST

- Ops slash commands (`/new`, `/status`, `/session`, `/compact`, `/forget`, `/reset`, `/help`) reaching `handleEvent` return a direct reply (`OPS_TASK`); every other message creates a `CHAT_REPLY` task
- Image messages must preserve the selected runtime while carrying `imageAttachment` for runtime adapters that can consume it

## Key Files

- `orchestrator.ts` — Main dispatch: ops-command short-circuit, otherwise create a task
- `task-state-machine.ts` — Task state transitions
- `debounce.ts` — Message debounce utility

## Dispatch Rules

- There is no per-message keyword intent classifier. `handleEvent` produces only
  `OPS_TASK` (ops slash command → direct reply) or `CHAT_REPLY` (everything else →
  task); the runtime decides its own approach from the goal text.
- `self_dev` is set by the `/dev` slash command and PR polling, never by `handleEvent`.
- `runtimeHint` is always `null` here (`runtime` is resolved downstream); the result's
  `runtime: 'auto'` lets `task-dispatch` preserve the session's persisted runtime.
- `IntentType.ANALYSIS`/`RESEARCH`/`SELF_IMPROVEMENT` remain valid persisted/label
  values (still produced by agent delegation and used by Feishu tracking) but are no
  longer produced from inbound text.
