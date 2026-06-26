import { z } from 'zod';
import { ReplyLanguageSchema } from './reply-language.js';

// ── NormalizedEvent ──
export const MentionSchema = z.object({
  id: z.string(),
  name: z.string(),
  isBot: z.boolean(),
  key: z.string().optional(),
  index: z.number().optional(),
});

export const ReferencedMessageEntrySchema = z.object({
  author: z.string().optional(),
  text: z.string(),
});

export const FileAttachmentSchema = z.object({
  resourceKey: z.string(),
  messageId: z.string(),
  resourceType: z.enum(['file', 'audio', 'media']).default('file'),
  fileName: z.string().optional(),
  mimeType: z.string().optional(),
});

export const ReferencedMessageSchema = z.object({
  messageId: z.string(),
  contentType: z.enum(['text', 'rich_text', 'image', 'file', 'unknown']),
  entries: z.array(ReferencedMessageEntrySchema).default([]),
  imageAttachment: z
    .object({
      imageKey: z.string(),
      messageId: z.string(),
    })
    .optional(),
  warnings: z.array(z.string()).optional(),
});

export const NormalizedEventSchema = z.object({
  eventId: z.string(),
  messageId: z.string(),
  chatId: z.string(),
  chatType: z.enum(['p2p', 'group']),
  threadId: z.string().optional(),
  rootMessageId: z.string().optional(),
  parentMessageId: z.string().optional(),
  senderOpenId: z.string(),
  senderUnionId: z.string().optional(),
  senderType: z.string().optional(),
  tenantKey: z.string(),
  content: z.object({
    type: z.enum(['text', 'rich_text', 'image', 'file', 'command']),
    text: z.string().optional(),
    command: z.string().optional(),
    args: z.string().optional(),
    commandIndex: z.number().optional(),
    mentions: z.array(MentionSchema).optional(),
    imageKey: z.string().optional(),
    imageMessageId: z.string().optional(),
    fileAttachment: FileAttachmentSchema.optional(),
    referencedMessages: z.array(ReferencedMessageSchema).optional(),
    referencedMessageWarnings: z.array(z.string()).optional(),
    raw: z.unknown(),
  }),
  replyLanguage: ReplyLanguageSchema.optional(),
  timestamp: z.number(),
});

const RuntimeBackendSchema = z.enum(['claude_code', 'codex', 'coco']);
const AgentLifecycleStatusSchema = z.enum(['active', 'inactive', 'archived']);

// ── Agent Identity ──
export const AgentProfileSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().nullable().optional(),
  systemPrompt: z.string().nullable().optional(),
  stylePrompt: z.string().nullable().optional(),
  skillRefs: z.array(z.string()).default([]),
  defaultRuntime: RuntimeBackendSchema.nullable().optional(),
  defaultModel: z.string().nullable().optional(),
  sourceType: z.enum(['builtin', 'manifest', 'manual']).default('builtin'),
  sourceUri: z.string().nullable().optional(),
  status: AgentLifecycleStatusSchema.default('active'),
  createdAt: z.date().optional(),
  updatedAt: z.date().optional(),
});

export const AgentSchema = z.object({
  id: z.string().uuid().optional(),
  tenantKey: z.string().min(1).default('default'),
  scopeType: z.enum(['system', 'tenant', 'chat', 'user']).default('system'),
  scopeId: z.string().min(1).default('default'),
  handle: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().nullable().optional(),
  profileId: z.string().uuid(),
  ownerUserId: z.string().uuid().nullable().optional(),
  visibility: z.enum(['public', 'private', 'unlisted']).default('public'),
  defaultRuntime: RuntimeBackendSchema.nullable().optional(),
  defaultWorkDir: z.string().nullable().optional(),
  projectId: z.string().uuid().nullable().optional(),
  accessPolicy: z.record(z.unknown()).default({}),
  status: AgentLifecycleStatusSchema.default('active'),
  createdAt: z.date().optional(),
  updatedAt: z.date().optional(),
});

