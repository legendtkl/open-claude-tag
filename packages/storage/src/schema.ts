import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  bigint,
  numeric,
  real,
  boolean,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  unique,
  primaryKey,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// ── 1. users ──
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  feishuOpenId: varchar('feishu_open_id', { length: 64 }).notNull().unique(),
  feishuUnionId: varchar('feishu_union_id', { length: 64 }),
  displayName: varchar('display_name', { length: 128 }),
  role: varchar('role', { length: 16 }).notNull().default('user'),
  preferences: jsonb('preferences').default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── 1a. platform_users ──
// Console (admin) identity domain, distinct from the Feishu `users` domain above.
// Rows are upserted on first request from the local dev-auth login (design D-A6)
// or an SSO provider (upsert-by-SSO pattern). `ssoSub` is the normalized stable
// person-level subject. `role` gates superadmin (ops, sees everything) vs
// user (self-service, owns only what they registered).
export const platformUsers = pgTable(
  'platform_users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ssoSub: text('sso_sub').notNull().unique(),
    email: text('email'),
    displayName: text('display_name'),
    department: text('department'),
    role: varchar('role', { length: 16 }).notNull().default('user'),
    computerAccessEnabled: boolean('computer_access_enabled').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('idx_platform_users_email').on(table.email)],
);

// ── 2. projects ──
export const projects = pgTable('projects', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 128 }).notNull().unique(),
  path: varchar('path', { length: 1024 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── 3. agent_profiles ──
export const agentProfiles = pgTable(
  'agent_profiles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 64 }).notNull(),
    displayName: varchar('display_name', { length: 128 }).notNull(),
    description: text('description'),
    systemPrompt: text('system_prompt'),
    stylePrompt: text('style_prompt'),
    skillRefs: jsonb('skill_refs').notNull().default([]),
    defaultRuntime: varchar('default_runtime', { length: 32 }),
    defaultModel: varchar('default_model', { length: 128 }),
    sourceType: varchar('source_type', { length: 32 }).notNull().default('builtin'),
    sourceUri: varchar('source_uri', { length: 1024 }),
    // Console (SSO) owner of this profile (R2-6). NULL = a builtin/shared profile,
    // mutable by superadmin ONLY (fail-closed, D-A3). A console-created profile is
    // stamped with its creator's platform user; a plain user may mutate ONLY a
    // profile they own (owning an agent that merely *uses* the profile is NOT
    // sufficient — that loophole let a user edit a shared profile for everyone).
    platformOwnerId: uuid('platform_owner_id').references(() => platformUsers.id, {
      onDelete: 'set null',
    }),
    status: varchar('status', { length: 16 }).notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('idx_agent_profiles_name').on(table.name),
    index('idx_agent_profiles_status').on(table.status),
    index('idx_agent_profiles_platform_owner').on(table.platformOwnerId),
  ],
);

// ── 4. feishu_apps ──
export const feishuApps = pgTable(
  'feishu_apps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantKey: varchar('tenant_key', { length: 128 }).notNull().default('default'),
    appId: varchar('app_id', { length: 128 }).notNull(),
    appSecretRef: varchar('app_secret_ref', { length: 256 }).notNull(),
    appSecret: text('app_secret'),
    // Console (SSO) owner of this bot registration (design D-A2). NULL = a
    // legacy/ops-created row, visible to superadmins only (fail-closed, D-A3).
    platformOwnerId: uuid('platform_owner_id').references(() => platformUsers.id, {
      onDelete: 'set null',
    }),
    botOpenId: varchar('bot_open_id', { length: 64 }),
    botName: varchar('bot_name', { length: 128 }),
    eventMode: varchar('event_mode', { length: 32 }).notNull().default('websocket'),
    status: varchar('status', { length: 16 }).notNull().default('enabled'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('idx_feishu_apps_app_id').on(table.appId),
    index('idx_feishu_apps_tenant_status').on(table.tenantKey, table.status),
    index('idx_feishu_apps_bot_open_id').on(table.botOpenId),
  ],
);

// ── 5. agents ──
export const agents = pgTable(
  'agents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantKey: varchar('tenant_key', { length: 128 }).notNull().default('default'),
    scopeType: varchar('scope_type', { length: 16 }).notNull().default('system'),
    scopeId: varchar('scope_id', { length: 256 }).notNull().default('default'),
    handle: varchar('handle', { length: 64 }).notNull(),
    displayName: varchar('display_name', { length: 128 }).notNull(),
    description: text('description'),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => agentProfiles.id, { onDelete: 'restrict' }),
    ownerUserId: uuid('owner_user_id').references(() => users.id, { onDelete: 'set null' }),
    // Console (SSO) owner of this agent (design D-A2). Distinct from the
    // Feishu-domain `ownerUserId` above. NULL = a legacy/ops-created agent,
    // visible to superadmins only (fail-closed, D-A3).
    platformOwnerId: uuid('platform_owner_id').references(() => platformUsers.id, {
      onDelete: 'set null',
    }),
    // Execution machine this agent's tasks run on (design D-A8). NULL = server-local.
    // Set in the console agent create/edit form (the owner's own non-revoked
    // machines + "server-local"); validated to be owned by the agent's
    // `platformOwnerId` (fail-closed, D-A3). ON DELETE set null so revoking/removing
    // the machine row gracefully reverts bound agents to server-local. Routing
    // precedence: per-turn constraint → this → session binding → chat default →
    // server-local (D-A8/D6).
    machineId: uuid('machine_id').references(() => machines.id, { onDelete: 'set null' }),
    visibility: varchar('visibility', { length: 16 }).notNull().default('public'),
    defaultRuntime: varchar('default_runtime', { length: 32 }),
    defaultWorkDir: varchar('default_work_dir', { length: 1024 }),
    runtimeEnv: jsonb('runtime_env').$type<Record<string, string>>().notNull().default({}),
    // Layer A agent workspace memory (long-term memory) toggle, console-managed.
    memoryEnabled: boolean('memory_enabled').notNull().default(true),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    accessPolicy: jsonb('access_policy').notNull().default({}),
    status: varchar('status', { length: 16 }).notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Console (SSO) owner-level handle uniqueness: a handle is unique within one
    // owner's agents, so two different users may each have a "Developer". Partial
    // — only `platform_owner_id` NOT NULL (console-created) agents. The display
    // name is the user-facing identifier now; routing/handoff use `id`, so this
    // index just stops a single owner from creating two agents with the same name.
    uniqueIndex('idx_agents_owner_handle')
      .on(table.tenantKey, table.platformOwnerId, table.handle)
      .where(sql`${table.platformOwnerId} IS NOT NULL`),
    // ops / built-in agents (platform_owner_id NULL, e.g. the bootstrap
    // `open-claude-tag`) keep the legacy scope-level uniqueness so their idempotent
    // upsert (agent-bootstrap.ts / agent-sync.ts) still has a unique target to
    // conflict on — NULLs do not collide in the owner index above.
    uniqueIndex('idx_agents_scope_handle')
      .on(table.tenantKey, table.scopeType, table.scopeId, table.handle)
      .where(sql`${table.platformOwnerId} IS NULL`),
    index('idx_agents_profile').on(table.profileId),
    index('idx_agents_status').on(table.status),
    index('idx_agents_machine').on(table.machineId),
  ],
);

