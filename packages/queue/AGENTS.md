# queue — Agent Guide

## MUST

- ALWAYS call `createQueue()` before `boss.send()` — pg-boss v10 silently returns null otherwise
- NEVER set `expireInHours` to 24 — strict < 24, use `23`
- Use `singletonKey` to prevent duplicate tasks for the same session

## Key Concepts

- Wraps pg-boss for task queue management
- Queue name constant: `TASK_QUEUE_NAME`
- `createQueue()` must be called in `TaskQueue.start()` before any `send()` calls
