# queue — Agent Guide

## MUST

- ALWAYS call `createQueue()` before `boss.send()` — pg-boss v10 silently returns null otherwise
- NEVER set `expireInHours` to 24 — strict < 24, use `23`
- Use `singletonKey` to prevent duplicate tasks for the same session
- `task-queue.ts` custom SQL couples to pg-boss 10.x `pgboss.job` internals; `pg-boss` is pinned to exact `10.4.2`. Do NOT bump it without re-running the integration suite — the `assertPgBossLayout` startup check catches removed/renamed columns and job-state type changes.

## Key Concepts

- Wraps pg-boss for task queue management
- Queue name constant: `TASK_QUEUE_NAME`
- `createQueue()` must be called in `TaskQueue.start()` before any `send()` calls
