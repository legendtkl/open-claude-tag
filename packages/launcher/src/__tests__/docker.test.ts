import { describe, expect, it, vi } from 'vitest';
import { createDockerDbProvider, type CommandRunner } from '../providers/docker.js';

const noopSleep = () => Promise.resolve();

describe('createDockerDbProvider', () => {
  it('brings up compose Postgres, polls pg_isready, and returns the DSN', async () => {
    let readyChecks = 0;
    const run: CommandRunner = vi.fn(async (_command, args) => {
      if (args.includes('up')) return 0;
      if (args.includes('pg_isready')) {
        readyChecks += 1;
        return readyChecks >= 2 ? 0 : 1;
      }
      return 1;
    });

    const provider = createDockerDbProvider({
      env: {},
      run,
      sleep: noopSleep,
      readinessAttempts: 5,
      readinessIntervalMs: 1,
    });

    const { databaseUrl } = await provider.ensureRunning();
    expect(databaseUrl).toBe('postgresql://open-claude-tag:open-claude-tag@localhost:5432/open-claude-tag');
    expect(readyChecks).toBe(2);
    expect(run).toHaveBeenCalledWith('docker', [
      'compose',
      '-f',
      'infra/docker-compose.yaml',
      'up',
      'postgres',
      '-d',
    ]);
  });

  it('prefers an explicit DATABASE_URL', async () => {
    const run: CommandRunner = async (_command, args) => (args.includes('up') ? 0 : 0);
    const provider = createDockerDbProvider({
      env: { DATABASE_URL: 'postgresql://u:p@db.example:6543/app' },
      run,
      sleep: noopSleep,
    });
    const { databaseUrl } = await provider.ensureRunning();
    expect(databaseUrl).toBe('postgresql://u:p@db.example:6543/app');
  });

  it('throws when compose up fails', async () => {
    const run: CommandRunner = async () => 1;
    const provider = createDockerDbProvider({ env: {}, run, sleep: noopSleep });
    await expect(provider.ensureRunning()).rejects.toThrow(/docker compose up postgres` failed/);
  });

  it('throws when Postgres never becomes ready', async () => {
    const run: CommandRunner = async (_command, args) => (args.includes('up') ? 0 : 1);
    const provider = createDockerDbProvider({
      env: {},
      run,
      sleep: noopSleep,
      readinessAttempts: 3,
      readinessIntervalMs: 1,
    });
    await expect(provider.ensureRunning()).rejects.toThrow(/did not become ready/);
  });

  it('stop is a no-op', async () => {
    const provider = createDockerDbProvider({ env: {}, run: async () => 0 });
    await expect(provider.stop()).resolves.toBeUndefined();
  });
});
