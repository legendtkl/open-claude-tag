# OpenClaudeTag — Agent Guide

This is the lightweight entry point for agents working in OpenClaudeTag. Keep it
short: read the relevant rules below first, then open the linked deep docs only
when the task needs them.

## Rule Index

| Area | Read |
| --- | --- |
| Project changes | `## Change Workflow` below (fast-dev vs self-dev tiers, design-on-demand); full workflow in `.codex/skills/self-dev/SKILL.md` |
| Decisions / ADRs | `doc/decisions/README.md` — Architecture Decision Records |
| Verification | `## Verification Rules` below; checklist in `doc/testing/self-dev-checklist.md` |
| Agent operations reference | `doc/agent-guide/operations-reference.md` |
| Server / daemon architecture | `## Server-Centralized Invariants` below; deep dive in `doc/deployment/server-mode.md` |
| Remote server-daemon E2E | `doc/testing/server-daemon-isolated-test.md` |
| Deployment / ops | `doc/deployment/server-mode.md` and `doc/deployment-checklist.md` |
| PR / MR | `doc/contributing/pr-guidelines.md` and `## Commit and PR` below |
| Admin console architecture | `doc/architecture/admin-console.md` |
| Feishu / event pipeline | `doc/architecture/event-pipeline.md` and `doc/architecture/task-cards.md` |

## Project Overview

Monorepo using pnpm workspaces:

- `apps/api` — Fastify HTTP + Feishu WebSocket, event pipeline, task dispatch
- `apps/worker` — pg-boss subscriber, executes tasks through runtime adapters
- `apps/console` — admin console UI
- `apps/daemon` — per-user execution daemon
- `packages/feishu-adapter` — Feishu REST client, event normalizer, card builder
- `packages/orchestrator` — inbound dispatch, task state machine
- `packages/runtime-adapters` — Claude Code and Codex adapters
- `packages/storage` — Drizzle ORM schemas, migrations, DB connection
- `packages/session`, `queue`, `core-types`, `approval`, `memory`, `registry`,
  `observability` — shared platform packages

## Change Workflow

- By default, project iteration changes that modify the repo MUST follow the
  lightweight flow before editing files: confirm a short test-case +
  implementation plan, then work test-first (TDD), verify, and open a PR. This
  applies to code, config, schema, generated artifacts, and process changes.
- Documentation-only changes, read-only investigation, status checks, and
  explicitly requested one-off operational commands that do not modify the repo
  may skip the workflow.
- **Pick the tier by blast radius.** This table is the authoritative routing
  rule; the `self-dev` and `fast-dev` skills defer to it:

  | Tier | Use when the change is… | Flow & gates |
  | --- | --- | --- |
  | **fast-dev** (explicit opt-in) | narrow, low-risk: docs/copy, static assets, a localized console UI tweak, a clearly isolated helper, or a localized test adjustment | `.claude/skills/fast-dev` or `.codex/skills/fast-dev` — focused verification + explicit report of skipped gates |
  | **self-dev** | DB schema, migrations, storage/seed, auth/permissions/ownership, secrets, deployment/release, queue/worker/runtime adapters, Feishu event handling, daemon gateway, or a broad/architectural refactor | `.claude/skills/self-dev` or `.codex/skills/self-dev` — confirmed test cases + implementation plan, TDD, full gates, PR |

- **fast-dev requires an explicit user opt-in** and still needs focused
  verification, explicit reporting of skipped gates, and Browser validation for
  console UI / web changes. If a fast-dev change turns out mid-flight to touch
  any self-dev (tier-2) area, stop and switch to self-dev, stating why.
- **Record real architectural decisions as a concise ADR** under
  `doc/decisions/` (see [`doc/decisions/README.md`](doc/decisions/README.md))
  rather than sprawling design prose — only when the change has a genuine
  architectural decision (a fork between viable options, a reversal of a prior
  decision, or a convention spanning multiple files).
- Work from the current worktree. Do not hand-roll `.env`; if it is missing,
  re-run `tools/worktree/create.sh <name>` from the main repo root.

## Quick Commands

| Task | Command |
| --- | --- |
| Install | `pnpm install` |
| Local bootstrap | `pnpm setup:local` |
| Local doctor | `pnpm doctor:local` |
| Build | `pnpm build` |
| Lint | `pnpm lint` |
| Type check | `pnpm typecheck` |
| Unit tests | `pnpm test` |
| Unit test, one package | `pnpm --filter @open-tag/<pkg> test` |
| E2E, default env | `pnpm --filter @open-tag/api test:e2e` |
| Live runtime e2e (opt-in) | `pnpm test:runtime:e2e` |
| Integration, default env | `pnpm test:integration` |
| DB setup | `pnpm db:setup` |
| Dev API / Worker | `pnpm dev:api` / `pnpm dev:worker` |
| Managed services | `pnpm services:start` / `pnpm services:stop` / `pnpm services:restart` |
| Isolated API / Worker | `pnpm dev:api:isolated` / `pnpm dev:worker:isolated` |
| Isolated E2E | `pnpm test:e2e:isolated` |
| Isolated integration | `pnpm test:integration:isolated` |
| Isolated DB setup | `pnpm db:setup:isolated` |
| Isolated cleanup | `pnpm isolated:ps && pnpm isolated:stop && pnpm isolated:reap && pnpm isolated:purge` |
| Start Postgres | `docker compose -f infra/docker-compose.yaml up postgres -d` |
| Health check | `curl http://localhost:3000/health` |

