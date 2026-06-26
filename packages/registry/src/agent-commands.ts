import { and, eq } from 'drizzle-orm';
import type { Database } from '@open-tag/storage';
import {
  agentBotBindings,
  agentProfiles,
  agents,
  chatConfigs,
  feishuApps,
  resolveActiveAgentByHandle,
} from '@open-tag/storage';
import { syncAgentManifests } from './agent-sync.js';

export interface AgentListItem {
  handle: string;
  displayName: string;
  visibility: string;
  status: string;
}

export interface AgentInfo {
  handle: string;
  displayName: string;
  description: string | null;
  visibility: string;
  status: string;
  profileName: string | null;
  boundAppId: string | null;
}

export interface AgentCommandMutationResult {
  ok: boolean;
  message: string;
}

export interface AgentCommandServices {
  listAgents(): Promise<AgentListItem[]>;
  getAgentInfo(handle: string): Promise<AgentInfo | null>;
  syncAgents(): Promise<{ scanned: number; synced: Array<{ handle: string }> }>;
  bindBot(handle: string, appId: string): Promise<AgentCommandMutationResult>;
  unbindBot(handle: string): Promise<AgentCommandMutationResult>;
  setDefaultAgent(handle: string): Promise<AgentCommandMutationResult>;
}

export interface AgentCommandContext {
  canManageAgents: boolean;
}

export interface AgentCommandResult {
  message: string;
  mutated: boolean;
}

const MUTATING_AGENT_SUBCOMMANDS = new Set(['sync', 'bind-bot', 'unbind-bot', 'default']);

export const AGENT_COMMAND_HELP = [
  '/agent — Manage OpenClaudeTag agents',
  '',
  'Usage:',
  '  /agent list',
  '  /agent info <handle>',
  '  /agent sync',
  '  /agent bind-bot <handle> <app_id>',
  '  /agent unbind-bot <handle>',
  '  /agent default <handle>',
].join('\n');

export async function handleAgentCommand(
  args: string,
  context: AgentCommandContext,
  services: AgentCommandServices,
): Promise<AgentCommandResult> {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const subCommand = parts[0] ?? 'list';
  const mutated = MUTATING_AGENT_SUBCOMMANDS.has(subCommand);

  if (subCommand === '--help' || subCommand === 'help') {
    return { message: AGENT_COMMAND_HELP, mutated: false };
  }

  if (mutated && !context.canManageAgents) {
    return {
      message: 'Permission denied: /agent mutations require MANAGE_AGENTS or owner role.',
      mutated: false,
    };
  }

  if (subCommand === 'list') {
    const agents = await services.listAgents();
    if (agents.length === 0) {
      return { message: 'No active agents registered.', mutated: false };
    }
    return {
      message: agents
        .map((agent) => `• ${agent.handle} — ${agent.displayName} [${agent.visibility}]`)
        .join('\n'),
      mutated: false,
    };
  }

  if (subCommand === 'info') {
    const handle = parts[1];
    if (!handle) {
      return { message: 'Usage: /agent info <handle>', mutated: false };
    }
    const info = await services.getAgentInfo(handle);
    if (!info) {
      return { message: `Agent not found: ${handle}`, mutated: false };
    }
    return {
      message: [
        `Agent: ${info.handle}`,
        `Name: ${info.displayName}`,
        `Visibility: ${info.visibility}`,
        `Status: ${info.status}`,
        `Profile: ${info.profileName ?? '(missing)'}`,
        `Feishu app: ${info.boundAppId ?? '(unbound)'}`,
        ...(info.description ? [`Description: ${info.description}`] : []),
      ].join('\n'),
      mutated: false,
    };
  }

  if (subCommand === 'sync') {
    const result = await services.syncAgents();
    return {
      message: `Agent sync complete: ${result.scanned} manifest(s), ${result.synced.length} agent(s) synced.`,
      mutated: true,
    };
  }

  if (subCommand === 'bind-bot') {
    const [handle, appId] = parts.slice(1);
    if (!handle || !appId) {
      return { message: 'Usage: /agent bind-bot <handle> <app_id>', mutated: false };
    }
    const result = await services.bindBot(handle, appId);
    return { message: result.message, mutated: result.ok };
  }

  if (subCommand === 'unbind-bot') {
    const handle = parts[1];
    if (!handle) {
      return { message: 'Usage: /agent unbind-bot <handle>', mutated: false };
    }
    const result = await services.unbindBot(handle);
    return { message: result.message, mutated: result.ok };
  }

  if (subCommand === 'default') {
    const handle = parts[1];
    if (!handle) {
      return { message: 'Usage: /agent default <handle>', mutated: false };
    }
    const result = await services.setDefaultAgent(handle);
    return { message: result.message, mutated: result.ok };
  }

  return { message: AGENT_COMMAND_HELP, mutated: false };
}

export interface StorageAgentCommandServiceOptions {
  repoRoot: string;
  tenantKey: string;
  chatId: string;
}

