import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnMock, spawnSyncMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  spawnSyncMock: vi.fn(),
}));

vi.mock('child_process', () => ({
  spawn: spawnMock,
  spawnSync: spawnSyncMock,
}));

import {
  registerManagedService,
  startManagedService,
  stopManagedService,
  unregisterManagedService,
  waitForManagedServiceRegistration,
} from '../service-process.js';

describe('service-process', () => {
  const logger = { info: vi.fn(), warn: vi.fn() };
  let tempDir: string;
  let apiPidPath: string;
  let legacyApiPidPath: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = mkdtempSync(join(tmpdir(), 'open-claude-tag-service-process-'));
    apiPidPath = join(tempDir, 'api.pid.json');
    legacyApiPidPath = join(tempDir, 'api.pid.json');
    process.env.OPEN_TAG_API_PID_PATH = apiPidPath;
    process.env.OPEN_TAG_PID_ROOT = tempDir;
    delete process.env.OPEN_TAG_WORKER_PID_PATH;
    process.env.OPEN_TAG_INSTANCE_ROLE = 'isolated';
    process.env.OPEN_TAG_INSTANCE_ID = 'test-instance';

    spawnMock.mockReturnValue({
      pid: 4321,
      unref: vi.fn(),
    });
  });

  it('registers and unregisters the managed api process', () => {
    registerManagedService('api');

    const record = JSON.parse(readFileSync(apiPidPath, 'utf8'));
    expect(record).toMatchObject({
      service: 'api',
      pid: process.pid,
      cwd: process.cwd(),
      instanceRole: 'isolated',
      instanceId: 'test-instance',
    });
    expect(record.lastHeartbeatAt).toEqual(expect.any(Number));

    unregisterManagedService('api');
    expect(() => readFileSync(apiPidPath, 'utf8')).toThrow();
  });

  it('starts the managed api service through pnpm dev:api', () => {
    startManagedService('api', '/repo/OpenClaudeTag', logger as any);

    expect(spawnMock).toHaveBeenCalledWith('pnpm', ['dev:api'], {
      cwd: '/repo/OpenClaudeTag',
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
  });

  it('starts the managed worker service through pnpm dev:worker when WORKER_EXECUTOR is not set', () => {
    delete process.env.WORKER_EXECUTOR;
    startManagedService('worker', '/repo/OpenClaudeTag', logger as any);

    expect(spawnMock).toHaveBeenCalledWith('pnpm', ['dev:worker'], {
      cwd: '/repo/OpenClaudeTag',
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  describe('WORKER_EXECUTOR=tmux', () => {
    beforeEach(() => {
      process.env.WORKER_EXECUTOR = 'tmux';
      delete process.env.WORKER_EXECUTOR_SESSION;
    });

    afterEach(() => {
      delete process.env.WORKER_EXECUTOR;
      delete process.env.WORKER_EXECUTOR_SESSION;
    });

    it('starts the worker in a tmux session using the default session name', () => {
      startManagedService('worker', '/repo/OpenClaudeTag', logger as any);

      expect(spawnSyncMock).toHaveBeenCalledWith(
        'tmux',
        ['kill-session', '-t', 'open-claude-tag-worker-test-instance'],
        { stdio: 'ignore' },
      );
      expect(spawnMock).toHaveBeenCalledWith(
        'tmux',
        ['new-session', '-d', '-s', 'open-claude-tag-worker-test-instance', '-c', '/repo/OpenClaudeTag', 'pnpm dev:worker'],
        { detached: true, stdio: 'ignore', env: process.env },
      );
    });

    it('uses a custom tmux session name when WORKER_EXECUTOR_SESSION is set', () => {
      process.env.WORKER_EXECUTOR_SESSION = 'my-worker';
      startManagedService('worker', '/repo/OpenClaudeTag', logger as any);

      expect(spawnSyncMock).toHaveBeenCalledWith(
        'tmux',
        ['kill-session', '-t', 'my-worker'],
        { stdio: 'ignore' },
      );
      expect(spawnMock).toHaveBeenCalledWith(
        'tmux',
        ['new-session', '-d', '-s', 'my-worker', '-c', '/repo/OpenClaudeTag', 'pnpm dev:worker'],
        { detached: true, stdio: 'ignore', env: process.env },
      );
    });

    it('does not use tmux for the api service even when WORKER_EXECUTOR=tmux', () => {
      startManagedService('api', '/repo/OpenClaudeTag', logger as any);

      expect(spawnSyncMock).not.toHaveBeenCalled();
      expect(spawnMock).toHaveBeenCalledWith('pnpm', ['dev:api'], {
        cwd: '/repo/OpenClaudeTag',
        detached: true,
        stdio: 'ignore',
        env: process.env,
      });
    });

    it('returns undefined instead of a pid when using tmux', () => {
      const pid = startManagedService('worker', '/repo/OpenClaudeTag', logger as any);
      expect(pid).toBeUndefined();
    });
  });

  it('waits until the managed service pid file appears', async () => {
    setTimeout(() => {
      writeFileSync(
        apiPidPath,
        JSON.stringify({
          service: 'api',
          pid: process.pid,
          startedAt: Date.now(),
          cwd: process.cwd(),
        }),
      );
    }, 10);

    const record = await waitForManagedServiceRegistration('api', 1_000);
    expect(record.pid).toBe(process.pid);
  });

  it('stops a managed service recorded in the pid file', async () => {
    writeFileSync(
      apiPidPath,
      JSON.stringify({
        service: 'api',
        pid: 99999,
        startedAt: Date.now(),
        cwd: '/repo/OpenClaudeTag',
      }),
    );

    let terminated = false;
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((
      pid: number,
      signal?: NodeJS.Signals | number,
    ) => {
      if (pid !== 99999) return true;
      if (signal === 'SIGTERM') {
        terminated = true;
        return true;
      }
      if (signal === 0 && terminated) {
        const error = new Error('missing process') as NodeJS.ErrnoException;
        error.code = 'ESRCH';
        throw error;
      }
      return true;
    }) as typeof process.kill);

    await stopManagedService('api', logger as any, 100);

    expect(killSpy).toHaveBeenCalledWith(99999, 'SIGTERM');
    expect(() => readFileSync(apiPidPath, 'utf8')).toThrow();

    killSpy.mockRestore();
  });

  it('falls back to the legacy primary pid path during stop', async () => {
    delete process.env.OPEN_TAG_API_PID_PATH;
    process.env.OPEN_TAG_INSTANCE_ROLE = 'primary';
    delete process.env.OPEN_TAG_INSTANCE_ID;

    writeFileSync(
      legacyApiPidPath,
      JSON.stringify({
        service: 'api',
        pid: 99998,
        startedAt: Date.now(),
        cwd: '/repo/OpenClaudeTag',
        instanceRole: 'primary',
        instanceId: 'primary',
      }),
    );

    let terminated = false;
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((
      pid: number,
      signal?: NodeJS.Signals | number,
    ) => {
      if (pid !== 99998) return true;
      if (signal === 'SIGTERM') {
        terminated = true;
        return true;
      }
      if (signal === 0 && terminated) {
        const error = new Error('missing process') as NodeJS.ErrnoException;
        error.code = 'ESRCH';
        throw error;
      }
      return true;
    }) as typeof process.kill);

    await stopManagedService('api', logger as any, 100);

    expect(killSpy).toHaveBeenCalledWith(99998, 'SIGTERM');
    expect(() => readFileSync(legacyApiPidPath, 'utf8')).toThrow();

    killSpy.mockRestore();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(legacyApiPidPath, { force: true });
    delete process.env.OPEN_TAG_API_PID_PATH;
    delete process.env.OPEN_TAG_PID_ROOT;
    delete process.env.OPEN_TAG_INSTANCE_ROLE;
    delete process.env.OPEN_TAG_INSTANCE_ID;
  });
});
