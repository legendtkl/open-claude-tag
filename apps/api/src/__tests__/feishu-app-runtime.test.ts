import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Database } from '@open-tag/storage';
import { agentBotBindings, feishuApps } from '@open-tag/storage';
import type { FeishuClient } from '@open-tag/feishu-adapter';
import { MultiFeishuAppRuntime, resolveSecretRef } from '../feishu-app-runtime.js';

interface FeishuAppRow {
  id: string;
  tenantKey: string;
  appId: string;
  appSecretRef: string;
  appSecret: string | null;
  botOpenId: string | null;
  botName: string | null;
  eventMode?: string;
}

function makeDb(rows: FeishuAppRow[], activeBindingAppIds = rows.map((row) => row.id)) {
  const updates: Array<Record<string, unknown>> = [];
  let selectedTable: unknown = null;
  const selectChain = {
    from: (table: unknown) => {
      selectedTable = table;
      return selectChain;
    },
    where: async () => {
      if (selectedTable === feishuApps) return rows;
      if (selectedTable === agentBotBindings) {
        return activeBindingAppIds.map((feishuAppId) => ({ feishuAppId }));
      }
      return [];
    },
  };
  const updateChain = {
    set(value: Record<string, unknown>) {
      updates.push(value);
      return {
        where: async () => undefined,
      };
    },
  };

  return {
    db: {
      select: vi.fn(() => selectChain),
      update: vi.fn(() => updateChain),
    } as unknown as Database,
    updates,
  };
}

function makeClient(appId: string, appSecret: string): FeishuClient {
  return { appId, appSecret } as unknown as FeishuClient;
}

function makeLoopbackClient(): FeishuClient {
  return { loopback: true } as unknown as FeishuClient;
}

