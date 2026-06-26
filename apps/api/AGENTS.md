# api — Agent Guide

## MUST

- Run the API E2E gate after every change: use `pnpm --filter @open-tag/api test:e2e` in the default environment, and `pnpm test:e2e:isolated` in worktrees as the safe wrapper for the same gate
- Follow `doc/testing/self-dev-checklist.md` for the full verification order
- Use `--env-file=../../.env` with tsx (does not auto-load `.env`)

## Key Files

- `server.ts` — Fastify HTTP server, Feishu WS connection, `adaptSdkEvent()`, event dispatch
- `slash-command-handler.ts` — Slash command validation, routing, ACK responses
- `slash-command-help.ts` — Help text generation for slash commands
- `task-dispatch.ts` — Task creation and queue dispatch
- `card-action-handler.ts` — Feishu card action callbacks (retry, run with codex)
- `pr-polling-service.ts` — Background PR/MR comment polling (configurable via `PR_POLLING_INTERVAL_MS`)
- `pr-comment-fetcher.ts` — PR/MR comment fetching via `gh api` (GitHub) or the configured host's CLI
- `worktree-cleanup.ts` — Worktree cleanup, `isPrMerged()` check

## Debug Endpoint

`POST /debug/simulate` — inject events without Feishu. See root AGENTS.md.

## Feishu Access Gate

`server.ts` decides at startup whether to open the Feishu WSClient:

| `INSTANCE_ROLE` | `OPEN_TAG_FEISHU_ACCESS` | Result |
|---|---|---|
| `primary` | unset / `enabled` | live |
| `primary` | `disabled` | disabled |
| `isolated` | unset / `disabled` | disabled (default) |
| `isolated` | `enabled` | live (dev-bot opt-in) |

`apps/worker/src/main.ts` mirrors the same logic. Both apps must agree, otherwise the worker would try to PATCH cards that the API never registered (or vice versa).

For dev-bot setup and rationale see root AGENTS.md "Worktree Feishu Validation".

## Slash Commands

Definitions centralized in `packages/core-types/src/slash-commands.ts` — the
`ownerOnly` flags there are the source of truth (currently `/chat`, `/project`,
`/schedule`, `/add-bot`, `/clean-task`, `/merge-pr`). The worktree subcommands
`/session worktrees` and `/session clean` are owner-only at subcommand level
inside `slash-command-handler.ts` (OPEN_ACCESS bypass mirrors the dispatcher
gate).
