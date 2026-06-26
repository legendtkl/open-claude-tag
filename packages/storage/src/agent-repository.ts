import { and, eq, getTableColumns, isNotNull, or, sql, type SQL } from 'drizzle-orm';
import type { Database } from './db.js';
import {
  agentBotBindings,
  agentSessionStates,
  agents,
  chatConfigs,
  feishuApps,
  userIdentities,
  users,
} from './schema.js';

export type AgentRecord = typeof agents.$inferSelect;
export type AgentSessionStateRecord = typeof agentSessionStates.$inferSelect;
export type UserIdentityRecord = typeof userIdentities.$inferSelect;

export type AgentRouteSource = 'bot_binding' | 'virtual_handle' | 'chat_default' | 'builtin';

export interface AgentAccessContext {
  userId?: string | null;
  role?: string | null;
}

export interface ResolveActiveAgentByHandleInput {
  tenantKey: string;
  handle: string;
  scopeType?: string;
  scopeId?: string;
  access?: AgentAccessContext;
}

export interface ResolveAgentRouteInput {
  tenantKey: string;
  chatId?: string;
  feishuAppId?: string;
  virtualHandle?: string;
  access?: AgentAccessContext;
  allowDefaultBuiltInFallback?: boolean;
}

export interface AgentRouteResolution {
  source: AgentRouteSource;
  agent: AgentRecord;
  feishuAppId?: string;
}

export interface AgentRouteLoaders {
  findByBotBinding(feishuAppId: string): Promise<AgentRecord | null>;
  findByHandle(handle: string): Promise<AgentRecord | null>;
  findChatDefault(chatId: string): Promise<AgentRecord | null>;
  findBuiltIn(allowDefaultTenantFallback?: boolean): Promise<AgentRecord | null>;
}

export interface LoadAgentSessionStateInput {
  agentId: string;
  sessionId: string;
}

export interface UpsertAgentSessionStateInput extends LoadAgentSessionStateInput {
  runtimeBackend?: string | null;
  sdkSessionId?: string | null;
  /**
   * The machine that produced `sdkSessionId` (NULL = server-local). Written in
   * the same upsert as `sdkSessionId` so the D15 substrate-switch check can read
   * back the substrate that owns the stored SDK state.
   */
  sdkSessionMachineId?: string | null;
  workspacePath?: string | null;
  worktreeBranch?: string | null;
  adhocWorkDir?: string | null;
  summary?: string | null;
  lastRunAt?: Date | null;
}

export interface ResolveUserIdentityInput {
  tenantKey: string;
  feishuAppId: string;
  openId: string;
  unionId?: string | null;
  displayName?: string | null;
}

export interface UpsertUserIdentityInput extends ResolveUserIdentityInput {
  userId: string | null;
}

export interface UserIdentityLoaders {
  findExistingAppIdentity(input: ResolveUserIdentityInput): Promise<UserIdentityRecord | null>;
  findIdentityByUnionId(tenantKey: string, unionId: string): Promise<UserIdentityRecord | null>;
  findUserByUnionId(unionId: string): Promise<{ id: string } | null>;
  upsertAppIdentity(input: UpsertUserIdentityInput): Promise<UserIdentityRecord>;
}

export class AgentRouteNotFoundError extends Error {
  constructor(message = 'No active agent route could be resolved') {
    super(message);
    this.name = 'AgentRouteNotFoundError';
  }
}

export class AgentAccessDeniedError extends Error {
  constructor(agent: AgentRecord) {
    super(`User is not allowed to route to private agent "${agent.handle}"`);
    this.name = 'AgentAccessDeniedError';
  }
}

const agentColumns = getTableColumns(agents);

export function isAgentVisibleToUser(agent: AgentRecord, access?: AgentAccessContext): boolean {
  if (agent.visibility !== 'private') {
    return true;
  }

  if (access?.role === 'owner' || access?.role === 'admin') {
    return true;
  }

  return Boolean(access?.userId && agent.ownerUserId === access.userId);
}

export function requireAgentVisible(
  agent: AgentRecord | null,
  access?: AgentAccessContext,
): AgentRecord | null {
  if (!agent) {
    return null;
  }

  if (!isAgentVisibleToUser(agent, access)) {
    throw new AgentAccessDeniedError(agent);
  }

  return agent;
}

export async function resolveAgentRouteFromLoaders(
  input: ResolveAgentRouteInput,
  loaders: AgentRouteLoaders,
): Promise<AgentRouteResolution> {
  if (input.feishuAppId) {
    const boundAgent = requireAgentVisible(
      await loaders.findByBotBinding(input.feishuAppId),
      input.access,
    );
    if (boundAgent) {
      return {
        source: 'bot_binding',
        agent: boundAgent,
        feishuAppId: input.feishuAppId,
      };
    }
  }

  const virtualHandle = input.virtualHandle?.trim();
  if (virtualHandle) {
    const virtualAgent = requireAgentVisible(await loaders.findByHandle(virtualHandle), input.access);
    if (virtualAgent) {
      return { source: 'virtual_handle', agent: virtualAgent, feishuAppId: input.feishuAppId };
    }
  }

  if (input.chatId) {
    const defaultAgent = requireAgentVisible(await loaders.findChatDefault(input.chatId), input.access);
    if (defaultAgent) {
      return { source: 'chat_default', agent: defaultAgent, feishuAppId: input.feishuAppId };
    }
  }

  const builtInAgent = requireAgentVisible(
    await loaders.findBuiltIn(input.allowDefaultBuiltInFallback ?? false),
    input.access,
  );
  if (builtInAgent) {
    return { source: 'builtin', agent: builtInAgent, feishuAppId: input.feishuAppId };
  }

  throw new AgentRouteNotFoundError();
}

