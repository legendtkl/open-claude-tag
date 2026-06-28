import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'child_process';
import { join } from 'path';
import { missingBuildSentinels, buildServiceEnv, startConsole } from '../supervisors.js';
import type { PersonalConfig } from '../config.js';

// Mock only the side-effecting boundaries startConsole touches; the sibling
// suites (buildServiceEnv / missingBuildSentinels) use injected deps, not these
// modules, so importActual keeps everything else real.
vi.mock('child_process', async (orig) => ({
  ...(await orig<typeof import('child_process')>()),
  spawn: vi.fn(),
}));
vi.mock('fs', async (orig) => ({
  ...(await orig<typeof import('fs')>()),
  mkdirSync: vi.fn(),
  openSync: vi.fn(() => 3),
  closeSync: vi.fn(),
}));
vi.mock('../process-control.js', async (orig) => ({
  ...(await orig<typeof import('../process-control.js')>()),
  isProcessAlive: vi.fn(() => false),
  writePidRecord: vi.fn(),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(spawn).mockReset();
});

describe('buildServiceEnv', () => {
  it('overlays the personal knobs on the effective env', () => {
    const config = {
      apiPort: 3210,
      apiUrl: 'http://127.0.0.1:3210',
      feishuAccess: 'disabled',
    } as unknown as PersonalConfig;
    const env = buildServiceEnv(config, { EXISTING: 'keep' }, 'postgres://db');
    expect(env.EXISTING).toBe('keep');
    expect(env.DATABASE_URL).toBe('postgres://db');
    expect(env.PORT).toBe('3210');
    expect(env.API_PORT).toBe('3210');
    expect(env.API_URL).toBe('http://127.0.0.1:3210');
    expect(env.OPEN_TAG_FEISHU_ACCESS).toBe('disabled');
    // The personal launcher always runs the stack in personal mode so the console
    // auto-launches its onboarding wizard.
    expect(env.OPEN_TAG_PERSONAL_MODE).toBe('enabled');
  });

  it('forces personal mode on even when the inherited env disables it', () => {
    const config = {
      apiPort: 3210,
      apiUrl: 'http://127.0.0.1:3210',
      feishuAccess: 'disabled',
    } as unknown as PersonalConfig;
    const env = buildServiceEnv(
      config,
      { OPEN_TAG_PERSONAL_MODE: 'disabled' },
      'postgres://db',
    );
    expect(env.OPEN_TAG_PERSONAL_MODE).toBe('enabled');
  });
});

describe('missingBuildSentinels', () => {
  const repo = '/repo';

  function deps(present: Set<string>, packages: Record<string, unknown>) {
    return {
      exists: (p: string) => present.has(p),
      readDir: () => Object.keys(packages),
      readFile: (p: string) => {
        const name = p.split('/').slice(-2)[0];
        return JSON.stringify(packages[name] ?? {});
      },
    };
  }

  it('returns empty when console + package dists are present', () => {
    const present = new Set([
      '/repo/apps/console/dist/index.html',
      '/repo/packages/storage/package.json',
      '/repo/packages/storage/dist/index.js',
    ]);
    const missing = missingBuildSentinels(
      repo,
      deps(present, { storage: { scripts: { build: 'tsc' }, main: './dist/index.js' } }),
    );
    expect(missing).toEqual([]);
  });

  it('flags a missing console dist', () => {
    const present = new Set(['/repo/packages/storage/package.json', '/repo/packages/storage/dist/index.js']);
    const missing = missingBuildSentinels(
      repo,
      deps(present, { storage: { scripts: { build: 'tsc' }, main: './dist/index.js' } }),
    );
    expect(missing).toContain('/repo/apps/console/dist/index.html');
  });

  it('flags a package whose dist main is missing', () => {
    const present = new Set([
      '/repo/apps/console/dist/index.html',
      '/repo/packages/storage/package.json',
    ]);
    const missing = missingBuildSentinels(
      repo,
      deps(present, { storage: { scripts: { build: 'tsc' }, main: './dist/index.js' } }),
    );
    expect(missing).toContain('/repo/packages/storage/dist/index.js');
  });

  it('ignores packages without a build script or main', () => {
    const present = new Set(['/repo/apps/console/dist/index.html', '/repo/packages/types/package.json']);
    const missing = missingBuildSentinels(
      repo,
      deps(present, { types: { main: './dist/index.js' } }), // no build script
    );
    expect(missing).toEqual([]);
  });
});

describe('startConsole', () => {
  it('reuses an already reachable console instead of spawning another process', async () => {
    const fetch = vi.fn(async () => ({
      ok: true,
      headers: {
        get: (name: string) => (name === 'x-open-claude-tag-console' ? '1' : null),
      },
      json: async () => ({}),
      text: async () => '',
    }));
    vi.stubGlobal('fetch', fetch);

    const result = await startConsole(
      {
        repoRoot: '/repo',
        consoleUrl: 'http://127.0.0.1:8080',
      } as PersonalConfig,
      {},
    );

    expect(result.status).toBe('already-running');
    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:8080');
  });

  // Regression for #25: a foreign service answering plain HTTP 200 on the console
  // URL (no `x-open-claude-tag-console` header, no console <title>) must NOT be
  // treated as already-running — startConsole must proceed to spawn its own.
  it('does not treat a foreign HTTP 200 as already-running; proceeds to spawn', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      headers: { get: () => null },
      json: async () => ({}),
      text: async () => '<title>Some other app</title>',
    }));
    vi.stubGlobal('fetch', fetchMock);
    // Spawn a fake child that immediately looks dead (isProcessAlive → false),
    // so startConsole throws fast without real I/O, timers, or signals.
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true as never);
    vi.mocked(spawn).mockReturnValue({ pid: 999_999, unref: vi.fn(), on: vi.fn() } as never);

    await expect(
      startConsole(
        {
          repoRoot: '/repo',
          consoleUrl: 'http://127.0.0.1:8080',
          runtimeDir: '/tmp/oct-console-test',
          consoleLogPath: '/tmp/oct-console-test/console.log',
          consolePort: 8080,
          apiUrl: 'http://127.0.0.1:3000',
          consolePidPath: '/tmp/oct-console-test/console.pid',
        } as unknown as PersonalConfig,
        {},
      ),
    ).rejects.toThrow(/exited during startup/);

    // Proves the foreign 200 did not short-circuit to already-running.
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(spawn)).toHaveBeenCalledWith(
      'node',
      [join('/repo', 'apps', 'console', 'serve-console.mjs')],
      expect.objectContaining({ cwd: '/repo' }),
    );
    killSpy.mockRestore();
  });
});
