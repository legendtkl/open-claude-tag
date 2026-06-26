import { describe, expect, it } from 'vitest';
import {
  BUILTIN_AGENT_HANDLE,
  BUILTIN_AGENT_PROFILE_NAME,
  PRIMARY_FEISHU_APP_SECRET_REF,
  buildBuiltInAgentSeedRows,
  seedBuiltInAgentIdentity,
} from '../agent-bootstrap.js';
import type { Database } from '../db.js';
import { agentBotBindings, agentProfiles, agents, feishuApps } from '../schema.js';

interface SeedDbMock {
  db: Database;
  insertTables: unknown[];
  insertValues: Array<{ table: unknown; value: unknown }>;
}

function createSeedDbMock(existingBindingId?: string): SeedDbMock {
  const insertTables: unknown[] = [];
  const insertValues: Array<{ table: unknown; value: unknown }> = [];
  const returningByTable = new Map<unknown, { id: string }>([
    [agentProfiles, { id: 'profile_id' }],
    [agents, { id: 'agent_id' }],
    [feishuApps, { id: 'feishu_app_id' }],
    [agentBotBindings, { id: 'binding_id' }],
  ]);

  const db = {
    insert(table: unknown) {
      insertTables.push(table);

      const insertChain = {
        values(value: unknown) {
          insertValues.push({ table, value });
          return insertChain;
        },
        onConflictDoUpdate() {
          return insertChain;
        },
        returning() {
          return Promise.resolve([returningByTable.get(table) ?? { id: 'unknown_id' }]);
        },
      };

      return insertChain;
    },
    select() {
      const selectChain = {
        from() {
          return selectChain;
        },
        where() {
          return selectChain;
        },
        limit() {
          return Promise.resolve(existingBindingId ? [{ id: existingBindingId }] : []);
        },
      };

      return selectChain;
    },
  };

  return { db: db as unknown as Database, insertTables, insertValues };
}

describe('built-in agent bootstrap rows', () => {
  it('builds deterministic built-in profile and agent rows', () => {
    const first = buildBuiltInAgentSeedRows();
    const second = buildBuiltInAgentSeedRows();

    expect(first).toEqual(second);
    expect(first.profile.name).toBe(BUILTIN_AGENT_PROFILE_NAME);
    expect(first.agent.handle).toBe(BUILTIN_AGENT_HANDLE);
    expect(first.agent.scopeType).toBe('system');
    expect(first.agent.scopeId).toBe('default');
    expect(first.agent.visibility).toBe('public');
    expect(first.feishuApp).toBeUndefined();
  });

  it('includes primary Feishu app rows when app id is configured', () => {
    const rows = buildBuiltInAgentSeedRows({
      tenantKey: 'tenant_a',
      primaryFeishuAppId: 'cli_primary',
      primaryFeishuAppSecretRef: 'FEISHU_PRIMARY_SECRET',
      primaryFeishuBotOpenId: 'ou_bot',
      primaryFeishuBotName: 'Primary Bot',
    });

    expect(rows.agent.tenantKey).toBe('tenant_a');
    expect(rows.feishuApp).toEqual({
      tenantKey: 'tenant_a',
      appId: 'cli_primary',
      appSecretRef: 'FEISHU_PRIMARY_SECRET',
      botOpenId: 'ou_bot',
      botName: 'Primary Bot',
      eventMode: 'websocket',
      status: 'enabled',
    });
  });

  it('uses a secret reference instead of a plaintext app secret', () => {
    const rows = buildBuiltInAgentSeedRows({
      primaryFeishuAppId: 'cli_primary',
    });

    expect(rows.feishuApp?.appSecretRef).toBe(PRIMARY_FEISHU_APP_SECRET_REF);
    expect(rows.feishuApp).not.toHaveProperty('appSecret');
  });

  it('reuses an existing active bot binding during repeated bootstrap', async () => {
    const mock = createSeedDbMock('existing_binding_id');

    const result = await seedBuiltInAgentIdentity(mock.db, {
      primaryFeishuAppId: 'cli_primary',
      primaryFeishuBotOpenId: 'ou_bot',
    });

    expect(result).toEqual({
      profileId: 'profile_id',
      agentId: 'agent_id',
      feishuAppId: 'feishu_app_id',
      bindingId: 'existing_binding_id',
    });
    expect(mock.insertTables.filter((table) => table === agentBotBindings)).toHaveLength(0);
  });
});