export const FeishuAppRegistrationSchema = z.object({
  id: z.string().uuid().optional(),
  tenantKey: z.string().min(1).default('default'),
  appId: z.string().min(1),
  appSecretRef: z.string().min(1),
  botOpenId: z.string().nullable().optional(),
  botName: z.string().nullable().optional(),
  eventMode: z.enum(['websocket', 'webhook']).default('websocket'),
  status: z.enum(['enabled', 'disabled', 'unhealthy']).default('enabled'),
  createdAt: z.date().optional(),
  updatedAt: z.date().optional(),
});

export const AgentBotBindingSchema = z.object({
  id: z.string().uuid().optional(),
  agentId: z.string().uuid(),
  feishuAppId: z.string().uuid(),
  botOpenId: z.string().nullable().optional(),
  status: z.enum(['active', 'disabled']).default('active'),
  createdAt: z.date().optional(),
  updatedAt: z.date().optional(),
});

export const AgentSessionStateSchema = z.object({
  id: z.string().uuid().optional(),
  agentId: z.string().uuid(),
  sessionId: z.string().uuid(),
  runtimeBackend: RuntimeBackendSchema.nullable().optional(),
  sdkSessionId: z.string().nullable().optional(),
  workspacePath: z.string().nullable().optional(),
  worktreeBranch: z.string().nullable().optional(),
  adhocWorkDir: z.string().nullable().optional(),
  summary: z.string().nullable().optional(),
  lastRunAt: z.date().nullable().optional(),
  createdAt: z.date().optional(),
  updatedAt: z.date().optional(),
});

export const UserIdentitySchema = z.object({
  id: z.string().uuid().optional(),
  userId: z.string().uuid().nullable().optional(),
  tenantKey: z.string().min(1).default('default'),
  feishuAppId: z.string().uuid(),
  openId: z.string().min(1),
  unionId: z.string().nullable().optional(),
  displayName: z.string().nullable().optional(),
  createdAt: z.date().optional(),
  updatedAt: z.date().optional(),
});

export const AgentDelegationSchema = z.object({
  id: z.string().uuid().optional(),
  treeId: z.string().uuid().nullable().optional(),
  parentDelegationId: z.string().uuid().nullable().optional(),
  depth: z.number().int().nonnegative().default(1),
  childSessionId: z.string().uuid().nullable().optional(),
  parentTaskId: z.string().uuid(),
  childTaskId: z.string().uuid().nullable().optional(),
  callerAgentId: z.string().uuid(),
  calleeAgentId: z.string().uuid(),
  goal: z.string().min(1),
  inputSummary: z.string().nullable().optional(),
  permissionScope: z.record(z.unknown()).default({}),
  status: z
    .enum(['pending', 'running', 'completed', 'failed', 'rejected', 'cancelled'])
    .default('pending'),
  result: z.unknown().optional(),
  errorMessage: z.string().nullable().optional(),
  createdAt: z.date().optional(),
  updatedAt: z.date().optional(),
  completedAt: z.date().nullable().optional(),
});

export const DelegationTreeSchema = z.object({
  id: z.string().uuid().optional(),
  rootTaskId: z.string().uuid(),
  totalBudget: z.number().int().positive(),
  tasksUsed: z.number().int().nonnegative().default(0),
  fanoutBudget: z.number().int().positive(),
  status: z.enum(['active', 'completed', 'failed', 'cancelled']).default('active'),
  resumeTaskId: z.string().uuid().nullable().optional(),
  wokenAt: z.date().nullable().optional(),
  version: z.number().int().nonnegative().default(0),
  createdAt: z.date().optional(),
  updatedAt: z.date().optional(),
});

// ── TaskSpec ──
export const TaskConstraintsSchema = z.object({
  timeoutSec: z.number().default(1800),
  approvalRequired: z.boolean().default(false),
  writeScope: z.array(z.string()).default([]),
  networkPolicy: z.enum(['restricted', 'open']).default('restricted'),
  maxCostUsd: z.number().optional(),
  replyLanguage: ReplyLanguageSchema.optional(),
});

