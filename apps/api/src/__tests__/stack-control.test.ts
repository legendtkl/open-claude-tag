import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createRequire } from 'module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const {
  startStack,
  stopStack,
  restartStack,
  runStackSubcommand,
  buildManagedServiceEnv,
  findRogueProcesses,
} = require('../../../../tools/instance/stack-control.mjs') as {
  startStack: (options: StackOptions) => Promise<unknown>;
  stopStack: (options: StackOptions) => Promise<unknown>;
  restartStack: (options: StackOptions) => Promise<unknown>;
  runStackSubcommand: (subcommand: string, options: StackOptions) => Promise<unknown>;
  buildManagedServiceEnv: (config: InstanceConfig, env?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
  findRogueProcesses: (
    config: InstanceConfig,
    service: string,
    excludePids: Set<number>,
    ops: { execSync: (cmd: string, opts?: unknown) => string },
  ) => number[];
};

type ManagedService = 'api' | 'worker';
type InstanceRole = 'primary' | 'isolated';

interface InstanceConfig {
  instanceRole: InstanceRole;
  instanceId: string;
  cwd: string;
  apiUrl: string;
  apiPidPath: string;
  workerPidPath: string;
}

interface SpawnResult {
  pid: number;
  unref: () => void;
}

interface StackDeps {
  spawn?: (
    command: string,
    args: string[],
    options: {
      cwd: string;
      env: NodeJS.ProcessEnv;
      detached: boolean;
      shell: false;
      stdio: ['ignore', number, number];
    },
  ) => SpawnResult;
  execSync?: (command: string, options?: unknown) => string;
  isProcessAlive?: (pid: number) => boolean;
  kill?: (pid: number, signal?: NodeJS.Signals | number) => void;
  fetch?: (input: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean }>;
  wait?: (ms: number) => Promise<void>;
  now?: () => number;
  ensureDatabase?: () => void;
  startStack?: (options: StackOptions) => Promise<unknown>;
  stopStack?: (options: StackOptions) => Promise<unknown>;
  restartStack?: (options: StackOptions) => Promise<unknown>;
}

interface StackOptions {
  config: InstanceConfig;
  env: NodeJS.ProcessEnv;
  deps?: StackDeps;
  timeoutMs?: number;
  stdout?: { write: (chunk: string) => void };
  stderr?: { write: (chunk: string) => void };
}

describe('stack-control', () => {
  let tempDir: string;
  let repoRoot: string;
  let config: InstanceConfig;

  beforeEach(() => {
    tempDir = join(tmpdir(), `open-claude-tag-stack-control-${Date.now()}-${Math.random()}`);
    repoRoot = join(tempDir, 'repo');
    mkdirSync(repoRoot, { recursive: true });
    config = {
      instanceRole: 'isolated',
      instanceId: 'dev-123',
      cwd: repoRoot,
      apiUrl: 'http://127.0.0.1:4321',
      apiPidPath: join(tempDir, 'runtime', 'api.pid.json'),
      workerPidPath: join(tempDir, 'runtime', 'worker.pid.json'),
    };
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('starts api and worker in detached mode and creates per-service log files', async () => {
    const alivePids = new Set<number>();
    const spawnMock = vi.fn(
      (
        _command: string,
        args: string[],
        options: {
          cwd: string;
          env: NodeJS.ProcessEnv;
          detached: boolean;
          shell: false;
          stdio: ['ignore', number, number];
        },
      ) => {
        const service = args.includes('@open-tag/api') ? 'api' : 'worker';
        const pid = service === 'api' ? 4101 : 4102;
        const pidPath = service === 'api' ? config.apiPidPath : config.workerPidPath;

        alivePids.add(pid);
        mkdirSync(join(tempDir, 'runtime'), { recursive: true });
        writeFileSync(
          pidPath,
          JSON.stringify({
            service,
            pid,
            startedAt: Date.now(),
            lastHeartbeatAt: Date.now(),
            cwd: repoRoot,
            instanceRole: 'isolated',
            instanceId: config.instanceId,
          }),
        );

        expect(options.cwd).toBe(repoRoot);
        expect(options.detached).toBe(true);
        expect(options.shell).toBe(false);
        expect(options.stdio[0]).toBe('ignore');
        expect(typeof options.stdio[1]).toBe('number');
        expect(options.stdio[1]).toBe(options.stdio[2]);

        return {
          pid,
          unref: vi.fn(),
        };
      },
    );
    const fetchMock = vi.fn(async (_input: string, _init?: { signal?: AbortSignal }) => ({
      ok: true,
    }));

    await startStack({
      config,
      env: {
        OPEN_TAG_INSTANCE_ROLE: 'isolated',
        OPEN_TAG_INSTANCE_ID: config.instanceId,
        OPEN_TAG_API_PID_PATH: config.apiPidPath,
        OPEN_TAG_WORKER_PID_PATH: config.workerPidPath,
      },
      deps: {
        spawn: spawnMock,
        isProcessAlive: (pid) => alivePids.has(pid),
        fetch: fetchMock,
      },
      timeoutMs: 50,
    });

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${config.apiUrl}/health`);
    expect(existsSync(join(repoRoot, 'logs', 'services', 'api', 'service.log'))).toBe(true);
    expect(existsSync(join(repoRoot, 'logs', 'services', 'worker', 'service.log'))).toBe(true);
  });

  it('builds primary managed service env from pid paths', () => {
    const env = buildManagedServiceEnv(
      {
        ...config,
        instanceRole: 'primary',
      },
      {},
    );

    expect(env.OPEN_TAG_INSTANCE_ROLE).toBe('primary');
    expect(env.OPEN_TAG_INSTANCE_ID).toBe('primary');
    expect(env.OPEN_TAG_API_PID_PATH).toBe(config.apiPidPath);
    expect(env.OPEN_TAG_WORKER_PID_PATH).toBe(config.workerPidPath);
  });

  it('builds personal managed service env with a forced personal instance id', () => {
    const env = buildManagedServiceEnv(
      { ...config, instanceRole: 'personal' as InstanceRole },
      {
        OPEN_TAG_INSTANCE_ID: 'ambient-should-be-ignored',
        DATABASE_URL: 'postgresql://u:p@127.0.0.1:5599/db',
        PORT: '3210',
        OPEN_TAG_FEISHU_ACCESS: 'disabled',
      },
    );

    // Forced to "personal" — never inherits the ambient OPEN_TAG_INSTANCE_ID.
    expect(env.OPEN_TAG_INSTANCE_ID).toBe('personal');
    expect(env.OPEN_TAG_INSTANCE_ROLE).toBe('primary');
    expect(env.OPEN_TAG_API_PID_PATH).toBe(config.apiPidPath);
    expect(env.OPEN_TAG_WORKER_PID_PATH).toBe(config.workerPidPath);
    // Launcher-supplied env is passed through unchanged.
    expect(env.DATABASE_URL).toBe('postgresql://u:p@127.0.0.1:5599/db');
    expect(env.PORT).toBe('3210');
    expect(env.OPEN_TAG_FEISHU_ACCESS).toBe('disabled');
  });

  it('does not rogue-kill when starting the personal stack', async () => {
    const personalConfig = { ...config, instanceRole: 'personal' as InstanceRole };
    const alivePids = new Set<number>();
    const execSyncMock = vi.fn(() => {
      throw new Error('ps must not be consulted for personal');
    });

    const spawnMock = vi.fn((_command: string, args: string[]) => {
      const service: ManagedService = args.includes('@open-tag/api') ? 'api' : 'worker';
      const pid = service === 'api' ? 9301 : 9302;
      const pidPath = service === 'api' ? personalConfig.apiPidPath : personalConfig.workerPidPath;
      alivePids.add(pid);
      mkdirSync(join(tempDir, 'runtime'), { recursive: true });
      writeFileSync(
        pidPath,
        JSON.stringify({
          service,
          pid,
          startedAt: Date.now(),
          lastHeartbeatAt: Date.now(),
          cwd: repoRoot,
          instanceRole: 'primary',
          instanceId: 'personal',
        }),
      );
      return { pid, unref: vi.fn() };
    });

    await startStack({
      config: personalConfig,
      env: { API_URL: personalConfig.apiUrl },
      deps: {
        spawn: spawnMock,
        execSync: execSyncMock,
        isProcessAlive: (pid) => alivePids.has(pid),
        fetch: async () => ({ ok: true }),
      },
      timeoutMs: 50,
    });

    expect(spawnMock).toHaveBeenCalledTimes(2);
    // Rogue detection (ps) is skipped entirely for the personal role.
    expect(execSyncMock).not.toHaveBeenCalled();
  });

  it('rolls back a newly started api when worker registration fails', async () => {
    const alivePids = new Set<number>();
    const killMock = vi.fn((pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 'SIGTERM' || signal === 'SIGKILL') {
        alivePids.delete(pid);
      }
    });

    const spawnMock = vi.fn(
      (
        _command: string,
        args: string[],
        _options: {
          cwd: string;
          env: NodeJS.ProcessEnv;
          detached: boolean;
          shell: false;
          stdio: ['ignore', number, number];
        },
      ) => {
        const service = args.includes('@open-tag/api') ? 'api' : 'worker';
        const pid = service === 'api' ? 5101 : 5102;

        alivePids.add(pid);
        if (service === 'api') {
          mkdirSync(join(tempDir, 'runtime'), { recursive: true });
          writeFileSync(
            config.apiPidPath,
            JSON.stringify({
              service: 'api',
              pid,
              startedAt: Date.now(),
              lastHeartbeatAt: Date.now(),
              cwd: repoRoot,
              instanceRole: 'isolated',
              instanceId: config.instanceId,
            }),
          );
        }

        return {
          pid,
          unref: vi.fn(),
        };
      },
    );

    let now = 0;
    await expect(
      startStack({
        config,
        env: {
          OPEN_TAG_INSTANCE_ROLE: 'isolated',
          OPEN_TAG_INSTANCE_ID: config.instanceId,
          OPEN_TAG_API_PID_PATH: config.apiPidPath,
          OPEN_TAG_WORKER_PID_PATH: config.workerPidPath,
        },
        deps: {
          spawn: spawnMock,
          isProcessAlive: (pid) => alivePids.has(pid),
          kill: killMock,
          fetch: async () => ({ ok: true }),
          now: () => now,
          wait: async () => {
            now += 10;
          },
        },
        timeoutMs: 20,
      }),
    ).rejects.toThrow(join(repoRoot, 'logs', 'services', 'worker', 'service.log'));

    expect(killMock).toHaveBeenCalledWith(5101, 'SIGTERM');
    expect(existsSync(config.apiPidPath)).toBe(false);
  });

  it('stops worker before api and removes stale pid files', async () => {
    mkdirSync(join(tempDir, 'runtime'), { recursive: true });
    writeFileSync(
      config.apiPidPath,
      JSON.stringify({
        service: 'api',
        pid: 6101,
        startedAt: Date.now(),
        lastHeartbeatAt: Date.now(),
        cwd: repoRoot,
        instanceRole: 'isolated',
        instanceId: config.instanceId,
      }),
    );
    writeFileSync(
      config.workerPidPath,
      JSON.stringify({
        service: 'worker',
        pid: 6102,
        startedAt: Date.now(),
        lastHeartbeatAt: Date.now(),
        cwd: repoRoot,
        instanceRole: 'isolated',
        instanceId: config.instanceId,
      }),
    );

    const alivePids = new Set<number>([6102]);
    const killMock = vi.fn((pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 'SIGTERM' || signal === 'SIGKILL') {
        alivePids.delete(pid);
      }
    });

    await stopStack({
      config,
      env: {},
      deps: {
        isProcessAlive: (pid) => alivePids.has(pid),
        kill: killMock,
      },
      timeoutMs: 20,
    });

    expect(killMock).toHaveBeenCalledTimes(1);
    expect(killMock).toHaveBeenCalledWith(6102, 'SIGTERM');
    expect(existsSync(config.workerPidPath)).toBe(false);
    expect(existsSync(config.apiPidPath)).toBe(false);
  });

  it('restarts the full stack by stopping then starting it again', async () => {
    const order: string[] = [];

    const result = await restartStack({
      config,
      env: {},
      deps: {
        stopStack: async () => {
          order.push('stop');
        },
        startStack: async () => {
          order.push('start');
          return {
            action: 'start',
            services: {},
          };
        },
      },
    });

    expect(order).toEqual(['stop', 'start']);
    expect(result).toMatchObject({ action: 'restart' });
  });

  it('prepares isolated runtime before running services-start and services-restart', async () => {
    const ensureDatabase = vi.fn();
    const startMock = vi.fn(async () => undefined);
    const restartMock = vi.fn(async () => undefined);

    await runStackSubcommand('services-start', {
      config,
      env: {},
      deps: {
        ensureDatabase,
        startStack: startMock,
      },
    });
    await runStackSubcommand('services-restart', {
      config,
      env: {},
      deps: {
        ensureDatabase,
        restartStack: restartMock,
      },
    });

    expect(ensureDatabase).toHaveBeenCalledTimes(2);
    expect(startMock).toHaveBeenCalledTimes(1);
    expect(restartMock).toHaveBeenCalledTimes(1);
  });

  it('keeps start failure messages actionable by including the relevant log path', async () => {
    let now = 0;
    const alivePids = new Set<number>();
    const killMock = vi.fn((pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 'SIGTERM' || signal === 'SIGKILL') {
        alivePids.delete(pid);
      }
    });

    await expect(
      startStack({
        config,
        env: {},
        deps: {
          spawn: vi.fn((_command: string, args: string[]) => {
            const service = args.includes('@open-tag/api') ? 'api' : 'worker';
            const pid = service === 'api' ? 7101 : 7102;
            const pidPath = service === 'api' ? config.apiPidPath : config.workerPidPath;

            alivePids.add(pid);
            mkdirSync(join(tempDir, 'runtime'), { recursive: true });
            writeFileSync(
              pidPath,
              JSON.stringify({
                service,
                pid,
                startedAt: Date.now(),
                lastHeartbeatAt: Date.now(),
                cwd: repoRoot,
                instanceRole: 'isolated',
                instanceId: config.instanceId,
              }),
            );

            return {
              pid,
              unref: vi.fn(),
            };
          }),
          isProcessAlive: (pid) => alivePids.has(pid),
          kill: killMock,
          fetch: async () => ({ ok: false }),
          now: () => now,
          wait: async () => {
            now += 10;
          },
        },
        timeoutMs: 20,
      }),
    ).rejects.toThrow(join(repoRoot, 'logs', 'services', 'api', 'service.log'));

    expect(killMock).toHaveBeenCalledWith(7101, 'SIGTERM');
    expect(existsSync(config.apiPidPath)).toBe(false);
    expect(existsSync(join(repoRoot, 'logs', 'services', 'api', 'service.log'))).toBe(true);
  });

  it('times out health checks when the endpoint never responds', async () => {
    const alivePids = new Set<number>();
    const killMock = vi.fn((pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 'SIGTERM' || signal === 'SIGKILL') {
        alivePids.delete(pid);
      }
    });

    await expect(
      startStack({
        config,
        env: {},
        deps: {
          spawn: vi.fn((_command: string, args: string[]) => {
            const service = args.includes('@open-tag/api') ? 'api' : 'worker';
            const pid = service === 'api' ? 7201 : 7202;
            const pidPath = service === 'api' ? config.apiPidPath : config.workerPidPath;

            alivePids.add(pid);
            mkdirSync(join(tempDir, 'runtime'), { recursive: true });
            writeFileSync(
              pidPath,
              JSON.stringify({
                service,
                pid,
                startedAt: Date.now(),
                lastHeartbeatAt: Date.now(),
                cwd: repoRoot,
                instanceRole: 'isolated',
                instanceId: config.instanceId,
              }),
            );

            return {
              pid,
              unref: vi.fn(),
            };
          }),
          isProcessAlive: (pid) => alivePids.has(pid),
          kill: killMock,
          fetch: (_input: string, init?: { signal?: AbortSignal }) =>
            new Promise((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () => {
                reject(new Error('aborted'));
              });
            }),
        },
        timeoutMs: 30,
      }),
    ).rejects.toThrow(join(repoRoot, 'logs', 'services', 'api', 'service.log'));

    expect(killMock).toHaveBeenCalledWith(7201, 'SIGTERM');
  });

  it('reuses legacy primary pid files instead of spawning duplicate services', async () => {
    config = {
      ...config,
      instanceRole: 'primary',
      apiPidPath: join(tempDir, 'primary', 'api.pid.json'),
      workerPidPath: join(tempDir, 'primary', 'worker.pid.json'),
    };

    const legacyApiPidPath = join(tempDir, 'api.pid.json');
    const legacyWorkerPidPath = join(tempDir, 'worker.pid.json');
    const alivePids = new Set<number>([7301, 7302]);
    const spawnMock = vi.fn();

    writeFileSync(
      legacyApiPidPath,
      JSON.stringify({
        service: 'api',
        pid: 7301,
        startedAt: Date.now(),
        lastHeartbeatAt: Date.now(),
        cwd: repoRoot,
        instanceRole: 'primary',
        instanceId: 'primary',
      }),
    );
    writeFileSync(
      legacyWorkerPidPath,
      JSON.stringify({
        service: 'worker',
        pid: 7302,
        startedAt: Date.now(),
        lastHeartbeatAt: Date.now(),
        cwd: repoRoot,
        instanceRole: 'primary',
        instanceId: 'primary',
      }),
    );

    const result = await startStack({
      config,
      env: {},
      deps: {
        spawn: spawnMock,
        isProcessAlive: (pid) => alivePids.has(pid),
        fetch: async () => ({ ok: true }),
      },
      timeoutMs: 50,
    });

    expect(spawnMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      services: {
        api: { status: 'already-running', pid: 7301 },
        worker: { status: 'already-running', pid: 7302 },
      },
    });
  });

  it('uses the current-instance log namespace for each service', async () => {
    const alivePids = new Set<number>();
    const spawnMock = vi.fn(
      (
        _command: string,
        args: string[],
        _options: {
          cwd: string;
          env: NodeJS.ProcessEnv;
          detached: boolean;
          shell: false;
          stdio: ['ignore', number, number];
        },
      ) => {
        const service: ManagedService = args.includes('@open-tag/api') ? 'api' : 'worker';
        const pid = service === 'api' ? 8101 : 8102;
        const pidPath = service === 'api' ? config.apiPidPath : config.workerPidPath;

        alivePids.add(pid);
        mkdirSync(join(tempDir, 'runtime'), { recursive: true });
        writeFileSync(
          pidPath,
          JSON.stringify({
            service,
            pid,
            startedAt: Date.now(),
            lastHeartbeatAt: Date.now(),
            cwd: repoRoot,
            instanceRole: 'isolated',
            instanceId: config.instanceId,
          }),
        );

        return {
          pid,
          unref: vi.fn(),
        };
      },
    );

    await startStack({
      config,
      env: {},
      deps: {
        spawn: spawnMock,
        isProcessAlive: (pid) => alivePids.has(pid),
        fetch: async () => ({ ok: true }),
      },
      timeoutMs: 50,
    });

    expect(readFileSync(config.apiPidPath, 'utf8')).toContain(config.instanceId);
    expect(readFileSync(config.workerPidPath, 'utf8')).toContain(config.instanceId);
    expect(existsSync(join(repoRoot, 'logs', 'services', 'api', 'service.log'))).toBe(true);
    expect(existsSync(join(repoRoot, 'logs', 'services', 'worker', 'service.log'))).toBe(true);
  });

  describe('rogue process detection', () => {
    it('findRogueProcesses detects unmanaged processes matching the service directory', () => {
      const psOutput = [
        '  PID ARGS',
        `  9901 node ${join(repoRoot, 'apps/worker')}/src/main.ts`,
        `  9902 node ${join(repoRoot, 'apps/api')}/src/main.ts`,
        '  9903 node /other/project/apps/worker/src/main.ts',
        `  9904 pnpm --filter @open-tag/worker run dev`,
      ].join('\n');

      const execSyncMock = vi.fn(() => psOutput);
      const ops = { execSync: execSyncMock };
      const excludePids = new Set([process.pid]);

      const workerRogues = findRogueProcesses(config, 'worker', excludePids, ops);
      expect(workerRogues).toEqual([9901]);

      const apiRogues = findRogueProcesses(config, 'api', excludePids, ops);
      expect(apiRogues).toEqual([9902]);
    });

    it('findRogueProcesses excludes managed pids', () => {
      const psOutput = [
        '  PID ARGS',
        `  9901 node ${join(repoRoot, 'apps/worker')}/src/main.ts`,
        `  9902 node ${join(repoRoot, 'apps/worker')}/src/main.ts`,
      ].join('\n');

      const ops = { execSync: vi.fn(() => psOutput) };
      const excludePids = new Set([9901]);

      const rogues = findRogueProcesses(config, 'worker', excludePids, ops);
      expect(rogues).toEqual([9902]);
    });

    it('findRogueProcesses returns empty when ps fails', () => {
      const ops = {
        execSync: vi.fn(() => {
          throw new Error('ps failed');
        }),
      };

      const rogues = findRogueProcesses(config, 'worker', new Set(), ops);
      expect(rogues).toEqual([]);
    });

    it('startStack kills rogue processes before spawning a new service', async () => {
      const alivePids = new Set<number>();
      const killMock = vi.fn((pid: number, signal?: NodeJS.Signals | number) => {
        if (signal === 'SIGTERM' || signal === 'SIGKILL') {
          alivePids.delete(pid);
        }
      });

      const roguePid = 37246;
      const psOutput = [
        '  PID ARGS',
        `  ${roguePid} node ${join(repoRoot, 'apps/api')}/src/main.ts`,
        `  ${roguePid + 1} node ${join(repoRoot, 'apps/worker')}/src/main.ts`,
      ].join('\n');
      alivePids.add(roguePid);
      alivePids.add(roguePid + 1);

      const spawnMock = vi.fn(
        (
          _command: string,
          args: string[],
        ) => {
          const service: ManagedService = args.includes('@open-tag/api') ? 'api' : 'worker';
          const pid = service === 'api' ? 4201 : 4202;
          const pidPath = service === 'api' ? config.apiPidPath : config.workerPidPath;

          alivePids.add(pid);
          mkdirSync(join(tempDir, 'runtime'), { recursive: true });
          writeFileSync(
            pidPath,
            JSON.stringify({
              service,
              pid,
              startedAt: Date.now(),
              lastHeartbeatAt: Date.now(),
              cwd: repoRoot,
              instanceRole: 'isolated',
              instanceId: config.instanceId,
            }),
          );

          return { pid, unref: vi.fn() };
        },
      );

      await startStack({
        config,
        env: {},
        deps: {
          spawn: spawnMock,
          execSync: vi.fn(() => psOutput),
          isProcessAlive: (pid) => alivePids.has(pid),
          kill: killMock,
          fetch: async () => ({ ok: true }),
        },
        timeoutMs: 50,
      });

      // Rogue processes should be killed before services are spawned
      expect(killMock).toHaveBeenCalledWith(roguePid, 'SIGTERM');
      expect(killMock).toHaveBeenCalledWith(roguePid + 1, 'SIGTERM');
      expect(spawnMock).toHaveBeenCalledTimes(2);
    });
  });
});
