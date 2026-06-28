---
name: self-dev
description: Use when making a substantial change to the OpenClaudeTag repo itself (tier-2 blast radius — DB schema/migrations, storage/seed, auth/permissions/ownership, secrets, deployment/release, queue/worker/runtime adapters, Feishu event handling, daemon gateway, or a broad/architectural refactor). Confirm test cases plus an implementation plan, work test-first, pass the full gates, record ADRs on demand, and open a PR. For a narrow, low-risk change use fast-dev instead.
---

# self-dev — full change workflow for OpenClaudeTag

You are iterating on the OpenClaudeTag system codebase — you are part of this
system. This skill is the full-gate flow for **tier-2** changes; the authoritative
routing rule lives in `AGENTS.md` → "Change Workflow". If a change is narrow and
low-risk, use **fast-dev** instead. If a fast-dev change grows into any tier-2 area
mid-flight, stop and escalate to this flow, stating why.

The detailed, worktree-safe verification order is `doc/testing/self-dev-checklist.md`.
Keep this skill, the `.codex` copy, and `packages/runtime-adapters/workflows/self-dev-common.md`
consistent in their design-on-demand / ADR / tier-routing wording (ADR-0001).

## Phase 1 — Plan the change

1. Derive a short kebab-case name for the change from the requirement.
2. Study the relevant existing code and patterns **before** proposing anything.
3. Return **test cases + a concise Technical Implementation Plan** to the user and
   wait for confirmation before writing code:
   - Test cases cover the happy path, edge cases, and error cases as a Markdown
     table with columns `# | Scenario | GIVEN | WHEN | THEN`.
   - The Technical Implementation Plan states the expected code touch points (files,
     modules, workflow layers), the expected code/test changes, the test coverage to
     add or adjust, and any notable risks or trade-offs.
   - Do not start implementing until the user confirms or adjusts. If they adjust,
     update the proposal and wait again.
4. **Record real architectural decisions as a concise ADR** under `doc/decisions/`
   (see `doc/decisions/README.md`) — only when the change has a genuine architectural
   decision (a fork between viable options, a reversal of a prior decision, or a
   convention spanning multiple files). Otherwise skip the ADR and implement.
5. If requirements are ambiguous, scope has expanded significantly, or context is
   insufficient, stop and ask the user before proceeding.

## Phase 2 — Implement by task (TDD)

6. Break the work into small tasks and implement them one at a time, test-first:
   write the failing test, then the minimal implementation to make it pass, then
   refactor with tests green.
7. Commit incrementally with a clear message: `git commit -m "<type>(<scope>): <summary>"`.
   Keep the change focused — no unrequested "opportunistic" edits.

## Phase 3 — Verify (all gates must pass)

8. Run the required gates before commit or PR:
   ```bash
   pnpm lint
   pnpm build
   pnpm test
   pnpm test:integration   # Postgres integration (storage + admin API)
   pnpm --filter @open-tag/api test:e2e
   ```
9. **In a worktree, use the isolated wrappers** for the Postgres and E2E gates
   (they derive the worktree's own DB/ports and must not reuse the default ones):
   ```bash
   pnpm test:integration:isolated   # needs `pnpm db:setup:isolated` first
   pnpm test:e2e:isolated           # start `pnpm dev:api:isolated` first
   ```
   `pnpm test:integration` needs `DATABASE_URL` in the shell; the isolated wrapper
   injects the worktree DB instead. See `doc/testing/self-dev-checklist.md`.
10. Run the runtime's **code-review gate** (an independent review pass — see the
    runtime-specific self-dev appendix). Fix any critical/major findings, then
    re-run build, test, integration, and E2E. Max 3 attempts per failure, then stop
    and reassess.
11. Run **manual isolated validation** when the change touches worker execution,
    queue dequeue, runtime-specific behavior the E2E suite doesn't exercise, Feishu
    card lifecycle, or background services (checklist → "When Manual Validation Is
    Also Required"). For console UI / web changes, validate the rendered behavior in
    a browser and capture a screenshot.

## Phase 4 — Open a PR

12. Push the branch and open a PR with the body template from `AGENTS.md`
    ("Commit and PR") and `doc/contributing/pr-guidelines.md`:
    ```bash
    git push -u origin HEAD
    gh pr create --title "<type>(<scope>): <summary>" --body "<body>"
    ```
    The PR body states the goal, an overview, the **confirmed test-case table** from
    Phase 1, the core changes, the change type, and the pre-merge checklist (mark
    the integration and E2E gates passed even when satisfied via the isolated
    wrappers). Request the configured automated PR review.

## Phase 5 — Hand off

13. Report the PR URL and the verification result. Do not push or merge beyond what
    the user asked; outward actions (push, PR, merge) are confirmed with the user.

## Rules

- Follow `CLAUDE.md` / `AGENTS.md` conventions. All code, comments, docs, and PR
  text are in **English**.
- Never modify `.env`, `infra/`, `.git/`, `pnpm-lock.yaml`, `*.key`, `*.pem`.
  Never delete `pnpm-lock.yaml`.
- Run every git command from the current worktree; never switch to the main repo dir.
- Never commit credentials, real tenant identifiers, or internal-only references.
