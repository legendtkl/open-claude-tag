import { getTableConfig, type AnyPgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import {
  agentBotBindings,
  agentDelegations,
  admissionLeases,
  agentProfiles,
  agentSessionStates,
  agents,
  chatConfigs,
  chatMemoryEntries,
  delegationTrees,
  discussionParticipants,
  discussions,
  discussionTurns,
  feishuCardActionReceipts,
  feishuApps,
  feishuWebhookReceipts,
  inboundEvents,
  machinePairingTokens,
  machines,
  messages,
  sessions,
  taskRunEvents,
  taskSteps,
  tasks,
  userIdentities,
} from '../schema.js';

function summarizeIndexes(table: AnyPgTable) {
  return getTableConfig(table).indexes.map((index) => ({
    name: index.config.name,
    unique: index.config.unique,
    columns: index.config.columns.map((column) => {
      const namedColumn = column as { name?: string };
      return namedColumn.name ?? '<expression>';
    }),
    where: Boolean(index.config.where),
  }));
}

describe('agent identity schema', () => {
  it('exports first-class agent identity tables', () => {
    expect(agentProfiles.id).toBeDefined();
    expect(agents.handle).toBeDefined();
    expect(feishuApps.appSecretRef).toBeDefined();
    expect(feishuApps.appSecret).toBeDefined();
    expect(agentBotBindings.feishuAppId).toBeDefined();
    expect(agentSessionStates.sdkSessionId).toBeDefined();
    expect(userIdentities.openId).toBeDefined();
    expect(agentDelegations.parentTaskId).toBeDefined();
    expect(taskRunEvents.eventType).toBeDefined();
    expect(agentDelegations.treeId).toBeDefined();
    expect(agentDelegations.parentDelegationId).toBeDefined();
    expect(agentDelegations.depth).toBeDefined();
    expect(agentDelegations.childSessionId).toBeDefined();
    expect(delegationTrees.rootTaskId).toBeDefined();
    expect(admissionLeases.taskId).toBeDefined();
    expect(admissionLeases.jobData).toBeDefined();
    expect(discussions.sessionId).toBeDefined();
    expect(discussionParticipants.orderIndex).toBeDefined();
    expect(discussionTurns.turnIndex).toBeDefined();
    expect(feishuWebhookReceipts.nonce.notNull).toBe(true);
    expect(feishuCardActionReceipts.dedupKey.notNull).toBe(true);
    expect(chatMemoryEntries.tenantKey.notNull).toBe(true);
    expect(chatMemoryEntries.chatId.notNull).toBe(true);
    expect(chatMemoryEntries.entryType.notNull).toBe(true);
    expect(chatMemoryEntries.keywords.notNull).toBe(true);
  });

  it('exports remote-execution machine tables and binding columns', () => {
    expect(machines.id).toBeDefined();
    expect(machines.tenantKey.notNull).toBe(true);
    // D-A7: legacy openId ownership is now nullable; console ownership is primary.
    expect(machines.ownerOpenId.notNull).toBe(false);
    expect(machines.platformOwnerId.notNull).toBe(false);
    expect(machines.name.notNull).toBe(true);
    expect(machines.secretHash.notNull).toBe(true);
    expect(machines.status.notNull).toBe(true);
    expect(machines.capabilities.notNull).toBe(true);
    expect(machines.lastSeenAt.notNull).toBe(false);
    // D-A9: server-initiated disconnect signal (nullable; set on console disconnect).
    expect(machines.disconnectRequestedAt.notNull).toBe(false);

    expect(machinePairingTokens.id).toBeDefined();
    expect(machinePairingTokens.tokenHash.notNull).toBe(true);
    expect(machinePairingTokens.tenantKey.notNull).toBe(true);
    // D-A7: console-issued tokens carry no openId/chat — both nullable.
    expect(machinePairingTokens.platformIssuerId.notNull).toBe(false);
    expect(machinePairingTokens.issuerOpenId.notNull).toBe(false);
    expect(machinePairingTokens.chatId.notNull).toBe(false);
    expect(machinePairingTokens.machineName.notNull).toBe(false);
    expect(machinePairingTokens.expiresAt.notNull).toBe(true);
    expect(machinePairingTokens.usedAt.notNull).toBe(false);

    // Machine-routing columns added to existing tables (design D6/§5).
    expect(sessions.boundMachineId.notNull).toBe(false);
    expect(chatConfigs.defaultMachineId.notNull).toBe(false);
    expect(chatConfigs.memoryEnabled.notNull).toBe(true);
    expect(chatConfigs.memorySummaryAgentId.notNull).toBe(false);
    expect(chatConfigs.memorySummaryTimezone.notNull).toBe(true);
    expect(tasks.executedOnMachineId.notNull).toBe(false);
    // D-A8: agents are bound to a machine (NULL = server-local).
    expect(agents.machineId.notNull).toBe(false);
    expect(agents.runtimeEnv.notNull).toBe(true);
  });

  it('indexes the agent machine binding for routing lookups (D-A8)', () => {
    expect(summarizeIndexes(agents)).toEqual(
      expect.arrayContaining([
        {
          name: 'idx_agents_machine',
          unique: false,
          columns: ['machine_id'],
          where: false,
        },
      ]),
    );
  });

  it('enforces per-owner machine name uniqueness and pairing-token hash uniqueness', () => {
    expect(summarizeIndexes(machines)).toEqual(
      expect.arrayContaining([
        {
          name: 'idx_machines_owner_name',
          unique: true,
          columns: ['tenant_key', 'owner_open_id', 'name'],
          where: false,
        },
      ]),
    );
    expect(machinePairingTokens.tokenHash.isUnique).toBe(true);
  });

  it('enforces a partial unique index on console-owned machine names (R2-7)', () => {
    // App-layer name uniqueness alone was racy for console machines (owner_open_id
    // is NULL, so idx_machines_owner_name does not catch them). The partial unique
    // index closes the gap at the DB layer for platform_owner_id NOT NULL rows.
    expect(summarizeIndexes(machines)).toEqual(
      expect.arrayContaining([
        {
          name: 'idx_machines_platform_owner_name',
          unique: true,
          columns: ['tenant_key', 'platform_owner_id', 'name'],
          where: true,
        },
      ]),
    );
  });

  it('adds nullable console ownership to agent_profiles (R2-6)', () => {
    // NULL = a builtin/shared profile (superadmin-only to mutate); a console-
    // created profile is stamped with its creator's platform user.
    expect(agentProfiles.platformOwnerId.notNull).toBe(false);
    expect(summarizeIndexes(agentProfiles)).toEqual(
      expect.arrayContaining([
        {
          name: 'idx_agent_profiles_platform_owner',
          unique: false,
          columns: ['platform_owner_id'],
          where: false,
        },
      ]),
    );
  });

  it('keeps legacy task/message/step rows compatible with nullable agent fields', () => {
    expect(tasks.agentId.notNull).toBe(false);
    expect(tasks.feishuAppId.notNull).toBe(false);
    expect(messages.agentId.notNull).toBe(false);
    expect(messages.feishuAppId.notNull).toBe(false);
    expect(taskSteps.agentId.notNull).toBe(false);
  });

  it('supports app-scoped inbound event identity without requiring legacy callers to pass an app id', () => {
    expect(inboundEvents.id.primary).toBe(true);
    expect(inboundEvents.eventId.notNull).toBe(true);
    expect(inboundEvents.feishuAppId.notNull).toBe(false);
  });

  it('persists ordered runtime events for task execution traces', () => {
    expect(taskRunEvents.taskId.notNull).toBe(true);
    expect(taskRunEvents.runId.notNull).toBe(true);
    expect(taskRunEvents.eventIndex.notNull).toBe(true);
    expect(taskRunEvents.payload.notNull).toBe(true);
    expect(summarizeIndexes(taskRunEvents)).toEqual(
      expect.arrayContaining([
        {
          name: 'idx_task_run_events_run_index',
          unique: true,
          columns: ['run_id', 'event_index'],
          where: false,
        },
        {
          name: 'idx_task_run_events_task',
          unique: false,
          columns: ['task_id', 'created_at'],
          where: false,
        },
      ]),
    );
  });

  it('defines uniqueness boundaries for agent routing, app deduplication, and session state', () => {
    expect(summarizeIndexes(agents)).toEqual(
      expect.arrayContaining([
        // Console-owned agents: handle unique per owner (partial, owner NOT NULL).
        {
          name: 'idx_agents_owner_handle',
          unique: true,
          columns: ['tenant_key', 'platform_owner_id', 'handle'],
          where: true,
        },
        // ops / built-in agents (owner NULL): legacy scope-level uniqueness, kept
        // partial so the bootstrap/sync upsert still has a unique target.
        {
          name: 'idx_agents_scope_handle',
          unique: true,
          columns: ['tenant_key', 'scope_type', 'scope_id', 'handle'],
          where: true,
        },
      ]),
    );

    expect(summarizeIndexes(agentBotBindings)).toEqual(
      expect.arrayContaining([
        {
          name: 'idx_agent_bot_bindings_active_agent',
          unique: true,
          columns: ['agent_id'],
          where: true,
        },
        {
          name: 'idx_agent_bot_bindings_active_app',
          unique: true,
          columns: ['feishu_app_id'],
          where: true,
        },
      ]),
    );

    // Dedup uniqueness moved to a table-level UNIQUE NULLS NOT DISTINCT
    // constraint (migration 0029): a NULL feishu_app_id is one dedup scope.
    const inboundEventUniques = getTableConfig(inboundEvents).uniqueConstraints.map((u) => ({
      name: u.name,
      columns: u.columns.map((column) => (column as { name?: string }).name ?? '<expression>'),
      nullsNotDistinct: u.nullsNotDistinct,
    }));
    expect(inboundEventUniques).toEqual(
      expect.arrayContaining([
        {
          name: 'idx_inbound_events_app_event',
          columns: ['feishu_app_id', 'event_id'],
          nullsNotDistinct: true,
        },
      ]),
    );

    expect(summarizeIndexes(feishuWebhookReceipts)).toEqual(
      expect.arrayContaining([
        {
          name: 'idx_feishu_webhook_receipts_nonce',
          unique: true,
          columns: ['nonce'],
          where: false,
        },
      ]),
    );

    expect(summarizeIndexes(feishuCardActionReceipts)).toEqual(
      expect.arrayContaining([
        {
          name: 'idx_feishu_card_action_receipts_dedup',
          unique: true,
          columns: ['dedup_key'],
          where: false,
        },
      ]),
    );

    expect(summarizeIndexes(agentSessionStates)).toEqual(
      expect.arrayContaining([
        {
          name: 'idx_agent_session_states_agent_session',
          unique: true,
          columns: ['agent_id', 'session_id'],
          where: false,
        },
      ]),
    );

    expect(summarizeIndexes(userIdentities)).toEqual(
      expect.arrayContaining([
        {
          name: 'idx_user_identities_app_open',
          unique: true,
          columns: ['feishu_app_id', 'open_id'],
          where: false,
        },
      ]),
    );

    expect(summarizeIndexes(admissionLeases)).toEqual(
      expect.arrayContaining([
        {
          name: 'idx_admission_leases_due',
          unique: false,
          columns: ['not_before'],
          where: false,
        },
      ]),
    );

    expect(summarizeIndexes(delegationTrees)).toEqual(
      expect.arrayContaining([
        {
          name: 'idx_delegation_trees_root_task',
          unique: true,
          columns: ['root_task_id'],
          where: false,
        },
      ]),
    );

    expect(summarizeIndexes(discussions)).toEqual(
      expect.arrayContaining([
        {
          name: 'idx_discussions_session',
          unique: true,
          columns: ['session_id'],
          where: false,
        },
        {
          name: 'idx_discussions_root',
          unique: true,
          columns: ['tenant_key', 'chat_id', 'root_thread_id'],
          where: false,
        },
        {
          name: 'idx_discussions_chat_status',
          unique: false,
          columns: ['tenant_key', 'chat_id', 'status'],
          where: false,
        },
      ]),
    );

    expect(summarizeIndexes(discussionParticipants)).toEqual(
      expect.arrayContaining([
        {
          name: 'idx_discussion_participants_order',
          unique: true,
          columns: ['discussion_id', 'order_index'],
          where: false,
        },
        {
          name: 'idx_discussion_participants_feishu_app',
          unique: false,
          columns: ['feishu_app_id'],
          where: false,
        },
      ]),
    );

    expect(summarizeIndexes(discussionTurns)).toEqual(
      expect.arrayContaining([
        {
          name: 'idx_discussion_turns_position',
          unique: true,
          columns: ['discussion_id', 'round', 'turn_index'],
          where: false,
        },
        {
          name: 'idx_discussion_turns_task',
          unique: true,
          columns: ['task_id'],
          where: false,
        },
      ]),
    );

    expect(summarizeIndexes(agentDelegations)).toEqual(
      expect.arrayContaining([
        {
          name: 'idx_agent_delegations_tree',
          unique: false,
          columns: ['tree_id'],
          where: false,
        },
        {
          name: 'idx_agent_delegations_parent_task',
          unique: false,
          columns: ['parent_task_id'],
          where: false,
        },
      ]),
    );
  });
});
