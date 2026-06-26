import { describe, expect, it, vi } from 'vitest';
import type { Database } from '@open-tag/storage';
import type { FeishuClient } from '@open-tag/feishu-adapter';
import {
  createWorkerFeishuClientRegistry,
  resolveSecretRef,
} from '../feishu-client-registry.js';

interface FeishuAppRow {
  id: string;
  appId: string;
  appSecretRef: string;
  appSecret: string | null;
}

function makeDb(rowsRef: { rows: FeishuAppRow[] }): Database {
  const selectChain = {
    from: () => selectChain,
    where: async () => rowsRef.rows,
  };

  return {
    select: vi.fn(() => selectChain),
  } as unknown as Database;
}

function makeClient(appId: string, appSecret: string): FeishuClient {
  return { appId, appSecret } as unknown as FeishuClient;
}

describe('createWorkerFeishuClientRegistry', () => {
  it('uses a stored Feishu app secret when the env secret ref is unavailable', async () => {
    const rowsRef = {
      rows: [
        {
          id: 'app_db_id',
          appId: 'cli_db',
          appSecretRef: 'MISSING_SECRET',
          appSecret: 'stored-secret',
        },
      ],
    };
    const createClient = vi.fn(makeClient);

    const registry = await createWorkerFeishuClientRegistry({
      db: makeDb(rowsRef),
      disabled: false,
      primaryAppId: '',
      primaryAppSecret: '',
      createClient,
    });

    await expect(registry.getClient('app_db_id')).resolves.toMatchObject({
      appId: 'cli_db',
      appSecret: 'stored-secret',
    });
    expect(registry.primaryClient).toMatchObject({
      appId: 'cli_db',
      appSecret: 'stored-secret',
    });
  });

  it('refreshes when a task references an app added after worker startup', async () => {
    const rowsRef = {
      rows: [
        {
          id: 'first_app',
          appId: 'cli_first',
          appSecretRef: 'FIRST_SECRET',
          appSecret: 'stored-first',
        },
      ],
    };

    const registry = await createWorkerFeishuClientRegistry({
      db: makeDb(rowsRef),
      disabled: false,
      primaryAppId: '',
      primaryAppSecret: '',
      createClient: makeClient,
      refreshIntervalMs: 60_000,
    });

    rowsRef.rows = [
      ...rowsRef.rows,
      {
        id: 'second_app',
        appId: 'cli_second',
        appSecretRef: 'SECOND_SECRET',
        appSecret: 'stored-second',
      },
    ];

    await expect(registry.getClient('second_app')).resolves.toMatchObject({
      appId: 'cli_second',
      appSecret: 'stored-second',
    });
    expect(registry.registeredAppIds()).toEqual(['first_app', 'second_app']);
  });
});

describe('resolveSecretRef', () => {
  it('resolves plain and env-prefixed references', () => {
    expect(resolveSecretRef('APP_SECRET', { APP_SECRET: 'value' })).toBe('value');
    expect(resolveSecretRef('env:APP_SECRET', { APP_SECRET: 'value' })).toBe('value');
    expect(resolveSecretRef('stored', { stored: 'should-not-use-env' })).toBeNull();
  });
});