// ── 5a. machines ──
// Remote execution daemons paired to a Feishu user. Capabilities are reported by
// the daemon on `hello` (see server-centralized-daemon design §5).
export interface MachineCapabilities {
  runtimes: string[];
  features?: string[];
  platform?: string;
  hostname?: string;
  daemonVersion?: string;
  protocolVersion?: number;
}

export const machines = pgTable(
  'machines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantKey: text('tenant_key').notNull(),
    // Legacy Feishu-domain owner (openId). Nullable since D-A7: machines are now
    // paired and owned exclusively through the console (`platformOwnerId`). Kept
    // for any pre-D-A7 rows; new console-issued machines leave this NULL.
    ownerOpenId: text('owner_open_id'),
    // Console (SSO) owner of this machine (design D-A7). The SOLE machine-ownership
    // domain going forward: pairing, visibility, and chat binding are all scoped to
    // this platform user. NULL only on legacy openId-owned rows.
    platformOwnerId: uuid('platform_owner_id').references(() => platformUsers.id, {
      onDelete: 'set null',
    }),
    name: text('name').notNull(),
    secretHash: text('secret_hash').notNull(),
    status: varchar('status', { length: 16 }).notNull().default('offline'),
    capabilities: jsonb('capabilities').$type<MachineCapabilities>().notNull().default({ runtimes: [] }),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    // Server-initiated disconnect signal (design D-A9). Set by the console when an
    // admin closes a machine's current daemon socket; the worker gateway honors it
    // on its liveness tick — a connection whose `connectedAt` predates this stamp is
    // closed. NOT a revoke (credentials stay valid); the daemon may reconnect.
    disconnectRequestedAt: timestamp('disconnect_requested_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('idx_machines_owner_name').on(table.tenantKey, table.ownerOpenId, table.name),
    // R2-7: enforce name uniqueness per console owner at the DB layer (the legacy
    // `idx_machines_owner_name` does not, because console machines carry a NULL
    // `owner_open_id`). Partial — only console-owned (platform_owner_id NOT NULL)
    // rows, so legacy openId machines keep their own uniqueness rule.
    uniqueIndex('idx_machines_platform_owner_name')
      .on(table.tenantKey, table.platformOwnerId, table.name)
      .where(sql`${table.platformOwnerId} IS NOT NULL`),
    index('idx_machines_owner').on(table.tenantKey, table.ownerOpenId),
    index('idx_machines_platform_owner').on(table.platformOwnerId),
    index('idx_machines_status').on(table.status),
  ],
);

// ── 5b. machine_pairing_tokens ──
// One-time tokens minted in the admin console (design D-A7) and redeemed by the
// daemon at `POST /daemon/pair`. Plaintext token only ever leaves in the issuing
// console response. The legacy Feishu `/machine connect` issuance path is removed
// (D-A7), so `issuerOpenId`/`chatId` are nullable and unused for new tokens.
export const machinePairingTokens = pgTable(
  'machine_pairing_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tokenHash: text('token_hash').notNull().unique(),
    tenantKey: text('tenant_key').notNull(),
    // Console (SSO) issuer of this token (design D-A7). The redeeming daemon's
    // machine is stamped with this `platformOwnerId`. NULL only on legacy
    // Feishu-issued tokens.
    platformIssuerId: uuid('platform_issuer_id').references(() => platformUsers.id, {
      onDelete: 'set null',
    }),
    // Legacy Feishu-domain issuer/announce-chat. Nullable since D-A7 — console
    // tokens carry no openId or chat. Kept for any pre-D-A7 token rows.
    issuerOpenId: text('issuer_open_id'),
    chatId: text('chat_id'),
    machineName: text('machine_name'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_machine_pairing_tokens_issuer').on(table.tenantKey, table.issuerOpenId),
    index('idx_machine_pairing_tokens_platform_issuer').on(table.platformIssuerId),
    index('idx_machine_pairing_tokens_expires').on(table.expiresAt),
  ],
);