export async function resolveActiveAgentByHandle(
  db: Database,
  input: ResolveActiveAgentByHandleInput,
): Promise<AgentRecord | null> {
  const conditions: SQL[] = [
    eq(agents.tenantKey, input.tenantKey),
    eq(agents.handle, input.handle),
    eq(agents.status, 'active'),
  ];

  if (input.scopeType) {
    conditions.push(eq(agents.scopeType, input.scopeType));
  }
  if (input.scopeId) {
    conditions.push(eq(agents.scopeId, input.scopeId));
  }

  const [agent] = await db
    .select(agentColumns)
    .from(agents)
    .where(and(...conditions))
    .orderBy(
      sql`case
        when ${agents.scopeType} = 'system' then 0
        when ${agents.scopeType} = 'tenant' then 1
        when ${agents.scopeType} = 'chat' then 2
        when ${agents.scopeType} = 'user' then 3
        else 4
      end`,
      agents.createdAt,
    )
    .limit(1);
  return requireAgentVisible(agent ?? null, input.access);
}

export async function resolveActiveAgentByBotBinding(
  db: Database,
  input: { feishuAppId: string; tenantKey: string },
  access?: AgentAccessContext,
): Promise<AgentRecord | null> {
  const [agent] = await db
    .select(agentColumns)
    .from(agentBotBindings)
    .innerJoin(agents, eq(agentBotBindings.agentId, agents.id))
    .innerJoin(feishuApps, eq(agentBotBindings.feishuAppId, feishuApps.id))
    .where(
      and(
        eq(agentBotBindings.feishuAppId, input.feishuAppId),
        eq(agentBotBindings.status, 'active'),
        eq(agents.status, 'active'),
        eq(feishuApps.status, 'enabled'),
        eq(agents.tenantKey, feishuApps.tenantKey),
        or(eq(feishuApps.tenantKey, input.tenantKey), eq(feishuApps.tenantKey, 'default')),
      ),
    )
    .limit(1);

  return requireAgentVisible(agent ?? null, access);
}

export async function resolveDefaultAgentForChat(
  db: Database,
  tenantKey: string,
  chatId: string,
  access?: AgentAccessContext,
): Promise<AgentRecord | null> {
  const [agent] = await db
    .select(agentColumns)
    .from(chatConfigs)
    .innerJoin(agents, eq(chatConfigs.defaultAgentId, agents.id))
    .where(
      and(
        eq(chatConfigs.tenantKey, tenantKey),
        eq(chatConfigs.chatId, chatId),
        eq(agents.status, 'active'),
      ),
    )
    .limit(1);

  return requireAgentVisible(agent ?? null, access);
}

export async function resolveBuiltInAgent(
  db: Database,
  tenantKey: string,
  access?: AgentAccessContext,
  options: { allowDefaultTenantFallback?: boolean } = {},
): Promise<AgentRecord | null> {
  const tenantKeys =
    tenantKey === 'default' || !options.allowDefaultTenantFallback
      ? [tenantKey]
      : [tenantKey, 'default'];

  for (const candidateTenantKey of tenantKeys) {
    const agent = await findBuiltInAgentForTenant(db, candidateTenantKey);
    if (agent) {
      return requireAgentVisible(agent, access);
    }
  }

  return null;
}

async function findBuiltInAgentForTenant(
  db: Database,
  tenantKey: string,
): Promise<AgentRecord | null> {
  const [agent] = await db
    .select(agentColumns)
    .from(agents)
    .where(
      and(
        eq(agents.tenantKey, tenantKey),
        eq(agents.scopeType, 'system'),
        eq(agents.scopeId, 'default'),
        eq(agents.handle, 'open-claude-tag'),
        eq(agents.status, 'active'),
      ),
    )
    .limit(1);

  return agent ?? null;
}

export function createAgentRouteLoaders(db: Database, tenantKey: string): AgentRouteLoaders {
  return {
    findByBotBinding: (feishuAppId) =>
      resolveActiveAgentByBotBinding(db, { feishuAppId, tenantKey }),
    findByHandle: (handle) => resolveActiveAgentByHandle(db, { tenantKey, handle }),
    findChatDefault: (chatId) => resolveDefaultAgentForChat(db, tenantKey, chatId),
    findBuiltIn: (allowDefaultTenantFallback) =>
      resolveBuiltInAgent(db, tenantKey, undefined, { allowDefaultTenantFallback }),
  };
}

