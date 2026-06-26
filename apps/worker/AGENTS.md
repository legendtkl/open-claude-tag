# worker — Agent Guide

## Key Files

- `main.ts` — Worker entry point, pg-boss subscriber, task execution loop
- `agent-workdir.ts` — Pure `session → chat → env` task-workdir resolver
- `session-persistence.ts` — Session state persistence after task completion

## Behavior

- Subscribes to pg-boss queue, picks up tasks, runs via runtime adapters
- Loads workflow prompts from `packages/runtime-adapters/workflows/`
- Prepends `soul/SOUL.md` to every task system prompt
- Updates task feedback card (running -> completed/failed) using `tasks.feedbackMessageId`
- Reuses Feishu message ID from queue constraints for card PATCH

## Working directory resolution

- A task's cwd is resolved per task (dynamic) with precedence **`sessions.adhocWorkDir`
  (session) → `chat_configs.defaultWorkDir` (chat) → `OPEN_TAG_DEFAULT_WORKDIR` (env)**.
  A directory confirmed for the current turn (`constraints.confirmedWorkDir`) overrides all.
- The session-level binding is shared across every agent in a session, so a workdir bound by
  one agent is reused by the others. Resolved workdirs persist to `sessions.adhocWorkDir`.
- When nothing resolves, an agent run falls back to a stable per-agent home
  `~/.open-claude-tag/agents/<agentId>` (base configurable via `OPEN_TAG_HOME`, default
  `~/.open-claude-tag`) instead of the `/tmp` scratch. `WORKSPACES_ROOT` scratch also defaults
  under `~/.open-claude-tag/workspaces`.
- `agents.defaultWorkDir` is NOT part of this chain. self_dev / `/dev` tasks are not redirected.
- Remote dispatch: when a machine takes the task, the DAEMON resolves the workdir on its own
  filesystem from `workdirHints` (incl. the per-agent home fallback via `workdirHints.agentId`,
  feature-gated on `agent_home`). The worker MUST NOT materialize server-local worktrees or agent
  homes for remote runs — it only picks the display path for the task card.

## MUST

- ALWAYS call `createQueue()` before `boss.send()` (pg-boss v10 requirement)
- Use `expireInHours: 23` not `24` (pg-boss strict < 24)
