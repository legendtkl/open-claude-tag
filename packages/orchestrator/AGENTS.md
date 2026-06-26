# orchestrator — Agent Guide

## MUST

- Only OPS_TASK (slash commands) returns direct replies; all other intents create tasks
- Image messages must preserve the selected runtime while carrying `imageAttachment` for runtime adapters that can consume it

## Key Files

- `intent-classifier.ts` — Keyword-based intent classification (bilingual Chinese/English keywords)
- `orchestrator.ts` — Main dispatch: intent -> task creation or direct reply
- `task-state-machine.ts` — Task state transitions
- `debounce.ts` — Message debounce utility

## Intent Classification Rules

- Code keywords (write, fix, implement...) -> `CODE_TASK` -> runtime: codex
- Short messages (< 20 chars) without keywords -> `CHAT_REPLY` -> runtime: claude_code
- Substring matching: "debug" matches "bug" keyword (known behavior)
- Chinese keywords in `intent-classifier.ts` are intentionally bilingual — do not remove