export async function resolveAgentRoute(
  db: Database,
  input: ResolveAgentRouteInput,
): Promise<AgentRouteResolution> {
  return resolveAgentRouteFromLoaders(input, createAgentRouteLoaders(db, input.tenantKey));
}

export async function loadAgentSessionState(
  db: Database,
  input: LoadAgentSessionStateInput,
): Promise<AgentSessionStateRecord | null> {
  const [state] = await db
    .select()
    .from(agentSessionStates)
    .where(
      and(
        eq(agentSessionStates.agentId, input.agentId),
        eq(agentSessionStates.sessionId, input.sessionId),
      ),
    )
    .limit(1);

  return state ?? null;
}

function compactUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  ) as Partial<T>;
}

export async function upsertAgentSessionState(
  db: Database,
  input: UpsertAgentSessionStateInput,
): Promise<AgentSessionStateRecord> {
  const now = new Date();
  const patch = compactUndefined({
    runtimeBackend: input.runtimeBackend,
    sdkSessionId: input.sdkSessionId,
    sdkSessionMachineId: input.sdkSessionMachineId,
    workspacePath: input.workspacePath,
    worktreeBranch: input.worktreeBranch,
    adhocWorkDir: input.adhocWorkDir,
    summary: input.summary,
    lastRunAt: input.lastRunAt,
  });
  const values: typeof agentSessionStates.$inferInsert = {
    agentId: input.agentId,
    sessionId: input.sessionId,
    ...patch,
  };
  const set: Partial<typeof agentSessionStates.$inferInsert> = {
    ...patch,
    updatedAt: now,
  };

  const [state] = await db
    .insert(agentSessionStates)
    .values(values)
    .onConflictDoUpdate({
      target: [agentSessionStates.agentId, agentSessionStates.sessionId],
      set,
    })
    .returning();

  if (!state) {
    throw new Error('Failed to upsert agent session state');
  }

  return state;
}

export async function resolveUserIdentityFromLoaders(
  input: ResolveUserIdentityInput,
  loaders: UserIdentityLoaders,
): Promise<UserIdentityRecord> {
  const existingAppIdentity = await loaders.findExistingAppIdentity(input);
  let userId = existingAppIdentity?.userId ?? null;

  const unionId = input.unionId?.trim();
  if (unionId) {
    const existingUnionIdentity = await loaders.findIdentityByUnionId(input.tenantKey, unionId);
    const existingUnionUser = existingUnionIdentity?.userId
      ? null
      : await loaders.findUserByUnionId(unionId);

    userId = existingUnionIdentity?.userId ?? existingUnionUser?.id ?? userId;
  }

  return loaders.upsertAppIdentity({
    ...input,
    unionId: unionId || input.unionId,
    userId,
  });
}

export async function resolveUserIdentity(
  db: Database,
  input: ResolveUserIdentityInput,
): Promise<UserIdentityRecord> {
  const loaders: UserIdentityLoaders = {
    async findExistingAppIdentity(identityInput) {
      const [identity] = await db
        .select()
        .from(userIdentities)
        .where(
          and(
            eq(userIdentities.feishuAppId, identityInput.feishuAppId),
            eq(userIdentities.openId, identityInput.openId),
          ),
        )
        .limit(1);

      return identity ?? null;
    },
    async findIdentityByUnionId(tenantKey, unionId) {
      const [identity] = await db
        .select()
        .from(userIdentities)
        .where(
          and(
            eq(userIdentities.tenantKey, tenantKey),
            eq(userIdentities.unionId, unionId),
            isNotNull(userIdentities.userId),
          ),
        )
        .limit(1);

      return identity ?? null;
    },
    async findUserByUnionId(unionId) {
      const [user] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.feishuUnionId, unionId))
        .limit(1);

      return user ?? null;
    },
    async upsertAppIdentity(identityInput) {
      const now = new Date();
      const unionId = identityInput.unionId?.trim();
      const displayName = identityInput.displayName?.trim();
      const values: typeof userIdentities.$inferInsert = {
        tenantKey: identityInput.tenantKey,
        feishuAppId: identityInput.feishuAppId,
        openId: identityInput.openId,
        ...(unionId ? { unionId } : {}),
        ...(displayName ? { displayName } : {}),
        ...(identityInput.userId ? { userId: identityInput.userId } : {}),
      };
      const set: Partial<typeof userIdentities.$inferInsert> = compactUndefined({
        tenantKey: identityInput.tenantKey,
        unionId: unionId || undefined,
        displayName: displayName || undefined,
        userId: identityInput.userId ?? undefined,
        updatedAt: now,
      });

      const [identity] = await db
        .insert(userIdentities)
        .values(values)
        .onConflictDoUpdate({
          target: [userIdentities.feishuAppId, userIdentities.openId],
          set,
        })
        .returning();

      if (!identity) {
        throw new Error('Failed to upsert Feishu user identity');
      }

      return identity;
    },
  };

  return resolveUserIdentityFromLoaders(input, loaders);
}