// ── 6. sessions ──
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionKey: varchar('session_key', { length: 512 }).notNull().unique(),
    chatId: varchar('chat_id', { length: 64 }).notNull(),
    scope: varchar('scope', { length: 32 }).notNull(),
    status: varchar('status', { length: 16 }).notNull().default('active'),
    title: varchar('title', { length: 256 }),
    summary: text('summary'),
    tokenBudgetProfile: jsonb('token_budget_profile').default({}),
    messageCount: integer('message_count').notNull().default(0),
    sdkSessionId: varchar('sdk_session_id', { length: 256 }),
    // The machine that executed the turn which produced `sdkSessionId`, or NULL
    // for a server-local turn. Persisted alongside `sdkSessionId` so the D15
    // machine-switch check compares against the substrate that owns the stored
    // SDK state, not an approximation derived from the prior task audit trail.
    sdkSessionMachineId: uuid('sdk_session_machine_id').references(() => machines.id, {
      onDelete: 'set null',
    }),
    runtimeBackend: varchar('runtime_backend', { length: 32 }),
    worktreePath: varchar('worktree_path', { length: 512 }),
    worktreeBranch: varchar('worktree_branch', { length: 128 }),
    prUrl: varchar('pr_url', { length: 512 }),
    prLastPolledAt: timestamp('pr_last_polled_at', { withTimezone: true }),
    adhocWorkDir: varchar('adhoc_work_dir', { length: 1024 }),
    boundMachineId: uuid('bound_machine_id').references(() => machines.id, { onDelete: 'set null' }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_sessions_chat').on(table.chatId),
    index('idx_sessions_status').on(table.status),
  ],
);

// ── 7. chat_active_sessions ──
export const chatActiveSessions = pgTable(
  'chat_active_sessions',
  {
    tenantKey: varchar('tenant_key', { length: 128 }).notNull().default('default'),
    chatId: varchar('chat_id', { length: 64 }).notNull(),
    activeSessionId: uuid('active_session_id').references(() => sessions.id),
    sessionAlias: varchar('session_alias', { length: 64 }),
    createdBy: uuid('created_by').references(() => users.id),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantKey, table.chatId] }),
    index('idx_chat_active_sessions_chat').on(table.chatId),
  ],
);

// ── 7a. chat_configs ──
export const chatConfigs = pgTable(
  'chat_configs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantKey: varchar('tenant_key', { length: 128 }).notNull(),
    chatId: varchar('chat_id', { length: 64 }).notNull(),
    displayName: varchar('display_name', { length: 128 }),
    defaultWorkDir: varchar('default_work_dir', { length: 1024 }),
    defaultRuntime: varchar('default_runtime', { length: 32 }),
    defaultAgentId: uuid('default_agent_id').references(() => agents.id, { onDelete: 'set null' }),
    defaultMachineId: uuid('default_machine_id').references(() => machines.id, {
      onDelete: 'set null',
    }),
    memoryEnabled: boolean('memory_enabled').notNull().default(false),
    memorySummaryAgentId: uuid('memory_summary_agent_id').references(() => agents.id, {
      onDelete: 'set null',
    }),
    memorySummaryTime: varchar('memory_summary_time', { length: 5 }),
    memorySummaryTimezone: varchar('memory_summary_timezone', { length: 64 })
      .notNull()
      .default('Asia/Shanghai'),
    memorySummaryNextRunAt: timestamp('memory_summary_next_run_at', { withTimezone: true }),
    memorySummaryLastRunAt: timestamp('memory_summary_last_run_at', { withTimezone: true }),
    memorySummaryLastStatus: varchar('memory_summary_last_status', { length: 32 }),
    memorySummaryLastError: text('memory_summary_last_error'),
    createdByOpenId: varchar('created_by_open_id', { length: 64 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('idx_chat_configs_tenant_chat').on(table.tenantKey, table.chatId),
    index('idx_chat_configs_chat').on(table.chatId),
    index('idx_chat_configs_default_agent').on(table.defaultAgentId),
    index('idx_chat_configs_memory_due').on(table.memoryEnabled, table.memorySummaryNextRunAt),
    index('idx_chat_configs_memory_agent').on(table.memorySummaryAgentId),
  ],
);

// ── 8. agent_bot_bindings ──
export const agentBotBindings = pgTable(
  'agent_bot_bindings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    feishuAppId: uuid('feishu_app_id')
      .notNull()
      .references(() => feishuApps.id, { onDelete: 'cascade' }),
    botOpenId: varchar('bot_open_id', { length: 64 }),
    status: varchar('status', { length: 16 }).notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('idx_agent_bot_bindings_active_agent')
      .on(table.agentId)
      .where(sql`${table.status} = 'active'`),
    uniqueIndex('idx_agent_bot_bindings_active_app')
      .on(table.feishuAppId)
      .where(sql`${table.status} = 'active'`),
    index('idx_agent_bot_bindings_bot_open_id').on(table.botOpenId),
    index('idx_agent_bot_bindings_status').on(table.status),
  ],
);

