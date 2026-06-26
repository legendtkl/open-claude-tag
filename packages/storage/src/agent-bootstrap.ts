import { and, eq, isNull } from 'drizzle-orm';
import type { Database } from './db.js';
import { agentBotBindings, agentProfiles, agents, feishuApps } from './schema.js';

export const BUILTIN_AGENT_PROFILE_NAME = 'open-claude-tag';
export const BUILTIN_AGENT_HANDLE = 'open-claude-tag';
export const PRIMARY_FEISHU_APP_SECRET_REF = 'FEISHU_APP_SECRET';

export interface BuiltInAgentSeedConfig {
  tenantKey?: string;
  primaryFeishuAppId?: string;
  primaryFeishuAppSecretRef?: string;
  primaryFeishuBotOpenId?: string;
  primaryFeishuBotName?: string;
}

export interface BuiltInAgentSeedRows {
  profile: {
    name: string;
    displayName: string;
    description: string;
    sourceType: string;
    status: string;
  };
  agent: {
    tenantKey: string;
    scopeType: string;
    scopeId: string;
    handle: string;
    displayName: string;
    description: string;
    visibility: string;
    status: string;
  };
  feishuApp?: {
    tenantKey: string;
    appId: string;
    appSecretRef: string;
    botOpenId?: string;
    botName?: string;
    eventMode: string;
    status: string;
  };
}

export function buildBuiltInAgentSeedRows(
  config: BuiltInAgentSeedConfig = {},
): BuiltInAgentSeedRows {
  const tenantKey = config.tenantKey ?? 'default';
  const primaryFeishuAppId = config.primaryFeishuAppId?.trim();
  const primaryFeishuAppSecretRef =
    config.primaryFeishuAppSecretRef?.trim() || PRIMARY_FEISHU_APP_SECRET_REF;

  return {
    profile: {
      name: BUILTIN_AGENT_PROFILE_NAME,
      displayName: 'OpenClaudeTag',
      description: 'Default OpenClaudeTag engineering assistant profile.',
      sourceType: 'builtin',
      status: 'active',
    },
    agent: {
      tenantKey,
      scopeType: 'system',
      scopeId: 'default',
      handle: BUILTIN_AGENT_HANDLE,
      displayName: 'OpenClaudeTag',
      description: 'Default OpenClaudeTag engineering assistant.',
      visibility: 'public',
      status: 'active',
    },
    ...(primaryFeishuAppId
      ? {
          feishuApp: {
            tenantKey,
            appId: primaryFeishuAppId,
            appSecretRef: primaryFeishuAppSecretRef,
            botOpenId: config.primaryFeishuBotOpenId?.trim() || undefined,
            botName: config.primaryFeishuBotName?.trim() || 'OpenClaudeTag',
            eventMode: 'websocket',
            status: 'enabled',
          },
        }
      : {}),
  };
}

export async function seedBuiltInAgentIdentity(
  db: Database,
  config: BuiltInAgentSeedConfig = {},
): Promise<{ profileId: string; agentId: string; feishuAppId?: string; bindingId?: string }> {
  const rows = buildBuiltInAgentSeedRows(config);

  const [profile] = await db
    .insert(agentProfiles)
    .values(rows.profile)
    .onConflictDoUpdate({
      target: agentProfiles.name,
      set: {
        displayName: rows.profile.displayName,
        description: rows.profile.description,
        sourceType: rows.profile.sourceType,
        status: rows.profile.status,
        updatedAt: new Date(),
      },
    })
    .returning({ id: agentProfiles.id });

  const [agent] = await db
    .insert(agents)
    .values({
      ...rows.agent,
      profileId: profile.id,
    })
    .onConflictDoUpdate({
      // Built-in agents carry a NULL platform_owner_id, so they conflict on the
      // partial `idx_agents_scope_handle` index (WHERE platform_owner_id IS NULL).
      // The targetWhere predicate must match that partial index for ON CONFLICT.
      target: [agents.tenantKey, agents.scopeType, agents.scopeId, agents.handle],
      targetWhere: isNull(agents.platformOwnerId),
      set: {
        displayName: rows.agent.displayName,
        description: rows.agent.description,
        profileId: profile.id,
        visibility: rows.agent.visibility,
        status: rows.agent.status,
        updatedAt: new Date(),
      },
    })
    .returning({ id: agents.id });

  if (!rows.feishuApp) {
    return { profileId: profile.id, agentId: agent.id };
  }

  const [feishuApp] = await db
    .insert(feishuApps)
    .values(rows.feishuApp)
    .onConflictDoUpdate({
      target: feishuApps.appId,
      set: {
        tenantKey: rows.feishuApp.tenantKey,
        appSecretRef: rows.feishuApp.appSecretRef,
        botOpenId: rows.feishuApp.botOpenId,
        botName: rows.feishuApp.botName,
        eventMode: rows.feishuApp.eventMode,
        status: rows.feishuApp.status,
        updatedAt: new Date(),
      },
    })
    .returning({ id: feishuApps.id });

  const [existingBinding] = await db
    .select({ id: agentBotBindings.id })
    .from(agentBotBindings)
    .where(
      and(
        eq(agentBotBindings.agentId, agent.id),
        eq(agentBotBindings.feishuAppId, feishuApp.id),
        eq(agentBotBindings.status, 'active'),
      ),
    )
    .limit(1);

  if (existingBinding) {
    return {
      profileId: profile.id,
      agentId: agent.id,
      feishuAppId: feishuApp.id,
      bindingId: existingBinding.id,
    };
  }

  const [binding] = await db
    .insert(agentBotBindings)
    .values({
      agentId: agent.id,
      feishuAppId: feishuApp.id,
      botOpenId: rows.feishuApp.botOpenId,
      status: 'active',
    })
    .returning({ id: agentBotBindings.id });

  return {
    profileId: profile.id,
    agentId: agent.id,
    feishuAppId: feishuApp.id,
    bindingId: binding.id,
  };
}
