# Task Feedback Cards

## Lifecycle

Task lifecycle feedback uses a single Feishu task card message per task.

1. The API sends the initial card via `ThreePhaseFeedback.sendAck()` after `task_created`, using the Feishu client for the task's `feishuAppId`.
2. The returned Feishu message ID is persisted on the task row in `tasks.feedbackMessageId`.
3. The task row stores ownership metadata in `tasks.agentId` and `tasks.feishuAppId`.
4. The task row also tracks feedback metadata via `tasks.feedbackCardType`, `tasks.feedbackState`, and `tasks.feedbackUpdatedAt`.
5. The worker reuses the same message ID from queue constraints to PATCH the card for running, completed, and failed states through the same app identity.
6. Completed and failed task cards include JSON 2.0 callback buttons for `Retry` and `Run with Codex`.
7. Clicking a task-card action resolves the original task's app identity, creates a fresh task and fresh queued card, and leaves the original task card immutable.

Cards are built with Feishu card JSON 2.0 structure in `packages/feishu-adapter/src/card-builder.ts`.

## Agent-Aware Ownership

Task cards are owned by the agent that created the task. The API stores
`agentId` and `feishuAppId` on the task, and queue jobs repeat both fields in
job data and constraints. Retries, runtime-switch retries, workdir
confirmations, and scheduled tasks preserve that ownership.

The Worker resolves the feedback client from `feishuAppId`. If the app client is
missing, the Worker logs the failure and skips the feedback operation instead of
using the primary bot. This prevents one agent's card from being patched by a
different Feishu bot.

Delegated backend child tasks do not automatically send user-facing cards. They
carry a bounded `delegationPackage` in constraints and return result or failure
to the caller through `agent_delegations`.

## Worker Workflows

The worker loads task-type-specific prompts at runtime:

| Workflow                 | File                                | Use Case                                               |
| ------------------------ | ----------------------------------- | ------------------------------------------------------ |
| Self-dev common          | `workflows/self-dev-common.md`      | Shared self-dev flow: plan, TDD, verification, PR      |
| Self-dev Claude appendix | `workflows/self-dev-claude.md`      | Claude-specific self-dev review and execution guidance |
| Self-dev Codex appendix  | `workflows/self-dev-codex.md`       | Codex-specific self-dev review guidance                |
| External project dev     | `workflows/external-project-dev.md` | Developing external codebases in isolated worktrees    |
| General task             | `workflows/general-task.md`         | Analysis, planning, research, Q&A                      |

The platform soul (`soul/SOUL.md`) is prepended to every task's system prompt.
For agent-owned tasks, the agent profile prompt and style prompt are appended
before the workflow-specific prompt. Runtime state and SDK session IDs are
stored per `(agentId, sessionId)` in `agent_session_states`; legacy tasks
without `agentId` continue to use the `sessions` row.