// ── 9. agent_session_states ──
export const agentSessionStates = pgTable(
  'agent_session_states',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    runtimeBackend: varchar('runtime_backend', { length: 32 }),
    sdkSessionId: varchar('sdk_session_id', { length: 256 }),
    // The machine that produced the stored `sdkSessionId` (NULL = server-local).
    // Mirrors `sessions.sdk_session_machine_id` for per-agent session state so the
    // D15 substrate-switch check works on agent runs too.
    sdkSessionMachineId: uuid('sdk_session_machine_id').references(() => machines.id, {
      onDelete: 'set null',
    }),
    workspacePath: varchar('workspace_path', { length: 512 }),
    worktreeBranch: varchar('worktree_branch', { length: 128 }),
    adhocWorkDir: varchar('adhoc_work_dir', { length: 1024 }),
    summary: text('summary'),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('idx_agent_session_states_agent_session').on(table.agentId, table.sessionId),
    index('idx_agent_session_states_session').on(table.sessionId),
  ],
);

// ── 10. user_identities ──
export const userIdentities = pgTable(
  'user_identities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    tenantKey: varchar('tenant_key', { length: 128 }).notNull().default('default'),
    feishuAppId: uuid('feishu_app_id')
      .notNull()
      .references(() => feishuApps.id, { onDelete: 'cascade' }),
    openId: varchar('open_id', { length: 64 }).notNull(),
    unionId: varchar('union_id', { length: 64 }),
    displayName: varchar('display_name', { length: 128 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('idx_user_identities_app_open').on(table.feishuAppId, table.openId),
    index('idx_user_identities_union').on(table.unionId),
    index('idx_user_identities_user').on(table.userId),
  ],
);

// ── 11. session_aliases ──
export const sessionAliases = pgTable('session_aliases', {
  id: uuid('id').primaryKey().defaultRandom(),
  aliasKey: varchar('alias_key', { length: 512 }).notNull().unique(),
  targetSessionId: uuid('target_session_id')
    .notNull()
    .references(() => sessions.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── 12. messages ──
export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    feishuMessageId: varchar('feishu_message_id', { length: 64 }),
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'set null' }),
    feishuAppId: uuid('feishu_app_id').references(() => feishuApps.id, {
      onDelete: 'set null',
    }),
    role: varchar('role', { length: 16 }).notNull(),
    content: text('content').notNull(),
    contentType: varchar('content_type', { length: 16 }).notNull().default('text'),
    tokenEstimate: integer('token_estimate'),
    metadata: jsonb('metadata').default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_messages_session').on(table.sessionId, table.createdAt),
    index('idx_messages_agent').on(table.agentId),
    index('idx_messages_feishu_app').on(table.feishuAppId),
  ],
);

// ── 13. inbound_events ──
export const inboundEvents = pgTable(
  'inbound_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    feishuAppId: uuid('feishu_app_id').references(() => feishuApps.id, {
      onDelete: 'set null',
    }),
    eventId: varchar('event_id', { length: 128 }).notNull(),
    messageId: varchar('message_id', { length: 64 }),
    status: varchar('status', { length: 16 }).notNull().default('received'),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // NULLS NOT DISTINCT (migration 0029): a NULL feishu_app_id is ONE dedup
    // scope — with the default semantics duplicate (NULL, event_id) rows
    // inserted freely and the same event was processed twice.
    unique('idx_inbound_events_app_event').on(table.feishuAppId, table.eventId).nullsNotDistinct(),
    index('idx_events_event_id').on(table.eventId),
    index('idx_events_message').on(table.messageId),
  ],
);

export const feishuWebhookReceipts = pgTable(
  'feishu_webhook_receipts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    nonce: varchar('nonce', { length: 128 }).notNull(),
    feishuAppId: uuid('feishu_app_id').references(() => feishuApps.id, {
      onDelete: 'set null',
    }),
    appId: varchar('app_id', { length: 128 }),
    eventId: varchar('event_id', { length: 128 }),
    timestampSeconds: integer('timestamp_seconds').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('idx_feishu_webhook_receipts_nonce').on(table.nonce),
    index('idx_feishu_webhook_receipts_created').on(table.createdAt),
    index('idx_feishu_webhook_receipts_app_event').on(table.feishuAppId, table.eventId),
  ],
);

// ── 14. tasks ──
export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id),
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'set null' }),
    feishuAppId: uuid('feishu_app_id').references(() => feishuApps.id, {
      onDelete: 'set null',
    }),
    parentTaskId: uuid('parent_task_id').references((): AnyPgColumn => tasks.id, {
      onDelete: 'set null',
    }),
    taskType: varchar('task_type', { length: 32 }).notNull(),
    goal: text('goal').notNull(),
    agentProfile: varchar('agent_profile', { length: 64 }),
    runtimeHint: varchar('runtime_hint', { length: 16 }),
    status: varchar('status', { length: 32 }).notNull().default('pending'),
    approvalState: varchar('approval_state', { length: 16 }),
    feedbackMessageId: varchar('feedback_message_id', { length: 64 }),
    feedbackCardType: varchar('feedback_card_type', { length: 32 }),
    feedbackState: varchar('feedback_state', { length: 32 }),
    feedbackUpdatedAt: timestamp('feedback_updated_at', { withTimezone: true }),
    interactionReason: varchar('interaction_reason', { length: 32 }),
    executedOnMachineId: uuid('executed_on_machine_id').references(() => machines.id, {
      onDelete: 'set null',
    }),
    constraints: jsonb('constraints').default({}),
    result: jsonb('result'),
    errorMessage: text('error_message'),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_tasks_session').on(table.sessionId),
    index('idx_tasks_agent').on(table.agentId),
    index('idx_tasks_feishu_app').on(table.feishuAppId),
    index('idx_tasks_status').on(table.status),
  ],
);

