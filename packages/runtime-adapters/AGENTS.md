# runtime-adapters — Agent Guide

## MUST

- `ClaudeCodeAdapter` uses `@anthropic-ai/claude-agent-sdk` `query()` — do NOT spawn the `claude` CLI
- `spawn` in the adapter is only for utility processes (git commands), not for Claude invocation

## Credentials (per-agent)

Claude Code credentials are **per-agent**, carried via `agents.runtimeEnv` exactly
like Codex. A `claude_code` agent stores `ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY`
in `runtimeEnv` (required at create time — see `apps/api` `admin-api.ts`). At
execution the adapter injects them as env with precedence **process env →
adapter/global config → per-agent `runtimeEnv` (wins)**. The adapter registers
unconditionally (no global `ANTHROPIC_BASE_URL` gate); global env is only an
optional fallback. A run that resolves no auth token (neither per-agent nor
global) **fails loud** instead of hanging.

## Key Files

- `claude-code-adapter.ts` — ClaudeCode runtime: workspace setup, TASK.md generation, SDK query execution
- `codex-adapter.ts` — Codex runtime adapter
- `runtime-manager.ts` — Runtime selection and orchestration
- `workspace.ts` — Workspace file operations (TASK.md, image downloads)
- `workflow-loader.ts` — Loads task-type-specific workflow prompts at runtime
- `soul-loader.ts` — Loads `soul/SOUL.md`, prepended to every task system prompt
- `worktree-manager.ts` — Git worktree lifecycle management

## Workflows (`workflows/`)

| File | Use Case |
|------|----------|
| `self-dev-common.md` | Shared self-dev flow: plan, TDD, verification, PR |
| `self-dev-claude.md` | Claude-specific review and execution guidance |
| `self-dev-codex.md` | Codex-specific review guidance |
| `external-project-dev.md` | External codebases in isolated worktrees |
| `general-task.md` | Analysis, planning, research, Q&A |

## Image Handling

Runtime adapters use the shared image attachment helper to download images -> `workspace/image.<ext>`.
TASK.md appends `Image: ./image.<ext>`. Codex passes the image path as SDK `local_image` input; Claude Code passes the prepared image as SDK image content. Download failures are non-fatal (warn, proceed text-only).
