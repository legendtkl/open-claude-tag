import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AgentAccessDeniedError,
  AgentRouteNotFoundError,
  type AgentRecord,
  type AgentRouteLoaders,
  type UpsertUserIdentityInput,
  type UserIdentityRecord,
  resolveAgentRouteFromLoaders,
  resolveUserIdentityFromLoaders,
} from '../agent-repository.js';

function makeAgent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  const now = new Date();
  return {
    id: randomUUID(),
    tenantKey: 'default',
    scopeType: 'system',
    scopeId: 'default',
    handle: 'open-claude-tag',
    displayName: 'OpenClaudeTag',
    description: null,
    profileId: randomUUID(),
    ownerUserId: null,
    platformOwnerId: null,
    machineId: null,
    visibility: 'public',
    defaultRuntime: null,
    defaultWorkDir: null,
    runtimeEnv: {},
    memoryEnabled: true,
    projectId: null,
    accessPolicy: {},
    status: 'active',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeIdentity(overrides: Partial<UserIdentityRecord> = {}): UserIdentityRecord {
  const now = new Date();
  return {
    id: randomUUID(),
    userId: null,
    tenantKey: 'default',
    feishuAppId: randomUUID(),
    openId: 'ou_user',
    unionId: null,
    displayName: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('agent route repository helpers', () => {
  it('resolves bound bot before virtual handle, chat default, and built-in fallback', async () => {
    const boundAgent = makeAgent({ handle: 'bound' });
    const loaders: AgentRouteLoaders = {
      findByBotBinding: async () => boundAgent,
      findByHandle: async () => makeAgent({ handle: 'virtual' }),
      findChatDefault: async () => makeAgent({ handle: 'default' }),
      findBuiltIn: async () => makeAgent({ handle: 'open-claude-tag' }),
    };

    const route = await resolveAgentRouteFromLoaders(
      {
        tenantKey: 'default',
        chatId: 'oc_chat',
        feishuAppId: 'feishu_app_id',
        virtualHandle: 'virtual',
      },
      loaders,
    );

    expect(route.source).toBe('bot_binding');
    expect(route.agent.handle).toBe('bound');
  });

  it('rejects private virtual agent routing for unauthorized users', async () => {
    const privateAgent = makeAgent({
      handle: 'private-reviewer',
      visibility: 'private',
      ownerUserId: randomUUID(),
    });
    const loaders: AgentRouteLoaders = {
      findByBotBinding: async () => null,
      findByHandle: async () => privateAgent,
      findChatDefault: async () => null,
      findBuiltIn: async () => makeAgent(),
    };

    await expect(
      resolveAgentRouteFromLoaders(
        {
          tenantKey: 'default',
          virtualHandle: 'private-reviewer',
          access: { userId: randomUUID(), role: 'user' },
        },
        loaders,
      ),
    ).rejects.toBeInstanceOf(AgentAccessDeniedError);
  });

  it('uses a public virtual handle when no bound bot route exists', async () => {
    const virtualAgent = makeAgent({ handle: 'reviewer' });
    const loaders: AgentRouteLoaders = {
      findByBotBinding: async () => null,
      findByHandle: async () => virtualAgent,
      findChatDefault: async () => makeAgent({ handle: 'default' }),
      findBuiltIn: async () => makeAgent(),
    };

    const route = await resolveAgentRouteFromLoaders(
      { tenantKey: 'default', chatId: 'oc_chat', virtualHandle: 'reviewer' },
      loaders,
    );

    expect(route.source).toBe('virtual_handle');
    expect(route.agent.handle).toBe('reviewer');
  });

  it('uses chat default before built-in fallback when no explicit route is available', async () => {
    const defaultAgent = makeAgent({ handle: 'chat-default' });
    const loaders: AgentRouteLoaders = {
      findByBotBinding: async () => null,
      findByHandle: async () => null,
      findChatDefault: async () => defaultAgent,
      findBuiltIn: async () => makeAgent({ handle: 'open-claude-tag' }),
    };

    const route = await resolveAgentRouteFromLoaders(
      { tenantKey: 'default', chatId: 'oc_chat' },
      loaders,
    );

    expect(route.source).toBe('chat_default');
    expect(route.agent.handle).toBe('chat-default');
  });

  it('falls back to the built-in agent for legacy single-bot traffic', async () => {
    const builtInAgent = makeAgent({ handle: 'open-claude-tag' });
    const loaders: AgentRouteLoaders = {
      findByBotBinding: async () => null,
      findByHandle: async () => null,
      findChatDefault: async () => null,
      findBuiltIn: async () => builtInAgent,
    };

    const route = await resolveAgentRouteFromLoaders({ tenantKey: 'default' }, loaders);

    expect(route.source).toBe('builtin');
    expect(route.agent.handle).toBe('open-claude-tag');
  });

  it('requires explicit legacy opt-in before falling back to the default tenant built-in agent', async () => {
    const builtInAgent = makeAgent({ handle: 'open-claude-tag' });
    const fallbackFlags: boolean[] = [];
    const loaders: AgentRouteLoaders = {
      findByBotBinding: async () => null,
      findByHandle: async () => null,
      findChatDefault: async () => null,
      findBuiltIn: async (allowDefaultTenantFallback = false) => {
        fallbackFlags.push(allowDefaultTenantFallback);
        return allowDefaultTenantFallback ? builtInAgent : null;
      },
    };

    await expect(
      resolveAgentRouteFromLoaders({ tenantKey: 'tenant_a' }, loaders),
    ).rejects.toBeInstanceOf(AgentRouteNotFoundError);

    const route = await resolveAgentRouteFromLoaders(
      { tenantKey: 'tenant_a', allowDefaultBuiltInFallback: true },
      loaders,
    );

    expect(route.source).toBe('builtin');
    expect(route.agent.handle).toBe('open-claude-tag');
    expect(fallbackFlags).toEqual([false, true]);
  });
});

describe('Feishu user identity repository helpers', () => {
  it('uses union_id to correlate the same internal user across apps', async () => {
    const userId = randomUUID();
    let upserted: UpsertUserIdentityInput | undefined;

    const identity = await resolveUserIdentityFromLoaders(
      {
        tenantKey: 'default',
        feishuAppId: randomUUID(),
        openId: 'ou_app_b',
        unionId: 'on_union',
        displayName: 'User',
      },
      {
        findExistingAppIdentity: async () => null,
        findIdentityByUnionId: async () => makeIdentity({ userId, unionId: 'on_union' }),
        findUserByUnionId: async () => {
          throw new Error('user lookup should not run when identity already has user id');
        },
        upsertAppIdentity: async (input) => {
          upserted = input;
          return makeIdentity(input);
        },
      },
    );

    expect(upserted?.userId).toBe(userId);
    expect(identity.userId).toBe(userId);
  });

  it('does not correlate app-scoped open_id across apps without union_id', async () => {
    let unionIdentityLookups = 0;
    let unionUserLookups = 0;
    let upserted: UpsertUserIdentityInput | undefined;

    await resolveUserIdentityFromLoaders(
      {
        tenantKey: 'default',
        feishuAppId: randomUUID(),
        openId: 'ou_same_value',
      },
      {
        findExistingAppIdentity: async () => null,
        findIdentityByUnionId: async () => {
          unionIdentityLookups += 1;
          return null;
        },
        findUserByUnionId: async () => {
          unionUserLookups += 1;
          return null;
        },
        upsertAppIdentity: async (input) => {
          upserted = input;
          return makeIdentity(input);
        },
      },
    );

    expect(unionIdentityLookups).toBe(0);
    expect(unionUserLookups).toBe(0);
    expect(upserted?.userId).toBeNull();
  });
});