export const feishuCardActionReceipts = pgTable(
  'feishu_card_action_receipts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    dedupKey: varchar('dedup_key', { length: 256 }).notNull(),
    sourceTaskId: uuid('source_task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    newTaskId: uuid('new_task_id'),
    action: varchar('action', { length: 64 }).notNull(),
    operatorOpenId: varchar('operator_open_id', { length: 128 }),
    eventId: varchar('event_id', { length: 128 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('idx_feishu_card_action_receipts_dedup').on(table.dedupKey),
    index('idx_feishu_card_action_receipts_source_task').on(table.sourceTaskId),
    index('idx_feishu_card_action_receipts_new_task').on(table.newTaskId),
  ],
);

export const chatMemoryEntries = pgTable(
  'chat_memory_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantKey: varchar('tenant_key', { length: 128 }).notNull(),
    chatId: varchar('chat_id', { length: 64 }).notNull(),
    entryType: varchar('entry_type', { length: 16 }).notNull(),
    title: varchar('title', { length: 128 }).notNull(),
    content: text('content').notNull(),
    keywords: jsonb('keywords').$type<string[]>().notNull().default([]),
    importanceScore: real('importance_score').notNull().default(0.5),
    sourceTaskId: uuid('source_task_id').references(() => tasks.id, { onDelete: 'set null' }),
    status: varchar('status', { length: 16 }).notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_chat_memory_scope').on(table.tenantKey, table.chatId, table.status),
    index('idx_chat_memory_type').on(table.entryType),
    index('idx_chat_memory_source_task').on(table.sourceTaskId),
  ],
);

// ── 14a. admission_leases ──
export const admissionLeases = pgTable(
  'admission_leases',
  {
    taskId: uuid('task_id')
      .primaryKey()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'set null' }),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    jobData: jsonb('job_data').notNull(),
    notBefore: timestamp('not_before', { withTimezone: true }).notNull(),
    attempts: integer('attempts').notNull().default(0),
    leaseOwner: varchar('lease_owner', { length: 128 }),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_admission_leases_due').on(table.notBefore),
    index('idx_admission_leases_agent').on(table.agentId),
    index('idx_admission_leases_session').on(table.sessionId),
  ],
);

// ── 14b. discussions ──
export const discussions = pgTable(
  'discussions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantKey: varchar('tenant_key', { length: 128 }).notNull().default('default'),
    chatId: varchar('chat_id', { length: 64 }).notNull(),
    rootThreadId: varchar('root_thread_id', { length: 64 }).notNull(),
    feishuAppId: uuid('feishu_app_id').references(() => feishuApps.id, {
      onDelete: 'set null',
    }),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    topic: text('topic').notNull(),
    status: varchar('status', { length: 32 }).notNull().default('active'),
    roundLimit: integer('round_limit').notNull().default(3),
    currentRound: integer('current_round').notNull().default(1),
    currentTurnIndex: integer('current_turn_index').notNull().default(0),
    version: integer('version').notNull().default(0),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('idx_discussions_session').on(table.sessionId),
    uniqueIndex('idx_discussions_root').on(table.tenantKey, table.chatId, table.rootThreadId),
    index('idx_discussions_chat_status').on(table.tenantKey, table.chatId, table.status),
    index('idx_discussions_feishu_app').on(table.feishuAppId),
  ],
);

export const discussionParticipants = pgTable(
  'discussion_participants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    discussionId: uuid('discussion_id')
      .notNull()
      .references(() => discussions.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    feishuAppId: uuid('feishu_app_id').references(() => feishuApps.id, { onDelete: 'set null' }),
    botOpenId: varchar('bot_open_id', { length: 64 }),
    displayName: varchar('display_name', { length: 128 }),
    role: varchar('role', { length: 128 }),
    orderIndex: integer('order_index').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('idx_discussion_participants_agent').on(table.discussionId, table.agentId),
    uniqueIndex('idx_discussion_participants_order').on(table.discussionId, table.orderIndex),
    index('idx_discussion_participants_discussion').on(table.discussionId),
    index('idx_discussion_participants_agent_lookup').on(table.agentId),
    index('idx_discussion_participants_feishu_app').on(table.feishuAppId),
  ],
);

export const discussionTurns = pgTable(
  'discussion_turns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    discussionId: uuid('discussion_id')
      .notNull()
      .references(() => discussions.id, { onDelete: 'cascade' }),
    participantId: uuid('participant_id').references(() => discussionParticipants.id, {
      onDelete: 'set null',
    }),
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'set null' }),
    taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    round: integer('round').notNull(),
    turnIndex: integer('turn_index').notNull(),
    status: varchar('status', { length: 32 }).notNull().default('completed'),
    content: text('content'),
    errorMessage: text('error_message'),
    metadata: jsonb('metadata').notNull().default({}),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('idx_discussion_turns_position').on(
      table.discussionId,
      table.round,
      table.turnIndex,
    ),
    index('idx_discussion_turns_discussion').on(table.discussionId, table.round, table.turnIndex),
    index('idx_discussion_turns_agent').on(table.agentId),
    uniqueIndex('idx_discussion_turns_task').on(table.taskId),
  ],
);

// ── 14a. feishu_task_tracking_spaces ──
export const feishuTaskTrackingSpaces = pgTable(
  'feishu_task_tracking_spaces',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    scopeType: varchar('scope_type', { length: 32 }).notNull().default('global'),
    scopeId: varchar('scope_id', { length: 256 }).notNull().default('default'),
    name: varchar('name', { length: 256 }),
    tasklistGuid: varchar('tasklist_guid', { length: 128 }).notNull(),
    statusFieldGuid: varchar('status_field_guid', { length: 128 }).notNull(),
    statusOptions: jsonb('status_options').notNull().default({}),
    sections: jsonb('sections').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('idx_feishu_task_tracking_spaces_scope').on(table.scopeType, table.scopeId),
    index('idx_feishu_task_tracking_spaces_tasklist').on(table.tasklistGuid),
  ],
);

