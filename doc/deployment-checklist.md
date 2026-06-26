# Deployment / Live-Restart Checklist

## ⚠️ RULE: Always CLEAN-rebuild before a live deploy/restart (no stale dist)

**Why this rule exists (2026-06-09):** A relay parent task kept "sticking at 90%" in live testing even after the fix passed all tests. Root cause: an **incremental build left stale `dist/` files** — `apps/worker/dist/main.js` was fresh but `handoff-delivery.js`, `task-terminal-transition.js`, and `discussion-turn-orchestration.js` were older than their source. The live worker ran the **old relay/resume code**, so the fix was in source + tests (green) but **not in the deployed dist** (broken). This is the classic "tests pass from source, live broken on stale dist" trap, and it cost several wasted live-test rounds.

**The rule — before restarting any live service to a new build:**

1. **Clean the build output** for the package(s) being deployed:
   ```bash
   rm -rf apps/worker/dist apps/api/dist
   find . -name '*.tsbuildinfo' -delete      # kill incremental-build caches
   ```
2. **Rebuild from scratch**:
   ```bash
   pnpm --filter @open-tag/worker build
   pnpm --filter @open-tag/api build
   ```
3. **Verify no dist file is stale** — every `dist/*.js` must be newer than its `src/*.ts`. Quick check:
   ```bash
   # any line printed = a STALE dist file → do NOT deploy, rebuild
   for ts in $(find apps/worker/src apps/api/src -name '*.ts' ! -name '*.test.ts'); do
     js="${ts/src/dist}"; js="${js%.ts}.js"
     [ -f "$js" ] && [ "$ts" -nt "$js" ] && echo "STALE: $js (src newer than dist)"
   done
   ```
4. **Restart** the service to the fresh dist, then **confirm the running process's dist path + build time** (e.g. `pm2 describe`, check `dist/main.js` mtime) before declaring the deploy live.
5. **Report the deployed commit** after the deployment is healthy. Routine
   devbox/live deployments do not create or push `release-*` tags by default;
   include the exact deployed commit and verification result in the deployment
   report instead. Create a release tag only when the deployment request
   explicitly asks for release tagging or versioning.

**Do NOT trust an incremental `pnpm build`** for a deploy: tsc/turbo incremental caches can skip files whose changes they didn't detect (especially after a `git merge`/stash-pop that touches mtimes inconsistently). When in doubt, clean-rebuild.

**Corollary:** "all tests green" does NOT mean "the fix is live." Tests run from source; the deploy runs the dist. Always verify the dist is fresh and the process is running it.
