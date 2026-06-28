import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { closeSync, constants, createReadStream, fstatSync, openSync } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { and, asc, desc, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { registerApp as registerOneClickFeishuApp } from '@larksuiteoapi/node-sdk';
import { FeishuClient, type FeishuApplicationScopeGrant } from '@open-tag/feishu-adapter';
import { errorMessage, KNOWN_RUNTIME_NAMES } from '@open-tag/core-types';
import {
  agentBotBindings,
  agentProfiles,
  agents,
  chatConfigs,
  feishuApps,
  feishuTaskLinks,
  feishuTaskTrackingSpaces,
  generatePairingToken,
  hashPairingToken,
  buildChatMemoryDisablePatch,
  buildChatMemoryEnablePatch,
  machinePairingTokens,
  machines,
  PAIRING_TOKEN_TTL_MS,
  platformUsers,
  sessions,
  taskRunEvents,
  taskRuns,
  tasks,
  updateChatMemoryConfig,
  upsertPlatformUserByDevAuth,
  type Database,
  type PlatformUser,
} from '@open-tag/storage';
import { extractDevAuthSub, validateDevAuthSub } from './admin-identity.js';
import {
  buildOpenClaudeTagFeishuPermissionInventory,
  evaluateFeishuPermissionScopes,
  type FeishuPermissionCheckResult,
} from './feishu-permission-check.js';

/**
 * Authorization scope resolved once per request by the admin guard and threaded
 * into every store call (the single choke point for ownership filtering, D-A3).
 *
 * Ownership-inheritance rules implemented by the store (D-A2/D-A3):
 *  - `superadmin`: sees and mutates everything (the scope is a no-op).
 *  - plain `user`:
 *    - feishu_apps  → visible/mutable iff `platform_owner_id === platformUserId`.
 *    - agents       → visible/mutable iff `platform_owner_id === platformUserId`.
 *    - bot bindings → a binding is owned iff its app OR its agent is owned;
 *                     bind/unbind requires owning BOTH the agent and the app.
 *    - chats / task boards / summary → scoped to the set of `tenantKey`s of the
 *                     apps the user owns (the "owned tenant set"). A user with no
 *                     owned apps sees an empty owned tenant set ⇒ no chats/boards.
 *    - machines     → visible iff `machine.tenantKey ∈ owned tenant set`.
 *  - NULL `platform_owner_id` rows (legacy / ops-created) never match a plain
 *    user, so they are visible to superadmin ONLY — the design's fail-closed rule.
 */
export interface OwnerScope {
  isSuperadmin: boolean;
  /** The platform user id whose resources are visible, or null for token-admin. */
  platformUserId: string | null;
  /** Effective access to computer/server-side execution controls for this request. */
  computerAccessEnabled: boolean;
}

/** A superadmin scope sees everything; used for the break-glass token/loopback path. */
export const SUPERADMIN_SCOPE: OwnerScope = {
  isSuperadmin: true,
  platformUserId: null,
  computerAccessEnabled: true,
};

// Membership sourced from the single runtime-name SoT (issue #16). This is a
// pure validator for the optional `defaultRuntime` field, so enum order is not
// behaviorally significant.
const RuntimeSchema = z.enum(KNOWN_RUNTIME_NAMES);
const NullableRuntimeSchema = RuntimeSchema.nullable();
const RuntimeEnvKeySchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'runtimeEnv keys must be valid environment variable names');
const RuntimeEnvSchema = z.record(RuntimeEnvKeySchema, z.string());
const AgentStatusSchema = z.enum(['active', 'inactive', 'archived']);
const ProfileStatusSchema = z.enum(['active', 'inactive', 'archived']);
const VisibilitySchema = z.enum(['public', 'private', 'unlisted']);
const FeishuAppStatusSchema = z.enum(['enabled', 'disabled']);
const ScopeTypeSchema = z.enum(['system', 'tenant', 'chat', 'user']);
const DELETED_AGENT_HANDLE_PREFIX = '__deleted__';
const DELETED_FEISHU_APP_ID_PREFIX = '__deleted__';
const SecretRefSchema = z.preprocess(
  (value) => (typeof value === 'string' ? value.trim() : value),
  z.union([
    z.literal('stored'),
    z
      .string()
      .regex(
        /^(env:)?[A-Z_][A-Z0-9_]*$/,
        'appSecretRef must be an env var reference like FEISHU_APP_SECRET or env:FEISHU_APP_SECRET, or stored',
      ),
  ]),
);
const StoredSecretSchema = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().trim().min(1).optional(),
);
const OptionalBotMetadataSchema = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? null : value),
  z.string().trim().min(1).nullable().optional(),
);
const OptionalPresetTextSchema = (maxLength: number) =>
  z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? null : value),
    z.string().trim().min(1).max(maxLength).nullable().optional(),
  );

const CreateProfileSchema = z.object({
  name: z.string().trim().min(1),
  displayName: z.string().trim().min(1),
  description: z.string().nullable().optional(),
  systemPrompt: z.string().nullable().optional(),
  stylePrompt: z.string().nullable().optional(),
  skillRefs: z.array(z.string().trim().min(1)).optional(),
  defaultRuntime: NullableRuntimeSchema.optional(),
  defaultModel: z.string().nullable().optional(),
  status: ProfileStatusSchema.optional(),
});

const PatchProfileSchema = CreateProfileSchema.partial();

const InlineAgentProfileSchema = CreateProfileSchema.partial();

const CreateAgentObject = z.object({
  tenantKey: z.string().trim().min(1).default('default'),
  scopeType: ScopeTypeSchema.default('system'),
  scopeId: z.string().trim().min(1).default('default'),
  // Handle is now an internal key derived from displayName by the store (see
  // deriveAgentHandle); the console no longer asks the user for it. Accepted but
  // optional for back-compat with older API clients — the store overwrites it.
  handle: z.string().trim().min(1).optional(),
  displayName: z.string().trim().min(1),
  description: z.string().nullable().optional(),
  profileId: z.string().uuid().optional(),
  profile: InlineAgentProfileSchema.optional(),
  ownerUserId: z.string().uuid().nullable().optional(),
  // Execution machine binding (design D-A8). NULL = server-local. Validated at the
  // store layer to be owned by the same platform_user and non-revoked.
  machineId: z.string().uuid().nullable().optional(),
  visibility: VisibilitySchema.default('public'),
  defaultRuntime: NullableRuntimeSchema.optional(),
  defaultWorkDir: z.string().nullable().optional(),
  runtimeEnv: RuntimeEnvSchema.optional(),
  // Layer A long-term memory toggle (doc/architecture/agent-memory.md).
  memoryEnabled: z.boolean().default(true),
  projectId: z.string().uuid().nullable().optional(),
  accessPolicy: z.record(z.unknown()).optional(),
  status: AgentStatusSchema.default('active'),
});

const ANTHROPIC_BASE_URL_KEY = 'ANTHROPIC_BASE_URL';
const ANTHROPIC_API_KEY_KEY = 'ANTHROPIC_API_KEY';

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Cross-field rule: Claude custom credentials are optional, but when a caller
 * supplies either field they must supply the complete pair. Absence of both
 * fields is subscription/local-login mode: Claude Code will use the login state
 * on the execution host.
 */
function claudeCredentialError(
  runtime: string | null | undefined,
  runtimeEnv: Record<string, string> | null | undefined,
): string | null {
  if (runtime !== 'claude_code') return null;

  const env = runtimeEnv ?? {};
  const baseUrl = env[ANTHROPIC_BASE_URL_KEY]?.trim();
  const apiKey = env[ANTHROPIC_API_KEY_KEY]?.trim();
  if (!baseUrl && !apiKey) return null;
  if (!baseUrl) return 'runtimeEnv.ANTHROPIC_BASE_URL is required when ANTHROPIC_API_KEY is set';
  if (!isValidHttpUrl(baseUrl)) {
    return 'runtimeEnv.ANTHROPIC_BASE_URL must be a valid http(s) URL';
  }
  if (!apiKey) {
    return 'runtimeEnv.ANTHROPIC_API_KEY is required when ANTHROPIC_BASE_URL is set';
  }
  return null;
}

function assertClaudeCredentialsValid(
  runtime: string | null | undefined,
  runtimeEnv: Record<string, string> | null | undefined,
): void {
  const error = claudeCredentialError(runtime, runtimeEnv);
  if (error) throw new AdminApiError(400, error);
}

const CreateAgentSchema = CreateAgentObject.superRefine((data, ctx) => {
  // The effective runtime is the agent's, or — when the agent inherits — the
  // inline profile's. Validate against that so a Claude agent created purely via
  // an inline claude_code profile cannot skip the credential requirement.
  const effectiveRuntime = data.defaultRuntime ?? data.profile?.defaultRuntime;
  const error = claudeCredentialError(effectiveRuntime, data.runtimeEnv);
  if (error) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: error, path: ['runtimeEnv'] });
  }
});

const PatchAgentSchema = CreateAgentObject.partial().superRefine((data, ctx) => {
  const effectiveRuntime = data.defaultRuntime ?? data.profile?.defaultRuntime;
  const error = claudeCredentialError(effectiveRuntime, data.runtimeEnv);
  if (error) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: error, path: ['runtimeEnv'] });
  }
});

const CreateFeishuAppSchema = z
  .object({
    tenantKey: z.string().trim().min(1).default('default'),
    appId: z.string().trim().min(1),
    appSecretRef: SecretRefSchema.optional(),
    appSecret: StoredSecretSchema,
    botOpenId: OptionalBotMetadataSchema,
    botName: OptionalBotMetadataSchema,
    eventMode: z.string().trim().min(1).default('websocket'),
    status: FeishuAppStatusSchema.default('enabled'),
  })
  .refine((input) => (input.appSecretRef && input.appSecretRef !== 'stored') || input.appSecret, {
    message: 'Either an env appSecretRef or appSecret is required',
    path: ['appSecretRef'],
  });

const PatchFeishuAppSchema = z.object({
  tenantKey: z.string().trim().min(1).optional(),
  appId: z.string().trim().min(1).optional(),
  appSecretRef: SecretRefSchema.optional(),
  appSecret: StoredSecretSchema,
  botOpenId: OptionalBotMetadataSchema,
  botName: OptionalBotMetadataSchema,
  eventMode: z.string().trim().min(1).optional(),
  status: FeishuAppStatusSchema.optional(),
});

const StartFeishuAppRegistrationSchema = z.object({
  botName: OptionalPresetTextSchema(80),
  description: OptionalPresetTextSchema(300),
});

const BindBotSchema = z.object({
  agentId: z.string().uuid(),
  feishuAppId: z.string().uuid(),
});

const PatchChatSchema = z.object({
  displayName: z.string().trim().min(1).nullable().optional(),
  defaultAgentId: z.string().uuid().nullable().optional(),
  defaultRuntime: NullableRuntimeSchema.optional(),
  defaultWorkDir: z.string().nullable().optional(),
  memoryEnabled: z.boolean().optional(),
  // Operator-set default execution machine for the chat (D6 routing). The admin
  // console is the OPERATOR surface, so this binding intentionally bypasses the
  // per-user machine ownership rule (D13) that governs the chat-user `/machine`
  // command path. The deployer running the console is trusted to bind any
  // non-revoked machine as a chat default; ownership enforcement applies only to
  // the in-chat `/machine bind` flow, not to this operator override.
  defaultMachineId: z.string().uuid().nullable().optional(),
});

const OptionalPositiveIntegerQuerySchema = z.preprocess(
  (value) => (value === undefined || value === '' ? undefined : Number(value)),
  z.number().int().min(1).max(100).optional(),
);
const OptionalOffsetQuerySchema = z.preprocess(
  (value) => (value === undefined || value === '' ? undefined : Number(value)),
  // Bound the offset so a hostile/huge value fails validation (400) instead of
  // reaching the store; 100000 is far above any real task-board page count.
  z.number().int().min(0).max(100000).optional(),
);
const TaskBoardListQuerySchema = z.object({
  taskLimit: OptionalPositiveIntegerQuerySchema,
});
const TaskBoardTasksQuerySchema = z.object({
  offset: OptionalOffsetQuerySchema,
  limit: OptionalPositiveIntegerQuerySchema,
  status: z.string().trim().min(1).optional(),
});

const IdParamsSchema = z.object({ id: z.string().uuid() });
const ChatParamsSchema = z.object({
  tenantKey: z.string().trim().min(1),
  chatId: z.string().trim().min(1),
});
// Dev-auth login body (design D-A6, local non-SSO login). `sub` is validated for charset
// and length by `validateDevAuthSub` in the handler; here we only require a
// non-empty string so a precise error surfaces before namespacing.
const DevLoginBodySchema = z.object({
  sub: z.string().trim().min(1),
  name: z.string().trim().min(1).nullable().optional(),
  email: z.string().trim().min(1).nullable().optional(),
});
// Console pairing-token issuance body (design D-A7). Empty/whitespace name → no
// pre-chosen name (the daemon picks a default on pairing).
const IssuePairingTokenBodySchema = z.object({
  name: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().trim().min(1).nullable().optional(),
  ),
});
const PatchComputerAccessSchema = z.object({
  computerAccessEnabled: z.boolean(),
});

type CreateProfileInput = z.infer<typeof CreateProfileSchema>;
type PatchProfileInput = z.infer<typeof PatchProfileSchema>;
type CreateAgentInput = z.infer<typeof CreateAgentSchema>;
type PatchAgentInput = z.infer<typeof PatchAgentSchema>;
type CreateFeishuAppInput = z.infer<typeof CreateFeishuAppSchema>;
type PatchFeishuAppInput = z.infer<typeof PatchFeishuAppSchema>;
type StartFeishuAppRegistrationInput = z.infer<typeof StartFeishuAppRegistrationSchema>;
type BindBotInput = z.infer<typeof BindBotSchema>;
type PatchChatInput = z.infer<typeof PatchChatSchema>;
type PatchComputerAccessInput = z.infer<typeof PatchComputerAccessSchema>;
type ListTaskBoardsOptions = { taskLimit?: number };
type ListTaskBoardTasksOptions = { offset?: number; limit?: number; status?: string };

export interface AdminApiStore {
  getSummary(scope: OwnerScope): Promise<AdminSummaryDto>;
  listComputerAccessUsers(scope: OwnerScope): Promise<ComputerAccessUserDto[]>;
  updateComputerAccessUser(
    scope: OwnerScope,
    id: string,
    input: PatchComputerAccessInput,
  ): Promise<ComputerAccessUserDto>;
  listMachines(scope: OwnerScope): Promise<MachineDto[]>;
  disconnectMachine(scope: OwnerScope, id: string): Promise<MachineDto>;
  issuePairingToken(scope: OwnerScope, input: IssuePairingTokenInput): Promise<IssuedPairingToken>;
  listProfiles(scope: OwnerScope): Promise<ProfileDto[]>;
  listAgents(scope: OwnerScope): Promise<AgentDto[]>;
  createProfile(scope: OwnerScope, input: CreateProfileInput): Promise<ProfileDto>;
  updateProfile(scope: OwnerScope, id: string, input: PatchProfileInput): Promise<ProfileDto>;
  createAgent(scope: OwnerScope, input: CreateAgentInput): Promise<AgentDto>;
  updateAgent(scope: OwnerScope, id: string, input: PatchAgentInput): Promise<AgentDto>;
  deleteAgent(scope: OwnerScope, id: string): Promise<AgentDto>;
  listFeishuApps(scope: OwnerScope): Promise<FeishuAppDto[]>;
  createFeishuApp(scope: OwnerScope, input: CreateFeishuAppInput): Promise<FeishuAppDto>;
  updateFeishuApp(scope: OwnerScope, id: string, input: PatchFeishuAppInput): Promise<FeishuAppDto>;
  syncFeishuAppMetadata(scope: OwnerScope, id: string): Promise<FeishuAppDto>;
  deleteFeishuApp(scope: OwnerScope, id: string): Promise<FeishuAppDto>;
  checkFeishuAppPermissions(scope: OwnerScope, id: string): Promise<FeishuAppPermissionCheckDto>;
  applyFeishuAppPermissions(scope: OwnerScope, id: string): Promise<FeishuAppPermissionApplyDto>;
  startFeishuAppRegistration(
    scope: OwnerScope,
    input: StartFeishuAppRegistrationInput,
  ): Promise<FeishuAppRegistrationDto>;
  getFeishuAppRegistration(scope: OwnerScope, id: string): Promise<FeishuAppRegistrationDto>;
  cancelFeishuAppRegistration(scope: OwnerScope, id: string): Promise<FeishuAppRegistrationDto>;
  bindBot(scope: OwnerScope, input: BindBotInput): Promise<BotBindingDto>;
  unbindBot(scope: OwnerScope, id: string): Promise<BotBindingDto>;
  listChats(scope: OwnerScope): Promise<ChatDto[]>;
  updateChat(
    scope: OwnerScope,
    tenantKey: string,
    chatId: string,
    input: PatchChatInput,
  ): Promise<ChatDto>;
  listTaskBoards(scope: OwnerScope, options?: ListTaskBoardsOptions): Promise<TaskBoardDto[]>;
  listTaskBoardTasks(
    scope: OwnerScope,
    taskBoardId: string,
    options?: ListTaskBoardTasksOptions,
  ): Promise<TaskBoardTaskDto[]>;
}

export interface AdminApiStoreOptions {
  resolveFeishuChatDisplayName?: (input: {
    tenantKey: string;
    chatId: string;
  }) => Promise<string | null>;
  createFeishuClient?: (input: {
    appId: string;
    appSecret: string;
  }) => Pick<FeishuClient, 'listApplicationScopes' | 'applyApplicationScopes'> &
    Partial<Pick<FeishuClient, 'getApplicationInfo'>>;
  feishuTaskTrackingEnabled?: boolean;
  feishuDocumentCommentsEnabled?: boolean;
  registerFeishuApp?: typeof registerOneClickFeishuApp;
  feishuAppRegistrationReadyTimeoutMs?: number;
  afterFeishuAppRegistrationComplete?: () => Promise<void>;
}

export interface AdminSummaryDto {
  profiles: number;
  agents: number;
  activeAgents: number;
  feishuApps: number;
  enabledFeishuApps: number;
  botBindings: number;
  chats: number;
  taskBoards: number;
  machines: number;
  onlineMachines: number;
}

