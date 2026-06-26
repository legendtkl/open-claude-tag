import { defineConfig } from 'tsup';

/**
 * Bundle config for npm distribution (design §2/§9, D9).
 *
 * The four workspace packages (`@open-tag/daemon-protocol`, `core-types`,
 * `runtime-adapters`, `observability`) are bundled INTO `dist/index.js` so the
 * published tarball is self-contained and `npx @open-tag/daemon` resolves with
 * no `workspace:*` references. Heavy / native / SDK deps stay external and ship
 * as regular `dependencies` that npm installs alongside the bundle.
 *
 * The plain `tsc` build (`pnpm build`) remains the path the monorepo's
 * `pnpm -r run build` uses; this bundle runs only on `prepack`.
 */
export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  bundle: true,
  clean: true,
  dts: false,
  sourcemap: true,
  shims: false,
  // Heavy / native / SDK deps stay external — installed by npm from `dependencies`.
  external: [
    '@anthropic-ai/claude-agent-sdk',
    '@openai/codex-sdk',
    'commander',
    'https-proxy-agent',
    'pino',
    'ws',
    'zod',
  ],
  // Bundle the workspace packages (everything not listed as external is inlined).
  noExternal: [
    '@open-tag/daemon-protocol',
    '@open-tag/core-types',
    '@open-tag/runtime-adapters',
    '@open-tag/observability',
  ],
  // The shebang is carried by `src/index.ts` itself and preserved by tsup, so we
  // do NOT add a `banner` here (that would duplicate it and break the bundle).
});
