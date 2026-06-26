import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, 'fixtures', 'reconnect-survives-loop-drain.ts');
// Invoke the tsx CLI entry through the current Node binary, resolving the
// package via Node's own algorithm — bin shims and hand-built node_modules
// paths are layout-dependent across pnpm hoisting setups.
const tsxCli = join(
  dirname(createRequire(import.meta.url).resolve('tsx/package.json')),
  'dist',
  'cli.mjs',
);

describe('reconnect survives event-loop drain (subprocess regression)', () => {
  // Live-smoke regression: with the socket closed and all other timers
  // cleared, an unref'd reconnect timer let Node drain the event loop and the
  // daemon exited silently instead of reconnecting. The fixture process holds
  // NO other ref'd handles, so it only stays alive long enough to retry if
  // the reconnect timer is ref'd.
  it('keeps retrying against an unreachable server instead of exiting silently', () => {
    const stdout = execFileSync(process.execPath, [tsxCli, fixture], {
      encoding: 'utf8',
      timeout: 15_000,
      env: { ...process.env, LOG_LEVEL: 'silent' },
    });
    expect(stdout).toContain('ALIVE attempts=3');
  });
});
