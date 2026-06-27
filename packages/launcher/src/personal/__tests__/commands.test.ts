import { describe, expect, it, vi } from 'vitest';
import {
  runUp,
  runDown,
  runStatus,
  formatStatus,
  type UpDeps,
  type DownDeps,
  type StatusSnapshot,
} from '../commands.js';
import type { PersonalConfig } from '../config.js';
import type { HealthSnapshot } from '../health.js';

const config = {
  healthUrl: 'http://127.0.0.1:3000/health',
  consoleUrl: 'http://127.0.0.1:8080',
} as unknown as PersonalConfig;

const readyHealth: HealthSnapshot = {
  status: 'ok',
  db: 'connected',
  instanceId: 'personal',
  worker: { status: 'healthy' },
};

function makeUpDeps(overrides: Partial<UpDeps>, order: string[]): UpDeps {
  return {
    log: () => {},
    acquireLock: vi.fn(() => {
      order.push('acquireLock');
      return { path: '/lock', pid: 1 };
    }),
    releaseLock: vi.fn(() => order.push('releaseLock')),
    ensureEnvFile: vi.fn(() => order.push('ensureEnvFile')),
    probeRunning: vi.fn(async () => {
      order.push('probeRunning');
      return { allUp: false, health: null };
    }),
    ensureDatabaseUp: vi.fn(async () => {
      order.push('ensureDatabaseUp');
      return { databaseUrl: 'postgres://x' };
    }),
    migrateAndSeed: vi.fn(async () => {
      order.push('migrateAndSeed');
    }),
    ensureBuilt: vi.fn(async () => {
      order.push('ensureBuilt');
    }),
    startServices: vi.fn(async () => {
      order.push('startServices');
    }),
    startConsole: vi.fn(async () => {
      order.push('startConsole');
    }),
    waitForHealth: vi.fn(async () => {
      order.push('waitForHealth');
      return readyHealth;
    }),
    openBrowser: vi.fn(() => order.push('openBrowser')),
    rollback: vi.fn(async () => {
      order.push('rollback');
    }),
    ...overrides,
  };
}

describe('runUp', () => {
  it('runs the steps in order and opens the browser', async () => {
    const order: string[] = [];
    const deps = makeUpDeps({}, order);
    const result = await runUp(config, deps);
    expect(result.status).toBe('started');
    expect(order).toEqual([
      'acquireLock',
      'ensureEnvFile',
      'probeRunning',
      'ensureDatabaseUp',
      'migrateAndSeed',
      'ensureBuilt',
      'startServices',
      'startConsole',
      'waitForHealth',
      'openBrowser',
      'releaseLock',
    ]);
  });

  it('short-circuits when the stack is already up', async () => {
    const order: string[] = [];
    const deps = makeUpDeps(
      {
        probeRunning: vi.fn(async () => {
          order.push('probeRunning');
          return { allUp: true, health: readyHealth };
        }),
      },
      order,
    );
    const result = await runUp(config, deps);
    expect(result.status).toBe('already-running');
    expect(deps.ensureDatabaseUp).not.toHaveBeenCalled();
    expect(deps.startServices).not.toHaveBeenCalled();
    expect(deps.openBrowser).toHaveBeenCalled();
    expect(order).toEqual(['acquireLock', 'ensureEnvFile', 'probeRunning', 'openBrowser', 'releaseLock']);
  });

  it('does not open the browser with noOpen', async () => {
    const order: string[] = [];
    const deps = makeUpDeps({}, order);
    await runUp(config, deps, { noOpen: true });
    expect(deps.openBrowser).not.toHaveBeenCalled();
  });

  it('rolls back and releases the lock when a step throws after mutation begins', async () => {
    const order: string[] = [];
    const deps = makeUpDeps(
      {
        startServices: vi.fn(async () => {
          throw new Error('boom');
        }),
      },
      order,
    );
    await expect(runUp(config, deps)).rejects.toThrow('boom');
    expect(deps.rollback).toHaveBeenCalled();
    expect(deps.releaseLock).toHaveBeenCalled();
    // rollback runs before the lock is released
    expect(order).toContain('rollback');
    expect(order.indexOf('rollback')).toBeLessThan(order.indexOf('releaseLock'));
  });

  it('tears down a stack that never becomes healthy', async () => {
    const order: string[] = [];
    const deps = makeUpDeps(
      { waitForHealth: vi.fn(async () => ({ status: 'degraded', instanceId: 'personal' })) },
      order,
    );
    await expect(runUp(config, deps)).rejects.toThrow(/did not become healthy/);
    expect(deps.rollback).toHaveBeenCalled();
    expect(deps.releaseLock).toHaveBeenCalled();
  });

  it('does not roll back when already running (no mutation)', async () => {
    const order: string[] = [];
    const deps = makeUpDeps(
      {
        probeRunning: vi.fn(async () => ({ allUp: true, health: readyHealth })),
      },
      order,
    );
    await runUp(config, deps);
    expect(deps.rollback).not.toHaveBeenCalled();
  });
});

describe('runDown', () => {
  it('stops console, then services, then database in order', async () => {
    const order: string[] = [];
    const deps: DownDeps = {
      log: () => {},
      stopConsole: vi.fn(async () => {
        order.push('console');
        return { status: 'stopped' };
      }),
      stopServices: vi.fn(async () => {
        order.push('services');
        return {};
      }),
      stopDatabase: vi.fn(async () => {
        order.push('database');
        return { status: 'stopped' };
      }),
    };
    const result = await runDown(config, deps);
    expect(order).toEqual(['console', 'services', 'database']);
    expect(result.console.status).toBe('stopped');
    expect(result.database.status).toBe('stopped');
  });
});

describe('runStatus / formatStatus', () => {
  it('delegates to collect', async () => {
    const snapshot: StatusSnapshot = {
      dbMode: 'embedded',
      databaseUp: true,
      databaseDetail: 'embedded, db-host alive, 127.0.0.1:5432',
      api: true,
      worker: true,
      console: false,
      health: readyHealth,
    };
    const result = await runStatus(config, { collect: async () => snapshot });
    expect(result).toBe(snapshot);
  });

  it('renders a readable block', () => {
    const text = formatStatus({
      dbMode: 'embedded',
      databaseUp: true,
      databaseDetail: 'embedded, db-host alive, 127.0.0.1:5432',
      api: true,
      worker: false,
      console: true,
      health: readyHealth,
    });
    expect(text).toContain('DB mode:  embedded');
    expect(text).toContain('API:      up');
    expect(text).toContain('Worker:   down');
    expect(text).toContain('status=ok db=connected');
  });

  it('reports an unreachable /health', () => {
    const text = formatStatus({
      dbMode: 'external',
      databaseUp: false,
      databaseDetail: 'external, unreachable',
      api: false,
      worker: false,
      console: false,
      health: null,
    });
    expect(text).toContain('/health:  unreachable');
  });
});