## Verification Rules

- Non-doc-only changes MUST pass lint, build, unit tests, Postgres integration,
  and API E2E before commit or PR/MR.
- In worktrees, prefer isolated gates:
  `pnpm test:integration:isolated` and `pnpm test:e2e:isolated`.
- `pnpm test:e2e:isolated` expects an isolated API to be running. Prepare
  Postgres and the isolated DB first when needed:
  `docker compose -f infra/docker-compose.yaml up postgres -d` and
  `pnpm db:setup:isolated`.
- After every web UI, page, or console change, start the relevant frontend,
  verify rendered behavior with Browser / browser-use in the in-app browser,
  check browser console errors, and return a screenshot as acceptance evidence.
- Pure documentation-only changes may skip the standard test suite when they
  only modify prose documentation.
- Mixed changes and any executable code, config, schema, or generated artifact
  change still require the normal gates.

## Live Runtime E2E (opt-in)

`pnpm test:runtime:e2e` runs ONE trivial `chat_reply` task through the REAL
Codex and Claude Code runtime adapters (via the real `@openai/codex-sdk` and
`@anthropic-ai/claude-agent-sdk`), asserting each runtime echoes a unique token
and returns usage metrics. It proves the adapters actually execute end-to-end —
beyond the mocked-SDK unit tests.

- **It is NOT part of the default suite.** `pnpm test`, `pnpm -r run test:unit`,
  and the existing `test:e2e` never run it. The test file is named
  `*.runtime-e2e.ts` (not `*.test.ts`), so vitest's default include skips it; it
  only runs via its own `--config vitest.runtime-e2e.config.ts`.
- **When to run:** on-demand, when you have host credentials and want to confirm
  real runtime execution. **Do NOT add it to CI** — it makes REAL, billable
  model calls.
- **Self-skipping per runtime:** a runtime with no credentials is reported as
  skipped (exit 0), not failed. Only a runtime that has credentials, ran, and
  did not return its token fails (exit non-zero).
- **Per-runtime prerequisites** (the operator supplies these via ambient env;
  no credentials or proxy are ever hardcoded in the test):
  - **Codex** — `~/.codex` credentials (or `CODEX_API_KEY` / `OPENAI_API_KEY`)
    and NO proxy (`unset HTTP_PROXY HTTPS_PROXY`).
  - **Claude Code** — `~/.claude/.credentials.json` (or `ANTHROPIC_API_KEY` /
    `ANTHROPIC_AUTH_TOKEN`) and an HTTPS proxy reachable to api.anthropic.com
    (`export HTTPS_PROXY=… HTTP_PROXY=…`). Credentials present but no reachable
    proxy is an operator misconfiguration that surfaces as a failure, not a skip.

  Run each runtime in its own proxy context, e.g. Codex with proxy unset, then
  Claude Code with the proxy exported.

## Local Runtime Notes

- Full task processing requires both API and Worker. Starting only the API
  accepts Feishu events and shows ACK cards, but tasks stay at "Request received".
- Rebuild before restarting after code changes:
  `pnpm build && pnpm services:restart`.
- `services:restart` kills rogue API/Worker processes from the same project dir
  before starting managed services, avoiding duplicate pg-boss workers.
- Do not assume `localhost:3000` or the default local DB are free. Inspect the
  environment, choose an isolated setup when appropriate, and pass `API_URL` to
  tests/debug scripts.
- Worktree isolated instances default to Feishu-disabled. Never point an
  isolated instance at the production Feishu app.

## Server-Centralized Invariants

OpenClaudeTag can run as a central server with per-user daemons. Do not break these:

- The central API owns the only Feishu WSClient; daemons never hold Feishu or DB
  credentials.
- Remote execution flows through the `RuntimeAdapter` boundary. If no machine is
  bound, the local execution path remains unchanged.
- `self_dev` / `/dev` tasks always run server-local.
- A machine-bound task NEVER silently falls back to server-local. Offline
  machine, down gateway, or invalid binding fails fast.
- Console ownership is per-creator and fail-closed: users only see or mutate
  their own Feishu apps, agents, machines, profiles, and chats.
- Isolated instances derive `DAEMON_GATEWAY_PORT` as `<isolated API port> + 2000`
  in `tools/instance/config.mjs`.

