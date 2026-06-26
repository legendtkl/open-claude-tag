# PR Guidelines

Every self-dev PR body must follow the template below. All sections are required.

## PR Body Template

```markdown
> PR title format: `<type>(<scope>): <short summary>` in English, max 72 chars.
> Replace every placeholder, example row, and unchecked applicability note before requesting review.

## Goal

<!-- One sentence: what problem this PR solves and why it matters -->

## Overview

**Change:** `<change-name>`

<!-- 2–3 sentences summarising what changed and the key decisions made -->

## Verified Test Cases

| # | Scenario | GIVEN | WHEN | THEN |
|---|----------|-------|------|------|
| 1 | | | | |

<!-- Paste the confirmed test-case table from the planning phase.
     Include happy-path, edge-case, and error-case rows.
     For incident-driven fixes, capture the confirmed incident scenarios
     here as the test-case table. -->

## Core Changes

| File / Component | What Changed |
|------------------|--------------|
| `path/to/file.ts` | Description |

<!-- List every file or component that was meaningfully modified.
     Keep descriptions concise (one line per entry). -->

## Type of Change

- [ ] Bug fix
- [ ] New feature
- [ ] Refactor
- [ ] Documentation

## Pre-merge Checklist

- [ ] `pnpm build` passes _(skip for docs-only changes)_
- [ ] `pnpm test` passes _(skip for docs-only changes)_
- [ ] `pnpm --filter @open-tag/api test:e2e` passes _(skip for docs-only changes)_
- [ ] `AGENTS.md` updated if architecture / dev workflow changed
```

## Guidance

- **Goal** — one sentence only; avoid restating the title.
- **Overview** — summarise what changed and the key decisions, not the implementation details.
- **Verified Test Cases** — use the exact table confirmed during the planning phase (before implementation started). For incident-driven fixes without a formal table, capture the confirmed incident scenarios as the test-case table. Do not fabricate rows after implementation.
- **Core Changes** — list files changed, not git diff hunks. Group related files on a single row when they form a logical unit (e.g. `handler.ts` + `handler.test.ts`).
- **Type of Change** — tick all that apply.
- PR title must follow Conventional Commits: `<type>(<scope>): <short summary>` (max 72 chars, English).
- `.github/pull_request_template.md` must stay aligned with this document whenever the PR body rules change.
- For pure documentation-only changes, the build/test/E2E checklist items may be left unchecked and called out explicitly in the PR body.