describe('MultiFeishuAppRuntime', () => {
  it('creates a disabled loopback context when Feishu access is disabled', async () => {
    const { db } = makeDb([]);
    const runtime = new MultiFeishuAppRuntime({
      db,
      disabled: true,
      primaryAppId: 'cli_primary',
      primaryAppSecret: 'secret',
      disabledBotOpenId: 'ou_disabled',
      createLoopbackClient: makeLoopbackClient,
    });

    const primary = await runtime.initialize();

    expect(primary.status).toBe('disabled');
    expect(primary.botOpenId).toBe('ou_disabled');
    expect(runtime.getHealthSnapshot()[0]).not.toHaveProperty('appSecret');
  });

  it('keeps single-app env fallback compatibility when no DB registrations exist', async () => {
    const { db } = makeDb([]);
    const fetchBotInfo = vi.fn(async () => ({ openId: 'ou_primary', name: 'Primary Bot' }));
    const runtime = new MultiFeishuAppRuntime({
      db,
      disabled: false,
      primaryAppId: 'cli_primary',
      primaryAppSecret: 'secret',
      disabledBotOpenId: 'ou_disabled',
      createLoopbackClient: makeLoopbackClient,
      createClient: makeClient,
      fetchBotInfo,
    });

    const primary = await runtime.initialize();

    expect(primary.id).toBe('primary-env');
    expect(primary.appId).toBe('cli_primary');
    expect(primary.eventMode).toBe('websocket');
    expect(primary.botOpenId).toBe('ou_primary');
    expect(fetchBotInfo).toHaveBeenCalledWith({ appId: 'cli_primary', appSecret: 'secret' });
  });

  it('uses webhook mode for env fallback when configured', async () => {
    const { db } = makeDb([]);
    const fetchBotInfo = vi.fn(async () => ({ openId: 'ou_primary', name: 'Primary Bot' }));
    const runtime = new MultiFeishuAppRuntime({
      db,
      disabled: false,
      primaryAppId: 'cli_primary',
      primaryAppSecret: 'secret',
      primaryEventMode: 'webhook',
      disabledBotOpenId: 'ou_disabled',
      createLoopbackClient: makeLoopbackClient,
      createClient: makeClient,
      fetchBotInfo,
    });

    const primary = await runtime.initialize();

    expect(primary.eventMode).toBe('webhook');
    expect(runtime.getHealthSnapshot()[0]).toMatchObject({ eventMode: 'webhook' });
  });

  it('initializes two enabled DB apps and persists missing bot info', async () => {
    const primaryAppDbId = randomUUID();
    const secondaryAppDbId = randomUUID();
    const { db, updates } = makeDb([
      {
        id: primaryAppDbId,
        tenantKey: 'default',
        appId: 'cli_primary',
        appSecretRef: 'PRIMARY_SECRET',
        appSecret: null,
        botOpenId: 'ou_primary',
        botName: 'Primary Bot',
        eventMode: 'websocket',
      },
      {
        id: secondaryAppDbId,
        tenantKey: 'default',
        appId: 'cli_secondary',
        appSecretRef: 'SECONDARY_SECRET',
        appSecret: null,
        botOpenId: null,
        botName: null,
        eventMode: 'webhook',
      },
    ]);
    const fetchBotInfo = vi.fn(async () => ({ openId: 'ou_secondary', name: 'Secondary Bot' }));
    const runtime = new MultiFeishuAppRuntime({
      db,
      disabled: false,
      primaryAppId: 'cli_primary',
      primaryAppSecret: 'primary-secret',
      disabledBotOpenId: 'ou_disabled',
      createLoopbackClient: makeLoopbackClient,
      createClient: makeClient,
      fetchBotInfo,
      env: {
        PRIMARY_SECRET: 'primary-secret',
        SECONDARY_SECRET: 'secondary-secret',
      },
    });

    const primary = await runtime.initialize();

    expect(primary.appId).toBe('cli_primary');
    expect(runtime.getHealthyContexts().map((context) => context.appId)).toEqual([
      'cli_primary',
      'cli_secondary',
    ]);
    expect(runtime.getHealthyContexts().map((context) => context.eventMode)).toEqual([
      'websocket',
      'webhook',
    ]);
    expect(fetchBotInfo).toHaveBeenCalledTimes(1);
    expect(fetchBotInfo).toHaveBeenCalledWith({
      appId: 'cli_secondary',
      appSecret: 'secondary-secret',
    });
    expect(updates[0]).toMatchObject({
      botOpenId: 'ou_secondary',
      botName: 'Secondary Bot',
    });
  });

  it('marks enabled DB apps without active bot bindings as not event-enabled', async () => {
    const boundAppDbId = randomUUID();
    const unboundAppDbId = randomUUID();
    const { db } = makeDb(
      [
        {
          id: boundAppDbId,
          tenantKey: 'default',
          appId: 'cli_bound',
          appSecretRef: 'BOUND_SECRET',
          appSecret: null,
          botOpenId: 'ou_bound',
          botName: 'Bound Bot',
          eventMode: 'websocket',
        },
        {
          id: unboundAppDbId,
          tenantKey: 'default',
          appId: 'cli_unbound',
          appSecretRef: 'UNBOUND_SECRET',
          appSecret: null,
          botOpenId: 'ou_unbound',
          botName: 'Unbound Bot',
          eventMode: 'websocket',
        },
      ],
      [boundAppDbId],
    );
    const runtime = new MultiFeishuAppRuntime({
      db,
      disabled: false,
      primaryAppId: 'cli_bound',
      primaryAppSecret: 'bound-secret',
      disabledBotOpenId: 'ou_disabled',
      createLoopbackClient: makeLoopbackClient,
      createClient: makeClient,
      env: {
        BOUND_SECRET: 'bound-secret',
        UNBOUND_SECRET: 'unbound-secret',
      },
    });

    await runtime.initialize();

    expect(runtime.getHealthSnapshot()).toEqual([
      expect.objectContaining({ appId: 'cli_bound', hasActiveBotBinding: true }),
      expect.objectContaining({ appId: 'cli_unbound', hasActiveBotBinding: false }),
    ]);
  });

  it('uses a stored app secret when the env secret ref is unavailable', async () => {
    const appDbId = randomUUID();
    const { db } = makeDb([
      {
        id: appDbId,
        tenantKey: 'default',
        appId: 'cli_stored',
        appSecretRef: 'MISSING_SECRET_REF',
        appSecret: 'stored-secret',
        botOpenId: 'ou_stored',
        botName: 'Stored Bot',
      },
    ]);
    const fetchBotInfo = vi.fn();
    const runtime = new MultiFeishuAppRuntime({
      db,
      disabled: false,
      primaryAppId: '',
      primaryAppSecret: '',
      disabledBotOpenId: 'ou_disabled',
      createLoopbackClient: makeLoopbackClient,
      createClient: makeClient,
      fetchBotInfo,
      env: {},
    });

    const primary = await runtime.initialize();

    expect(primary.appId).toBe('cli_stored');
    expect(primary.appSecret).toBe('stored-secret');
    expect(fetchBotInfo).not.toHaveBeenCalled();
  });
});

describe('resolveSecretRef', () => {
  it('resolves plain and env-prefixed secret refs', () => {
    expect(resolveSecretRef('APP_SECRET', { APP_SECRET: 'value' })).toBe('value');
    expect(resolveSecretRef('env:APP_SECRET', { APP_SECRET: 'value' })).toBe('value');
    expect(resolveSecretRef('stored', { stored: 'should-not-use-env' })).toBeNull();
  });
});