// ── 14b. feishu_task_links ──
export const feishuTaskLinks = pgTable(
  'feishu_task_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    trackingSpaceId: uuid('tracking_space_id').references(() => feishuTaskTrackingSpaces.id, {
      onDelete: 'set null',
    }),
    feishuTaskGuid: varchar('feishu_task_guid', { length: 128 }),
    feishuTaskUrl: varchar('feishu_task_url', { length: 1024 }),
    sourceMessageId: varchar('source_message_id', { length: 64 }),
    sourceTopicKey: varchar('source_topic_key', { length: 512 }),
    sourceTopicUrl: varchar('source_topic_url', { length: 1024 }),
    lastSyncedStatus: varchar('last_synced_status', { length: 32 }),
    lastSyncError: text('last_sync_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('idx_feishu_task_links_task').on(table.taskId),
    index('idx_feishu_task_links_feishu_task').on(table.feishuTaskGuid),
    index('idx_feishu_task_links_topic').on(table.trackingSpaceId, table.sourceTopicKey),
  ],
);

// ── 15. task_steps ──
export const taskSteps = pgTable('task_steps', {
  id: uuid('id').primaryKey().defaultRandom(),
  taskId: uuid('task_id')
    .notNull()
    .references(() => tasks.id, { onDelete: 'cascade' }),
  stepIndex: integer('step_index').notNull(),
  description: text('description').notNull(),
  agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'set null' }),
  agentProfile: varchar('agent_profile', { length: 64 }),
  runtimeBackend: varchar('runtime_backend', { length: 16 }),
  status: varchar('status', { length: 32 }).notNull().default('pending'),
  result: jsonb('result'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
});

// ── 16. task_runs ──
export const taskRuns = pgTable('task_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  taskId: uuid('task_id')
    .notNull()
    .references(() => tasks.id, { onDelete: 'cascade' }),
  stepId: uuid('step_id').references(() => taskSteps.id),
  runtimeBackend: varchar('runtime_backend', { length: 16 }).notNull(),
  mode: varchar('mode', { length: 16 }).notNull().default('one_shot'),
  workspacePath: varchar('workspace_path', { length: 512 }),
  externalSessionRef: varchar('external_session_ref', { length: 256 }),
  status: varchar('status', { length: 16 }).notNull().default('running'),
  exitCode: integer('exit_code'),
  cost: jsonb('cost').default({}),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  lastHeartbeatAt: timestamp('last_heartbeat_at', { withTimezone: true }),
});

// ── 17. task_run_events ──
export const taskRunEvents = pgTable(
  'task_run_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    runId: uuid('run_id')
      .notNull()
      .references(() => taskRuns.id, { onDelete: 'cascade' }),
    eventIndex: integer('event_index').notNull(),
    eventType: varchar('event_type', { length: 32 }).notNull(),
    message: text('message'),
    progress: real('progress'),
    payload: jsonb('payload').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('idx_task_run_events_run_index').on(table.runId, table.eventIndex),
    index('idx_task_run_events_task').on(table.taskId, table.createdAt),
    index('idx_task_run_events_run').on(table.runId),
  ],
);

// ── 18. memory_entries ──
export const memoryEntries = pgTable(
  'memory_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    scopeType: varchar('scope_type', { length: 16 }).notNull(),
    scopeId: varchar('scope_id', { length: 256 }).notNull(),
    memoryType: varchar('memory_type', { length: 32 }).notNull(),
    content: text('content').notNull(),
    tags: jsonb('tags').default([]),
    importanceScore: real('importance_score').notNull().default(0.5),
    confidence: real('confidence').notNull().default(1.0),
    confirmed: boolean('confirmed').notNull().default(false),
    sourceMessageId: varchar('source_message_id', { length: 64 }),
    ttlAt: timestamp('ttl_at', { withTimezone: true }),
    status: varchar('status', { length: 16 }).notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_memory_scope').on(table.scopeType, table.scopeId),
    index('idx_memory_type').on(table.memoryType),
    index('idx_memory_status').on(table.status),
  ],
);

// ── 18. delegation_trees ──
export const delegationTrees = pgTable(
  'delegation_trees',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    rootTaskId: uuid('root_task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    totalBudget: integer('total_budget').notNull(),
    tasksUsed: integer('tasks_used').notNull().default(0),
    fanoutBudget: integer('fanout_budget').notNull(),
    status: varchar('status', { length: 32 }).notNull().default('active'),
    resumeTaskId: uuid('resume_task_id').references(() => tasks.id, { onDelete: 'set null' }),
    wokenAt: timestamp('woken_at', { withTimezone: true }),
    version: integer('version').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('idx_delegation_trees_root_task').on(table.rootTaskId),
    index('idx_delegation_trees_status').on(table.status),
  ],
);

