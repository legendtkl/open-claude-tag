# Review Request Comment Polling

## Overview

`PrPollingService` (`apps/api/src/pr-polling-service.ts`) runs in the API process on a configurable interval (default 5 min, override via `PR_POLLING_INTERVAL_MS` env var). It supports GitHub PR URLs stored in `sessions.prUrl`.

## Behavior

- On each tick, queries all sessions where `sessions.prUrl IS NOT NULL`.
- Skips sessions whose PR is already merged or closed (uses `getPrState()` from `worktree-cleanup.ts`).
- Fetches new issue-level and inline review comments via `gh api` for GitHub (capped at 20 most recent per cycle).
- Optimistically updates `sessions.prLastPolledAt` **before** enqueueing to prevent duplicate processing.
- Enqueues a `SELF_DEV` task whose goal instructs the agent to analyse comments, apply fixes, push, and reply on the review request.
- Inherits the latest task's `agentId` / `feishuAppId` / `runtimeHint` so worker-side runtime selection can use the routed agent profile and `agent_session_states`. If no agent is associated, it falls back to the legacy session runtime state.
- `singletonKey: sessionId` in pg-boss prevents a second task from starting if one is already queued or running.

## Database

`sessions.prLastPolledAt` — nullable timestamp column added in migration `0004`. Existing sessions with `prUrl` will have `null`; on first poll, all existing unresolved comments are treated as new.
