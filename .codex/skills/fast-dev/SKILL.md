---
name: fast-dev
description: Use ONLY with explicit user opt-in for a narrow, low-risk OpenClaudeTag repo change — docs/copy, static assets, a localized console UI tweak, a clearly isolated helper, or a localized test adjustment. Do focused verification and explicitly report which full gates you skipped. If the change turns out to touch any tier-2 area (schema, auth, queue/worker/runtime, Feishu events, daemon, secrets, deployment, or a broad refactor), stop and switch to self-dev.
---

# fast-dev — lightweight flow for narrow, low-risk changes

This is the lightweight tier of `AGENTS.md` → "Change Workflow". It exists so a
small change does not pay the full self-dev ceremony. The tier table in `AGENTS.md`
is the authoritative routing rule; this skill defers to it.

**fast-dev requires an explicit user opt-in.** If the user did not opt into
fast-dev, default to `self-dev`.

## In scope (only these)

- Documentation / copy edits.
- Static assets.
- A localized console UI tweak with a contained blast radius.
- A clearly isolated helper or utility.
- A localized test adjustment.

## Out of scope — escalate to self-dev

If the change touches DB schema, migrations, storage/seed, auth / permissions /
ownership, secrets, deployment / release, queue / worker / runtime adapters, Feishu
event handling, the daemon gateway, or is a broad / architectural refactor — **stop
and switch to self-dev**, stating why. This applies even if you only discover the
tier-2 surface mid-flight.

## Flow

1. Confirm a one-line intent and the few files in scope. Keep the change focused —
   no unrequested "opportunistic" edits.
2. Make the change. Prefer test-first when a behavior is involved; for pure
   docs/copy/assets, a test may not apply.
3. **Focused verification** — run the checks relevant to what you touched, e.g.:
   - touched `.ts`: `pnpm lint`, `pnpm typecheck`, `pnpm build`, and the affected
     package's `pnpm --filter @open-tag/<pkg> test`;
   - touched a workspace `package.json` / docs that a test pins: the test guarding it;
   - **console UI / web change: validate the rendered behavior in a browser, check
     the browser console for errors, and capture a screenshot as acceptance evidence.**
4. **Explicitly report the gates you skipped** and why (e.g. "skipped Postgres
   integration + API E2E: docs-only change, no runtime path touched"). Never imply
   the full suite ran when it did not.
5. Commit with a clear message: `git commit -m "<type>(<scope>): <summary>"`.
6. Open a PR per `AGENTS.md` ("Commit and PR") when the change warrants one. Outward
   actions (push, PR, merge) are confirmed with the user.

## Rules

- All code, comments, docs, and PR text are in **English**.
- Never modify `.env`, `infra/`, `.git/`, `pnpm-lock.yaml`, `*.key`, `*.pem`.
- Run every git command from the current worktree.
- Never commit credentials, real tenant identifiers, or internal-only references.