export function createStorageAgentCommandServices(
  db: Database,
  options: StorageAgentCommandServiceOptions,
): AgentCommandServices {
  async function findAgent(handle: string) {
    return resolveActiveAgentByHandle(db, { tenantKey: options.tenantKey, handle });
  }

  return {
    async listAgents() {
      return db
        .select({
          handle: agents.handle,
          displayName: agents.displayName,
          visibility: agents.visibility,
          status: agents.status,
        })
        .from(agents)
        .where(and(eq(agents.tenantKey, options.tenantKey), eq(agents.status, 'active')));
    },
    async getAgentInfo(handle) {
      const agent = await findAgent(handle);
      if (!agent) return null;

      const [profile] = await db
        .select({ name: agentProfiles.name })
        .from(agentProfiles)
        .where(eq(agentProfiles.id, agent.profileId))
        .limit(1);
      const [binding] = await db
        .select({ appId: feishuApps.appId })
        .from(agentBotBindings)
        .innerJoin(feishuApps, eq(agentBotBindings.feishuAppId, feishuApps.id))
        .where(and(eq(agentBotBindings.agentId, agent.id), eq(agentBotBindings.status, 'active')))
        .limit(1);

      return {
        handle: agent.handle,
        displayName: agent.displayName,
        description: agent.description,
        visibility: agent.visibility,
        status: agent.status,
        profileName: profile?.name ?? null,
        boundAppId: binding?.appId ?? null,
      };
    },
    async syncAgents() {
      return syncAgentManifests(db, {
        repoRoot: options.repoRoot,
        tenantKey: options.tenantKey,
      });
    },
    async bindBot(handle, appId) {
      const agent = await findAgent(handle);
      if (!agent) {
        return { ok: false, message: `Agent not found: ${handle}` };
      }

      const [app] = await db
        .select({
          id: feishuApps.id,
          status: feishuApps.status,
          appId: feishuApps.appId,
          tenantKey: feishuApps.tenantKey,
        })
        .from(feishuApps)
        .where(and(eq(feishuApps.appId, appId), eq(feishuApps.tenantKey, options.tenantKey)))
        .limit(1);
      if (!app || app.status !== 'enabled') {
        return {
          ok: false,
          message: `Enabled Feishu app not found in tenant ${options.tenantKey}: ${appId}`,
        };
      }
      if (app.tenantKey !== agent.tenantKey) {
        return {
          ok: false,
          message: `Feishu app ${appId} cannot be bound to agent ${handle} across tenants.`,
        };
      }

      const [appBinding] = await db
        .select({ id: agentBotBindings.id, agentId: agentBotBindings.agentId })
        .from(agentBotBindings)
        .where(
          and(eq(agentBotBindings.feishuAppId, app.id), eq(agentBotBindings.status, 'active')),
        )
        .limit(1);
      if (appBinding && appBinding.agentId !== agent.id) {
        return { ok: false, message: `Feishu app already bound to another agent: ${appId}` };
      }
      if (appBinding?.agentId === agent.id) {
        return { ok: true, message: `Agent ${handle} is already bound to ${appId}.` };
      }

      const [agentBinding] = await db
        .select({ id: agentBotBindings.id })
        .from(agentBotBindings)
        .where(and(eq(agentBotBindings.agentId, agent.id), eq(agentBotBindings.status, 'active')))
        .limit(1);
      if (agentBinding) {
        return { ok: false, message: `Agent ${handle} already has an active bot binding.` };
      }

      await db.insert(agentBotBindings).values({
        agentId: agent.id,
        feishuAppId: app.id,
        status: 'active',
      });
      return { ok: true, message: `Agent ${handle} bound to Feishu app ${appId}.` };
    },
    async unbindBot(handle) {
      const agent = await findAgent(handle);
      if (!agent) {
        return { ok: false, message: `Agent not found: ${handle}` };
      }

      const disabled = await db
        .update(agentBotBindings)
        .set({ status: 'disabled', updatedAt: new Date() })
        .where(and(eq(agentBotBindings.agentId, agent.id), eq(agentBotBindings.status, 'active')))
        .returning({ id: agentBotBindings.id });
      if (disabled.length === 0) {
        return { ok: false, message: `Agent ${handle} has no active bot binding.` };
      }
      return { ok: true, message: `Agent ${handle} bot binding disabled.` };
    },
    async setDefaultAgent(handle) {
      const agent = await findAgent(handle);
      if (!agent) {
        return { ok: false, message: `Agent not found: ${handle}` };
      }

      await db
        .insert(chatConfigs)
        .values({
          tenantKey: options.tenantKey,
          chatId: options.chatId,
          defaultAgentId: agent.id,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [chatConfigs.tenantKey, chatConfigs.chatId],
          set: {
            defaultAgentId: agent.id,
            updatedAt: new Date(),
          },
        });
      return { ok: true, message: `Default agent for this chat set to ${handle}.` };
    },
  };
}