export const TaskSpecSchema = z.object({
  taskId: z.string().uuid(),
  sessionId: z.string().uuid(),
  taskType: z.enum([
    'chat_reply',
    'analysis',
    'research',
    'ops_task',
    'self_improvement',
    'self_dev',
  ]),
  goal: z.string(),
  agentProfile: z.string().optional(),
  runtimeHint: z.enum(['claude_code', 'codex', 'coco', 'auto']).default('auto'),
  /**
   * Effective model for this task (resolved from the agent profile's
   * `defaultModel`). Drives codex `--model` and coco `-c model.name=`. When
   * unset the runtime uses its own host default. Flows to remote daemons
   * verbatim because the dispatch frame embeds the full TaskSpec.
   */
  model: z.string().optional(),
  constraints: TaskConstraintsSchema.default({}),
  context: z.object({
    systemPrompt: z.string(),
    sessionSummary: z.string().optional(),
    memoryEntries: z.array(z.unknown()).optional(),
    recentTurns: z.array(z.unknown()),
    repository: z
      .object({
        workspaceId: z.string(),
        repoUrl: z.string().optional(),
        branch: z.string().optional(),
        path: z.string().optional(),
      })
      .optional(),
    imageAttachment: z
      .object({
        imageKey: z.string(),
        messageId: z.string(),
      })
      .optional(),
    imageAttachments: z
      .array(
        z.object({
          imageKey: z.string(),
          messageId: z.string(),
        }),
      )
      .optional(),
    fileAttachment: FileAttachmentSchema.optional(),
  }),
  expectedOutputs: z.array(z.string()).optional(),
});

// ── TaskResult ──
export const ArtifactRefSchema = z.object({
  name: z.string(),
  path: z.string(),
  mimeType: z.string(),
  sha256: z.string(),
  sizeBytes: z.number().optional(),
});

export const TaskResultSchema = z.object({
  taskId: z.string().uuid(),
  status: z.enum(['completed', 'failed', 'cancelled', 'needs_approval']),
  output: z.object({
    text: z.string().optional(),
    artifacts: z.array(ArtifactRefSchema).optional(),
    error: z.string().optional(),
  }),
  memoryCandidates: z
    .array(
      z.object({
        content: z.string(),
        memoryType: z.string(),
        confidence: z.number(),
      }),
    )
    .optional(),
  metrics: z.object({
    durationMs: z.number(),
    tokenIn: z.number(),
    tokenOut: z.number(),
    estimatedCostUsd: z.number(),
  }),
});

// ── RuntimeEvent ──
export const RuntimeEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('status'), message: z.string() }),
  z.object({ type: z.literal('runtime_started'), executionId: z.string().optional() }),
  z.object({ type: z.literal('progress'), percent: z.number(), message: z.string() }),
  z.object({ type: z.literal('reasoning'), summary: z.string() }),
  z.object({ type: z.literal('stdout'), data: z.string() }),
  z.object({ type: z.literal('stderr'), data: z.string() }),
  z.object({ type: z.literal('artifact'), ref: ArtifactRefSchema }),
  z.object({ type: z.literal('completed'), result: TaskResultSchema }),
  z.object({
    type: z.literal('failed'),
    error: z.string(),
    reason: z.enum(['cancelled']).optional(),
  }),
  z.object({ type: z.literal('session_created'), sdkSessionId: z.string() }),
]);

// ── MemoryItem ──
export const MemoryItemSchema = z.object({
  id: z.string().uuid(),
  scopeType: z.enum(['session', 'user', 'group', 'system', 'agent', 'agent_session']),
  scopeId: z.string(),
  memoryType: z.enum(['summary', 'fact', 'preference', 'instruction', 'decision']),
  content: z.string(),
  tags: z.array(z.string()).default([]),
  importanceScore: z.number().min(0).max(1).default(0.5),
  confidence: z.number().min(0).max(1).default(1.0),
  confirmed: z.boolean().default(false),
  sourceMessageId: z.string().optional(),
  status: z.enum(['active', 'archived', 'deleted']).default('active'),
  createdAt: z.date().optional(),
  updatedAt: z.date().optional(),
});
