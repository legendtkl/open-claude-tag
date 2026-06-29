import { defineConfig } from 'vitest/config';

/**
 * Config for the OPT-IN live Slack e2e (`pnpm test:slack:e2e`). It is run ONLY
 * via `vitest run --config vitest.slack-e2e.config.ts`; this file is NOT named
 * `vitest.config.*`, so the default `vitest run` (package `test` / `test:unit`)
 * never auto-loads it and instead uses vitest's built-in include
 * (`**\/*.{test,spec}...`), which never matches the `.slack-e2e.ts` file. That
 * keeps the real-Slack-call check out of the default suite and CI.
 *
 * testTimeout (60s) is a generous backstop for the handful of quick Slack REST
 * calls the single end-to-end flow makes. No in-test watchdog is needed (unlike
 * the runtime e2e, these are short REST round-trips, not long-running model
 * calls).
 */
export default defineConfig({
  test: {
    include: ['src/__e2e__/*.slack-e2e.ts'],
    testTimeout: 60_000,
    hookTimeout: 30_000,
  },
});
