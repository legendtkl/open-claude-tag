import { defineConfig } from 'vitest/config';

/**
 * Config for the OPT-IN live runtime e2e (`pnpm test:runtime:e2e`). It is run
 * ONLY via `vitest run --config vitest.runtime-e2e.config.ts`; the default
 * `vitest run` (package `test` / `test:unit`) uses vitest's built-in include
 * (`**\/*.{test,spec}...`) and never matches the `.runtime-e2e.ts` file, so this
 * billable check stays out of the default suite and CI.
 *
 * testTimeout (200s) is the backstop ABOVE the in-test watchdog (175s) so a
 * stalled runtime is force-cancelled and the workspace cleaned up before vitest
 * aborts the test.
 */
export default defineConfig({
  test: {
    include: ['src/__e2e__/*.runtime-e2e.ts'],
    testTimeout: 200_000,
    hookTimeout: 30_000,
  },
});
