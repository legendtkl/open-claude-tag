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