export interface ComputerAccessUserDto {
  id: string;
  email: string | null;
  displayName: string | null;
  role: 'user' | 'superadmin';
  /** Effective permission: superadmins are always true, plain users follow the setting. */
  computerAccessEnabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface MachineDto {
  id: string;
  name: string;
  status: string;
  ownerOpenId: string;
  lastSeenAt: Date | null;
  runtimes: string[];
  createdAt: Date;
}

/** Body for `POST /admin/machines/pairing-token` (design D-A7). */
export interface IssuePairingTokenInput {
  /** Optional friendly machine name pre-chosen by the issuer. */
  name?: string | null;
}

/** Store result of minting a console pairing token; plaintext token returned once. */
export interface IssuedPairingToken {
  /** The one-time plaintext token (only surfaced here; stored as a SHA-256 hash). */
  token: string;
  /** Token expiry. */
  expiresAt: Date;
  /** Optional machine name recorded with the token. */
  machineName: string | null;
}

export interface ProfileDto {
  id: string;
  name: string;
  displayName: string;
  description: string | null;
  systemPrompt: string | null;
  stylePrompt: string | null;
  skillRefs: string[];
  defaultRuntime: string | null;
  defaultModel: string | null;
  sourceType: string;
  sourceUri: string | null;
  // Console (SSO) owner of this profile (R2-6). NULL = a builtin/shared profile
  // (superadmin-only to mutate). `platformOwner` carries a compact label for the
  // superadmin owner column; null for a plain user (who only ever sees own + shared).
  platformOwnerId: string | null;
  platformOwner: OwnerLabelDto | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface AgentDto {
  id: string;
  tenantKey: string;
  scopeType: string;
  scopeId: string;
  handle: string;
  displayName: string;
  description: string | null;
  profileId: string;
  profile: Pick<ProfileDto, 'id' | 'name' | 'displayName' | 'status'> | null;
  ownerUserId: string | null;
  platformOwnerId: string | null;
  platformOwner: OwnerLabelDto | null;
  // Execution machine binding (design D-A8). `machineId` is NULL for a
  // server-local agent; `machine` carries a compact label so the console can group
  // agents by machine without a second fetch (null when unbound).
  machineId: string | null;
  machine: AgentMachineDto | null;
  visibility: string;
  defaultRuntime: string | null;
  defaultWorkDir: string | null;
  runtimeEnvKeys: string[];
  projectId: string | null;
  accessPolicy: Record<string, unknown>;
  status: string;
  binding: BotBindingDto | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Compact machine label embedded in {@link AgentDto} for the Agents-by-machine grouping (D-A8). */
export interface AgentMachineDto {
  id: string;
  name: string;
  status: string;
}

export interface FeishuAppDto {
  id: string;
  tenantKey: string;
  appId: string;
  appSecretRef: string;
  hasStoredSecret: boolean;
  botOpenId: string | null;
  botName: string | null;
  eventMode: string;
  status: string;
  platformOwnerId: string | null;
  platformOwner: OwnerLabelDto | null;
  binding: BotBindingSummaryDto | null;
  createdAt: Date;
  updatedAt: Date;
}

/** A compact owner label surfaced to superadmins on owned-object tables (D-A4). */
export interface OwnerLabelDto {
  id: string;
  email: string | null;
  displayName: string | null;
}

/** Identity shape returned by `GET /admin/me` (design D-A4). */
export interface MeDto {
  id: string | null;
  email: string | null;
  displayName: string | null;
  role: 'user' | 'superadmin';
  /** Effective access to computer/server-side execution controls. */
  computerAccessEnabled: boolean;
  /** True for the break-glass loopback/token path (no platform-user row behind it). */
  tokenAdmin: boolean;
  /** True when this identity came from the local dev-auth path (design D-A6). */
  devAuth?: boolean;
}

export interface FeishuAppPermissionCheckDto extends FeishuPermissionCheckResult {
  feishuAppId: string;
  appId: string;
  checkedAt: Date;
}

export interface FeishuAppPermissionApplyDto {
  feishuAppId: string;
  appId: string;
  submittedAt: Date;
  submitted: boolean;
  status?: 'submitted' | 'no_pending_scopes';
  message?: string;
}

export type FeishuAppRegistrationStatus =
  | 'pending'
  | 'completed'
  | 'failed'
  | 'expired'
  | 'cancelled';

export interface FeishuAppRegistrationDto {
  id: string;
  status: FeishuAppRegistrationStatus;
  verificationUrl: string;
  expireIn: number;
  expiresAt: Date;
  app: FeishuAppDto | null;
  error: string | null;
  sdkStatus: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface BotBindingSummaryDto {
  id: string;
  agentId: string;
  agentHandle: string | null;
  agentDisplayName: string | null;
  status: string;
}

export interface BotBindingDto {
  id: string;
  agentId: string;
  feishuAppId: string;
  botOpenId: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ChatDto {
  tenantKey: string;
  chatId: string;
  displayName: string;
  openFeishuUrl: string;
  defaultWorkDir: string | null;
  defaultRuntime: string | null;
  defaultAgentId: string | null;
  defaultAgent: Pick<AgentDto, 'id' | 'handle' | 'displayName' | 'status'> | null;
  defaultMachineId: string | null;
  defaultMachineName: string | null;
  memoryEnabled: boolean;
  memorySummaryNextRunAt: Date | null;
  memorySummaryLastRunAt: Date | null;
  memorySummaryLastStatus: string | null;
  memorySummaryLastError: string | null;
  taskBoard: Pick<
    TaskBoardDto,
    'id' | 'name' | 'tasklistGuid' | 'openTasklistUrl' | 'taskCount'
  > | null;
  agents: ChatAgentDto[];
  taskCount: number;
  lastTaskAt: Date | null;
  createdAt: Date | null;
  updatedAt: Date | null;
}

export interface ChatAgentDto {
  id: string;
  handle: string;
  displayName: string;
  status: string;
  taskCount: number;
  lastTaskAt: Date | null;
}

export interface TaskBoardTaskDto {
  id: string;
  taskId: string;
  trackingSpaceId: string;
  sessionId: string;
  chatId: string;
  title: string;
  taskType: string;
  localStatus: string;
  trackingStatus: string;
  runtimeHint: string | null;
  feishuTaskGuid: string | null;
  openTaskUrl: string | null;
  sourceTopicUrl: string | null;
  lastSyncError: string | null;
  runs: TaskRunDto[];
  createdAt: Date;
  updatedAt: Date;
}

export interface TaskRunDto {
  id: string;
  taskId: string;
  runtimeBackend: string;
  mode: string;
  workspacePath: string | null;
  externalSessionRef: string | null;
  status: string;
  exitCode: number | null;
  startedAt: Date;
  completedAt: Date | null;
  lastHeartbeatAt: Date | null;
  eventCount: number;
  events: TaskRunEventDto[];
}

export interface TaskRunEventDto {
  id: string;
  runId: string;
  taskId: string;
  eventIndex: number;
  eventType: string;
  message: string | null;
  progress: number | null;
  payload: unknown;
  createdAt: Date;
}

export interface TaskBoardDto {
  id: string;
  name: string;
  scopeType: string;
  scopeId: string;
  chatId: string | null;
  chatDisplayName: string | null;
  tasklistGuid: string;
  openTasklistUrl: string;
  openChatUrl: string | null;
  statusFieldGuid: string;
  statusOptions: unknown;
  sections: unknown;
  tasks: TaskBoardTaskDto[];
  taskCount: number;
  statusCounts: Record<string, number>;
  createdAt: Date;
  updatedAt: Date;
}

export class AdminApiError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export function buildFeishuChatOpenUrl(chatId: string): string {
  return `https://applink.feishu.cn/client/chat/open?openChatId=${encodeURIComponent(chatId)}`;
}

export function buildFeishuTasklistOpenUrl(tasklistGuid: string): string {
  return `https://applink.feishu.cn/client/todo/task_list?guid=${encodeURIComponent(tasklistGuid)}`;
}

const TRACKING_STATUS_ORDER = [
  'todo',
  'in-progress',
  'to-clarify',
  'review',
  'completed',
  'cleaned',
  'unknown',
] as const;
const FEISHU_EMPTY_UNAUTHORIZED_SCOPES_CODE = 212002;
const FEISHU_DUPLICATE_SCOPE_APPLY_CODE = 212004;
const FEISHU_EMPTY_UNAUTHORIZED_SCOPES_MESSAGE =
  "No pending app-version scopes can be submitted for approval. Add the missing scopes to this app's permission configuration in Feishu Open Platform, publish or approve that app version, then run Check permissions again.";

function parseFeishuErrorCode(body: string | undefined): number | null {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body) as { code?: unknown };
    return typeof parsed.code === 'number' ? parsed.code : null;
  } catch {
    return null;
  }
}

function feishuErrorDetails(error: unknown): { code?: number; body?: string } {
  if (!error || typeof error !== 'object') return {};
  const details = (error as { details?: unknown }).details;
  if (!details || typeof details !== 'object') return {};
  const code = (details as { code?: unknown }).code;
  const body = (details as { body?: unknown }).body;
  return {
    ...(typeof code === 'number' ? { code } : {}),
    ...(typeof body === 'string' ? { body } : {}),
  };
}

function isEmptyUnauthorizedScopesError(error: unknown): boolean {
  const details = feishuErrorDetails(error);
  if (details.code === FEISHU_EMPTY_UNAUTHORIZED_SCOPES_CODE) return true;
  if (parseFeishuErrorCode(details.body) === FEISHU_EMPTY_UNAUTHORIZED_SCOPES_CODE) {
    return true;
  }

  const message = errorMessage(error);
  return (
    message.includes(`code ${FEISHU_EMPTY_UNAUTHORIZED_SCOPES_CODE}`) ||
    message.includes(`"code":${FEISHU_EMPTY_UNAUTHORIZED_SCOPES_CODE}`) ||
    message.includes('unauthorized scopes were empty')
  );
}

function isDuplicateScopeApplyError(error: unknown): boolean {
  const details = feishuErrorDetails(error);
  if (details.code === FEISHU_DUPLICATE_SCOPE_APPLY_CODE) return true;
  if (parseFeishuErrorCode(details.body) === FEISHU_DUPLICATE_SCOPE_APPLY_CODE) {
    return true;
  }

  const message = errorMessage(error);
  return (
    message.includes(`code ${FEISHU_DUPLICATE_SCOPE_APPLY_CODE}`) ||
    message.includes(`"code":${FEISHU_DUPLICATE_SCOPE_APPLY_CODE}`) ||
    message.includes('duplicate apply')
  );
}

function feishuPermissionApplyError(error: unknown): AdminApiError {
  return new AdminApiError(502, `Feishu app permission apply failed: ${errorMessage(error)}`);
}

function buildChatKey(tenantKey: string, chatId: string): string {
  return `${tenantKey}:${chatId}`;
}

function parseChatScope(
  scopeType: string,
  scopeId: string,
): { tenantKey: string; chatId: string } | null {
  if (scopeType !== 'chat') return null;
  if (scopeId.startsWith('oc_')) {
    return { tenantKey: 'default', chatId: scopeId };
  }
  const delimiter = scopeId.lastIndexOf(':');
  if (delimiter <= 0 || delimiter === scopeId.length - 1) return null;
  const chatId = scopeId.slice(delimiter + 1);
  if (!chatId.startsWith('oc_')) return null;
  return { tenantKey: scopeId.slice(0, delimiter), chatId };
}

export function buildTaskBoardChatKey(scopeType: string, scopeId: string): string | null {
  const chat = parseChatScope(scopeType, scopeId);
  return chat ? buildChatKey(chat.tenantKey, chat.chatId) : null;
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function normalizeObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeRuntimeEnv(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (entry): entry is [string, string] =>
        RuntimeEnvKeySchema.safeParse(entry[0]).success && typeof entry[1] === 'string',
    ),
  );
}

function runtimeEnvKeys(value: unknown): string[] {
  return Object.keys(normalizeRuntimeEnv(value)).sort();
}

// runtimeEnv keys that look like secret material. Unlike access-bundle credentials
// (env NAMES only; VALUES resolved from a SecretProvider at execution, never
// persisted — see packages/registry/src/access-injection.ts), runtimeEnv VALUES are
// STORED verbatim as plaintext in `agents.runtime_env` (ADR-0012). We WARN by name
// when a write carries such a key — never reject, because per-agent custom Claude
// credentials (ANTHROPIC_API_KEY) are a supported feature — and never log the VALUE.
// `(^|_)` so a bare `API_KEY` / `TOKEN` / `SECRET` matches as well as suffixed names
// like `ANTHROPIC_API_KEY` or `GITHUB_TOKEN`.
const SENSITIVE_RUNTIME_ENV_KEY_PATTERN = /(^|_)(API_KEY|TOKEN|SECRET)$/i;

function sensitiveRuntimeEnvKeys(runtimeEnv: Record<string, string> | undefined): string[] {
  if (!runtimeEnv) return [];
  return Object.keys(runtimeEnv)
    .filter((key) => key === ANTHROPIC_API_KEY_KEY || SENSITIVE_RUNTIME_ENV_KEY_PATTERN.test(key))
    .sort();
}

/**
 * Emit a structured WARN (NAMES only, never VALUES) when an agent write persists
 * sensitive-looking runtimeEnv keys as plaintext. No-op when there are none. See
 * {@link sensitiveRuntimeEnvKeys} and ADR-0012.
 */
function warnSensitiveRuntimeEnv(
  request: FastifyRequest,
  agentId: string,
  runtimeEnv: Record<string, string> | undefined,
): void {
  const keys = sensitiveRuntimeEnvKeys(runtimeEnv);
  if (keys.length === 0) return;
  request.log.warn(
    { event: 'runtimeEnv.sensitive_key_stored', agentId, keys },
    'Storing sensitive runtimeEnv keys as plaintext; prefer an access-bundle for secret values',
  );
}

function shortenId(value: string, head = 8, tail = 6): string {
  if (value.length <= head + tail + 3) return value;
  return `${value.slice(0, head)}...${value.slice(-tail)}`;
}

function chatDisplayNameFallback(chatId: string): string {
  return `Chat ${shortenId(chatId, 10, 6)}`;
}

function normalizeChatDisplayName(
  displayName: string | null | undefined,
  chatId: string,
): string | null {
  const name = displayName?.trim();
  if (!name || name === chatId || /^oc_[A-Za-z0-9]+$/.test(name)) return null;
  return name;
}

function buildChatDisplayName(displayName: string | null | undefined, chatId: string): string {
  return normalizeChatDisplayName(displayName, chatId) ?? chatDisplayNameFallback(chatId);
}

function extractChatNameFromTaskBoardName(
  name: string | null | undefined,
  chatId: string,
): string | null {
  const trimmed = name?.trim();
  if (!trimmed) return null;
  for (const suffix of ['任务看板', ' Task Board']) {
    if (trimmed.endsWith(suffix) && trimmed.length > suffix.length) {
      return normalizeChatDisplayName(trimmed.slice(0, -suffix.length), chatId);
    }
  }
  return null;
}

export function resolveChatDisplayName(input: {
  configDisplayName?: string | null;
  chatId: string;
  taskBoardName?: string | null;
}): string {
  return buildChatDisplayName(
    input.configDisplayName ?? extractChatNameFromTaskBoardName(input.taskBoardName, input.chatId),
    input.chatId,
  );
}

export async function resolveReadableChatDisplayName(
  options: AdminApiStoreOptions,
  input: {
    tenantKey: string;
    chatId: string;
    configDisplayName?: string | null;
    taskBoardName?: string | null;
  },
): Promise<string> {
  const localDisplayName = resolveChatDisplayName(input);
  if (localDisplayName !== chatDisplayNameFallback(input.chatId)) return localDisplayName;
  if (!options.resolveFeishuChatDisplayName) return localDisplayName;

  const feishuDisplayName = await options
    .resolveFeishuChatDisplayName({ tenantKey: input.tenantKey, chatId: input.chatId })
    .catch(() => null);
  return buildChatDisplayName(feishuDisplayName, input.chatId);
}

function buildTaskBoardName(
  name: string | null | undefined,
  scopeType: string,
  chatDisplayName: string | null,
): string {
  const boardName = name?.trim();
  if (boardName) return boardName;
  if (scopeType === 'chat') {
    return chatDisplayName ? `${chatDisplayName} Task Board` : 'Chat Task Board';
  }
  return 'OpenClaudeTag Project Tracking';
}

function normalizeTrackingStatus(value: string | null, localStatus: string | null): string {
  if (value?.trim()) return value.trim();
  if (localStatus === 'running') return 'in-progress';
  if (localStatus === 'failed' || localStatus === 'cancelled') return 'review';
  if (localStatus === 'completed') return 'completed';
  return 'todo';
}

function buildStatusCounts(tasks: TaskBoardTaskDto[]): Record<string, number> {
  const counts = createEmptyStatusCounts();
  for (const task of tasks) {
    incrementStatusCount(counts, task.trackingStatus);
  }
  return counts;
}

function createEmptyStatusCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const status of TRACKING_STATUS_ORDER) counts[status] = 0;
  return counts;
}

function incrementStatusCount(counts: Record<string, number>, status: string): void {
  counts[status] = (counts[status] ?? 0) + 1;
}

interface TaskBoardTaskStats {
  taskCount: number;
  statusCounts: Record<string, number>;
}

function buildTaskBoardTaskStats(tasks: TaskBoardTaskDto[]): Map<string, TaskBoardTaskStats> {
  const stats = new Map<string, TaskBoardTaskStats>();
  for (const task of tasks) {
    const boardStats = stats.get(task.trackingSpaceId) ?? {
      taskCount: 0,
      statusCounts: createEmptyStatusCounts(),
    };
    boardStats.taskCount += 1;
    incrementStatusCount(boardStats.statusCounts, task.trackingStatus);
    stats.set(task.trackingSpaceId, boardStats);
  }
  return stats;
}

function toTaskRunEventDto(row: typeof taskRunEvents.$inferSelect): TaskRunEventDto {
  return {
    id: row.id,
    runId: row.runId,
    taskId: row.taskId,
    eventIndex: row.eventIndex,
    eventType: row.eventType,
    message: row.message,
    progress: row.progress,
    payload: row.payload,
    createdAt: row.createdAt,
  };
}

function toTaskRunDto(
  row: typeof taskRuns.$inferSelect,
  events: TaskRunEventDto[] = [],
): TaskRunDto {
  return {
    id: row.id,
    taskId: row.taskId,
    runtimeBackend: row.runtimeBackend,
    mode: row.mode,
    workspacePath: row.workspacePath,
    externalSessionRef: row.externalSessionRef,
    status: row.status,
    exitCode: row.exitCode,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    lastHeartbeatAt: row.lastHeartbeatAt,
    eventCount: events.length,
    events,
  };
}