// ── 19. agent_delegations ──
export const agentDelegations = pgTable(
  'agent_delegations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    treeId: uuid('tree_id').references(() => delegationTrees.id, { onDelete: 'cascade' }),
    parentDelegationId: uuid('parent_delegation_id').references(
      (): AnyPgColumn => agentDelegations.id,
      { onDelete: 'set null' },
    ),
    depth: integer('depth').notNull().default(1),
    childSessionId: uuid('child_session_id').references(() => sessions.id, {
      onDelete: 'set null',
    }),
    parentTaskId: uuid('parent_task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    childTaskId: uuid('child_task_id').references(() => tasks.id, { onDelete: 'set null' }),
    callerAgentId: uuid('caller_agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    calleeAgentId: uuid('callee_agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    goal: text('goal').notNull(),
    inputSummary: text('input_summary'),
    permissionScope: jsonb('permission_scope').notNull().default({}),
    status: varchar('status', { length: 32 }).notNull().default('pending'),
    result: jsonb('result'),
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    index('idx_agent_delegations_tree').on(table.treeId),
    index('idx_agent_delegations_parent_delegation').on(table.parentDelegationId),
    index('idx_agent_delegations_depth').on(table.depth),
    index('idx_agent_delegations_child_session').on(table.childSessionId),
    index('idx_agent_delegations_parent_task').on(table.parentTaskId),
    index('idx_agent_delegations_child_task').on(table.childTaskId),
    index('idx_agent_delegations_caller').on(table.callerAgentId),
    index('idx_agent_delegations_callee').on(table.calleeAgentId),
    index('idx_agent_delegations_status').on(table.status),
  ],
);

// ── 20. change_requests ──
export const changeRequests = pgTable('change_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  taskId: uuid('task_id').references(() => tasks.id),
  title: varchar('title', { length: 256 }).notNull(),
  description: text('description'),
  targetType: varchar('target_type', { length: 32 }).notNull(),
  riskLevel: varchar('risk_level', { length: 16 }).notNull(),
  status: varchar('status', { length: 32 }).notNull().default('draft'),
  diffUri: varchar('diff_uri', { length: 512 }),
  testReportUri: varchar('test_report_uri', { length: 512 }),
  snapshotId: varchar('snapshot_id', { length: 128 }),
  rollbackPlan: text('rollback_plan'),
  createdBy: uuid('created_by').references(() => users.id),
  approvedBy: uuid('approved_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── 21. approvals ──
// NOTE: state-machine CHECK constraints (chk_tasks_status etc.) live in
// migration 0030 only — drizzle cannot express NOT VALID and they add no
// query-layer value.
export const approvals = pgTable(
  'approvals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    changeRequestId: uuid('change_request_id').references(() => changeRequests.id),
    taskId: uuid('task_id').references(() => tasks.id),
    approverId: uuid('approver_id').references(() => users.id),
    action: varchar('action', { length: 16 }).notNull(),
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // One vote per (request, approver, action); conflict-tolerant inserts
    // use this as their arbiter (migration 0030).
    uniqueIndex('idx_approvals_request_approver_action')
      .on(table.changeRequestId, table.approverId, table.action)
      .where(sql`${table.changeRequestId} IS NOT NULL AND ${table.approverId} IS NOT NULL`),
  ],
);

// ── 22. artifacts ──
export const artifacts = pgTable('artifacts', {
  id: uuid('id').primaryKey().defaultRandom(),
  taskId: uuid('task_id').references(() => tasks.id),
  runId: uuid('run_id').references(() => taskRuns.id),
  artifactType: varchar('artifact_type', { length: 32 }).notNull(),
  name: varchar('name', { length: 256 }).notNull(),
  storageUri: varchar('storage_uri', { length: 512 }).notNull(),
  sha256: varchar('sha256', { length: 64 }),
  mimeType: varchar('mime_type', { length: 64 }),
  sizeBytes: bigint('size_bytes', { mode: 'number' }),
  metadata: jsonb('metadata').default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── 23. waiting_contracts ──
// A deferred agent's promise to act after a primary agent completes, created at
// multi-mention intake (relay route). Consumed by the worker completion hook
// (waiting → woken posts the visible wake mention) and the contract reconciler
// (waiting → expired past TTL / when no primary task ever appeared).
export const waitingContracts = pgTable(
  'waiting_contracts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantKey: varchar('tenant_key', { length: 64 }).notNull().default('default'),
    chatId: varchar('chat_id', { length: 128 }).notNull(),
    messageId: varchar('message_id', { length: 128 }).notNull(),
    sessionId: uuid('session_id').references(() => sessions.id, { onDelete: 'set null' }),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    feishuAppId: uuid('feishu_app_id').references(() => feishuApps.id, { onDelete: 'set null' }),
    waitingOnAgentId: uuid('waiting_on_agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    primaryTaskId: uuid('primary_task_id').references(() => tasks.id, { onDelete: 'set null' }),
    goal: text('goal').notNull(),
    ackMessageId: varchar('ack_message_id', { length: 128 }),
    status: varchar('status', { length: 16 }).notNull().default('waiting'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('idx_waiting_contracts_message_agent').on(
      table.tenantKey,
      table.chatId,
      table.messageId,
      table.agentId,
    ),
    index('idx_waiting_contracts_primary_task').on(table.primaryTaskId),
    index('idx_waiting_contracts_waiting_on').on(table.waitingOnAgentId, table.status),
    index('idx_waiting_contracts_status_created').on(table.status, table.createdAt),
  ],
);

// ── 24. audit_events ──
export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    actorId: uuid('actor_id').references(() => users.id),
    action: varchar('action', { length: 64 }).notNull(),
    targetType: varchar('target_type', { length: 32 }),
    targetId: varchar('target_id', { length: 256 }),
    severity: varchar('severity', { length: 16 }).notNull().default('info'),
    detail: jsonb('detail').default({}),
    ipAddress: varchar('ip_address', { length: 45 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('idx_audit_action').on(table.action, table.createdAt)],
);

// ── 27. shared_context_entries ──
// Runtime-neutral, location-neutral coordination substrate (DeLM "shared
// verified context", arXiv 2606.10662). A compact gist plus a structured
// `evidenceRef` that points to portable backing evidence (a central `artifacts`
// row, a git branch+commit, or self-contained inline text — never a bare local
// path). Any agent of any runtime kind on any machine can read these via the
// central DB, so cross-kind / cross-machine handoffs no longer depend on SDK
// `resume` or a shared working directory. Admission is gated by a verifier and
// the no-self-verify rule (see @open-tag/memory SharedContextStore).
export const sharedContextEntries = pgTable(
  'shared_context_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    scopeType: varchar('scope_type', { length: 16 }).notNull().default('session'),
    scopeId: varchar('scope_id', { length: 256 }).notNull(),
    // Author identity (NULL = server/system-authored). `authorAgentKind` is the
    // runtime backend (claude_code / codex / coco); `authorMachineId` NULL means
    // the authoring turn ran server-local.
    authorAgentId: uuid('author_agent_id').references(() => agents.id, { onDelete: 'set null' }),
    authorAgentKind: varchar('author_agent_kind', { length: 32 }),
    authorMachineId: uuid('author_machine_id').references(() => machines.id, {
      onDelete: 'set null',
    }),
    memoryType: varchar('memory_type', { length: 32 }).notNull().default('fact'),
    gist: text('gist').notNull(),
    // { kind: 'artifact'|'git'|'inline', artifactId?, gitBranch?, gitCommit?, inline? }
    // NOT NULL: an admitted gist must always cite portable backing evidence.
    evidenceRef: jsonb('evidence_ref').notNull(),
    verified: boolean('verified').notNull().default(false),
    // The verifying actor — MUST differ from `authorAgentId` (no-self-verify).
    verifiedByAgentId: uuid('verified_by_agent_id').references(() => agents.id, {
      onDelete: 'set null',
    }),
    verifyReason: text('verify_reason'),
    importanceScore: real('importance_score').notNull().default(0.5),
    status: varchar('status', { length: 16 }).notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_shared_context_session').on(table.sessionId),
    index('idx_shared_context_scope').on(table.scopeType, table.scopeId),
    index('idx_shared_context_status').on(table.status),
  ],
);

// ── 21. channel_observations ──
// Channel-scoped observation memory: the always-on "following the channel" write
// path. Un-addressed channel activity accumulates per channel, keyed by the
// channel isolation key (`ChannelScope.scopeId`) + `channelKind` — distinct from
// `shared_context_entries`/`memory_entries`, which store an agent's own task
// results. Repeated identical content in the same channel is deduped at the DB
// layer by a UNIQUE (channel_kind, scope_id, dedupe_hash).
export const channelObservations = pgTable(
  'channel_observations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // The channel vendor (lark / slack / discord) — never narrowed in the core.
    channelKind: varchar('channel_kind', { length: 32 }).notNull(),
    // The channel isolation key (ChannelScope.scopeId) — the unit of isolation.
    scopeId: varchar('scope_id', { length: 256 }).notNull(),
    // The inbound message this observation was lifted from (InboundMessage.messageId).
    sourceMessageId: varchar('source_message_id', { length: 256 }).notNull(),
    // The observation gist (stage-1: the human message text, whitespace-normalized).
    gist: text('gist').notNull(),
    // From InboundMessage.occurredAt — never Date.now().
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    // sha256(channelKind + scopeId + normalizedText): a stable, channel-scoped key.
    dedupeHash: varchar('dedupe_hash', { length: 64 }).notNull(),
    // Recency/decay weight for later ranking; full weight at stage-1.
    decayWeight: real('decay_weight').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('idx_channel_observations_dedupe').on(
      table.channelKind,
      table.scopeId,
      table.dedupeHash,
    ),
    index('idx_channel_observations_scope').on(table.channelKind, table.scopeId),
    index('idx_channel_observations_occurred').on(table.occurredAt),
  ],
);

// ── 22. identity_usage ──
// Per-identity budget accounting: one aggregate row per (identity_id, period,
// window_key) holding the running tokens/spend consumed inside that window. The
// enforcement counterpart to the declared `Identity.budget` cap (see
// @open-tag/registry `checkBudget`/`recordUsage`).
//
// `identity_id` is a free-form varchar (NOT a uuid FK to `agents`): an Identity
// id defaults to the composed `agent.id` but may be the agent handle, so this
// purposely does not constrain it to a single agents-row shape. `window_key` is
// the caller-derived bucket label (e.g. '2026-06-27' for a day, '2026-06' for a
// month) — derived from the inbound event timestamp, never wall-clock here.
// Increments are atomic via an upsert that adds to the existing counters.
export const identityUsage = pgTable(
  'identity_usage',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    identityId: varchar('identity_id', { length: 256 }).notNull(),
    // 'day' | 'month' — mirrors IdentityBudgetWindow.
    period: varchar('period', { length: 8 }).notNull(),
    windowKey: varchar('window_key', { length: 16 }).notNull(),
    // bigint: a month of token accounting can exceed the 32-bit int range.
    tokensUsed: bigint('tokens_used', { mode: 'number' }).notNull().default(0),
    // numeric for exact monetary accumulation (drizzle reads it back as a string).
    spendUsed: numeric('spend_used').notNull().default('0'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('idx_identity_usage_window').on(
      table.identityId,
      table.period,
      table.windowKey,
    ),
  ],
);
