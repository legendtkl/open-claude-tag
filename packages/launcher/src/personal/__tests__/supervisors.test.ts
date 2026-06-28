import { afterEach, describe, expect, it, vi } from 'vitest';
import { missingBuildSentinels, buildServiceEnv, startConsole } from '../supervisors.js';
import type { PersonalConfig } from '../config.js';

afterEach(() => {
  vi.unstubAllGlobals();
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
      json: async () => ({}),
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
});
