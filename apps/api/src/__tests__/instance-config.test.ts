import { createRequire } from 'module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { buildIsolatedInstanceConfig, buildIsolatedEnv, deriveDatabaseUrl } =
  require('../../../../tools/instance/config.mjs') as {
    buildIsolatedInstanceConfig: (params?: { cwd?: string; env?: NodeJS.ProcessEnv }) => {
      instanceRole: 'primary' | 'isolated';
      instanceId: string;
      port: number;
      apiUrl: string;
      databaseUrl: string;
      apiPidPath: string;
      workerPidPath: string;
      cwd: string;
    };
    buildIsolatedEnv: (params?: { cwd?: string; env?: NodeJS.ProcessEnv }) => NodeJS.ProcessEnv;
    deriveDatabaseUrl: (baseDatabaseUrl: string, instanceId: string) => string;
  };

describe('isolated instance config', () => {
  it('derives a stable instance id from the worktree directory', () => {
    const config = buildIsolatedInstanceConfig({
      cwd: '/tmp/open-claude-tag/.worktrees/codex-session-d637cf65',
      env: {},
    });

    expect(config.instanceRole).toBe('isolated');
    expect(config.instanceId).toBe('codex-session-d637cf65');
  });

  it('derives an isolated database name from the base URL', () => {
    expect(
      deriveDatabaseUrl(
        'postgresql://open-claude-tag:open-claude-tag@localhost:5432/open-claude-tag',
        'codex-session-d637cf65',
      ),
    ).toContain('/open_claude_tag_codex_session_d637cf65');
  });

  it('builds a consistent api url and pid paths', () => {
    const config = buildIsolatedInstanceConfig({
      cwd: '/tmp/open-claude-tag/.worktrees/codex-session-d637cf65',
      env: {},
    });

    expect(config.port).toBeGreaterThanOrEqual(3100);
    expect(config.port).toBeLessThan(5100);
    expect(config.apiUrl).toBe(`http://127.0.0.1:${config.port}`);
    expect(config.apiPidPath).toBe('/tmp/open-claude-tag/isolated/codex-session-d637cf65/api.pid.json');
    expect(config.workerPidPath).toBe(
      '/tmp/open-claude-tag/isolated/codex-session-d637cf65/worker.pid.json',
    );
  });

  it('sets env vars needed by isolated scripts', () => {
    const env = buildIsolatedEnv({
      cwd: '/tmp/open-claude-tag/.worktrees/codex-session-d637cf65',
      env: { DATABASE_URL: 'postgresql://open-claude-tag:open-claude-tag@localhost:5432/open-claude-tag' },
    });

    expect(env.OPEN_TAG_INSTANCE_ROLE).toBe('isolated');
    expect(env.OPEN_TAG_INSTANCE_ID).toBe('codex-session-d637cf65');
    expect(env.PORT).toBe(env.API_PORT);
    expect(env.API_URL).toBe(`http://127.0.0.1:${env.PORT}`);
    expect(env.DATABASE_URL).toContain('/open_claude_tag_codex_session_d637cf65');
    expect(env.OPEN_TAG_API_PID_PATH).toBe(
      '/tmp/open-claude-tag/isolated/codex-session-d637cf65/api.pid.json',
    );
    expect(env.OPEN_TAG_WORKER_PID_PATH).toBe(
      '/tmp/open-claude-tag/isolated/codex-session-d637cf65/worker.pid.json',
    );
    expect(env.OPEN_TAG_FEISHU_ACCESS).toBe('disabled');
  });

  it('ignores inherited primary instance ids when deriving an isolated worktree config', () => {
    const config = buildIsolatedInstanceConfig({
      cwd: '/tmp/open-claude-tag/.worktrees/dev-90a62684',
      env: {
        OPEN_TAG_INSTANCE_ID: 'primary',
        OPEN_TAG_INSTANCE_ROLE: 'primary',
      },
    });

    expect(config.instanceRole).toBe('isolated');
    expect(config.instanceId).toBe('dev-90a62684');
  });

  it('ignores inherited primary instance ids when building an isolated worktree env', () => {
    const env = buildIsolatedEnv({
      cwd: '/tmp/open-claude-tag/.worktrees/dev-90a62684',
      env: {
        DATABASE_URL: 'postgresql://open-claude-tag:open-claude-tag@localhost:5432/open-claude-tag',
        OPEN_TAG_INSTANCE_ID: 'primary',
        OPEN_TAG_INSTANCE_ROLE: 'primary',
      },
    });

    expect(env.OPEN_TAG_INSTANCE_ROLE).toBe('isolated');
    expect(env.OPEN_TAG_INSTANCE_ID).toBe('dev-90a62684');
    expect(env.API_URL).toBe(`http://127.0.0.1:${env.PORT}`);
    expect(env.DATABASE_URL).toContain('/open_claude_tag_dev_90a62684');
  });

  it('uses dedicated primary pid paths for the main repo', () => {
    const config = buildIsolatedInstanceConfig({
      cwd: '/tmp/open-claude-tag',
      env: {},
    });

    expect(config.instanceRole).toBe('primary');
    expect(config.apiPidPath).toBe('/tmp/open-claude-tag/primary/api.pid.json');
    expect(config.workerPidPath).toBe('/tmp/open-claude-tag/primary/worker.pid.json');
  });

  it('forces isolated pid paths even when launched from the primary repo root', () => {
    const env = buildIsolatedEnv({
      cwd: '/tmp/open-claude-tag',
      env: {
        DATABASE_URL: 'postgresql://open-claude-tag:open-claude-tag@localhost:5432/open-claude-tag',
        OPEN_TAG_INSTANCE_ID: 'verify-feishu-block',
      },
    });

    expect(env.OPEN_TAG_INSTANCE_ROLE).toBe('isolated');
    expect(env.OPEN_TAG_API_PID_PATH).toBe(
      '/tmp/open-claude-tag/isolated/verify-feishu-block/api.pid.json',
    );
    expect(env.OPEN_TAG_WORKER_PID_PATH).toBe(
      '/tmp/open-claude-tag/isolated/verify-feishu-block/worker.pid.json',
    );
  });

  it('treats an open-claude-tag repo root as the primary instance', () => {
    const config = buildIsolatedInstanceConfig({
      cwd: '/tmp/open-claude-tag',
      env: {},
    });

    expect(config.instanceRole).toBe('primary');
    expect(config.apiPidPath).toBe('/tmp/open-claude-tag/primary/api.pid.json');
    expect(config.workerPidPath).toBe('/tmp/open-claude-tag/primary/worker.pid.json');
  });
});
