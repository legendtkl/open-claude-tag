# Worktree Pre/Post Hooks

## Overview

`packages/runtime-adapters/src/worktree-hooks.ts` exposes `runWorktreeHook(phase, ctx)`, a lifecycle extension point that runs a shell script when a session worktree is created or removed. Hooks let operators inject side effects (copy credentials, warm caches, snapshot logs, redact secrets) without forking the runtime adapter code.

## File location

Each phase looks for a script at a fixed path under the **source root** (the repo whose `git worktree add` produced this worktree):

```
<sourceRoot>/.open-claude-tag/worktree-hooks/pre.sh
<sourceRoot>/.open-claude-tag/worktree-hooks/post.sh
```

If the file is absent, the hook is a silent no-op. The script does not need an executable bit — it is invoked via `bash <script>`.

What `sourceRoot` resolves to depends on session type:

| Session flow | Function | sourceRoot |
|---|---|---|
| Self-dev | `createWorktree` | OpenClaudeTag repo root |
| External project (`adhocWorkDir`) | `resolveExternalProjectWorkspace` | The external project root |
| Cleanup by sessionId | `removeWorktree` | OpenClaudeTag repo root |
| Cleanup by path | `removeWorktreeAtPath` | grandparent of `worktreePath` |

## Lifecycle

| Phase | Fires | After / Before |
|---|---|---|
| `pre` | self-dev create | After `git worktree add`, after `.env` copy, before return |
| `pre` | external create | After `git worktree add`, before `persist()` |
| `post` | self-dev remove | At the start of `removeWorktree`, before `.env` is unlinked and before `git worktree remove` |
| `post` | path-based remove | Same, in `removeWorktreeAtPath` |

`resolveExternalProjectWorkspace` skips hooks when it falls back to using `projectPath` directly (non-git directory) or when reusing an existing worktree.

## Execution environment

Each hook script is spawned with:

- **cwd** — the worktree directory (`WORKTREE_PATH`)
- **timeout** — 60 seconds (`HOOK_TIMEOUT_MS` in `worktree-hooks.ts`)
- **env** — inherited `process.env` plus:
  - `WORKTREE_PATH` — absolute path of the worktree
  - `REPO_ROOT` — same value as `sourceRoot` above
  - `SESSION_ID` — full session id, or the `dev-<shortId>` suffix when only the path is known (`removeWorktreeAtPath`)
  - `BRANCH_NAME` — worktree branch, or empty string when null
  - `WORKTREE_HOOK_PHASE` — `"pre"` or `"post"`

Hook stdout and stderr are captured and emitted to the structured logger under `name: "worktree-hooks"`.

## Failure semantics

| Phase | Non-zero exit |
|---|---|
| `pre` | Logged at `error`, the partially-created worktree is rolled back (`git worktree remove --force` + `git branch -D`), and the original error is rethrown wrapped as `Error("pre worktree hook failed: ...", { cause })`. The session never enters a ready state without the resources the hook was meant to provide. |
| `post` | Logged at `warn`, then swallowed. Cleanup must always finish, so a broken `post.sh` can never block worktree removal. |

External projects have an extra safeguard: a `pre` failure is tagged with `__worktreeHookFailure` so it bypasses the outer fallback in `resolveExternalProjectWorkspace`. Without that tag the function would silently downgrade to running directly in `projectPath`, defeating the rollback.

## `REPO_ROOT` versus `OPEN_TAG_DEFAULT_WORKDIR`

These are not the same thing.

- `OPEN_TAG_DEFAULT_WORKDIR` — startup config read from `.env`, used to seed `adhocWorkDir` on new sessions. Static.
- `REPO_ROOT` (in the hook env) — the parent repo of the worktree being created right now. Dynamic. For self-dev it is the OpenClaudeTag monorepo; for external projects it is whatever path the session points at.

If a hook needs to locate the OpenClaudeTag monorepo specifically (regardless of session type), pass it through a separate env var when launching the worker, e.g. `OPEN_TAG_HOME=/path/to/OpenClaudeTag`, and reference `$OPEN_TAG_HOME` from the script.

## Example: copy credentials before each run

`<OpenClaudeTag>/.open-claude-tag/worktree-hooks/pre.sh`

```bash
#!/usr/bin/env bash
set -euo pipefail

# Reference: in self-dev sessions $REPO_ROOT == OpenClaudeTag root; in external
# project sessions it points at the user's project, so we resolve the
# OpenClaudeTag home explicitly.
OPEN_TAG_HOME="${OPEN_TAG_HOME:-$HOME/open-claude-tag}"

for src in "$OPEN_TAG_HOME/.anthropic" "$OPEN_TAG_HOME/.codex"; do
  [ -d "$src" ] && cp -r "$src" "$WORKTREE_PATH/"
done
```

`post.sh` is the symmetric place to scrub anything the runtime wrote that should not survive worktree removal — but note that the worktree directory is deleted right after, so most "cleanup" is unnecessary unless the hook copied data outside `WORKTREE_PATH`.

## Reference

- Implementation: `packages/runtime-adapters/src/worktree-hooks.ts`
- Wire-in: `packages/runtime-adapters/src/worktree-manager.ts`
- Tests: `packages/runtime-adapters/src/__tests__/worktree-hooks.test.ts`
- Public exports: `runWorktreeHook`, `WorktreeHookPhase`, `WorktreeHookContext` from `@open-tag/runtime-adapters`