function toProfileDto(
  row: typeof agentProfiles.$inferSelect,
  platformOwner: OwnerLabelDto | null = null,
): ProfileDto {
  return {
    id: row.id,
    name: row.name,
    displayName: row.displayName,
    description: row.description,
    systemPrompt: row.systemPrompt,
    stylePrompt: row.stylePrompt,
    skillRefs: normalizeStringArray(row.skillRefs),
    defaultRuntime: row.defaultRuntime,
    defaultModel: row.defaultModel,
    sourceType: row.sourceType,
    sourceUri: row.sourceUri,
    platformOwnerId: row.platformOwnerId,
    platformOwner,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toMachineDto(row: typeof machines.$inferSelect): MachineDto {
  const runtimes = Array.isArray(row.capabilities?.runtimes)
    ? row.capabilities.runtimes.filter((item): item is string => typeof item === 'string')
    : [];
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    // Legacy openId owner; empty string for console-owned machines (D-A7), which
    // carry a `platformOwnerId` instead. The console renders owner from the
    // platform identity going forward.
    ownerOpenId: row.ownerOpenId ?? '',
    lastSeenAt: row.lastSeenAt,
    runtimes,
    createdAt: row.createdAt,
  };
}

// Order machines for the operator console: online first, then most-recently-seen.
// Mirrors the `/machine list` UX from the daemon design (status + last-seen).
function compareMachinesForListing(
  a: typeof machines.$inferSelect,
  b: typeof machines.$inferSelect,
): number {
  const aOnline = a.status === 'online' ? 0 : 1;
  const bOnline = b.status === 'online' ? 0 : 1;
  if (aOnline !== bOnline) return aOnline - bOnline;
  const aSeen = a.lastSeenAt?.getTime() ?? 0;
  const bSeen = b.lastSeenAt?.getTime() ?? 0;
  return bSeen - aSeen;
}

function toBindingDto(row: typeof agentBotBindings.$inferSelect): BotBindingDto {
  return {
    id: row.id,
    agentId: row.agentId,
    feishuAppId: row.feishuAppId,
    botOpenId: row.botOpenId,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function buildManagedProfileName(handle: string): string {
  const safeHandle = handle
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const prefix = safeHandle || 'agent';
  const suffix = randomUUID().slice(0, 8);
  return `${prefix.slice(0, 55)}-${suffix}`;
}

function toTaskBoardDto(
  row: typeof feishuTaskTrackingSpaces.$inferSelect,
  options: {
    chatDisplayName?: string | null;
    tasks?: TaskBoardTaskDto[];
    taskCount?: number;
    statusCounts?: Record<string, number>;
  } = {},
): TaskBoardDto {
  const chat = parseChatScope(row.scopeType, row.scopeId);
  const taskRows = options.tasks ?? [];
  const chatDisplayName =
    options.chatDisplayName ??
    (chat ? resolveChatDisplayName({ chatId: chat.chatId, taskBoardName: row.name }) : null);
  return {
    id: row.id,
    name: buildTaskBoardName(row.name, row.scopeType, chatDisplayName),
    scopeType: row.scopeType,
    scopeId: row.scopeId,
    chatId: chat?.chatId ?? null,
    chatDisplayName,
    tasklistGuid: row.tasklistGuid,
    openTasklistUrl: buildFeishuTasklistOpenUrl(row.tasklistGuid),
    openChatUrl: chat ? buildFeishuChatOpenUrl(chat.chatId) : null,
    statusFieldGuid: row.statusFieldGuid,
    statusOptions: row.statusOptions,
    sections: row.sections,
    tasks: taskRows,
    taskCount: options.taskCount ?? taskRows.length,
    statusCounts: options.statusCounts ?? buildStatusCounts(taskRows),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function listTaskBoardTaskStats(db: Database): Promise<Map<string, TaskBoardTaskStats>> {
  const rows = await db
    .select({
      trackingSpaceId: feishuTaskLinks.trackingSpaceId,
      lastSyncedStatus: feishuTaskLinks.lastSyncedStatus,
      localStatus: tasks.status,
    })
    .from(feishuTaskLinks)
    .innerJoin(tasks, eq(feishuTaskLinks.taskId, tasks.id));
  const stats = new Map<string, TaskBoardTaskStats>();
  for (const row of rows) {
    if (!row.trackingSpaceId) continue;
    const boardStats = stats.get(row.trackingSpaceId) ?? {
      taskCount: 0,
      statusCounts: createEmptyStatusCounts(),
    };
    boardStats.taskCount += 1;
    incrementStatusCount(
      boardStats.statusCounts,
      normalizeTrackingStatus(row.lastSyncedStatus, row.localStatus),
    );
    stats.set(row.trackingSpaceId, boardStats);
  }
  return stats;
}

function trackingStatusPredicate(status: string): SQL {
  return sql`
    case
      when nullif(trim(${feishuTaskLinks.lastSyncedStatus}), '') is not null
        then trim(${feishuTaskLinks.lastSyncedStatus})
      when ${tasks.status} = 'running' then 'in-progress'
      when ${tasks.status} in ('failed', 'cancelled') then 'review'
      when ${tasks.status} = 'completed' then 'completed'
      else 'todo'
    end = ${status}
  `;
}

async function listTaskBoardTasks(
  db: Database,
  options: { trackingSpaceId?: string; offset?: number; limit?: number; status?: string } = {},
): Promise<TaskBoardTaskDto[]> {
  let query = db
    .select({
      id: feishuTaskLinks.id,
      taskId: feishuTaskLinks.taskId,
      trackingSpaceId: feishuTaskLinks.trackingSpaceId,
      feishuTaskGuid: feishuTaskLinks.feishuTaskGuid,
      openTaskUrl: feishuTaskLinks.feishuTaskUrl,
      sourceTopicUrl: feishuTaskLinks.sourceTopicUrl,
      lastSyncedStatus: feishuTaskLinks.lastSyncedStatus,
      lastSyncError: feishuTaskLinks.lastSyncError,
      sessionId: tasks.sessionId,
      chatId: sessions.chatId,
      title: tasks.goal,
      taskType: tasks.taskType,
      localStatus: tasks.status,
      runtimeHint: tasks.runtimeHint,
      createdAt: tasks.createdAt,
      updatedAt: tasks.updatedAt,
    })
    .from(feishuTaskLinks)
    .innerJoin(tasks, eq(feishuTaskLinks.taskId, tasks.id))
    .innerJoin(sessions, eq(tasks.sessionId, sessions.id))
    .$dynamic();

  const conditions: SQL[] = [];
  if (options.trackingSpaceId) {
    conditions.push(eq(feishuTaskLinks.trackingSpaceId, options.trackingSpaceId));
  }
  if (options.status) {
    conditions.push(trackingStatusPredicate(options.status));
  }
  if (conditions.length > 0) {
    query = query.where(and(...conditions));
  }
  query = query.orderBy(desc(tasks.createdAt));
  if (options.limit !== undefined) {
    query = query.limit(options.limit);
  }
  if (options.offset !== undefined && options.offset > 0) {
    query = query.offset(options.offset);
  }

  const rows = await query;

  const taskIds = [...new Set(rows.map((row) => row.taskId))];
  const runRows =
    taskIds.length > 0
      ? await db
          .select()
          .from(taskRuns)
          .where(inArray(taskRuns.taskId, taskIds))
          .orderBy(desc(taskRuns.startedAt))
      : [];
  const runIds = runRows.map((row) => row.id);
  const eventRows =
    runIds.length > 0
      ? await db
          .select()
          .from(taskRunEvents)
          .where(inArray(taskRunEvents.runId, runIds))
          .orderBy(asc(taskRunEvents.eventIndex))
      : [];
  const eventsByRunId = new Map<string, TaskRunEventDto[]>();
  for (const eventRow of eventRows) {
    const event = toTaskRunEventDto(eventRow);
    const bucket = eventsByRunId.get(event.runId) ?? [];
    bucket.push(event);
    eventsByRunId.set(event.runId, bucket);
  }
  const runsByTaskId = new Map<string, TaskRunDto[]>();
  for (const runRow of runRows) {
    const run = toTaskRunDto(runRow, eventsByRunId.get(runRow.id) ?? []);
    const bucket = runsByTaskId.get(run.taskId) ?? [];
    bucket.push(run);
    runsByTaskId.set(run.taskId, bucket);
  }

  return rows
    .filter((row) => row.trackingSpaceId)
    .map((row) => ({
      id: row.id,
      taskId: row.taskId,
      trackingSpaceId: row.trackingSpaceId!,
      sessionId: row.sessionId,
      chatId: row.chatId,
      title: row.title,
      taskType: row.taskType,
      localStatus: row.localStatus,
      trackingStatus: normalizeTrackingStatus(row.lastSyncedStatus, row.localStatus),
      runtimeHint: row.runtimeHint,
      feishuTaskGuid: row.feishuTaskGuid,
      openTaskUrl: row.openTaskUrl,
      sourceTopicUrl: row.sourceTopicUrl,
      lastSyncError: row.lastSyncError,
      runs: runsByTaskId.get(row.taskId) ?? [],
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
}

function rowNotFound(entity: string): AdminApiError {
  return new AdminApiError(404, `${entity} not found`);
}

/**
 * Translate a Postgres unique violation (23505) on the agents handle index into
 * a friendly 409. Anything else is rethrown untouched. Without this, creating
 * an agent whose handle is already taken in the same tenant/scope surfaced as a
 * raw 500 "duplicate key value violates unique constraint".
 */
/**
 * Derive the internal handle from a user-facing display name. Names are now
 * unique per owner (idx_agents_owner_handle), so the handle is just a
 * normalized copy of the display name used as the uniqueness key — routing and
 * handoff use the agent id, not the handle. Whitespace is collapsed and the
 * value is truncated to the handle column width (64).
 */
export function deriveAgentHandle(displayName: string): string {
  return displayName.trim().replace(/\s+/g, ' ').slice(0, 64);
}

/**
 * Translate a Postgres unique violation (23505) on either agent-handle index
 * into a friendly 409. Names are unique within one owner's agents now, so the
 * conflict means the caller already has an agent with this name. Anything else
 * is rethrown untouched.
 */
function rethrowAgentHandleConflict(error: unknown, displayName: string): never {
  const pgError = error as { code?: string; message?: string };
  const message = pgError?.message ?? '';
  if (
    pgError?.code === '23505' &&
    (message.includes('idx_agents_owner_handle') || message.includes('idx_agents_scope_handle'))
  ) {
    throw new AdminApiError(
      409,
      `You already have an agent named "${displayName}". Pick a different name.`,
    );
  }
  throw error;
}

/**
 * Translate a Postgres unique violation (23505) on either active-binding partial
 * index into a friendly 409. The indexes (`idx_agent_bot_bindings_active_agent` /
 * `_active_app`) enforce one active binding per agent and per app; a concurrent
 * bind that races past the in-transaction deactivation surfaces as 23505. Without
 * this, that collision was a raw 500. Anything else is rethrown untouched.
 */
function rethrowBotBindingConflict(error: unknown): never {
  const pgError = error as { code?: string; message?: string };
  const message = pgError?.message ?? '';
  if (
    pgError?.code === '23505' &&
    (message.includes('idx_agent_bot_bindings_active_agent') ||
      message.includes('idx_agent_bot_bindings_active_app'))
  ) {
    throw new AdminApiError(
      409,
      'This agent or Feishu app already has an active bot binding. Unbind it first, then retry.',
    );
  }
  throw error;
}

function platformUserHasComputerAccess(
  user: Pick<PlatformUser, 'role' | 'computerAccessEnabled'>,
): boolean {
  return user.role === 'superadmin' || user.computerAccessEnabled;
}

function scopeHasComputerAccess(scope: OwnerScope): boolean {
  return scope.isSuperadmin || scope.computerAccessEnabled;
}

/**
 * Computer access gates exactly one capability: choosing SERVER-LOCAL execution
 * for an agent (creating an agent without a machine binding, or clearing an
 * existing binding back to server-local). Pairing machines, managing them, and
 * binding agents/chats to machines the user OWNS are open to every platform
 * user — ownership rules (D-A3/D-A7/D-A8) still apply there.
 */
function assertComputerAccess(scope: OwnerScope): void {
  if (!scopeHasComputerAccess(scope)) {
    throw new AdminApiError(403, 'Server-side execution is disabled for this user');
  }
}

function assertSuperadmin(scope: OwnerScope): void {
  if (!scope.isSuperadmin) {
    throw new AdminApiError(403, 'Superadmin access is required');
  }
}

function toComputerAccessUserDto(row: typeof platformUsers.$inferSelect): ComputerAccessUserDto {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    role: row.role === 'superadmin' ? 'superadmin' : 'user',
    computerAccessEnabled: platformUserHasComputerAccess(row),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ── Owner-scope helpers (D-A3 fail-closed) ──

/**
 * Drizzle predicate matching feishu_apps owned by the scope, or `undefined` for a
 * superadmin (no filter). A plain user matches only rows whose
 * `platform_owner_id` equals their id; NULL-owner rows never match (fail closed).
 */
function feishuAppOwnerFilter(scope: OwnerScope): SQL | undefined {
  if (scope.isSuperadmin) return undefined;
  if (!scope.platformUserId) return sql`false`;
  return eq(feishuApps.platformOwnerId, scope.platformUserId);
}

function notDeletedFeishuAppFilter(): SQL {
  return sql`not (${feishuApps.status} = 'disabled' and left(${feishuApps.appId}, ${DELETED_FEISHU_APP_ID_PREFIX.length}) = ${DELETED_FEISHU_APP_ID_PREFIX})`;
}

function visibleFeishuAppFilter(scope: OwnerScope): SQL {
  const ownerFilter = feishuAppOwnerFilter(scope);
  const deletedFilter = notDeletedFeishuAppFilter();
  return ownerFilter ? and(ownerFilter, deletedFilter)! : deletedFilter;
}

function buildDeletedFeishuAppId(): string {
  return `${DELETED_FEISHU_APP_ID_PREFIX}${randomUUID().replaceAll('-', '')}`;
}

function isDeletedFeishuAppRow(row: { appId: string; status: string }): boolean {
  return row.status === 'disabled' && row.appId.startsWith(DELETED_FEISHU_APP_ID_PREFIX);
}

/** Drizzle predicate matching agents owned by the scope, or `undefined` for superadmin. */
function agentOwnerFilter(scope: OwnerScope): SQL | undefined {
  if (scope.isSuperadmin) return undefined;
  if (!scope.platformUserId) return sql`false`;
  return eq(agents.platformOwnerId, scope.platformUserId);
}

function notDeletedAgentFilter(): SQL {
  return sql`not (${agents.status} = 'archived' and left(${agents.handle}, ${DELETED_AGENT_HANDLE_PREFIX.length}) = ${DELETED_AGENT_HANDLE_PREFIX})`;
}

function visibleAgentFilter(scope: OwnerScope): SQL {
  const ownerFilter = agentOwnerFilter(scope);
  const deletedFilter = notDeletedAgentFilter();
  return ownerFilter ? and(ownerFilter, deletedFilter)! : deletedFilter;
}

function buildDeletedAgentHandle(): string {
  return `${DELETED_AGENT_HANDLE_PREFIX}${randomUUID().replaceAll('-', '')}`;
}

function isDeletedAgentRow(row: { handle: string; status: string }): boolean {
  return row.status === 'archived' && row.handle.startsWith(DELETED_AGENT_HANDLE_PREFIX);
}

/**
 * The set of tenantKeys the scope can see: the distinct `tenantKey`s of the apps
 * it owns. The summary and machines inherit visibility through this set (a user
 * with no owned apps sees nothing tenant-scoped). Superadmins are handled by
 * callers short-circuiting before this is consulted.
 *
 * NOTE: chats and task boards do NOT use this — see {@link ownedChatIdSet}. The
 * tenant-grant model was rejected by D-A2 (two colleagues in the same Feishu
 * tenant must not see each other's chats), and R2-1 tightened chat/board scoping
 * to per-agent ownership.
 */
async function ownedTenantSet(db: Database, scope: OwnerScope): Promise<Set<string>> {
  if (scope.isSuperadmin) return new Set();
  if (!scope.platformUserId) return new Set();
  const rows = await db
    .select({ tenantKey: feishuApps.tenantKey })
    .from(feishuApps)
    .where(visibleFeishuAppFilter(scope));
  return new Set(rows.map((row) => row.tenantKey));
}

/**
 * R2-1 chat/board ownership predicate — the single store-layer choke point for
 * which chats and task boards a plain user may see/mutate.
 *
 * A chat is visible to a plain user iff they OWN at least one agent that is
 * active-in or bound-to that chat:
 *   - active-in: the agent has run ≥1 task whose session lives in that chat
 *     (`tasks.agent_id` → `tasks.session_id` → `sessions.chat_id`), OR
 *   - bound-to: the agent is the chat's configured default
 *     (`chat_configs.default_agent_id`).
 * Ownership of the agent is by `agents.platform_owner_id === scope.platformUserId`
 * (the D-A2 per-creator model). Chat ids (`oc_…`) are globally unique in Feishu,
 * so the set is keyed by `chatId` alone, matching how chat activity is aggregated.
 *
 * Fail-closed: a user who owns no agent active-in/bound-to a chat does not see it
 * and gets a 404 on mutate. A task board inherits the chat's visibility (it
 * belongs to exactly one chat). Superadmin callers short-circuit before this runs.
 */
async function ownedChatIdSet(db: Database, scope: OwnerScope): Promise<Set<string>> {
  if (scope.isSuperadmin) return new Set();
  if (!scope.platformUserId) return new Set();
  const ownedAgentIdRows = await db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.platformOwnerId, scope.platformUserId));
  const ownedAgentIds = ownedAgentIdRows.map((row) => row.id);
  if (ownedAgentIds.length === 0) return new Set();

  // active-in: chats where an owned agent has run a task.
  const activeRows = await db
    .select({ chatId: sessions.chatId })
    .from(tasks)
    .innerJoin(sessions, eq(tasks.sessionId, sessions.id))
    .where(inArray(tasks.agentId, ownedAgentIds));

  // bound-to: chats whose configured default agent is owned.
  const boundRows = await db
    .select({ chatId: chatConfigs.chatId })
    .from(chatConfigs)
    .where(inArray(chatConfigs.defaultAgentId, ownedAgentIds));

  const chatIds = new Set<string>();
  for (const row of activeRows) if (row.chatId) chatIds.add(row.chatId);
  for (const row of boundRows) if (row.chatId) chatIds.add(row.chatId);
  return chatIds;
}

/** Select non-deleted agents visible to the scope (owner-filtered for plain users). */
function agentScopedSelect(db: Database, scope: OwnerScope) {
  return db.select().from(agents).where(visibleAgentFilter(scope));
}

/** Load owner labels for the given platform user ids (for superadmin owner columns). */
async function loadOwnerLabels(
  db: Database,
  ownerIds: Array<string | null | undefined>,
): Promise<Map<string, OwnerLabelDto>> {
  const ids = [...new Set(ownerIds.filter((id): id is string => Boolean(id)))];
  if (ids.length === 0) return new Map();
  const rows = await db.select().from(platformUsers).where(inArray(platformUsers.id, ids));
  return new Map(
    rows.map((row) => [row.id, { id: row.id, email: row.email, displayName: row.displayName }]),
  );
}

/**
 * Assert the scope owns a row given its `platform_owner_id`. Superadmin always
 * passes. A plain user passes only when the row's owner equals their id; a
 * NULL-owner (legacy/ops) row is NOT owned by any plain user (fail closed). The
 * 404 (rather than 403) hides existence of out-of-scope rows.
 */
function assertOwnsRow(scope: OwnerScope, ownerId: string | null, entity: string): void {
  if (scope.isSuperadmin) return;
  if (scope.platformUserId && ownerId && ownerId === scope.platformUserId) return;
  throw rowNotFound(entity);
}

/**
 * Assert the scope may ASSIGN/REFERENCE a row it does not necessarily own:
 * superadmin always passes; a plain user passes when the row is theirs OR a
 * shared/ops/legacy (NULL-owner) row. Unlike {@link assertOwnsRow} (which
 * fail-closes on NULL owners because *mutating* a shared row needs ops), pointing
 * a chat default at a shared agent/profile is a safe reference, so NULL is
 * allowed. 404 (not 403) hides existence of another user's private row.
 */
function assertAssignableOwnedRow(scope: OwnerScope, ownerId: string | null, entity: string): void {
  if (scope.isSuperadmin) return;
  if (ownerId === null) return;
  if (scope.platformUserId && ownerId === scope.platformUserId) return;
  throw rowNotFound(entity);
}

/**
 * Validate an agent's `machine_id` binding (design D-A8). When `machineId` is null,
 * the agent runs server-local — nothing to check. When non-null, the machine MUST:
 *   1. exist,
 *   2. be owned by `ownerPlatformUserId` (the agent's platform_owner / current user)
 *      — UNLESS the scope is a superadmin, who may bind any machine, and
 *   3. not be revoked.
 * Any failure throws a 400 with an actionable message (fail-closed, D-A3). The
 * ownership check is by `platform_owner_id`, the sole machine-ownership domain (D-A7).
 */
async function assertMachineBindable(
  db: Database,
  scope: OwnerScope,
  machineId: string,
  ownerPlatformUserId: string | null,
): Promise<void> {
  const [machine] = await db
    .select({ status: machines.status, platformOwnerId: machines.platformOwnerId })
    .from(machines)
    .where(eq(machines.id, machineId))
    .limit(1);
  if (!machine) {
    throw new AdminApiError(400, 'Selected machine does not exist');
  }
  if (machine.status === 'revoked') {
    throw new AdminApiError(
      400,
      'Selected machine is revoked; choose an active machine or set the agent to server-local',
    );
  }
  // Superadmins (ops) may bind any non-revoked machine; plain users are confined to
  // machines they own and may only bind to agents they own (ownerPlatformUserId).
  if (scope.isSuperadmin) return;
  if (!ownerPlatformUserId || machine.platformOwnerId !== ownerPlatformUserId) {
    throw new AdminApiError(400, 'Selected machine is not owned by you');
  }
}

/**
 * Validate a chat's `default_machine_id` binding (R2-2). Mirrors
 * {@link assertMachineBindable} but with chat-appropriate copy. A plain user may
 * only bind a machine they own (`platform_owner_id === scope.platformUserId`); a
 * superadmin may bind any non-revoked machine. Binding to another user's daemon
 * was a cross-user remote-code-execution path (the chat's tasks would run on it).
 */
async function assertChatMachineBindable(
  db: Database,
  scope: OwnerScope,
  machineId: string,
): Promise<void> {
  const [machine] = await db
    .select({ status: machines.status, platformOwnerId: machines.platformOwnerId })
    .from(machines)
    .where(eq(machines.id, machineId))
    .limit(1);
  if (!machine) {
    throw new AdminApiError(400, 'Default machine does not exist');
  }
  if (machine.status === 'revoked') {
    throw new AdminApiError(
      400,
      'Default machine is revoked; choose an active machine or clear the binding',
    );
  }
  if (scope.isSuperadmin) return;
  if (!scope.platformUserId || machine.platformOwnerId !== scope.platformUserId) {
    throw new AdminApiError(400, 'Default machine is not owned by you');
  }
}

/** Assert the scope can mutate a binding: it owns the app OR the agent (D-A3). */
async function assertOwnsBinding(
  db: Database,
  scope: OwnerScope,
  binding: typeof agentBotBindings.$inferSelect,
): Promise<void> {
  if (scope.isSuperadmin) return;
  const [agent] = await db
    .select({ platformOwnerId: agents.platformOwnerId })
    .from(agents)
    .where(eq(agents.id, binding.agentId))
    .limit(1);
  const [app] = await db
    .select({ platformOwnerId: feishuApps.platformOwnerId })
    .from(feishuApps)
    .where(eq(feishuApps.id, binding.feishuAppId))
    .limit(1);
  const owns =
    (scope.platformUserId &&
      ((agent?.platformOwnerId && agent.platformOwnerId === scope.platformUserId) ||
        (app?.platformOwnerId && app.platformOwnerId === scope.platformUserId))) ||
    false;
  if (!owns) throw rowNotFound('Bot binding');
}

/**
 * Assert the scope may mutate a profile (R2-6). A plain user may mutate ONLY a
 * profile they OWN (`agent_profiles.platform_owner_id === scope.platformUserId`).
 * Owning an agent that merely *uses* the profile is NOT sufficient — that was the
 * cross-user mutation loophole: a user could attach a shared/builtin profile to
 * their agent and then rewrite its prompt/runtime for everyone. A NULL-owner
 * (builtin/shared) profile is mutable by superadmin ONLY (fail-closed). 404 (not
 * 403) hides existence of out-of-scope profiles.
 */
async function assertProfileMutableByScope(
  db: Database,
  scope: OwnerScope,
  profileId: string,
): Promise<void> {
  if (scope.isSuperadmin) return;
  if (!scope.platformUserId) throw rowNotFound('Profile');
  const [row] = await db
    .select({ platformOwnerId: agentProfiles.platformOwnerId })
    .from(agentProfiles)
    .where(eq(agentProfiles.id, profileId))
    .limit(1);
  if (!row || row.platformOwnerId !== scope.platformUserId) throw rowNotFound('Profile');
}

/**
 * Assert the scope may ASSIGN a profile to its agent (R2-3). Looser than
 * {@link assertProfileMutableByScope}: a plain user may attach a profile they OWN
 * or a shared/builtin (NULL-owner) profile — attaching a shared profile is a safe
 * reference and does not mutate it. Another user's PRIVATE profile is rejected
 * with 404 (no existence leak). Superadmin may assign any. A missing profile is
 * 404 (replacing the prior existence-only profile check).
 */
async function assertProfileAssignableByScope(
  db: Database,
  scope: OwnerScope,
  profileId: string,
): Promise<void> {
  const [row] = await db
    .select({ platformOwnerId: agentProfiles.platformOwnerId })
    .from(agentProfiles)
    .where(eq(agentProfiles.id, profileId))
    .limit(1);
  if (!row) throw rowNotFound('Profile');
  assertAssignableOwnedRow(scope, row.platformOwnerId, 'Profile');
}

/**
 * Assert the scope may mutate a chat (R2-1 chat-mutation gate). A plain user may
 * mutate a chat only when they own an agent active-in / bound-to it (the same
 * predicate that governs visibility, {@link ownedChatIdSet}). Fail-closed: 404 on
 * any chat the user does not own an agent in. Superadmin always passes.
 */
async function assertChatInScope(db: Database, scope: OwnerScope, chatId: string): Promise<void> {
  if (scope.isSuperadmin) return;
  const ownedChatIds = await ownedChatIdSet(db, scope);
  if (!ownedChatIds.has(chatId)) throw rowNotFound('Chat');
}

async function resolveChatMemorySummaryAgentId(
  db: Database,
  scope: OwnerScope,
  input: {
    tenantKey: string;
    chatId: string;
    preferredAgentId?: string | null;
  },
): Promise<string | null> {
  async function assignableActiveAgent(agentId: string | null | undefined): Promise<string | null> {
    if (!agentId) return null;
    const [agent] = await db
      .select({
        id: agents.id,
        platformOwnerId: agents.platformOwnerId,
      })
      .from(agents)
      .where(
        and(
          eq(agents.id, agentId),
          eq(agents.tenantKey, input.tenantKey),
          eq(agents.status, 'active'),
        ),
      )
      .limit(1);
    if (!agent) return null;
    try {
      assertAssignableOwnedRow(scope, agent.platformOwnerId, 'Chat memory summary agent');
      return agent.id;
    } catch (error) {
      if (error instanceof AdminApiError && error.statusCode === 404) return null;
      throw error;
    }
  }

  const preferred = await assignableActiveAgent(input.preferredAgentId);
  if (preferred) return preferred;

  const activityRows = await db
    .select({
      agentId: agents.id,
      platformOwnerId: agents.platformOwnerId,
    })
    .from(tasks)
    .innerJoin(sessions, eq(tasks.sessionId, sessions.id))
    .innerJoin(agents, eq(tasks.agentId, agents.id))
    .where(
      and(
        eq(sessions.chatId, input.chatId),
        eq(agents.tenantKey, input.tenantKey),
        eq(agents.status, 'active'),
      ),
    )
    .orderBy(desc(tasks.createdAt))
    .limit(50);

  const seen = new Set<string>();
  for (const row of activityRows) {
    if (seen.has(row.agentId)) continue;
    seen.add(row.agentId);
    try {
      assertAssignableOwnedRow(scope, row.platformOwnerId, 'Chat memory summary agent');
      return row.agentId;
    } catch (error) {
      if (error instanceof AdminApiError && error.statusCode === 404) continue;
      throw error;
    }
  }

  return null;
}

function normalizeSecretRef(ref: string): string {
  return ref.startsWith('env:') ? ref.slice(4) : ref;
}

function resolveFeishuAppSecret(row: { appSecretRef: string; appSecret: string | null }): string {
  const secretRef = row.appSecretRef.trim();
  if (secretRef && secretRef !== 'stored') {
    const envName = normalizeSecretRef(secretRef);
    const envSecret = process.env[envName]?.trim();
    if (envSecret) return envSecret;
  }

  const storedSecret = row.appSecret?.trim();
  if (storedSecret) return storedSecret;

  if (!secretRef || secretRef === 'stored') {
    throw new AdminApiError(409, 'Stored Feishu app secret is not configured');
  }

  const envName = normalizeSecretRef(secretRef);
  throw new AdminApiError(409, `Feishu app secret env var ${envName} is not configured`);
}

function evaluateFeishuScopeGrants(input: {
  feishuAppId: string;
  appId: string;
  scopes: FeishuApplicationScopeGrant[];
  feishuTaskTrackingEnabled: boolean;
  feishuDocumentCommentsEnabled: boolean;
}): FeishuAppPermissionCheckDto {
  const grantedScopes = input.scopes
    .filter((scope) => scope.grantStatus === 1)
    .map((scope) => scope.scopeName);
  return {
    feishuAppId: input.feishuAppId,
    appId: input.appId,
    checkedAt: new Date(),
    ...evaluateFeishuPermissionScopes({
      grantedScopes,
      inventory: buildOpenClaudeTagFeishuPermissionInventory({
        feishuTaskTrackingEnabled: input.feishuTaskTrackingEnabled,
        feishuDocumentCommentsEnabled: input.feishuDocumentCommentsEnabled,
      }),
    }),
  };
}

function buildFeishuScopeApplyResult(input: {
  feishuAppId: string;
  appId: string;
}): FeishuAppPermissionApplyDto {
  return {
    feishuAppId: input.feishuAppId,
    appId: input.appId,
    submittedAt: new Date(),
    submitted: true,
    status: 'submitted',
  };
}

function buildFeishuNoPendingScopeApplyResult(input: {
  feishuAppId: string;
  appId: string;
}): FeishuAppPermissionApplyDto {
  return {
    feishuAppId: input.feishuAppId,
    appId: input.appId,
    submittedAt: new Date(),
    submitted: false,
    status: 'no_pending_scopes',
    message: FEISHU_EMPTY_UNAUTHORIZED_SCOPES_MESSAGE,
  };
}

type FeishuAppRegistrationSession = {
  id: string;
  scope: OwnerScope;
  platformOwnerId: string | null;
  tenantKey: string;
  botName: string | null;
  description: string | null;
  controller: AbortController;
  status: FeishuAppRegistrationStatus;
  verificationUrl: string;
  expireIn: number;
  expiresAt: Date;
  app: FeishuAppDto | null;
  error: string | null;
  sdkStatus: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type FeishuAppRegistrationReady = {
  verificationUrl: string;
  expireIn: number;
  expiresAt: Date;
};

const DEFAULT_ONE_CLICK_BOT_NAME = 'OpenClaudeTag Bot for {user}';
const DEFAULT_ONE_CLICK_BOT_DESCRIPTION =
  'OpenClaudeTag AI engineering assistant for Feishu group collaboration.';
export const ONE_CLICK_QR_READY_TIMEOUT_MS = 30_000;

function toFeishuAppRegistrationDto(
  session: FeishuAppRegistrationSession,
): FeishuAppRegistrationDto {
  return {
    id: session.id,
    status: session.status,
    verificationUrl: session.verificationUrl,
    expireIn: session.expireIn,
    expiresAt: session.expiresAt,
    app: session.app,
    error: session.error,
    sdkStatus: session.sdkStatus,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

function assertOwnsRegistrationSession(
  scope: OwnerScope,
  session: FeishuAppRegistrationSession,
): void {
  if (scope.isSuperadmin) return;
  if (
    scope.platformUserId &&
    session.platformOwnerId &&
    scope.platformUserId === session.platformOwnerId
  ) {
    return;
  }
  throw rowNotFound('Feishu app registration');
}

function mapFeishuRegistrationError(error: unknown): {
  status: FeishuAppRegistrationStatus;
  message: string;
} {
  const maybeError = error as { code?: unknown; description?: unknown };
  const code = typeof maybeError.code === 'string' ? maybeError.code : '';
  const description =
    typeof maybeError.description === 'string' && maybeError.description.trim()
      ? maybeError.description.trim()
      : errorMessage(error);
  if (code === 'expired_token') return { status: 'expired', message: description };
  if (code === 'abort') return { status: 'cancelled', message: description };
  if (code === 'access_denied') return { status: 'failed', message: description };
  return { status: 'failed', message: description };
}

export function assertActiveBotBindingRouteInvariant(input: {
  agentStatus: string;
  appStatus: string;
  agentTenantKey: string;
  appTenantKey: string;
}): void {
  if (input.agentStatus !== 'active') {
    throw new AdminApiError(
      409,
      'Active bot bindings require an active agent; unbind the bot first',
    );
  }
  if (input.appStatus !== 'enabled') {
    throw new AdminApiError(
      409,
      'Active bot bindings require an enabled Feishu app; unbind the bot first',
    );
  }
  if (input.agentTenantKey !== input.appTenantKey) {
    throw new AdminApiError(
      409,
      'Active bot bindings require the agent and Feishu app to share a tenantKey; unbind the bot first',
    );
  }
}

export function createDrizzleAdminApiStore(
  db: Database,
  options: AdminApiStoreOptions = {},
): AdminApiStore {
  const feishuAppRegistrations = new Map<string, FeishuAppRegistrationSession>();
  const registerFeishuApp = options.registerFeishuApp ?? registerOneClickFeishuApp;

  function createAdminFeishuClient(input: { appId: string; appSecret: string }) {
    return options.createFeishuClient?.(input) ?? new FeishuClient(input);
  }

  async function submitFeishuAppPermissionApproval(input: {
    feishuAppId: string;
    appId: string;
    appSecret: string;
  }): Promise<FeishuAppPermissionApplyDto> {
    const client = createAdminFeishuClient({
      appId: input.appId,
      appSecret: input.appSecret,
    });
    try {
      await client.applyApplicationScopes();
    } catch (error) {
      if (isEmptyUnauthorizedScopesError(error)) {
        return buildFeishuNoPendingScopeApplyResult({
          feishuAppId: input.feishuAppId,
          appId: input.appId,
        });
      }
      if (isDuplicateScopeApplyError(error)) {
        return buildFeishuScopeApplyResult({
          feishuAppId: input.feishuAppId,
          appId: input.appId,
        });
      }
      throw feishuPermissionApplyError(error);
    }
    return buildFeishuScopeApplyResult({
      feishuAppId: input.feishuAppId,
      appId: input.appId,
    });
  }

  function pruneFeishuAppRegistrations() {
    const now = Date.now();
    for (const [id, session] of feishuAppRegistrations) {
      const terminal = session.status !== 'pending';
      const ttlMs = terminal ? 30 * 60_000 : Math.max(session.expireIn * 1000, 10 * 60_000);
      if (now - session.updatedAt.getTime() > ttlMs) {
        feishuAppRegistrations.delete(id);
      }
    }
  }

  async function createOneClickFeishuAppRecord(
    scope: OwnerScope,
    input: {
      tenantKey: string;
      appId: string;
      appSecret: string;
      botName: string | null;
    },
  ): Promise<FeishuAppDto> {
    const platformOwnerId = scope.platformUserId ?? null;
    const [row] = await db
      .insert(feishuApps)
      .values({
        tenantKey: input.tenantKey,
        appId: input.appId,
        appSecretRef: 'stored',
        appSecret: input.appSecret,
        platformOwnerId: platformOwnerId ?? undefined,
        botName: input.botName ?? undefined,
        eventMode: 'websocket',
        status: 'enabled',
      })
      .returning();
    const ownerLabels = scope.isSuperadmin
      ? await loadOwnerLabels(db, [platformOwnerId])
      : new Map<string, OwnerLabelDto>();
    return {
      id: row.id,
      tenantKey: row.tenantKey,
      appId: row.appId,
      appSecretRef: row.appSecretRef,
      hasStoredSecret: Boolean(row.appSecret),
      botOpenId: row.botOpenId,
      botName: row.botName,
      eventMode: row.eventMode,
      status: row.status,
      platformOwnerId: row.platformOwnerId,
      platformOwner: row.platformOwnerId ? (ownerLabels.get(row.platformOwnerId) ?? null) : null,
      binding: null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  return {
    async listComputerAccessUsers(scope) {
      assertSuperadmin(scope);
      const rows = await db
        .select()
        .from(platformUsers)
        .orderBy(asc(platformUsers.email), asc(platformUsers.displayName), asc(platformUsers.id));
      return rows.map(toComputerAccessUserDto);
    },

    async updateComputerAccessUser(scope, id, input) {
      assertSuperadmin(scope);
      const [current] = await db
        .select()
        .from(platformUsers)
        .where(eq(platformUsers.id, id))
        .limit(1);
      if (!current) throw rowNotFound('Platform user');
      if (current.role === 'superadmin' && !input.computerAccessEnabled) {
        throw new AdminApiError(400, 'Superadmins always have computer access');
      }
      const [row] = await db
        .update(platformUsers)
        .set({ computerAccessEnabled: input.computerAccessEnabled, updatedAt: new Date() })
        .where(eq(platformUsers.id, id))
        .returning();
      if (!row) throw rowNotFound('Platform user');
      return toComputerAccessUserDto(row);
    },

    async getSummary(scope) {
      const appFilter = visibleFeishuAppFilter(scope);
      const [profileRows, agentRows, appRows, bindingRows, boardRows, machineRows] =
        await Promise.all([
          db.select().from(agentProfiles),
          agentScopedSelect(db, scope),
          db.select().from(feishuApps).where(appFilter),
          db.select().from(agentBotBindings),
          db.select().from(feishuTaskTrackingSpaces),
          db.select().from(machines),
        ]);

      // Chats and task boards inherit visibility through the owned-chat set (R2-1):
      // a plain user counts only chats/boards where they own an agent active-in /
      // bound-to the chat. Superadmin sees all. (Scoping by owned TENANT leaked
      // same-tenant colleagues' chats — rejected by D-A2.)
      const ownedChatIds = scope.isSuperadmin ? null : await ownedChatIdSet(db, scope);
      const visibleBoards = ownedChatIds
        ? boardRows.filter((board) => {
            const chat = parseChatScope(board.scopeType, board.scopeId);
            return chat ? ownedChatIds.has(chat.chatId) : false;
          })
        : boardRows;
      const visibleMachines = scope.isSuperadmin
        ? machineRows
        : scope.platformUserId
          ? machineRows.filter((row) => row.platformOwnerId === scope.platformUserId)
          : [];
      // Owned-agent ids gate which bindings count toward the summary for a user.
      const ownedAgentIds = new Set(agentRows.map((row) => row.id));
      const ownedAppIds = new Set(appRows.map((row) => row.id));
      const visibleBindings = bindingRows.filter(
        (row) =>
          row.status === 'active' &&
          (scope.isSuperadmin ||
            ownedAgentIds.has(row.agentId) ||
            ownedAppIds.has(row.feishuAppId)),
      );

      const chatKeys = new Set<string>();
      const chatRows = await db.select().from(chatConfigs);
      for (const row of chatRows) {
        if (!ownedChatIds || ownedChatIds.has(row.chatId)) {
          chatKeys.add(buildChatKey(row.tenantKey, row.chatId));
        }
      }
      for (const board of visibleBoards) {
        const chatKey = buildTaskBoardChatKey(board.scopeType, board.scopeId);
        if (chatKey) chatKeys.add(chatKey);
      }
      return {
        profiles: profileRows.length,
        agents: agentRows.length,
        activeAgents: agentRows.filter((row) => row.status === 'active').length,
        feishuApps: appRows.length,
        enabledFeishuApps: appRows.filter((row) => row.status === 'enabled').length,
        botBindings: visibleBindings.length,
        chats: chatKeys.size,
        taskBoards: visibleBoards.length,
        machines: visibleMachines.length,
        onlineMachines: visibleMachines.filter((row) => row.status === 'online').length,
      };
    },

    async listMachines(scope) {
      const rows = await db.select().from(machines);
      // D-A7: machines are owned solely by the console platform user. A plain user
      // sees only machines they own (`platform_owner_id === id`); legacy NULL-owner
      // rows never match (fail closed, D-A3). Superadmin sees everything.
      const visible = scope.isSuperadmin
        ? rows
        : scope.platformUserId
          ? rows.filter((row) => row.platformOwnerId === scope.platformUserId)
          : [];
      return visible.sort(compareMachinesForListing).map(toMachineDto);
    },

    async disconnectMachine(scope, id) {
      // Server-initiated disconnect (design D-A9): set `disconnect_requested_at =
      // now()`. The worker gateway honors this on its liveness tick — it closes the
      // current daemon socket whose `connectedAt` predates the stamp. This is NOT a
      // revoke: credentials stay valid and the daemon may reconnect per its backoff.
      // Owner-scoped (D-A3, fail-closed): the machine must be owned by the calling
      // platform user; a superadmin may disconnect any. 404 (not 403) on a miss so
      // we never reveal a machine the caller does not own — consistent with the
      // other admin mutations. Idempotent: re-stamping a disconnect is harmless.
      const [row] = await db.select().from(machines).where(eq(machines.id, id)).limit(1);
      const owned =
        row &&
        (scope.isSuperadmin ||
          (scope.platformUserId != null && row.platformOwnerId === scope.platformUserId));
      if (!row || !owned) {
        throw new AdminApiError(404, 'Machine not found');
      }
      const [updated] = await db
        .update(machines)
        .set({ disconnectRequestedAt: new Date(), updatedAt: new Date() })
        .where(eq(machines.id, id))
        .returning();
      return toMachineDto(updated);
    },

    async issuePairingToken(scope, input) {
      // Only a real platform user may mint a console pairing token (design D-A7):
      // the redeemed machine is owned by that platform user. A break-glass /
      // token-admin (superadmin scope without a platformUserId) has no platform
      // identity to stamp, so the token would create an unownable machine — reject.
      if (!scope.platformUserId) {
        throw new AdminApiError(400, 'log in as a user to pair a machine');
      }
      const platformIssuerId = scope.platformUserId;
      const now = new Date();
      const expiresAt = new Date(now.getTime() + PAIRING_TOKEN_TTL_MS);
      const token = generatePairingToken();
      const machineName = input.name?.trim() ? input.name.trim() : null;

      // Tenant: prefer the issuer's owned-tenant set (the tenant of an app they
      // registered) so machines surface alongside their other resources; fall back
      // to 'default' when they own no app yet (machines are still scoped by
      // platform_owner_id, so the tenant is informational, not an authz boundary).
      const owned = await ownedTenantSet(db, scope);
      const tenantKey = owned.values().next().value ?? 'default';

      await db.insert(machinePairingTokens).values({
        tokenHash: hashPairingToken(token),
        tenantKey,
        platformIssuerId,
        issuerOpenId: null,
        chatId: null,
        machineName,
        expiresAt,
      });

      return { token, expiresAt, machineName };
    },

    async listProfiles(scope) {
      // R2-6 profile ownership. A plain user sees builtin/shared profiles
      // (platform_owner_id IS NULL) + profiles they own; a superadmin sees all
      // (with an owner label per row for the owner column).
      const filter = scope.isSuperadmin
        ? undefined
        : scope.platformUserId
          ? or(
              sql`${agentProfiles.platformOwnerId} is null`,
              eq(agentProfiles.platformOwnerId, scope.platformUserId),
            )
          : sql`${agentProfiles.platformOwnerId} is null`;
      const rows = filter
        ? await db.select().from(agentProfiles).where(filter).orderBy(desc(agentProfiles.updatedAt))
        : await db.select().from(agentProfiles).orderBy(desc(agentProfiles.updatedAt));
      const ownerLabels = scope.isSuperadmin
        ? await loadOwnerLabels(
            db,
            rows.map((row) => row.platformOwnerId),
          )
        : new Map<string, OwnerLabelDto>();
      return rows.map((row) =>
        toProfileDto(
          row,
          row.platformOwnerId ? (ownerLabels.get(row.platformOwnerId) ?? null) : null,
        ),
      );
    },

    async listAgents(scope) {
      const agentFilter = visibleAgentFilter(scope);
      const [profileRows, agentRows, bindingRows, appRows, machineRows] = await Promise.all([
        db.select().from(agentProfiles),
        db.select().from(agents).where(agentFilter).orderBy(desc(agents.updatedAt)),
        db.select().from(agentBotBindings),
        db.select().from(feishuApps),
        db.select({ id: machines.id, name: machines.name, status: machines.status }).from(machines),
      ]);
      const profileById = new Map(profileRows.map((row) => [row.id, toProfileDto(row)]));
      const appById = new Map(appRows.map((row) => [row.id, row]));
      // Machine label lookup for the Agents-by-machine grouping (D-A8).
      const machineById = new Map(machineRows.map((row) => [row.id, row]));
      const activeBindingByAgentId = new Map(
        bindingRows.filter((row) => row.status === 'active').map((row) => [row.agentId, row]),
      );
      const ownerLabels = scope.isSuperadmin
        ? await loadOwnerLabels(
            db,
            agentRows.map((row) => row.platformOwnerId),
          )
        : new Map<string, OwnerLabelDto>();

      return agentRows.map((row) => {
        const profile = profileById.get(row.profileId) ?? null;
        const binding = activeBindingByAgentId.get(row.id);
        const app = binding ? appById.get(binding.feishuAppId) : undefined;
        return {
          id: row.id,
          tenantKey: row.tenantKey,
          scopeType: row.scopeType,
          scopeId: row.scopeId,
          handle: row.handle,
          displayName: row.displayName,
          description: row.description,
          profileId: row.profileId,
          profile: profile
            ? {
                id: profile.id,
                name: profile.name,
                displayName: profile.displayName,
                status: profile.status,
              }
            : null,
          ownerUserId: row.ownerUserId,
          platformOwnerId: row.platformOwnerId,
          platformOwner: row.platformOwnerId
            ? (ownerLabels.get(row.platformOwnerId) ?? null)
            : null,
          machineId: row.machineId,
          machine: row.machineId ? (machineById.get(row.machineId) ?? null) : null,
          visibility: row.visibility,
          defaultRuntime: row.defaultRuntime,
          defaultWorkDir: row.defaultWorkDir,
          runtimeEnvKeys: runtimeEnvKeys(row.runtimeEnv),
          memoryEnabled: row.memoryEnabled,
          projectId: row.projectId,
          accessPolicy: normalizeObject(row.accessPolicy),
          status: row.status,
          binding: binding
            ? {
                ...toBindingDto(binding),
                botOpenId: binding.botOpenId ?? app?.botOpenId ?? null,
              }
            : null,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        };
      });
    },

    async createProfile(scope, input) {
      // R2-6: stamp the creating SSO user as owner. A token/loopback superadmin
      // without a platform identity creates an ops-owned (NULL) shared profile.
      const platformOwnerId = scope.platformUserId ?? null;
      const [row] = await db
        .insert(agentProfiles)
        .values({
          ...input,
          description: input.description ?? undefined,
          systemPrompt: input.systemPrompt ?? undefined,
          stylePrompt: input.stylePrompt ?? undefined,
          skillRefs: input.skillRefs ?? [],
          defaultRuntime: input.defaultRuntime ?? undefined,
          defaultModel: input.defaultModel ?? undefined,
          platformOwnerId: platformOwnerId ?? undefined,
          sourceType: 'console',
          status: input.status ?? 'active',
        })
        .returning();
      return toProfileDto(row);
    },

    async updateProfile(scope, id, input) {
      // Profiles are managed config reached through an owned agent. A plain user
      // may only update a profile attached to an agent they own (fail closed).
      await assertProfileMutableByScope(db, scope, id);
      const [row] = await db
        .update(agentProfiles)
        .set({ ...input, updatedAt: new Date() })
        .where(eq(agentProfiles.id, id))
        .returning();
      if (!row) throw rowNotFound('Profile');
      return toProfileDto(row);
    },

    async createAgent(scope, input) {
      const { profile, profileId, ...agentInput } = input;
      // The handle is an internal uniqueness key derived from the display name;
      // the console no longer collects it. Overwrite any client-sent value.
      const handle = deriveAgentHandle(agentInput.displayName);
      // Stamp the creating SSO user as owner (D-A2). Superadmin/token-admin create
      // ops-owned rows (NULL owner) unless they carry a platform identity.
      const platformOwnerId = scope.platformUserId ?? null;
      // Execution location: binding to an OWNED machine is open to every user
      // (ownership validated below); choosing SERVER-LOCAL execution (machineId
      // null/omitted) is the allowlisted capability and requires computer access.
      if (agentInput.machineId) {
        await assertMachineBindable(db, scope, agentInput.machineId, platformOwnerId);
      } else {
        assertComputerAccess(scope);
      }
      const rowId = await db
        .transaction(async (tx) => {
          let resolvedProfileId = profileId;
          let resolvedProfileRuntime: string | null =
            profile?.defaultRuntime ?? agentInput.defaultRuntime ?? null;
          if (resolvedProfileId) {
            const [existingProfile] = await tx
              .select()
              .from(agentProfiles)
              .where(eq(agentProfiles.id, resolvedProfileId))
              .limit(1);
            if (!existingProfile) throw rowNotFound('Profile');
            resolvedProfileRuntime = existingProfile.defaultRuntime;
          } else {
            const [profileRow] = await tx
              .insert(agentProfiles)
              .values({
                name: profile?.name ?? buildManagedProfileName(handle),
                displayName: profile?.displayName ?? agentInput.displayName,
                description: profile?.description ?? agentInput.description ?? undefined,
                systemPrompt: profile?.systemPrompt ?? undefined,
                stylePrompt: profile?.stylePrompt ?? undefined,
                skillRefs: profile?.skillRefs ?? [],
                defaultRuntime: profile?.defaultRuntime ?? agentInput.defaultRuntime ?? undefined,
                defaultModel: profile?.defaultModel ?? undefined,
                // R2-6: a profile created implicitly for a new agent is owned by the
                // agent's creator, so they can later edit it (and no one else can).
                platformOwnerId: platformOwnerId ?? undefined,
                sourceType: 'console',
                status: profile?.status ?? 'active',
              })
              .returning({ id: agentProfiles.id });
            resolvedProfileId = profileRow.id;
          }

          assertClaudeCredentialsValid(
            agentInput.defaultRuntime ?? resolvedProfileRuntime,
            agentInput.runtimeEnv,
          );

          const [row] = await tx
            .insert(agents)
            .values({
              ...agentInput,
              handle,
              profileId: resolvedProfileId,
              description: agentInput.description ?? undefined,
              ownerUserId: agentInput.ownerUserId ?? undefined,
              platformOwnerId: platformOwnerId ?? undefined,
              defaultRuntime: agentInput.defaultRuntime ?? undefined,
              defaultWorkDir: agentInput.defaultWorkDir ?? undefined,
              runtimeEnv: agentInput.runtimeEnv ?? {},
              projectId: agentInput.projectId ?? undefined,
              accessPolicy: agentInput.accessPolicy ?? {},
            })
            .returning({ id: agents.id });
          return row.id;
        })
        .catch((error) => rethrowAgentHandleConflict(error, agentInput.displayName));
      const [agent] = (await this.listAgents(scope)).filter((item) => item.id === rowId);
      return agent;
    },

    async updateAgent(scope, id, input) {
      const { profile, ...agentInput } = input;
      const [current] = await db.select().from(agents).where(eq(agents.id, id)).limit(1);
      if (!current) throw rowNotFound('Agent');
      if (isDeletedAgentRow(current)) throw rowNotFound('Agent');
      assertOwnsRow(scope, current.platformOwnerId, 'Agent');
      // Note: Claude credentials are optional. A claude_code agent without
      // per-agent ANTHROPIC_* env uses subscription/local-login mode on the
      // execution host; partial custom credential pairs are rejected against the
      // effective next runtime/profile before persistence.
      // Machine binding change (D-A8): re-binding to an owned machine is open
      // (ownership + non-revoked validated against the agent's existing owner);
      // explicitly CLEARING to server-local is the allowlisted capability and
      // requires computer access.
      if ('machineId' in agentInput && agentInput.machineId == null) {
        assertComputerAccess(scope);
      }
      if (agentInput.machineId != null) {
        await assertMachineBindable(db, scope, agentInput.machineId, current.platformOwnerId);
      }
      // R2-3: reassigning to a new profile must respect profile ownership, not
      // just existence. A plain user may point their agent at a profile they OWN
      // or a shared/builtin (NULL-owner) profile — never another user's private
      // profile (404, no leak). Superadmin may assign any. Only enforced when the
      // profile actually changes so a no-op patch never trips on the current one.
      if (agentInput.profileId && agentInput.profileId !== current.profileId) {
        await assertProfileAssignableByScope(db, scope, agentInput.profileId);
      }
      if (agentInput.status !== undefined || agentInput.tenantKey !== undefined) {
        await assertAgentPatchKeepsActiveBinding(db, current, input);
      }
      const targetProfileId = agentInput.profileId ?? current.profileId;
      // R2-6: an inline profile edit through the agent form must respect PROFILE
      // ownership, not just agent ownership. Owning the agent that uses a shared
      // profile is NOT enough to rewrite its prompt/runtime for everyone — the
      // user must own the profile itself (superadmin may mutate any).
      if (profile && Object.keys(profile).length > 0) {
        await assertProfileMutableByScope(db, scope, targetProfileId);
      }
      const [targetProfile] = await db
        .select()
        .from(agentProfiles)
        .where(eq(agentProfiles.id, targetProfileId))
        .limit(1);
      if (!targetProfile) throw rowNotFound('Profile');
      const nextAgentRuntime =
        'defaultRuntime' in agentInput
          ? (agentInput.defaultRuntime ?? null)
          : current.defaultRuntime;
      const nextProfileRuntime =
        profile && 'defaultRuntime' in profile
          ? (profile.defaultRuntime ?? null)
          : targetProfile.defaultRuntime;
      const nextRuntimeEnv =
        'runtimeEnv' in agentInput
          ? (agentInput.runtimeEnv ?? {})
          : normalizeRuntimeEnv(current.runtimeEnv);
      assertClaudeCredentialsValid(nextAgentRuntime ?? nextProfileRuntime, nextRuntimeEnv);
      // The handle follows the display name (internal uniqueness key); recompute
      // it when the name changes and never trust a client-sent handle.
      const nextHandle =
        agentInput.displayName !== undefined
          ? deriveAgentHandle(agentInput.displayName)
          : current.handle;
      await db
        .transaction(async (tx) => {
          const now = new Date();
          if (profile && Object.keys(profile).length > 0) {
            const [profileRow] = await tx
              .update(agentProfiles)
              .set({ ...profile, updatedAt: now })
              .where(eq(agentProfiles.id, targetProfileId))
              .returning({ id: agentProfiles.id });
            if (!profileRow) throw rowNotFound('Profile');
          }

          const [row] = await tx
            .update(agents)
            .set({ ...agentInput, handle: nextHandle, updatedAt: now })
            .where(eq(agents.id, id))
            .returning({ id: agents.id });
          if (!row) throw rowNotFound('Agent');
        })
        .catch((error) =>
          rethrowAgentHandleConflict(error, agentInput.displayName ?? current.displayName),
        );
      const [agent] = (await this.listAgents(scope)).filter((item) => item.id === id);
      return agent;
    },

    async deleteAgent(scope, id) {
      const [current] = await db.select().from(agents).where(eq(agents.id, id)).limit(1);
      if (!current) throw rowNotFound('Agent');
      if (isDeletedAgentRow(current)) throw rowNotFound('Agent');
      assertOwnsRow(scope, current.platformOwnerId, 'Agent');
      const deleted = (await this.listAgents(scope)).find((item) => item.id === id);
      if (!deleted) throw rowNotFound('Agent');
      await db.transaction(async (tx) => {
        const now = new Date();
        await tx.delete(agentBotBindings).where(eq(agentBotBindings.agentId, id));
        const [row] = await tx
          .update(agents)
          .set({
            handle: buildDeletedAgentHandle(),
            status: 'archived',
            updatedAt: now,
          })
          .where(eq(agents.id, id))
          .returning({ id: agents.id });
        if (!row) throw rowNotFound('Agent');
      });
      return deleted;
    },

    async listFeishuApps(scope) {
      const appFilter = visibleFeishuAppFilter(scope);
      const [appRows, bindingRows, agentRows] = await Promise.all([
        db.select().from(feishuApps).where(appFilter).orderBy(desc(feishuApps.updatedAt)),
        db.select().from(agentBotBindings),
        db.select().from(agents),
      ]);
      const activeBindingByAppId = new Map(
        bindingRows.filter((row) => row.status === 'active').map((row) => [row.feishuAppId, row]),
      );
      const agentById = new Map(agentRows.map((row) => [row.id, row]));
      const ownerLabels = scope.isSuperadmin
        ? await loadOwnerLabels(
            db,
            appRows.map((row) => row.platformOwnerId),
          )
        : new Map<string, OwnerLabelDto>();
      return appRows.map((row) => {
        const binding = activeBindingByAppId.get(row.id);
        const agent = binding ? agentById.get(binding.agentId) : undefined;
        return {
          id: row.id,
          tenantKey: row.tenantKey,
          appId: row.appId,
          appSecretRef: row.appSecretRef,
          hasStoredSecret: Boolean(row.appSecret),
          botOpenId: row.botOpenId,
          botName: row.botName,
          eventMode: row.eventMode,
          status: row.status,
          platformOwnerId: row.platformOwnerId,
          platformOwner: row.platformOwnerId
            ? (ownerLabels.get(row.platformOwnerId) ?? null)
            : null,
          binding: binding
            ? {
                id: binding.id,
                agentId: binding.agentId,
                agentHandle: agent?.handle ?? null,
                agentDisplayName: agent?.displayName ?? null,
                status: binding.status,
              }
            : null,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        };
      });
    },

    async createFeishuApp(scope, input) {
      // Stamp the creating SSO user as owner — the self-service registration path
      // (D-A2/D-A4). Token/loopback admins create ops-owned rows (NULL owner).
      const platformOwnerId = scope.platformUserId ?? null;
      const [row] = await db
        .insert(feishuApps)
        .values({
          ...input,
          appSecretRef: input.appSecretRef ?? 'stored',
          appSecret: input.appSecret ?? undefined,
          platformOwnerId: platformOwnerId ?? undefined,
          botOpenId: input.botOpenId ?? undefined,
          botName: input.botName ?? undefined,
        })
        .returning();
      return (await this.listFeishuApps(scope)).find((item) => item.id === row.id)!;
    },

    async updateFeishuApp(scope, id, input) {
      const [current] = await db.select().from(feishuApps).where(eq(feishuApps.id, id)).limit(1);
      if (!current) throw rowNotFound('Feishu app');
      if (isDeletedFeishuAppRow(current)) throw rowNotFound('Feishu app');
      assertOwnsRow(scope, current.platformOwnerId, 'Feishu app');
      if (input.status !== undefined || input.tenantKey !== undefined) {
        await assertFeishuAppPatchKeepsActiveBinding(db, current, input);
      }
      const [row] = await db
        .update(feishuApps)
        .set({
          ...input,
          appSecret: input.appSecret ?? undefined,
          updatedAt: new Date(),
        })
        .where(eq(feishuApps.id, id))
        .returning({ id: feishuApps.id });
      if (!row) throw rowNotFound('Feishu app');
      return (await this.listFeishuApps(scope)).find((item) => item.id === id)!;
    },

    async syncFeishuAppMetadata(scope, id) {
      const [current] = await db.select().from(feishuApps).where(eq(feishuApps.id, id)).limit(1);
      if (!current) throw rowNotFound('Feishu app');
      if (isDeletedFeishuAppRow(current)) throw rowNotFound('Feishu app');
      assertOwnsRow(scope, current.platformOwnerId, 'Feishu app');
      const appSecret = resolveFeishuAppSecret(current);
      const client = createAdminFeishuClient({ appId: current.appId, appSecret });
      let botName: string;
      try {
        if (!client.getApplicationInfo) {
          throw new Error('Feishu client does not support application metadata');
        }
        const info = await client.getApplicationInfo({ appId: current.appId, lang: 'zh_cn' });
        botName = info.appName.trim();
      } catch (error) {
        throw new AdminApiError(502, `Feishu app metadata sync failed: ${errorMessage(error)}`);
      }
      if (!botName) {
        throw new AdminApiError(502, 'Feishu app metadata sync failed: empty application name');
      }
      const [row] = await db
        .update(feishuApps)
        .set({ botName, updatedAt: new Date() })
        .where(eq(feishuApps.id, id))
        .returning({ id: feishuApps.id });
      if (!row) throw rowNotFound('Feishu app');
      return (await this.listFeishuApps(scope)).find((item) => item.id === id)!;
    },

    async deleteFeishuApp(scope, id) {
      const [current] = await db.select().from(feishuApps).where(eq(feishuApps.id, id)).limit(1);
      if (!current) throw rowNotFound('Feishu app');
      if (isDeletedFeishuAppRow(current)) throw rowNotFound('Feishu app');
      assertOwnsRow(scope, current.platformOwnerId, 'Feishu app');
      const deleted = (await this.listFeishuApps(scope)).find((item) => item.id === id);
      if (!deleted) throw rowNotFound('Feishu app');
      await db.transaction(async (tx) => {
        const now = new Date();
        await tx.delete(agentBotBindings).where(eq(agentBotBindings.feishuAppId, id));
        const [row] = await tx
          .update(feishuApps)
          .set({
            appId: buildDeletedFeishuAppId(),
            appSecretRef: 'deleted',
            appSecret: null,
            botOpenId: null,
            status: 'disabled',
            updatedAt: now,
          })
          .where(eq(feishuApps.id, id))
          .returning({ id: feishuApps.id });
        if (!row) throw rowNotFound('Feishu app');
      });
      return deleted;
    },

    async checkFeishuAppPermissions(scope, id) {
      const [row] = await db.select().from(feishuApps).where(eq(feishuApps.id, id)).limit(1);
      if (!row) throw rowNotFound('Feishu app');
      if (isDeletedFeishuAppRow(row)) throw rowNotFound('Feishu app');
      assertOwnsRow(scope, row.platformOwnerId, 'Feishu app');
      const appSecret = resolveFeishuAppSecret(row);
      const client = createAdminFeishuClient({ appId: row.appId, appSecret });
      let scopes: FeishuApplicationScopeGrant[];
      try {
        scopes = await client.listApplicationScopes();
      } catch (error) {
        throw new AdminApiError(502, `Feishu app permission check failed: ${errorMessage(error)}`);
      }
      return evaluateFeishuScopeGrants({
        feishuAppId: row.id,
        appId: row.appId,
        scopes,
        feishuTaskTrackingEnabled: options.feishuTaskTrackingEnabled ?? false,
        feishuDocumentCommentsEnabled: options.feishuDocumentCommentsEnabled ?? false,
      });
    },

    async applyFeishuAppPermissions(scope, id) {
      const [row] = await db.select().from(feishuApps).where(eq(feishuApps.id, id)).limit(1);
      if (!row) throw rowNotFound('Feishu app');
      if (isDeletedFeishuAppRow(row)) throw rowNotFound('Feishu app');
      assertOwnsRow(scope, row.platformOwnerId, 'Feishu app');
      const appSecret = resolveFeishuAppSecret(row);
      return submitFeishuAppPermissionApproval({
        feishuAppId: row.id,
        appId: row.appId,
        appSecret,
      });
    },

    async startFeishuAppRegistration(scope, input) {
      pruneFeishuAppRegistrations();
      const now = new Date();
      const id = randomUUID();
      const botName = input.botName ?? DEFAULT_ONE_CLICK_BOT_NAME;
      const description = input.description ?? DEFAULT_ONE_CLICK_BOT_DESCRIPTION;
      const readyTimeoutMs =
        options.feishuAppRegistrationReadyTimeoutMs ?? ONE_CLICK_QR_READY_TIMEOUT_MS;
      const session: FeishuAppRegistrationSession = {
        id,
        scope,
        platformOwnerId: scope.platformUserId ?? null,
        tenantKey: 'default',
        botName,
        description,
        controller: new AbortController(),
        status: 'pending',
        verificationUrl: '',
        expireIn: 600,
        expiresAt: new Date(now.getTime() + 600_000),
        app: null,
        error: null,
        sdkStatus: null,
        createdAt: now,
        updatedAt: now,
      };
      feishuAppRegistrations.set(id, session);

      let readyResolve!: (ready: FeishuAppRegistrationReady) => void;
      let readyReject!: (error: unknown) => void;
      let readySettled = false;
      let readyTimer: ReturnType<typeof setTimeout> | undefined;
      function clearReadyTimer() {
        if (readyTimer) {
          clearTimeout(readyTimer);
          readyTimer = undefined;
        }
      }
      const ready = new Promise<FeishuAppRegistrationReady>((resolve, reject) => {
        readyResolve = (value) => {
          readySettled = true;
          clearReadyTimer();
          resolve(value);
        };
        readyReject = (error) => {
          readySettled = true;
          clearReadyTimer();
          reject(error);
        };
      });

      readyTimer = setTimeout(() => {
        if (readySettled) return;
        session.controller.abort();
        readyReject(new Error('Timed out waiting for Feishu verification link'));
      }, readyTimeoutMs);

      let registration: ReturnType<typeof registerFeishuApp>;
      try {
        registration = registerFeishuApp({
          source: 'open-claude-tag-console',
          signal: session.controller.signal,
          appPreset: {
            name: botName,
            desc: description,
          },
          onQRCodeReady(info) {
            if (session.controller.signal.aborted) return;
            const readyAt = new Date();
            session.verificationUrl = info.url;
            session.expireIn = info.expireIn;
            session.expiresAt = new Date(readyAt.getTime() + info.expireIn * 1000);
            session.updatedAt = readyAt;
            readyResolve({
              verificationUrl: session.verificationUrl,
              expireIn: session.expireIn,
              expiresAt: session.expiresAt,
            });
          },
          onStatusChange(info) {
            session.sdkStatus = info.status;
            session.updatedAt = new Date();
          },
        });
      } catch (error) {
        readyReject(error);
        registration = Promise.reject(error);
      }

      void registration
        .then(async (result) => {
          const app = await createOneClickFeishuAppRecord(scope, {
            tenantKey: session.tenantKey,
            appId: result.client_id,
            appSecret: result.client_secret,
            botName,
          });
          session.status = 'completed';
          session.app = app;
          const completionWarnings: string[] = [];
          try {
            const permissionResult = await submitFeishuAppPermissionApproval({
              feishuAppId: app.id,
              appId: result.client_id,
              appSecret: result.client_secret,
            });
            if (permissionResult.status === 'no_pending_scopes') {
              completionWarnings.push(
                `Feishu app registered, but permission approval was not submitted: ${permissionResult.message}`,
              );
            }
          } catch (error) {
            completionWarnings.push(
              `Feishu app registered, but permission approval failed: ${errorMessage(error)}`,
            );
          }
          try {
            await options.afterFeishuAppRegistrationComplete?.();
          } catch (error) {
            completionWarnings.push(
              `Feishu app registered, but runtime reload failed: ${errorMessage(error)}`,
            );
          }
          session.error = completionWarnings.join('\n') || null;
          session.updatedAt = new Date();
        })
        .catch((error) => {
          const mapped = session.controller.signal.aborted
            ? { status: 'cancelled' as const, message: 'Registration cancelled' }
            : mapFeishuRegistrationError(error);
          session.status = mapped.status;
          session.error = mapped.message;
          session.updatedAt = new Date();
          if (!readySettled) readyReject(error);
        });

      try {
        await ready;
      } catch (error) {
        feishuAppRegistrations.delete(id);
        const mapped = mapFeishuRegistrationError(error);
        throw new AdminApiError(502, `Feishu app registration failed: ${mapped.message}`);
      }

      return toFeishuAppRegistrationDto(session);
    },

    async getFeishuAppRegistration(scope, id) {
      pruneFeishuAppRegistrations();
      const session = feishuAppRegistrations.get(id);
      if (!session) throw rowNotFound('Feishu app registration');
      assertOwnsRegistrationSession(scope, session);
      return toFeishuAppRegistrationDto(session);
    },

    async cancelFeishuAppRegistration(scope, id) {
      pruneFeishuAppRegistrations();
      const session = feishuAppRegistrations.get(id);
      if (!session) throw rowNotFound('Feishu app registration');
      assertOwnsRegistrationSession(scope, session);
      if (session.status === 'pending') {
        session.controller.abort();
        session.status = 'cancelled';
        session.error = 'Registration cancelled';
        session.updatedAt = new Date();
      }
      return toFeishuAppRegistrationDto(session);
    },

    async bindBot(scope, input) {
      const [agent] = await db.select().from(agents).where(eq(agents.id, input.agentId)).limit(1);
      if (!agent) throw rowNotFound('Agent');
      // Binding requires owning BOTH the agent and the app (D-A3 mutation rule).
      assertOwnsRow(scope, agent.platformOwnerId, 'Agent');
      if (agent.status !== 'active') {
        throw new AdminApiError(409, 'Agent must be active before binding a bot');
      }
      const [app] = await db
        .select()
        .from(feishuApps)
        .where(eq(feishuApps.id, input.feishuAppId))
        .limit(1);
      if (!app) throw rowNotFound('Feishu app');
      assertOwnsRow(scope, app.platformOwnerId, 'Feishu app');
      if (app.status !== 'enabled') {
        throw new AdminApiError(409, 'Feishu app must be enabled before binding');
      }
      if (agent.tenantKey !== app.tenantKey) {
        throw new AdminApiError(409, 'Agent and Feishu app must have the same tenantKey');
      }

      const binding = await db
        .transaction(async (tx) => {
          const now = new Date();
          await tx
            .update(agentBotBindings)
            .set({ status: 'inactive', updatedAt: now })
            .where(
              and(
                eq(agentBotBindings.status, 'active'),
                or(
                  eq(agentBotBindings.agentId, input.agentId),
                  eq(agentBotBindings.feishuAppId, input.feishuAppId),
                ),
              ),
            );
          const [row] = await tx
            .insert(agentBotBindings)
            .values({
              agentId: input.agentId,
              feishuAppId: input.feishuAppId,
              botOpenId: app.botOpenId,
              status: 'active',
            })
            .returning();
          return row;
        })
        // A concurrent bind can collide with an existing active binding on the
        // partial unique indexes (23505) — surface that as 409, not a raw 500.
        .catch((error) => rethrowBotBindingConflict(error));
      return toBindingDto(binding);
    },

    async unbindBot(scope, id) {
      // A binding is owned iff its app OR its agent is owned (D-A3). Check before
      // mutating so a plain user cannot clear someone else's binding.
      if (!scope.isSuperadmin) {
        const [existing] = await db
          .select()
          .from(agentBotBindings)
          .where(eq(agentBotBindings.id, id))
          .limit(1);
        if (!existing) throw rowNotFound('Bot binding');
        await assertOwnsBinding(db, scope, existing);
      }
      const [row] = await db
        .update(agentBotBindings)
        .set({ status: 'inactive', updatedAt: new Date() })
        .where(eq(agentBotBindings.id, id))
        .returning();
      if (!row) throw rowNotFound('Bot binding');
      return toBindingDto(row);
    },

    async listChats(scope) {
      const [
        allConfigRows,
        agentRows,
        allBoardRows,
        sessionRows,
        taskRows,
        boardTaskStats,
        machineRows,
      ] = await Promise.all([
        db.select().from(chatConfigs).orderBy(desc(chatConfigs.updatedAt)),
        db.select().from(agents),
        db.select().from(feishuTaskTrackingSpaces),
        db.select({ id: sessions.id, chatId: sessions.chatId }).from(sessions),
        db
          .select({
            sessionId: tasks.sessionId,
            agentId: tasks.agentId,
            createdAt: tasks.createdAt,
          })
          .from(tasks)
          .orderBy(desc(tasks.createdAt)),
        listTaskBoardTaskStats(db),
        db.select({ id: machines.id, name: machines.name }).from(machines),
      ]);
      // Chats/boards are visible iff the user owns an agent active-in / bound-to
      // the chat (R2-1, ownedChatIdSet). Scoping by owned TENANT was rejected by
      // D-A2 (same-tenant colleagues would leak chats); chat ids are globally
      // unique, so we filter by chatId.
      const ownedChatIds = await ownedChatIdSet(db, scope);
      const configRows = scope.isSuperadmin
        ? allConfigRows
        : allConfigRows.filter((row) => ownedChatIds.has(row.chatId));
      const boardRows = scope.isSuperadmin
        ? allBoardRows
        : allBoardRows.filter((board) => {
            const chat = parseChatScope(board.scopeType, board.scopeId);
            return chat ? ownedChatIds.has(chat.chatId) : false;
          });
      const agentById = new Map(agentRows.map((row) => [row.id, row]));
      const machineNameById = new Map(machineRows.map((row) => [row.id, row.name]));
      const sessionChatById = new Map(sessionRows.map((row) => [row.id, row.chatId]));
      const taskCountByChat = new Map<string, number>();
      const lastTaskAtByChat = new Map<string, Date>();
      const agentActivityByChatId = new Map<
        string,
        Map<string, { taskCount: number; lastTaskAt: Date | null }>
      >();
      for (const task of taskRows) {
        const chatId = sessionChatById.get(task.sessionId);
        if (!chatId) continue;
        taskCountByChat.set(chatId, (taskCountByChat.get(chatId) ?? 0) + 1);
        if (!lastTaskAtByChat.has(chatId)) {
          lastTaskAtByChat.set(chatId, task.createdAt);
        }
        if (task.agentId) {
          const agentActivity =
            agentActivityByChatId.get(chatId) ??
            new Map<string, { taskCount: number; lastTaskAt: Date | null }>();
          const current = agentActivity.get(task.agentId) ?? { taskCount: 0, lastTaskAt: null };
          agentActivity.set(task.agentId, {
            taskCount: current.taskCount + 1,
            lastTaskAt: current.lastTaskAt ?? task.createdAt,
          });
          agentActivityByChatId.set(chatId, agentActivity);
        }
      }

      const configByKey = new Map<string, (typeof configRows)[number]>(
        configRows.map((row) => [buildChatKey(row.tenantKey, row.chatId), row] as const),
      );
      const boardsByChat = new Map<string, TaskBoardDto>();
      for (const boardRow of boardRows) {
        const key = buildTaskBoardChatKey(boardRow.scopeType, boardRow.scopeId);
        if (!key) continue;
        const chat = parseChatScope(boardRow.scopeType, boardRow.scopeId);
        const chatConfig = chat
          ? configByKey.get(buildChatKey(chat.tenantKey, chat.chatId))
          : undefined;
        const chatDisplayName = chat
          ? await resolveReadableChatDisplayName(options, {
              tenantKey: chat.tenantKey,
              configDisplayName: chatConfig?.displayName,
              chatId: chat.chatId,
              taskBoardName: boardRow.name,
            })
          : null;
        const stats = boardTaskStats.get(boardRow.id);
        boardsByChat.set(
          key,
          toTaskBoardDto(boardRow, {
            chatDisplayName,
            taskCount: stats?.taskCount ?? 0,
            statusCounts: stats?.statusCounts ?? createEmptyStatusCounts(),
          }),
        );
      }

      const chatKeys = new Map<string, { tenantKey: string; chatId: string }>();
      for (const config of configRows) {
        chatKeys.set(buildChatKey(config.tenantKey, config.chatId), {
          tenantKey: config.tenantKey,
          chatId: config.chatId,
        });
      }
      for (const board of boardRows) {
        const chatKey = buildTaskBoardChatKey(board.scopeType, board.scopeId);
        const chat = parseChatScope(board.scopeType, board.scopeId);
        if (chatKey && chat) chatKeys.set(chatKey, chat);
      }
      // R2-1: surface owned chats that have task activity even with no config/board
      // row, so "a chat where the user owns an active agent" is fully honored. Such
      // chats use tenant 'default' (the activity map keys by globally-unique chatId).
      if (!scope.isSuperadmin) {
        for (const chatId of ownedChatIds) {
          if (!agentActivityByChatId.has(chatId)) continue;
          const key = buildChatKey('default', chatId);
          if (!chatKeys.has(key)) chatKeys.set(key, { tenantKey: 'default', chatId });
        }
      }

      return Promise.all(
        [...chatKeys.values()].map(async (chat) => {
          const key = buildChatKey(chat.tenantKey, chat.chatId);
          const config = configByKey.get(key);
          const defaultAgent = config?.defaultAgentId
            ? agentById.get(config.defaultAgentId)
            : undefined;
          const board = boardsByChat.get(key);
          const displayName =
            board?.chatDisplayName ??
            (await resolveReadableChatDisplayName(options, {
              tenantKey: chat.tenantKey,
              configDisplayName: config?.displayName,
              chatId: chat.chatId,
              taskBoardName: board?.name,
            }));
          return {
            tenantKey: chat.tenantKey,
            chatId: chat.chatId,
            displayName,
            openFeishuUrl: buildFeishuChatOpenUrl(chat.chatId),
            defaultWorkDir: config?.defaultWorkDir ?? null,
            defaultRuntime: config?.defaultRuntime ?? null,
            defaultAgentId: config?.defaultAgentId ?? null,
            defaultAgent: defaultAgent
              ? {
                  id: defaultAgent.id,
                  handle: defaultAgent.handle,
                  displayName: defaultAgent.displayName,
                  status: defaultAgent.status,
                }
              : null,
            defaultMachineId: config?.defaultMachineId ?? null,
            defaultMachineName: config?.defaultMachineId
              ? (machineNameById.get(config.defaultMachineId) ?? null)
              : null,
            memoryEnabled: config?.memoryEnabled ?? false,
            memorySummaryNextRunAt: config?.memorySummaryNextRunAt ?? null,
            memorySummaryLastRunAt: config?.memorySummaryLastRunAt ?? null,
            memorySummaryLastStatus: config?.memorySummaryLastStatus ?? null,
            memorySummaryLastError: config?.memorySummaryLastError ?? null,
            taskBoard: board
              ? {
                  id: board.id,
                  name: board.name,
                  tasklistGuid: board.tasklistGuid,
                  openTasklistUrl: board.openTasklistUrl,
                  taskCount: board.taskCount,
                }
              : null,
            agents: [...(agentActivityByChatId.get(chat.chatId)?.entries() ?? [])]
              .map(([agentId, activity]) => {
                const agent = agentById.get(agentId);
                return agent
                  ? {
                      id: agent.id,
                      handle: agent.handle,
                      displayName: agent.displayName,
                      status: agent.status,
                      taskCount: activity.taskCount,
                      lastTaskAt: activity.lastTaskAt,
                    }
                  : null;
              })
              .filter((agent): agent is ChatAgentDto => Boolean(agent)),
            taskCount: taskCountByChat.get(chat.chatId) ?? 0,
            lastTaskAt: lastTaskAtByChat.get(chat.chatId) ?? null,
            createdAt: config?.createdAt ?? null,
            updatedAt: config?.updatedAt ?? null,
          };
        }),
      );
    },

    async updateChat(scope, tenantKey, chatId, input) {
      const { memoryEnabled, ...configInput } = input;
      // R2-1: a plain user may only edit a chat where they own an agent
      // active-in / bound-to it (the same predicate as visibility). Scoping by
      // owned TENANT (the prior behavior) leaked same-tenant colleagues' chats.
      await assertChatInScope(db, scope, chatId);
      if (configInput.defaultAgentId) {
        const [agent] = await db
          .select()
          .from(agents)
          .where(and(eq(agents.id, configInput.defaultAgentId), eq(agents.tenantKey, tenantKey)))
          .limit(1);
        if (!agent) throw rowNotFound('Default agent');
        // R2-3 (mirrors the default-machine ownership check below): a plain user
        // may only set the chat default to an agent they OWN or a shared/ops/legacy
        // (NULL-owner) agent. Setting it to a colleague's private agent was a
        // cross-user assignment hole. Same 404/not-found shape so the foreign
        // agent's existence is not leaked.
        assertAssignableOwnedRow(scope, agent.platformOwnerId, 'Default agent');
      }
      // R2-2: chat machine binding must respect machine ownership. A plain user may
      // only bind a machine they OWN (`machine.platformOwnerId === scope.platformUserId`);
      // a superadmin may bind any non-revoked machine. Binding a chat to another
      // user's daemon was a cross-user remote-code-execution path. Clearing the
      // chat default is NOT gated: server-local capability is anchored at the
      // agent level (a server-local agent already required computer access).
      if (configInput.defaultMachineId) {
        await assertChatMachineBindable(db, scope, configInput.defaultMachineId);
      }
      const [existing] = await db
        .select()
        .from(chatConfigs)
        .where(and(eq(chatConfigs.tenantKey, tenantKey), eq(chatConfigs.chatId, chatId)))
        .limit(1);
      const hasConfigPatch = Object.keys(configInput).length > 0;
      if (hasConfigPatch) {
        if (existing) {
          await db
            .update(chatConfigs)
            .set({ ...configInput, updatedAt: new Date() })
            .where(and(eq(chatConfigs.tenantKey, tenantKey), eq(chatConfigs.chatId, chatId)));
        } else {
          await db.insert(chatConfigs).values({
            tenantKey,
            chatId,
            defaultAgentId: configInput.defaultAgentId ?? undefined,
            defaultRuntime: configInput.defaultRuntime ?? undefined,
            defaultWorkDir: configInput.defaultWorkDir ?? undefined,
            defaultMachineId: configInput.defaultMachineId ?? undefined,
          });
        }
      }
      if (memoryEnabled !== undefined) {
        const preferredAgentId =
          configInput.defaultAgentId !== undefined
            ? configInput.defaultAgentId
            : existing?.defaultAgentId;
        const summaryAgentId = memoryEnabled
          ? await resolveChatMemorySummaryAgentId(db, scope, {
              tenantKey,
              chatId,
              preferredAgentId,
            })
          : null;
        if (memoryEnabled && !summaryAgentId) {
          throw new AdminApiError(400, 'No active chat agent is available for chat memory summary');
        }
        await updateChatMemoryConfig(db, {
          tenantKey,
          chatId,
          patch: memoryEnabled
            ? buildChatMemoryEnablePatch({ agentId: summaryAgentId })
            : buildChatMemoryDisablePatch(),
        });
      }
      const [chat] = (await this.listChats(scope)).filter(
        (item) => item.tenantKey === tenantKey && item.chatId === chatId,
      );
      return chat;
    },

    async listTaskBoards(scope, pagination = {}) {
      const [allRows, configRows] = await Promise.all([
        db
          .select()
          .from(feishuTaskTrackingSpaces)
          .orderBy(desc(feishuTaskTrackingSpaces.updatedAt)),
        db.select().from(chatConfigs),
      ]);
      // Task boards inherit their chat's visibility (R2-1): a plain user sees a
      // board iff they own an agent active-in / bound-to the board's chat. Global
      // (non-chat) boards have no chat, so plain users never see them.
      const ownedChatIds = await ownedChatIdSet(db, scope);
      const rows = scope.isSuperadmin
        ? allRows
        : allRows.filter((row) => {
            const chat = parseChatScope(row.scopeType, row.scopeId);
            return chat ? ownedChatIds.has(chat.chatId) : false;
          });
      const configByKey = new Map<string, (typeof configRows)[number]>(
        configRows.map((row) => [buildChatKey(row.tenantKey, row.chatId), row] as const),
      );
      const tasksByBoardId = new Map<string, TaskBoardTaskDto[]>();
      let statsByBoardId = new Map<string, TaskBoardTaskStats>();
      if (pagination.taskLimit !== undefined) {
        statsByBoardId = await listTaskBoardTaskStats(db);
        await Promise.all(
          rows.map(async (row) => {
            const boardStats = statsByBoardId.get(row.id);
            const statuses = Object.entries(boardStats?.statusCounts ?? {})
              .filter(([, count]) => count > 0)
              .map(([status]) => status);
            const taskPages = await Promise.all(
              statuses.map((status) =>
                listTaskBoardTasks(db, {
                  trackingSpaceId: row.id,
                  status,
                  limit: pagination.taskLimit,
                }),
              ),
            );
            tasksByBoardId.set(row.id, taskPages.flat());
          }),
        );
      } else {
        const taskRows = await listTaskBoardTasks(db);
        statsByBoardId = buildTaskBoardTaskStats(taskRows);
        for (const task of taskRows) {
          const bucket = tasksByBoardId.get(task.trackingSpaceId) ?? [];
          bucket.push(task);
          tasksByBoardId.set(task.trackingSpaceId, bucket);
        }
      }
      return Promise.all(
        rows.map(async (row) => {
          const chat = parseChatScope(row.scopeType, row.scopeId);
          const config = chat
            ? configByKey.get(buildChatKey(chat.tenantKey, chat.chatId))
            : undefined;
          const chatDisplayName = chat
            ? await resolveReadableChatDisplayName(options, {
                tenantKey: chat.tenantKey,
                configDisplayName: config?.displayName,
                chatId: chat.chatId,
                taskBoardName: row.name,
              })
            : null;
          const stats = statsByBoardId.get(row.id);
          return toTaskBoardDto(row, {
            chatDisplayName,
            tasks: tasksByBoardId.get(row.id) ?? [],
            taskCount: stats?.taskCount ?? 0,
            statusCounts: stats?.statusCounts ?? createEmptyStatusCounts(),
          });
        }),
      );
    },

    async listTaskBoardTasks(scope, taskBoardId, options = {}) {
      const [board] = await db
        .select({
          id: feishuTaskTrackingSpaces.id,
          scopeType: feishuTaskTrackingSpaces.scopeType,
          scopeId: feishuTaskTrackingSpaces.scopeId,
        })
        .from(feishuTaskTrackingSpaces)
        .where(eq(feishuTaskTrackingSpaces.id, taskBoardId))
        .limit(1);
      if (!board) throw rowNotFound('Task board');
      // Fail closed (R2-1): a plain user may only read a board whose chat they own
      // an agent active-in / bound-to (a global/non-chat board has no chat ⇒ never
      // visible to a plain user).
      if (!scope.isSuperadmin) {
        const chat = parseChatScope(board.scopeType, board.scopeId);
        const ownedChatIds = await ownedChatIdSet(db, scope);
        if (!chat || !ownedChatIds.has(chat.chatId)) throw rowNotFound('Task board');
      }
      return listTaskBoardTasks(db, {
        trackingSpaceId: taskBoardId,
        offset: options.offset,
        limit: options.limit,
        status: options.status,
      });
    },
  };
}

async function assertAgentPatchKeepsActiveBinding(
  db: Database,
  currentAgent: typeof agents.$inferSelect,
  input: PatchAgentInput,
): Promise<void> {
  const [binding] = await db
    .select()
    .from(agentBotBindings)
    .where(
      and(eq(agentBotBindings.agentId, currentAgent.id), eq(agentBotBindings.status, 'active')),
    )
    .limit(1);
  if (!binding) return;

  const [app] = await db
    .select()
    .from(feishuApps)
    .where(eq(feishuApps.id, binding.feishuAppId))
    .limit(1);
  if (!app) throw rowNotFound('Feishu app');

  assertActiveBotBindingRouteInvariant({
    agentStatus: input.status ?? currentAgent.status,
    appStatus: app.status,
    agentTenantKey: input.tenantKey ?? currentAgent.tenantKey,
    appTenantKey: app.tenantKey,
  });
}

async function assertFeishuAppPatchKeepsActiveBinding(
  db: Database,
  currentApp: typeof feishuApps.$inferSelect,
  input: PatchFeishuAppInput,
): Promise<void> {
  const [binding] = await db
    .select()
    .from(agentBotBindings)
    .where(
      and(eq(agentBotBindings.feishuAppId, currentApp.id), eq(agentBotBindings.status, 'active')),
    )
    .limit(1);
  if (!binding) return;

  const [agent] = await db.select().from(agents).where(eq(agents.id, binding.agentId)).limit(1);
  if (!agent) throw rowNotFound('Agent');

  assertActiveBotBindingRouteInvariant({
    agentStatus: agent.status,
    appStatus: input.status ?? currentApp.status,
    agentTenantKey: agent.tenantKey,
    appTenantKey: input.tenantKey ?? currentApp.tenantKey,
  });
}

function parseWithReply<T extends z.ZodTypeAny>(
  schema: T,
  value: unknown,
  reply: FastifyReply,
): z.output<T> | null {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  reply.code(400).send({
    ok: false,
    error: parsed.error.issues.map((issue) => issue.message).join('; '),
  });
  return null;
}

async function respond<T>(reply: FastifyReply, action: () => Promise<T>): Promise<T | void> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof AdminApiError) {
      reply.code(error.statusCode).send({ ok: false, error: error.message });
      return;
    }
    throw error;
  }
}

/** Per-request identity resolved by the admin guard and read by the handlers. */
interface AdminRequestIdentity {
  scope: OwnerScope;
  me: MeDto;
}

// Identity is stashed on the request via a WeakMap so we never collide with
// Fastify's typed request shape or leak between requests.
const adminIdentityByRequest = new WeakMap<FastifyRequest, AdminRequestIdentity>();

function requireIdentity(request: FastifyRequest): AdminRequestIdentity {
  const identity = adminIdentityByRequest.get(request);
  // The guard runs as a preHandler on every admin route, so this is always set;
  // throwing here is a defensive invariant, not a reachable user path.
  if (!identity) throw new AdminApiError(403, 'Admin identity not resolved');
  return identity;
}

export interface RegisterAdminApiOptions {
  db?: Database;
  store?: AdminApiStore;
  adminToken?: string;
  resolveFeishuChatDisplayName?: AdminApiStoreOptions['resolveFeishuChatDisplayName'];
  feishuTaskTrackingEnabled?: boolean;
  feishuDocumentCommentsEnabled?: boolean;
  afterFeishuRuntimeChange?: () => Promise<void>;
  /**
   * Whether the local dev-auth login mode is active (design D-A6). Defaults to
   * env `OPEN_TAG_DEV_AUTH === 'enabled'` — secure by default OFF. When off: all
   * dev-auth endpoints 404 (existence hidden) AND the guard never honors a
   * `cc_dev_user` cookie, so a forged cookie does nothing in production. Tests
   * inject this so they do not depend on `process.env`. Dev-auth is how an
   * operator obtains a real (non-superadmin) platform-user identity — required to
   * mint owner-scoped machine pairing tokens (design D-A7), which the break-glass
   * token/loopback superadmin cannot do.
   */
  devAuthEnabled?: boolean;
  /**
   * Whether the server runs in single-user personal mode
   * (`OPEN_TAG_PERSONAL_MODE=enabled`). Surfaced via `GET /admin/auth/config` so
   * the localhost console can auto-launch its first-run onboarding wizard and
   * frame server-local execution as the default. Defaults to env; injectable so
   * tests do not depend on `process.env`. Purely informational — it changes no
   * auth, ownership, or execution behavior on the server.
   */
  personalMode?: boolean;
  /**
   * Public base URL a user's daemon dials (the worker daemon gateway, env
   * `SERVER_PUBLIC_URL`, e.g. `http://10.37.206.226:3001`). Surfaced via
   * `GET /admin/auth/config` so the Machines page can render the
   * `open-claude-tag-daemon install --server-url <url>` command without the operator
   * hand-copying it. May be null on hosts where the deployer has not set it yet;
   * the console then shows a `<SERVER_PUBLIC_URL>` placeholder.
   */
  serverPublicUrl?: string | null;
  /**
   * Version of the `@open-tag/daemon` package this server distributes. Read
   * from `apps/daemon/package.json` at startup (server.ts) and surfaced via
   * `GET /admin/auth/config` so the install guide can pin a concrete version.
   * Null when it cannot be resolved.
   */
  daemonVersion?: string | null;
  /**
   * Filesystem path to a packed daemon tarball streamed by
   * `GET /admin/daemon/artifact`. Defaults to env `DAEMON_ARTIFACT_PATH`.
   * Injectable so tests can point it at a fixture (or leave it unset to assert
   * the 404 path). When unset/absent the endpoint returns 404 with a JSON hint.
   */
  daemonArtifactPath?: string | null;
  /**
   * Filesystem paths to the packed macOS console app DMGs streamed by
   * `GET /admin/desktop/artifact?arch=arm64|x64`. Default to env
   * `DESKTOP_ARTIFACT_PATH_ARM64` / `DESKTOP_ARTIFACT_PATH_X64`, then fall back
   * to standard desktop release output discovery. Each arch is independently
   * optional: an unavailable arch 404s and the console renders its artifact
   * action disabled. Injectable so tests can point at a fixture.
   */
  desktopArtifactPathArm64?: string | null;
  desktopArtifactPathX64?: string | null;
  /**
   * Directory containing standard `pnpm dist:desktop:mac` DMG output. Defaults
   * to `apps/desktop/release` resolved relative to this module.
   */
  desktopReleaseDir?: string | null;
  /**
   * Version of the `@open-tag/desktop` package this server distributes. Read
   * from `apps/desktop/package.json` at startup (server.ts) and surfaced via
   * `GET /admin/auth/config` for desktop artifact metadata. Null when it cannot
   * be resolved.
   */
  desktopVersion?: string | null;
}

/**
 * Normalize the daemon gateway public URL for the install guide: trim whitespace
 * and any trailing slash, returning null when unset. The console substitutes
 * this into the `--server-url <url>` flag; a null surfaces a `<SERVER_PUBLIC_URL>`
 * placeholder so the deployer knows to set it.
 */
function normalizeServerPublicUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\/+$/, '');
}

/**
 * Dev-auth is OFF unless explicitly enabled (design D-A6, secure by default). The
 * option overrides env so tests do not depend on `process.env`; when the option
 * is undefined we read `OPEN_TAG_DEV_AUTH === 'enabled'`. This single resolver
 * is consulted both when registering the dev-auth endpoints and inside the guard,
 * so the flag governs endpoint existence AND cookie honoring uniformly.
 */
function resolveDevAuthEnabled(options: RegisterAdminApiOptions): boolean {
  if (options.devAuthEnabled !== undefined) return options.devAuthEnabled;
  return process.env.OPEN_TAG_DEV_AUTH === 'enabled';
}

/**
 * Personal mode is OFF unless explicitly enabled, mirroring the dev-auth
 * resolver: the option overrides env so tests do not depend on `process.env`;
 * when undefined we read `OPEN_TAG_PERSONAL_MODE === 'enabled'`. Surfaced on
 * `/admin/auth/config` for the localhost console; it gates no server behavior.
 */
function resolvePersonalMode(options: RegisterAdminApiOptions): boolean {
  if (options.personalMode !== undefined) return options.personalMode;
  return process.env.OPEN_TAG_PERSONAL_MODE === 'enabled';
}

/** Dev-auth session cookie lifetime: 12h, a reasonable local session window. */
const DEV_AUTH_COOKIE_MAX_AGE_SECONDS = 12 * 60 * 60;

/**
 * Opt-in `Secure` cookie suffix. Default deployments are http-internal (raw-IP /
 * plain-http reverse proxy) where a Secure cookie would never be sent back, so
 * the flag is OFF by default. TLS-fronted deployments set `SECURE_COOKIES=true`
 * to harden the session cookies without a code change.
 */
function secureCookieSuffix(): string {
  return process.env.SECURE_COOKIES === 'true' ? '; Secure' : '';
}

/**
 * The dev-auth session cookie (design D-A6, local non-SSO login). Carries the raw
 * dev subject; the guard resolves it to the `dev:<sub>` platform user. NOT marked
 * `Secure` by default (http-internal hosts: raw-IP / plain-http reverse proxy),
 * with HttpOnly, Path=/, SameSite=Lax. Honored ONLY while `OPEN_TAG_DEV_AUTH=enabled`.
 */
const DEV_AUTH_COOKIE_NAME = 'cc_dev_user';

function buildDevAuthSessionCookie(sub: string): string {
  return (
    `${DEV_AUTH_COOKIE_NAME}=${encodeURIComponent(sub)}; HttpOnly; Path=/; SameSite=Lax; ` +
    `Max-Age=${DEV_AUTH_COOKIE_MAX_AGE_SECONDS}${secureCookieSuffix()}`
  );
}

/** Expire the dev-auth session cookie (logout). */
function buildClearedDevAuthSessionCookie(): string {
  return `${DEV_AUTH_COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`;
}

/** CPU architectures the macOS console app is published for. */
type DesktopArch = 'arm64' | 'x64';

const DESKTOP_PRODUCT_NAME = 'OpenClaudeTag Console';
const LEGACY_DESKTOP_PRODUCT_NAMES = ['OpenClaudeTag Console', 'OpenClaudeTag-Console'];

interface DesktopArtifact {
  path: string;
  filename: string;
  explicit: boolean;
}

/**
 * True iff a desktop artifact path is configured AND points at a readable regular
 * file. `/admin/auth/config` reports this (rather than merely "path configured")
 * so artifact actions never appear enabled for a stale env path that would
 * deterministically 404 on click.
 */
async function desktopArtifactExists(path: string | null): Promise<boolean> {
  if (!path) return false;
  try {
    const stats = await stat(path);
    return stats.isFile();
  } catch {
    return false;
  }
}

function defaultDesktopReleaseDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../desktop/release');
}

function desktopAttachmentFilename(arch: DesktopArch, version: string | null): string {
  return version
    ? `${DESKTOP_PRODUCT_NAME}-${version}-${arch}.dmg`
    : `${DESKTOP_PRODUCT_NAME}-${arch}.dmg`;
}

function quoteContentDispositionFilename(filename: string): string {
  return filename.replace(/["\\\r\n]/g, '_');
}

function exactDesktopArtifactNames(arch: DesktopArch, version: string | null): string[] {
  const names = [desktopAttachmentFilename(arch, version), `${DESKTOP_PRODUCT_NAME}-${arch}.dmg`];
  if (version) {
    for (const legacyName of LEGACY_DESKTOP_PRODUCT_NAMES) {
      names.push(`${legacyName}-${version}-${arch}.dmg`);
    }
  }
  for (const legacyName of LEGACY_DESKTOP_PRODUCT_NAMES) {
    names.push(`${legacyName}-${arch}.dmg`);
  }
  return Array.from(new Set(names));
}

function isStandardDesktopArtifactName(name: string, arch: DesktopArch): boolean {
  if (!name.endsWith(`-${arch}.dmg`)) return false;
  const productNames = [DESKTOP_PRODUCT_NAME, ...LEGACY_DESKTOP_PRODUCT_NAMES];
  return productNames.some((productName) => name.startsWith(`${productName}-`));
}

async function discoverDesktopArtifact(
  releaseDir: string,
  arch: DesktopArch,
  version: string | null,
): Promise<string | null> {
  for (const name of exactDesktopArtifactNames(arch, version)) {
    const candidate = join(releaseDir, name);
    if (await desktopArtifactExists(candidate)) return candidate;
  }

  try {
    const entries = await readdir(releaseDir);
    const matches = entries
      .filter((entry) => isStandardDesktopArtifactName(entry, arch))
      .sort()
      .reverse();
    for (const match of matches) {
      const candidate = join(releaseDir, match);
      if (await desktopArtifactExists(candidate)) return candidate;
    }
  } catch {
    // Missing release output is the normal "not published yet" state.
  }

  return null;
}

async function resolveDesktopArtifact(
  arch: DesktopArch,
  explicitPath: string | null,
  releaseDir: string,
  version: string | null,
): Promise<DesktopArtifact | null> {
  if (explicitPath) {
    return {
      path: explicitPath,
      filename: desktopAttachmentFilename(arch, version),
      explicit: true,
    };
  }

  const discoveredPath = await discoverDesktopArtifact(releaseDir, arch, version);
  if (!discoveredPath) return null;
  return {
    path: discoveredPath,
    filename: basename(discoveredPath),
    explicit: false,
  };
}

/**
 * Harden the (intentionally unauthenticated) daemon-artifact download against a
 * misconfigured/hostile `DAEMON_ARTIFACT_PATH`. The allowlisted artifacts
 * directory is the configured path's parent; the file actually streamed must,
 * after following symlinks (`realpath`), be a regular file that still lives
 * inside that directory. Both the directory and the file are `realpath`-resolved
 * before comparison so platform tmpdir symlinks (e.g. macOS `/tmp` →
 * `/private/tmp`) do not produce false negatives. This keeps the normal happy
 * path (a real tarball at the configured location) working while refusing to
 * serve an arbitrary file reached via a symlink or `..` traversal out of the
 * artifacts directory. Returns the resolved canonical path + size on success, or
 * null when the path is missing / not a file / escapes the allowlisted directory.
 * The caller MUST open the returned `realPath` with `O_NOFOLLOW` before streaming
 * so a symlink swapped after validation cannot redirect the read.
 */
async function resolveServableArtifact(
  configuredPath: string,
): Promise<{ realPath: string; size: number } | null> {
  try {
    const allowedDir = await realpath(dirname(resolve(configuredPath)));
    const realPath = await realpath(configuredPath);
    const allowedPrefix = allowedDir.endsWith(sep) ? allowedDir : allowedDir + sep;
    if (!realPath.startsWith(allowedPrefix)) return null;
    const stats = await stat(realPath);
    if (!stats.isFile()) return null;
    return { realPath, size: stats.size };
  } catch {
    return null;
  }
}

function closeFdQuietly(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // Best effort cleanup after an open/fstat validation failure.
  }
}

function openServableArtifact(realPath: string): { fd: number; size: number } | null {
  let fd: number | null = null;
  try {
    fd = openSync(realPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stats = fstatSync(fd);
    if (!stats.isFile()) {
      closeFdQuietly(fd);
      return null;
    }
    return { fd, size: stats.size };
  } catch {
    if (fd !== null) closeFdQuietly(fd);
    return null;
  }
}

export function registerAdminApiRoutes(
  app: FastifyInstance,
  options: RegisterAdminApiOptions,
): void {
  const store =
    options.store ??
    createDrizzleAdminApiStore(options.db!, {
      resolveFeishuChatDisplayName: options.resolveFeishuChatDisplayName,
      feishuTaskTrackingEnabled: options.feishuTaskTrackingEnabled,
      feishuDocumentCommentsEnabled: options.feishuDocumentCommentsEnabled,
      afterFeishuAppRegistrationComplete: options.afterFeishuRuntimeChange,
    });
  const preHandler = createAdminGuard(options);

  // ── Auth endpoints (UNGUARDED) ──
  // These run OUTSIDE the admin guard: the console calls them to log in or read
  // config BEFORE it has an identity. dev-login sets the `cc_dev_user` cookie the
  // guard reads on every later request; logout clears it.
  const devAuthEnabled = resolveDevAuthEnabled(options);
  const personalMode = resolvePersonalMode(options);

  // The daemon-install guide config travels on the same unauthenticated config
  // endpoint as the auth config: the Machines page reads `serverPublicUrl` /
  // `daemonVersion` to render the one-command daemon installer. Neither value is
  // a secret (the gateway URL is what every daemon
  // dials anyway), so keeping it unauthenticated lets the install page render
  // before the operator has an admin identity.
  const serverPublicUrl = normalizeServerPublicUrl(options.serverPublicUrl);
  const daemonVersion = options.daemonVersion?.trim() || null;
  const daemonArtifactPath =
    options.daemonArtifactPath?.trim() || process.env.DAEMON_ARTIFACT_PATH?.trim() || null;

  // Per-arch macOS app artifacts (option > env). Each arch is independently
  // optional so a partial publish (arm64 only) is a valid state.
  const desktopArtifactPaths: Record<DesktopArch, string | null> = {
    arm64:
      options.desktopArtifactPathArm64?.trim() ||
      process.env.DESKTOP_ARTIFACT_PATH_ARM64?.trim() ||
      null,
    x64:
      options.desktopArtifactPathX64?.trim() ||
      process.env.DESKTOP_ARTIFACT_PATH_X64?.trim() ||
      null,
  };
  const desktopVersion = options.desktopVersion?.trim() || null;
  const desktopReleaseDir = options.desktopReleaseDir?.trim() || defaultDesktopReleaseDir();
  const getDesktopArtifact = (arch: DesktopArch) =>
    resolveDesktopArtifact(arch, desktopArtifactPaths[arch], desktopReleaseDir, desktopVersion);

  app.get('/admin/auth/config', async () => {
    const [arm64DesktopArtifact, x64DesktopArtifact] = await Promise.all([
      getDesktopArtifact('arm64'),
      getDesktopArtifact('x64'),
    ]);
    return {
      devAuthEnabled,
      personalMode,
      serverPublicUrl,
      daemonVersion,
      // Whether each macOS app arch is actually downloadable right now (path set
      // or standard release output discovered AND the file exists on disk), so
      // artifact actions never appear enabled when they would 404 — matching
      // what GET /admin/desktop/artifact would actually serve.
      desktopArtifacts: {
        arm64: await desktopArtifactExists(arm64DesktopArtifact?.path ?? null),
        x64: await desktopArtifactExists(x64DesktopArtifact?.path ?? null),
      },
      desktopVersion,
    };
  });

  // ── Daemon tarball download (guard-light, design: client-binary distribution) ──
  // Intentionally UNGUARDED, like /admin/auth/config: the artifact is a client
  // binary, not server state, and gating it behind the admin token would force
  // the install page to thread a token into a plain <a download> link. The
  // gateway URL the daemon connects to is already public, so the tarball adds no
  // new exposure. The path is injectable (option > env) so deploys can place the
  // packed tarball wherever convenient; absent ⇒ 404 with a JSON hint telling the
  // deployer to run the pack script and set DAEMON_ARTIFACT_PATH.
  app.get('/admin/daemon/artifact', async (_request, reply) => {
    if (!daemonArtifactPath) {
      reply.code(404).send({
        ok: false,
        error:
          'Daemon artifact not configured. Run `pnpm --filter @open-tag/daemon run pack:tgz` and set DAEMON_ARTIFACT_PATH to the produced .tgz.',
      });
      return;
    }
    // Refuse to stream anything that escapes the artifacts directory (symlink /
    // `..` traversal out of a misconfigured DAEMON_ARTIFACT_PATH). Same 404 as a
    // genuinely missing file so a probe cannot distinguish the two.
    const artifact = await resolveServableArtifact(daemonArtifactPath);
    if (artifact === null) {
      reply.code(404).send({
        ok: false,
        error: `Daemon artifact not found at ${daemonArtifactPath}. Re-run the daemon pack script.`,
      });
      return;
    }
    const openedArtifact = openServableArtifact(artifact.realPath);
    if (openedArtifact === null) {
      reply.code(404).send({
        ok: false,
        error: `Daemon artifact not found at ${daemonArtifactPath}. Re-run the daemon pack script.`,
      });
      return;
    }
    reply.header('Content-Type', 'application/gzip');
    reply.header('Content-Length', String(openedArtifact.size));
    reply.header('Content-Disposition', 'attachment; filename="open-claude-tag-daemon.tgz"');
    return reply.send(
      createReadStream(artifact.realPath, { fd: openedArtifact.fd, autoClose: true }),
    );
  });

  // ── Mac app DMG download (UNGUARDED, mirrors /admin/daemon/artifact) ──
  // The DMG is a client binary, not server state, and the server address it
  // connects to is already public — so, like the daemon tarball, gating it would
  // only force a token into a plain <a download> link. `arch` selects the binary
  // (arm64 default); an unknown arch is a 400 (caller error), while a valid-but-
  // unpublished/missing arch is a 404 with a JSON hint for the deployer.
  app.get('/admin/desktop/artifact', async (request, reply) => {
    const rawArch = (request.query as { arch?: unknown } | undefined)?.arch;
    // Reject a repeated `?arch=` (Fastify parses it as an array) instead of
    // stringifying it into a confusing `arm64,x64` value.
    if (rawArch !== undefined && typeof rawArch !== 'string') {
      reply.code(400).send({ ok: false, error: 'Invalid arch. Use arch=arm64 or arch=x64.' });
      return;
    }
    const archParam = (rawArch ?? 'arm64').trim().toLowerCase();
    if (archParam !== 'arm64' && archParam !== 'x64') {
      reply.code(400).send({
        ok: false,
        error: `Invalid arch '${archParam}'. Use arch=arm64 or arch=x64.`,
      });
      return;
    }
    const arch = archParam as DesktopArch;
    const artifact = await getDesktopArtifact(arch);
    if (!artifact) {
      reply.code(404).send({
        ok: false,
        error: `Mac app (${arch}) not configured. Build the DMG or set DESKTOP_ARTIFACT_PATH_${arch.toUpperCase()}.`,
      });
      return;
    }
    let size: number;
    try {
      const stats = await stat(artifact.path);
      if (!stats.isFile()) throw new Error('not a file');
      size = stats.size;
    } catch {
      // This endpoint is UNGUARDED, so the client-facing error must NOT echo the
      // server-side artifactPath (filesystem / deploy-path disclosure — Aime CR P1).
      // Keep the concrete path in the server log for the deployer instead.
      request.log.warn(
        { arch, artifactPath: artifact.path, explicit: artifact.explicit },
        'desktop artifact configured but missing on disk',
      );
      reply.code(404).send({
        ok: false,
        error: `Mac app (${arch}) artifact not found. Re-run the desktop build.`,
      });
      return;
    }
    reply.header('Content-Type', 'application/octet-stream');
    reply.header('Content-Length', String(size));
    reply.header(
      'Content-Disposition',
      `attachment; filename="${quoteContentDispositionFilename(artifact.filename)}"`,
    );
    return reply.send(createReadStream(artifact.path));
  });

  // ── Dev-auth login (UNGUARDED, design D-A6, local non-SSO login) ──
  // Active ONLY when devAuthEnabled. When off, this endpoint 404s (hiding its
  // existence) AND the guard never honors the cc_dev_user cookie, so the path is
  // impossible to reach in production. Dev users are ALWAYS role 'user' (the
  // upsert never promotes), so superadmin stays break-glass-token only while a
  // dev user still gets a real platform identity that can mint pairing tokens.
  app.post('/admin/auth/dev-login', async (request, reply) => {
    if (!devAuthEnabled) {
      reply.code(404).send({ ok: false, error: 'Not found' });
      return;
    }
    const body = parseWithReply(DevLoginBodySchema, request.body, reply);
    if (!body) return;
    const sub = validateDevAuthSub(body.sub);
    if (!sub) {
      reply.code(400).send({ ok: false, error: 'invalid dev-auth sub' });
      return;
    }
    if (!options.db) {
      reply.code(500).send({ ok: false, error: 'dev-auth requires a database' });
      return;
    }
    const user = await upsertPlatformUserByDevAuth(options.db, {
      sub,
      displayName: body.name ?? null,
      email: body.email ?? null,
    });
    reply.header('Set-Cookie', buildDevAuthSessionCookie(sub));
    return toMeFromDevUser(user);
  });

  app.post('/admin/auth/logout', async (_request, reply) => {
    // Clear the dev-auth session cookie (the only browser-set login cookie now;
    // break-glass token/loopback carry no cookie). Design D-A6.
    reply.header('Set-Cookie', buildClearedDevAuthSessionCookie());
    return { ok: true };
  });

  app.get('/admin/me', { preHandler }, async (request, reply) =>
    respond(reply, async () => requireIdentity(request).me),
  );

  app.get('/admin/summary', { preHandler }, async (request, reply) =>
    respond(reply, () => store.getSummary(requireIdentity(request).scope)),
  );

  app.get('/admin/settings/computer-access', { preHandler }, async (request, reply) =>
    respond(reply, () => store.listComputerAccessUsers(requireIdentity(request).scope)),
  );

  app.patch('/admin/settings/computer-access/:id', { preHandler }, async (request, reply) => {
    const params = parseWithReply(IdParamsSchema, request.params, reply);
    const body = parseWithReply(PatchComputerAccessSchema, request.body, reply);
    if (!params || !body) return;
    return respond(reply, () =>
      store.updateComputerAccessUser(requireIdentity(request).scope, params.id, body),
    );
  });

  app.get('/admin/machines', { preHandler }, async (request, reply) =>
    respond(reply, () => store.listMachines(requireIdentity(request).scope)),
  );

  // Console pairing-token issuance (design D-A7). Mints a one-time token owned by
  // the authenticated platform user; the plaintext token is returned only here.
  app.post('/admin/machines/pairing-token', { preHandler }, async (request, reply) => {
    const body = parseWithReply(IssuePairingTokenBodySchema, request.body, reply);
    if (!body) return;
    return respond(reply, async () => {
      const issued = await store.issuePairingToken(requireIdentity(request).scope, {
        name: body.name ?? null,
      });
      // Build the copyable one-command installer. Use SERVER_PUBLIC_URL when
      // set; otherwise a <SERVER_PUBLIC_URL> placeholder the console flags for
      // the deployer. The npx form mirrors the install guide's recommended
      // background-start method.
      const serverArg = serverPublicUrl ?? '<SERVER_PUBLIC_URL>';
      // Always `@latest`: pinning to this checkout's daemon version would break
      // whenever a registry publish and a server deploy drift apart.
      const npxSpec = '@open-tag/daemon@latest';
      const connectCommand =
        `npx ${npxSpec} ` +
        `--server-url ${serverArg} --token ${issued.token} --background`;
      return {
        token: issued.token,
        expiresAt: issued.expiresAt,
        machineName: issued.machineName,
        connectCommand,
        serverConfigured: Boolean(serverPublicUrl),
      };
    });
  });

  // Server-initiated machine disconnect (design D-A9). Owner-scoped: sets
  // `disconnect_requested_at = now()`, which the worker gateway honors on its
  // liveness tick by closing the machine's current daemon socket. NOT a revoke —
  // credentials stay valid; the daemon may reconnect. 404 hides existence on a
  // not-found / not-owned target, consistent with the other mutations.
  app.post('/admin/machines/:id/disconnect', { preHandler }, async (request, reply) => {
    const params = parseWithReply(IdParamsSchema, request.params, reply);
    if (!params) return;
    return respond(reply, () => store.disconnectMachine(requireIdentity(request).scope, params.id));
  });

  app.get('/admin/agents', { preHandler }, async (request, reply) =>
    respond(reply, () => store.listAgents(requireIdentity(request).scope)),
  );

  app.get('/admin/profiles', { preHandler }, async (request, reply) =>
    respond(reply, () => store.listProfiles(requireIdentity(request).scope)),
  );

  app.post('/admin/profiles', { preHandler }, async (request, reply) => {
    const body = parseWithReply(CreateProfileSchema, request.body, reply);
    if (!body) return;
    return respond(reply, () => store.createProfile(requireIdentity(request).scope, body));
  });

  app.patch('/admin/profiles/:id', { preHandler }, async (request, reply) => {
    const params = parseWithReply(IdParamsSchema, request.params, reply);
    const body = parseWithReply(PatchProfileSchema, request.body, reply);
    if (!params || !body) return;
    return respond(reply, () =>
      store.updateProfile(requireIdentity(request).scope, params.id, body),
    );
  });

  app.post('/admin/agents', { preHandler }, async (request, reply) => {
    const body = parseWithReply(CreateAgentSchema, request.body, reply);
    if (!body) return;
    return respond(reply, async () => {
      const agent = await store.createAgent(requireIdentity(request).scope, body);
      warnSensitiveRuntimeEnv(request, agent.id, body.runtimeEnv);
      return agent;
    });
  });

  app.patch('/admin/agents/:id', { preHandler }, async (request, reply) => {
    const params = parseWithReply(IdParamsSchema, request.params, reply);
    const body = parseWithReply(PatchAgentSchema, request.body, reply);
    if (!params || !body) return;
    return respond(reply, async () => {
      const agent = await store.updateAgent(requireIdentity(request).scope, params.id, body);
      warnSensitiveRuntimeEnv(request, params.id, body.runtimeEnv);
      return agent;
    });
  });

  app.delete('/admin/agents/:id', { preHandler }, async (request, reply) => {
    const params = parseWithReply(IdParamsSchema, request.params, reply);
    if (!params) return;
    return respond(reply, async () => {
      const result = await store.deleteAgent(requireIdentity(request).scope, params.id);
      await options.afterFeishuRuntimeChange?.();
      return result;
    });
  });

  app.get('/admin/feishu-apps', { preHandler }, async (request, reply) =>
    respond(reply, () => store.listFeishuApps(requireIdentity(request).scope)),
  );

  app.post('/admin/feishu-apps', { preHandler }, async (request, reply) => {
    const body = parseWithReply(CreateFeishuAppSchema, request.body, reply);
    if (!body) return;
    return respond(reply, async () => {
      const result = await store.createFeishuApp(requireIdentity(request).scope, body);
      await options.afterFeishuRuntimeChange?.();
      return result;
    });
  });

  app.patch('/admin/feishu-apps/:id', { preHandler }, async (request, reply) => {
    const params = parseWithReply(IdParamsSchema, request.params, reply);
    const body = parseWithReply(PatchFeishuAppSchema, request.body, reply);
    if (!params || !body) return;
    return respond(reply, async () => {
      const result = await store.updateFeishuApp(requireIdentity(request).scope, params.id, body);
      await options.afterFeishuRuntimeChange?.();
      return result;
    });
  });

  app.post('/admin/feishu-apps/:id/sync-metadata', { preHandler }, async (request, reply) => {
    const params = parseWithReply(IdParamsSchema, request.params, reply);
    if (!params) return;
    return respond(reply, async () => {
      const result = await store.syncFeishuAppMetadata(requireIdentity(request).scope, params.id);
      await options.afterFeishuRuntimeChange?.();
      return result;
    });
  });

  app.delete('/admin/feishu-apps/:id', { preHandler }, async (request, reply) => {
    const params = parseWithReply(IdParamsSchema, request.params, reply);
    if (!params) return;
    return respond(reply, async () => {
      const result = await store.deleteFeishuApp(requireIdentity(request).scope, params.id);
      await options.afterFeishuRuntimeChange?.();
      return result;
    });
  });

  app.post('/admin/feishu-apps/:id/permission-check', { preHandler }, async (request, reply) => {
    const params = parseWithReply(IdParamsSchema, request.params, reply);
    if (!params) return;
    return respond(reply, () =>
      store.checkFeishuAppPermissions(requireIdentity(request).scope, params.id),
    );
  });

  app.post('/admin/feishu-apps/:id/permission-apply', { preHandler }, async (request, reply) => {
    const params = parseWithReply(IdParamsSchema, request.params, reply);
    if (!params) return;
    return respond(reply, () =>
      store.applyFeishuAppPermissions(requireIdentity(request).scope, params.id),
    );
  });

  app.post('/admin/feishu-apps/one-click-registration', { preHandler }, async (request, reply) => {
    const body = parseWithReply(StartFeishuAppRegistrationSchema, request.body ?? {}, reply);
    if (!body) return;
    return respond(reply, () =>
      store.startFeishuAppRegistration(requireIdentity(request).scope, body),
    );
  });

  app.get(
    '/admin/feishu-apps/one-click-registration/:id',
    { preHandler },
    async (request, reply) => {
      const params = parseWithReply(IdParamsSchema, request.params, reply);
      if (!params) return;
      return respond(reply, () =>
        store.getFeishuAppRegistration(requireIdentity(request).scope, params.id),
      );
    },
  );

  app.delete(
    '/admin/feishu-apps/one-click-registration/:id',
    { preHandler },
    async (request, reply) => {
      const params = parseWithReply(IdParamsSchema, request.params, reply);
      if (!params) return;
      return respond(reply, () =>
        store.cancelFeishuAppRegistration(requireIdentity(request).scope, params.id),
      );
    },
  );

  app.post('/admin/bot-bindings', { preHandler }, async (request, reply) => {
    const body = parseWithReply(BindBotSchema, request.body, reply);
    if (!body) return;
    return respond(reply, async () => {
      const result = await store.bindBot(requireIdentity(request).scope, body);
      await options.afterFeishuRuntimeChange?.();
      return result;
    });
  });

  app.delete('/admin/bot-bindings/:id', { preHandler }, async (request, reply) => {
    const params = parseWithReply(IdParamsSchema, request.params, reply);
    if (!params) return;
    return respond(reply, async () => {
      const result = await store.unbindBot(requireIdentity(request).scope, params.id);
      await options.afterFeishuRuntimeChange?.();
      return result;
    });
  });

  app.get('/admin/chats', { preHandler }, async (request, reply) =>
    respond(reply, () => store.listChats(requireIdentity(request).scope)),
  );

  app.patch('/admin/chats/:tenantKey/:chatId', { preHandler }, async (request, reply) => {
    const params = parseWithReply(ChatParamsSchema, request.params, reply);
    const body = parseWithReply(PatchChatSchema, request.body, reply);
    if (!params || !body) return;
    return respond(reply, () =>
      store.updateChat(requireIdentity(request).scope, params.tenantKey, params.chatId, body),
    );
  });

  app.get('/admin/task-boards', { preHandler }, async (request, reply) => {
    const query = parseWithReply(TaskBoardListQuerySchema, request.query, reply);
    if (!query) return;
    return respond(reply, () =>
      store.listTaskBoards(
        requireIdentity(request).scope,
        query.taskLimit === undefined ? undefined : { taskLimit: query.taskLimit },
      ),
    );
  });

  app.get('/admin/task-boards/:id/tasks', { preHandler }, async (request, reply) => {
    const params = parseWithReply(IdParamsSchema, request.params, reply);
    const query = parseWithReply(TaskBoardTasksQuerySchema, request.query, reply);
    if (!params || !query) return;
    return respond(reply, () =>
      store.listTaskBoardTasks(requireIdentity(request).scope, params.id, {
        offset: query.offset ?? 0,
        limit: query.limit ?? 5,
        status: query.status,
      }),
    );
  });
}

/**
 * Resolve a dev-auth identity from the `cc_dev_user` cookie (design D-A6).
 * Callers MUST only invoke this when dev-auth is enabled (the guard checks the
 * flag first). Returns null when there is no valid cookie or no db. Dev users
 * are ALWAYS scoped as a plain `user` (never superadmin) — the upsert preserves
 * the always-`user` role, so the resulting scope is owner-filtered like any real
 * platform user, which is exactly what makes A/B isolation testable.
 */
async function resolveDevAuthIdentity(
  request: FastifyRequest,
  db: Database | undefined,
): Promise<AdminRequestIdentity | null> {
  if (!db) return null;
  const sub = extractDevAuthSub(request);
  if (!sub) return null;
  const user = await upsertPlatformUserByDevAuth(db, { sub });
  return {
    scope: {
      isSuperadmin: false,
      platformUserId: user.id,
      computerAccessEnabled: platformUserHasComputerAccess(user),
    },
    me: toMeFromDevUser(user),
  };
}

/**
 * Resolve the admin identity for a request and stash it for the handlers.
 *
 * Resolution order (design D-A3/D-A6):
 *  1. (Only when `OPEN_TAG_DEV_AUTH=enabled`) a `cc_dev_user` cookie → resolve
 *     to the `dev:<sub>` platform user, always role `user` (D-A6). This is the
 *     non-SSO way to hold a real platform identity (so pairing tokens can be
 *     minted); it is tried first so a dev user on loopback gets THEIR scoped view
 *     rather than silent break-glass god-mode.
 *  2. Loopback OR a matching `OPEN_TAG_ADMIN_TOKEN` → synthetic superadmin
 *     (break-glass / local-dev), labelled `tokenAdmin` in `/admin/me`.
 *  3. Otherwise reject with 403 (existing message style).
 *
 * The dev branch is gated on `devAuthEnabled` at REQUEST time, so a forged
 * `cc_dev_user` cookie does nothing when the flag is off — the cookie is never
 * even read.
 */
function createAdminGuard(
  options: RegisterAdminApiOptions,
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  const configuredToken = options.adminToken?.trim();
  const devAuthEnabled = resolveDevAuthEnabled(options);
  const db = options.db;

  return async (request, reply) => {
    if (devAuthEnabled) {
      const devIdentity = await resolveDevAuthIdentity(request, db);
      if (devIdentity) {
        adminIdentityByRequest.set(request, devIdentity);
        return;
      }
    }

    if (
      isEffectivelyLoopback(request) ||
      (configuredToken && requestHasAdminToken(request, configuredToken))
    ) {
      adminIdentityByRequest.set(request, { scope: SUPERADMIN_SCOPE, me: tokenAdminMe() });
      return;
    }

    reply.code(403).send({
      ok: false,
      error: 'Admin console API is local-only unless OPEN_TAG_ADMIN_TOKEN is configured.',
    });
  };
}

/**
 * Build the `/admin/me` payload for a dev-auth user (design D-A6). Always
 * `role: 'user'`, `tokenAdmin: false`, and `devAuth: true` so the console can
 * label the session as a local dev session.
 */
function toMeFromDevUser(user: PlatformUser): MeDto {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: 'user',
    computerAccessEnabled: platformUserHasComputerAccess(user),
    tokenAdmin: false,
    devAuth: true,
  };
}

function tokenAdminMe(): MeDto {
  return {
    id: null,
    email: null,
    displayName: null,
    role: 'superadmin',
    computerAccessEnabled: true,
    tokenAdmin: true,
  };
}

/**
 * Decide whether a request truly originates from the local host. This is the
 * unspoofable trust anchor for break-glass superadmin (this guard) and the debug
 * surface gate (server.ts), so both import this single implementation. The
 * decision uses only values a remote client CANNOT forge:
 *
 *  1. The real TCP peer (`request.socket.remoteAddress`) must be loopback. With
 *     Fastify `trustProxy` disabled this equals `request.ip`; reading the raw
 *     socket keeps the gate correct even if `trustProxy` is ever enabled (which
 *     would make `request.ip` itself header-derived and therefore spoofable).
 *  2. A same-host reverse proxy (apps/console/serve-console.mjs) connects over
 *     loopback, so the peer is loopback for EVERY external caller (found live:
 *     console visitors became superadmin). We therefore additionally require the
 *     proxy-appended `X-Forwarded-For` hop to be loopback. A standards-compliant
 *     proxy APPENDS the immediate client it observed to the END of the chain (or
 *     overwrites the whole header), so only the LAST hop is trustworthy; the
 *     leftmost entries are client-supplied and forgeable (`X-Forwarded-For:
 *     127.0.0.1, <real-client>` on an append-style proxy). Reading the FIRST hop
 *     let a remote attacker spoof loopback and escalate.
 *
 * Contract: assumes a SINGLE trusted same-host proxy that appends or overwrites
 * XFF. With multiple untrusted forwarding hops "last hop" is no longer
 * unambiguous — such a topology must overwrite XFF at the edge or rely on
 * `OPEN_TAG_ADMIN_TOKEN` instead. No XFF means a direct loopback connection (the
 * documented local-curl workflow) and is trusted on the peer check alone. A
 * malformed chain (any empty segment) or a non-loopback / hostname last hop is
 * rejected fail-closed.
 */
export function isEffectivelyLoopback(request: FastifyRequest): boolean {
  if (!isLoopbackAddress(request.socket?.remoteAddress ?? undefined)) return false;
  const xff = request.headers['x-forwarded-for'];
  if (!xff) return true;
  const hops = (Array.isArray(xff) ? xff.join(',') : xff).split(',').map((hop) => hop.trim());
  // A genuine proxy never emits empty hops; treat a malformed chain as untrusted.
  if (hops.some((hop) => hop.length === 0)) return false;
  return isLoopbackForwardedHop(hops[hops.length - 1]);
}

/**
 * Whether a single `X-Forwarded-For` hop is a loopback IP literal. Unlike
 * `isLoopbackAddress`, the hostname `localhost` is intentionally rejected: a real
 * proxy forwards an IP, never a name, and `localhost` is a value an attacker
 * could inject into the header.
 */
function isLoopbackForwardedHop(hop: string): boolean {
  return hop === '127.0.0.1' || hop === '::1' || hop === '::ffff:127.0.0.1';
}

export function isLoopbackAddress(ip: string | undefined): boolean {
  // Fail closed on an absent address: request.ip is always set by Fastify, and
  // an empty X-Forwarded-For segment must not be treated as loopback trust.
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip === 'localhost';
}

/**
 * Constant-time string compare for the break-glass token. Length is checked
 * first (different lengths → false without calling `timingSafeEqual`, which
 * throws on unequal-length buffers); equal-length values are compared in
 * constant time so a wrong token cannot be recovered byte-by-byte via timing.
 */
function timingSafeStringEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

function requestHasAdminToken(request: FastifyRequest, token: string): boolean {
  const header = request.headers['x-open-claude-tag-admin-token'];
  if (typeof header === 'string' && timingSafeStringEqual(header, token)) return true;
  const authorization = request.headers.authorization;
  if (typeof authorization === 'string' && authorization.startsWith('Bearer ')) {
    return timingSafeStringEqual(authorization.slice('Bearer '.length), token);
  }
  return false;
}