For deployment and day-2 ops, read `doc/deployment/server-mode.md`. For the
remote isolated server plus local daemon validation procedure, read
`doc/testing/server-daemon-isolated-test.md`. For long-form agent operations
notes, read `doc/agent-guide/operations-reference.md`.

## Feishu and Event Pipeline Rules

- Image messages MUST preserve the selected runtime. Adapters that receive
  `imageAttachment` and an image downloader should inject the image into the
  runtime workspace.
- Post messages MUST read nested locale content (`zh_cn` / `en_us`) before text
  parsing.
- Feishu terminal task cards must use conservative JSON card schemas on PATCH.
  If a richer card update fails, send a plain-text fallback so tasks do not
  appear stuck at 90%.
- Worktree real `@bot` validation requires a separate dev bot
  (`FEISHU_DEV_APP_ID`, `FEISHU_DEV_APP_SECRET`) and
  `OPEN_TAG_FEISHU_ACCESS=enabled`. Never reuse the primary bot's app id.
- Add the dev bot only to private test chats that do not contain the primary bot.
- Real two-bot Feishu validation is optional and on-demand. Configure only
  gitignored `.env` keys `FEISHU_LOCAL_E2E_BOT1_APP_ID`,
  `FEISHU_LOCAL_E2E_BOT1_APP_SECRET`, `FEISHU_LOCAL_E2E_BOT2_APP_ID`, and
  `FEISHU_LOCAL_E2E_BOT2_APP_SECRET`; run
  `pnpm lark:setup-two-bot-e2e`, then start API/Worker with
  `OPEN_TAG_FEISHU_ACCESS=enabled`.
- Changes to Feishu document-comment handling require a real Feishu document
  E2E before final sign-off when credentials are available. Create a temporary
  docx, grant the dev bot view access, add a local block comment that mentions
  the bot, then add a second reply in the same comment thread mentioning the
  same bot. Confirm the API logs show the same `commentId`, distinct `replyId`s,
  a reused document-comment `sessionId`, and an acknowledgement reaction; confirm
  the Worker logs show `strategy: resume` and reuse of the stored SDK session.
  Record the doc URL, comment ID, session ID, task IDs, and resume evidence in
  the handoff or PR. When using `lark-cli`, derive the reply mention open_id from
  the first comment's returned `person.user_id`; the bot app open_id can fail on
  reply creation with `open_id cross app`.
- For complete new-bot onboarding, WebSocket lifecycle, and document-comment
  E2E validation, use `doc/testing/new-feishu-bot-verification.md`.

## Coding Pitfalls

- ALWAYS use English for code, comments, docs, and PR/MR text.
- ALWAYS call `createQueue()` before `boss.send()` in pg-boss v10.
- ALWAYS use `--env-file=../../.env` with `tsx`; it does not auto-load `.env`.
- NEVER commit credentials. Use `.env` and environment variables.

## Debug Endpoint

Use `POST /debug/simulate` to exercise the full event pipeline without Feishu.
For isolated worktree APIs, replace `localhost:3000` with that instance's
`API_URL`.

```bash
curl -X POST http://localhost:3000/debug/simulate \
  -H 'Content-Type: application/json' \
  -d '{"text":"hello"}'
```

## lark-cli

Install and configure the official Feishu CLI for dev tooling and AI agent
skills when Lark/Feishu operations are needed:

```bash
npm install -g @larksuite/cli
lark-cli config init
npx skills add larksuite/cli -y -g
```

Useful scripts:

| Script | Usage |
| --- | --- |
| `pnpm lark:doctor` | Feishu connectivity health check |
| `pnpm lark:send -- --chat-id oc_xxx --text "hi"` | Send a message |
| `pnpm lark:search -- --query "keyword"` | Search chats by name |
| `bash tools/lark/send-test-card.sh <chat-id> [ack\|running\|done\|failed]` | Test card rendering |
| `bash tools/lark/chat-lookup.sh "keyword"` | Find chat IDs |
| `bash tools/lark/message-history.sh <chat-id> [count]` | View recent messages |

`LarkCli` in `@open-tag/feishu-adapter` is for non-hot-path use only; subprocess
overhead is about 300-500 ms.

## Commit and PR

- Must pass Lint / Build / Unit Test / Postgres Integration Test / E2E Test
  before non-doc-only commits.
- Use `doc/testing/self-dev-checklist.md` as the worktree-safe verification
  checklist for self-dev changes.
- See `doc/contributing/pr-guidelines.md` for PR/MR content guidelines.
- Routine live deployments do not create or push release tags by default.
  Report the deployed commit and verification result instead. Create a
  `release-*` tag only when explicitly requested.
- Open PRs against the configured Git remote. For GitHub:

```bash
gh pr create \
  --title "<type>(<scope>): <summary>" \
  --body "<summary and verification>"
```

- Before merging, check mergeability with `gh pr view <number>` (or the host's
  PR UI). Merge ready PRs after CI is green, preferring a rebase merge and
  removing the source branch.
