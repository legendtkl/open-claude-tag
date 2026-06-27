import { randomUUID } from 'node:crypto';
import { stableUuidFromKey } from '@open-tag/core-types';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { createLogger, installFatalProcessHandlers } from '@open-tag/observability';
import { createLlmClientFromEnv, type LlmClient } from '@open-tag/llm-client';
import {
  createDb,
  agentBotBindings,
  users,
  feishuTaskLinks,
  feishuTaskTrackingSpaces,
  feishuApps,
  feishuWebhookReceipts,
  messages,
  createDiscussion,
  setDiscussionStatusByRootThread,
  discussionParticipants,
  discussions,
  resolveAgentRoute,
  loadAgentSessionState,
  resolveUserIdentity,
  AgentAccessDeniedError,
  sessions,
  sessionAliases,
  tasks,
  taskRuns,
  agents,
  bindWaitingContractsToPrimaryTask,
  createWaitingContract,
  setWaitingContractAckMessageId,
} from '@open-tag/storage';
import { sql, eq, desc, and, isNull, or } from 'drizzle-orm';
import type { AgentAccessContext, Database } from '@open-tag/storage';
import {
  escapeRegExp,
  extractRawText,
  extractTextWithoutMentions,
  normalizeMentionName,
  renderRawMentionText,
  resolveDiscussionMentionedAgents,
  type DiscussionMentionedAgent,
} from './discussion-mention-parser.js';
import {
  listDebugSentMessages,
  lookupDebugReferencedMessage,
  recordDebugReferencedMessage,
  recordDebugSentMessage,
} from './debug-state.js';
import { FeishuWsManager } from './feishu-ws-manager.js';
import {
  FeishuClient,
  adaptNormalizedEvent,
  deriveFeishuTaskAttachments,
  normalizeDocumentCommentEvent,
  normalizeEvent,
  normalizeEventForObservation,
  checkAndRecordEvent,
  markEventProcessed,
  ThreePhaseFeedback,
  createFeishuChannelSender,
  DrizzleFeishuTaskTrackingRepository,
  FeishuTaskSyncService,
  createFeishuTaskTrackingConfigFromEnv,
  normalizeInteractionReason,
} from '@open-tag/feishu-adapter';
import type {
  CreateTrackedTaskInput,
  NormalizedDocumentCommentEvent,
  NormalizerConfig,
} from '@open-tag/feishu-adapter';
import {
  aliasThreadKeysForSession,
  resolveSession,
  resolvePreferredReplyLanguage,
  touchSession,
  incrementMessageCount,
} from '@open-tag/session';
import {
  classifyIntent,
  createMentionRoutingMemo,
  handleEvent,
  selectRuntime,
  TaskLifecycleService,
} from '@open-tag/orchestrator';
import type { MentionRoutingDecision, TaskCreatedEvent } from '@open-tag/orchestrator';
import { TaskQueue, type TaskJobData } from '@open-tag/queue';
import { AuditService, getUserRole } from '@open-tag/approval';
import { MemoryHandler } from '@open-tag/memory';
import { resolveIdentity, type Identity } from '@open-tag/registry';
import { parseAmbientFlag } from '@open-tag/ambient';
import type { AmbientConfig, AmbientDecision, AmbientJudge } from '@open-tag/ambient';
import {
  IntentType,
  TaskStatus,
  UserRole,
  isObjectRecord as isRecord,
  isOwnerOnlySlashCommand,
  isTaskSlashCommand,
} from '@open-tag/core-types';
import type { NormalizedEvent } from '@open-tag/core-types';
import { createApiReplyLocalizer } from './reply-language-text.js';
import { getHelpText } from './slash-command-help.js';
import { createSlashCommandHandler } from './slash-command-handler.js';
import { createTaskCardActionHandler } from './card-action-handler.js';
import {
  buildDocumentCommentTaskGoal,
  buildDocumentCommentTaskInput,
  buildQueuedTaskInput,
} from './task-dispatch.js';
import { failTaskCreatedPipeline } from './task-pipeline-compensation.js';
import { enqueueDiscussionTurnTaskOrFail } from './discussion-turn-enqueue.js';
import { PrPollingService } from './pr-polling-service.js';
import { registerManagedService, unregisterManagedService } from './service-process.js';
import { getReplyToMessageId, upgradeRootProvisionalSession } from './reply-threading.js';
import { sendDispatchReplyViaChannel } from './dispatch-reply.js';
import { resolveChannelSender } from './channel-sender-resolver.js';
import { applyDebugFeishuOverrides, createLoopbackFeishuClient } from './debug-feishu-client.js';
import { applyBufferGate } from './buffer-gate.js';
import { tapChannelObservation } from './channel-observation-tap.js';
import { tapAmbient, type AmbientTapDeps } from './ambient-tap.js';
import { SlackChannel } from '@open-tag/channel-slack';
import type { InboundMessage } from '@open-tag/channel-core';
import {
  SLACK_EVENTS_PATH,
  createSlackEventsHandler,
  createSlackInboundDispatch,
} from './slack-events.js';
import { WorkerHealthMonitor } from './worker-health-monitor.js';
import {
  WorktreeRetentionCleanupService,
  shouldRunWorktreeRetentionCleanup,
} from './worktree-retention-cleanup-service.js';
import { MultiFeishuAppRuntime, type FeishuAppRuntimeContext } from './feishu-app-runtime.js';
import { registerAdminApiRoutes, isLoopbackAddress } from './admin-api.js';
import { classifyFeishuTrackingIntent } from './feishu-tracking-intent.js';
import { enrichEventWithCurrentMessageThread } from './current-message-thread-enrichment.js';
import { enrichEventWithReferencedMessage } from './referenced-message-enrichment.js';
import { aliasQuotedImageTopicStart } from './topic-session-alias.js';
import {
  stripUnassignedBotMentionsFromAgentEvent,
  type UnassignedBotIdentity,
} from './agent-goal-sanitizer.js';
import {
  DEFAULT_FEISHU_WEBHOOK_PATH,
  LEGACY_FEISHU_WEBHOOK_PATH,
  adaptFeishuWebhookCardActionPayload,
  createFeishuWebhookRateLimiter,
  getFeishuWebhookAppId,
  getFeishuWebhookEventType,
  getFeishuWebhookSignatureMetadata,
  normalizeFeishuWebhookPath,
  verifyFeishuWebhookRequest,
} from './feishu-webhook.js';
import { ChatEventSerializer, getFeishuChatEventSerialKey } from './chat-event-serializer.js';
import { addDocumentCommentAckReaction } from './document-comment-ack-reaction.js';
import {
  enrichDocumentCommentEventIfNeeded,
  shouldRetryDocumentCommentAfterEnrichmentFailure,
} from './document-comment-event-enrichment.js';
import { buildDocumentCommentStorageIds } from './document-comment-storage-ids.js';

const logger = createLogger('api');

/**
 * Read the `@open-tag/daemon` package version so the admin console install
 * guide can pin a concrete `npx @open-tag/daemon@<version>`. Resolves
 * `apps/daemon/package.json` relative to this module (works from both the
 * compiled `dist` layout and the `tsx` source layout) and falls back to null if
 * it cannot be read — the console then omits the version pin.
 */
function readDaemonVersion(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  // From apps/api/src (tsx) or apps/api/dist (built), the daemon manifest sits at
  // ../../daemon/package.json. Try a couple of layouts to stay robust.
  const candidates = [
    join(here, '../../daemon/package.json'),
    join(here, '../../../daemon/package.json'),
  ];
  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate)) continue;
      const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as { version?: unknown };
      if (typeof parsed.version === 'string' && parsed.version.trim()) {
        return parsed.version.trim();
      }
    } catch {
      // Ignore and try the next candidate / fall through to null.
    }
  }
  return null;
}

/**
 * Read the `@open-tag/desktop` package version so the Downloads page can show
 * which Mac app build the server distributes. Resolves `apps/desktop/package.json`
 * relative to this module (works from both `dist` and `tsx` layouts) and falls
 * back to null if it cannot be read.
 */
function readDesktopVersion(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, '../../desktop/package.json'),
    join(here, '../../../desktop/package.json'),
  ];
  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate)) continue;
      const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as { version?: unknown };
      if (typeof parsed.version === 'string' && parsed.version.trim()) {
        return parsed.version.trim();
      }
    } catch {
      // Ignore and try the next candidate / fall through to null.
    }
  }
  return null;
}

// ── Environment ──
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://open-claude-tag:open-claude-tag@localhost:5432/open-claude-tag';
const FEISHU_APP_ID = process.env.FEISHU_APP_ID ?? '';
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET ?? '';
const FEISHU_EVENT_MODE = process.env.FEISHU_EVENT_MODE === 'webhook' ? 'webhook' : 'websocket';
const FEISHU_WEBHOOK_PATH = normalizeFeishuWebhookPath(
  process.env.FEISHU_WEBHOOK_PATH ?? DEFAULT_FEISHU_WEBHOOK_PATH,
);
const FEISHU_WEBHOOK_VERIFICATION_TOKEN =
  process.env.FEISHU_CALLBACK_VERIFICATION_TOKEN ?? process.env.FEISHU_VERIFICATION_TOKEN ?? '';
const FEISHU_ENCRYPT_KEY = process.env.FEISHU_ENCRYPT_KEY ?? '';
const FEISHU_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;
// Slack Events API inbound (channel #2). The route is registered only when a
// signing secret is configured, so an unconfigured instance exposes no Slack
// endpoint at all (404). The bot token is optional for inbound-only use.
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET?.trim() ?? '';
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN ?? '';
const FEISHU_WEBHOOK_MAX_TIMESTAMP_SKEW_SECONDS = Number.parseInt(
  process.env.FEISHU_WEBHOOK_MAX_TIMESTAMP_SKEW_SECONDS ?? '600',
  10,
);
const FEISHU_WEBHOOK_RATE_WINDOW_MS = 60_000;
const FEISHU_WEBHOOK_RATE_LIMIT_MAX = 120;
const FEISHU_WEBHOOK_RATE_MAX_KEYS = 4096;
const HOST = process.env.HOST ?? '0.0.0.0';
const PORT = parseInt(process.env.API_PORT ?? process.env.PORT ?? '3000', 10);
const INSTANCE_ROLE = process.env.OPEN_TAG_INSTANCE_ROLE === 'isolated' ? 'isolated' : 'primary';
const INSTANCE_ID = process.env.OPEN_TAG_INSTANCE_ID ?? INSTANCE_ROLE;
// Isolated instances default to Feishu-disabled to avoid double-subscribing to the primary's
// bot. They can opt back in by setting OPEN_TAG_FEISHU_ACCESS=enabled — used together with a
// distinct dev bot app id (see tools/worktree/create.sh) so the primary and the worktree are
// on different Feishu apps.
const FEISHU_ACCESS =
  process.env.OPEN_TAG_FEISHU_ACCESS === 'disabled' ||
  (INSTANCE_ROLE === 'isolated' && process.env.OPEN_TAG_FEISHU_ACCESS !== 'enabled')
    ? 'disabled'
    : 'live';
const FEISHU_ACCESS_DISABLED = FEISHU_ACCESS === 'disabled';
const DISABLED_FEISHU_BOT_OPEN_ID = 'ou_openClaudeTag_feishu_disabled';
const DISCUSSION_ORCHESTRATION_ENABLED = ['1', 'true', 'yes'].includes(
  (process.env.DISCUSSION_ORCHESTRATION_ENABLED ?? '').toLowerCase(),
);
const DISCUSSION_TRIGGER_MODE =
  process.env.DISCUSSION_TRIGGER_MODE === 'heuristic' ? 'heuristic' : 'slash';
const DISCUSSION_MAX_ROUNDS = (() => {
  const parsed = Number.parseInt(process.env.DISCUSSION_MAX_ROUNDS ?? '3', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 3;
})();

// ── Globals ──
let db: Database;
let feishuClient: FeishuClient;
let feishuAppRuntime: MultiFeishuAppRuntime;
let queue: TaskQueue;
let memoryHandler: MemoryHandler;
let auditService: AuditService;
let botOpenId: string;
let taskLifecycle: TaskLifecycleService;
let feishuTaskSync: FeishuTaskSyncService;
let feishuTrackingLlmClient: LlmClient | null = null;
let prPollingService: PrPollingService;
let taskCardActionHandler: ReturnType<typeof createTaskCardActionHandler> | null = null;
let workerHealthMonitor: WorkerHealthMonitor;
let worktreeRetentionCleanupService: WorktreeRetentionCleanupService | null = null;
const feishuChatEventSerializer = new ChatEventSerializer();
const feishuWsManager = new FeishuWsManager({
  logger,
  instanceId: INSTANCE_ID,
  instanceRole: INSTANCE_ROLE,
  feishuAccessDisabled: FEISHU_ACCESS_DISABLED,
  getRuntime: () => feishuAppRuntime,
  processEvent: (raw, appContext) => processEvent(raw, appContext),
  getTaskCardActionHandler: () => taskCardActionHandler,
});
let isShuttingDown = false;
let feishuRuntimeReloadPromise: Promise<void> | null = null;

interface TaskAgentContext {
  agentId?: string;
  feishuAppId?: string;
  senderAccess?: AgentAccessContext;
}

const OPEN_TAG_REPO_ROOT = process.env.OPEN_TAG_REPO_ROOT ?? process.cwd();

const BUFFER_UNTIL_AT = process.env.BUFFER_UNTIL_AT === 'true';

function pickChatDisplayName(chat: Awaited<ReturnType<FeishuClient['getChat']>>): string | null {
  return (
    chat.name?.trim() || chat.i18nNames?.zh_cn?.trim() || chat.i18nNames?.en_us?.trim() || null
  );
}

async function resolveAdminConsoleChatDisplayName(input: {
  chatId: string;
}): Promise<string | null> {
  if (FEISHU_ACCESS_DISABLED) return null;
  let client: FeishuClient | undefined;
  try {
    client = feishuAppRuntime?.getPrimaryContext().client ?? feishuClient;
  } catch {
    client = feishuClient;
  }
  if (!client) return null;

  try {
    return pickChatDisplayName(await client.getChat(input.chatId));
  } catch (error) {
    logger.warn({ err: error, chatId: input.chatId }, 'Failed to resolve admin console chat name');
    return null;
  }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function buildUserMessageMetadata(event: NormalizedEvent): Record<string, unknown> {
  const imageAttachment = event.content.imageKey
    ? {
        imageKey: event.content.imageKey,
        messageId: event.content.imageMessageId ?? event.messageId,
      }
    : undefined;
  return {
    ...(event.replyLanguage ? { replyLanguage: event.replyLanguage } : {}),
    ...(imageAttachment ? { imageAttachment } : {}),
    ...(event.content.referencedMessages?.length
      ? { referencedMessages: event.content.referencedMessages }
      : {}),
    ...(event.content.referencedMessageWarnings?.length
      ? { referencedMessageWarnings: event.content.referencedMessageWarnings }
      : {}),
  };
}

async function resolveDebugFeishuAppContext(
  feishuAppId?: string,
): Promise<FeishuAppRuntimeContext | null> {
  if (!feishuAppId) {
    return {
      id: 'debug-loopback',
      tenantKey: 'default',
      appId: FEISHU_APP_ID || 'debug-loopback',
      appSecretRef: 'debug',
      appSecret: '',
      client: createLoopbackFeishuClient(recordDebugSentMessage, lookupDebugReferencedMessage),
      botOpenId: DISABLED_FEISHU_BOT_OPEN_ID,
      botName: 'OpenClaudeTag',
      eventMode: 'webhook',
      status: 'disabled',
      wsStatus: 'disabled',
      isPrimary: false,
      persisted: false,
      hasActiveBotBinding: false,
    };
  }

  const runtimeContext = feishuAppRuntime.getContextById(feishuAppId);
  if (runtimeContext) {
    return runtimeContext;
  }

  if (!isUuid(feishuAppId)) {
    return null;
  }

  const [appRow] = await db
    .select()
    .from(feishuApps)
    .where(and(eq(feishuApps.id, feishuAppId), eq(feishuApps.status, 'enabled')))
    .limit(1);
  if (!appRow?.botOpenId) {
    return null;
  }
  const isDebugRegisteredApp =
    appRow.appSecretRef === 'stored' &&
    appRow.appSecret === 'debug' &&
    appRow.appId.startsWith('debug-') &&
    appRow.eventMode === 'webhook';
  if (!FEISHU_ACCESS_DISABLED && !isDebugRegisteredApp) {
    return null;
  }

  return {
    id: appRow.id,
    tenantKey: appRow.tenantKey,
    appId: appRow.appId,
    appSecretRef: appRow.appSecretRef,
    appSecret: '',
    client: createLoopbackFeishuClient(recordDebugSentMessage, lookupDebugReferencedMessage),
    botOpenId: appRow.botOpenId,
    botName: appRow.botName ?? undefined,
    eventMode: appRow.eventMode === 'webhook' ? 'webhook' : 'websocket',
    status: 'disabled',
    wsStatus: 'disabled',
    isPrimary: false,
    persisted: true,
    hasActiveBotBinding: false,
  };
}

async function handleSlashCommand(
  message: InboundMessage,
  sessionId: string,
  replyToMessageId?: string,
  appContext: FeishuAppRuntimeContext = feishuAppRuntime.getPrimaryContext(),
  agentContext: TaskAgentContext = {},
): Promise<void> {
  // ADR-0004 Stage 1a-ii: the slash-command path ENTERS as a channel-neutral
  // InboundMessage. handleSlashCommand reads no lossless scalars of its own — it is
  // a pure pass-through whose only consumers (the createSlashCommandHandler handler
  // and upgradeRootProvisionalSession) still take a NormalizedEvent — so it recovers
  // the lark-guarded native event once at the top and runs verbatim. The recovered
  // native is byte-identical to the call-site `adaptNormalizedEvent` input (same
  // object via channel.native), so behavior is unchanged. Outbound stays native.
  const event = recoverFeishuNormalizedEvent(message);
  const handler = createSlashCommandHandler({
    db,
    feishuClient: appContext.client,
    queue,
    memoryHandler,
    feishuTaskSync,
    agentContext,
    logger,
    repoRoot: OPEN_TAG_REPO_ROOT,
    instanceRole: INSTANCE_ROLE,
  });
  const sentMessageId = await handler(event, sessionId, replyToMessageId);
  await upgradeRootProvisionalSession({ db, event, logger, sessionId, sentMessageId });
}

// ── Normal message handler ──
async function handleNormalMessage(
  message: InboundMessage,
  sessionId: string,
  sessionScope: string,
  replyToMessageId?: string,
  appContext: FeishuAppRuntimeContext = feishuAppRuntime.getPrimaryContext(),
  agentContext: TaskAgentContext = {},
  extraTaskConstraints: Record<string, unknown> = {},
  explicitTaskId?: string,
): Promise<void> {
  // ADR-0004 Stage 1a-ii/1a-iii: the main task-creation path ENTERS as a
  // channel-neutral InboundMessage. Its lossless task-creation inputs (goal/summary
  // fallback text, tenant, chat, requester) read from `message.*`, and as of 1a-iii
  // the queued-task ACK card resolves its destination from `message.scope.scopeId`
  // too. The deferred Feishu OUTBOUND (direct reply / reaction), the ACK reply
  // target, and the downstream calls whose signatures still take a NormalizedEvent
  // (orchestrator handleEvent, buildQueuedTaskInput, upgradeRootProvisionalSession,
  // buildFeishuTaskSourceTopicKey) keep flowing from the lark-guarded recovered
  // native event — those migrate in later slices. The recovered native is
  // byte-identical to the call-site `adaptNormalizedEvent` input (same object via
  // channel.native), so behavior is unchanged. The one non-lossless scalar (the
  // exact message id) is also read from native.
  const event = recoverFeishuNormalizedEvent(message);
  const result = await handleEvent(db, message, sessionId, {
    ...agentContext,
    extraTaskConstraints,
    taskId: explicitTaskId,
    // Non-lossless attachment payloads + the exact source message id come from the
    // recovered native event that backs `message` (ADR-0004 1a-ii).
    ...deriveFeishuTaskAttachments(event),
    userMessageId: event.messageId,
  });

  if (result.type === 'direct_reply' && result.reply) {
    // ADR-0004 1a-iii: the orchestrator direct reply routes through the neutral
    // channel sender, byte-identical to the prior direct client.sendMessage. The
    // destination resolves from the neutral message scope; the reply target stays
    // the (native) replyToMessageId this slice.
    const sentMessageId = await sendDispatchReplyViaChannel(
      appContext.client,
      message.scope.scopeId,
      { msg_type: 'text', content: { text: result.reply } },
      replyToMessageId,
    );
    await upgradeRootProvisionalSession({
      db,
      event,
      logger,
      sessionId,
      sentMessageId,
    });
    return;
  }

  if (result.type === 'task_created' && result.taskId) {
    const createdTaskId = result.taskId;
    const goalText = result.goal ?? message.content.text ?? '';
    // ADR-0004 1a-iii: the queued-task ACK destination now reads the neutral
    // InboundMessage scope. `adaptNormalizedEvent` maps `scope.scopeId` straight
    // from the chat id, so this is byte-identical to the recovered `event.chatId`.
    // The ACK sender resolves from the inbound `message.channel.kind`; for the
    // lark dispatch path that is exactly `createFeishuChannelSender(appContext.client)`
    // (byte-identical), with a registered slot where a future Slack sender plugs in.
    const feedback = new ThreePhaseFeedback(
      resolveChannelSender(message.channel.kind, { feishuAppContext: appContext }),
      message.scope.scopeId,
      replyToMessageId,
    );
    let ackMessageId: string | null = null;
    // One error boundary for everything between task creation and enqueue:
    // the task row already exists, so an escaping error would strand it in
    // PENDING/QUEUED forever and let a webhook redelivery create a second
    // task for the same message.
    try {
      await feedback.sendAck(result.intent);
      ackMessageId = feedback.getAckMessageId();

      if (ackMessageId) {
        await db
          .update(tasks)
          .set({
            feedbackMessageId: ackMessageId,
            feedbackCardType: 'task_status',
            feedbackState: 'queued',
            feedbackUpdatedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(tasks.id, result.taskId));
      }

      await upgradeRootProvisionalSession({
        db,
        event,
        logger,
        sessionId,
        sentMessageId: ackMessageId ?? undefined,
      });

      await taskLifecycle.transitionTask(result.taskId, TaskStatus.QUEUED);
      await taskLifecycle.notifyTaskCreated({
        taskId: result.taskId,
        taskType: result.intent,
        sessionId,
        summary: result.goal ?? message.content.text ?? '',
        localStatus: TaskStatus.QUEUED,
        tenantKey: message.scope.installationId,
        sourceMessageId: event.messageId,
        sourceTopicKey: buildFeishuTaskSourceTopicKey(event, sessionId, sessionScope),
        chatId: message.scope.scopeId,
        replyToMessageId,
        requesterOpenId: message.sender.id,
        agentId: agentContext.agentId,
        feishuAppId: agentContext.feishuAppId,
      });

      // Look up existing SDK session for multi-turn resume
      const [sessionRow] = await db
        .select({
          sdkSessionId: sessions.sdkSessionId,
          sdkSessionMachineId: sessions.sdkSessionMachineId,
          runtimeBackend: sessions.runtimeBackend,
        })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1);

      // Add OK reaction to user's message to signal processing has started
      let userMessageReactionId: string | undefined;
      try {
        const reactionResult = await appContext.client.addReaction(event.messageId, 'OK');
        userMessageReactionId = reactionResult.reactionId || undefined;
      } catch (err) {
        logger.warn({ err, messageId: event.messageId }, 'Failed to add reaction to user message');
      }

      const { isRuntimeSwitch, job } = buildQueuedTaskInput({
        event,
        sessionId,
        agentId: agentContext.agentId,
        feishuAppId: agentContext.feishuAppId,
        result: {
          taskId: result.taskId,
          intent: result.intent,
          runtime: result.runtime,
          goal: result.goal,
          imageAttachment: result.imageAttachment,
          // result.fileAttachment is vendor-opaque (`unknown`) at the core boundary;
          // this Feishu layer threads the known descriptor back through.
          fileAttachment: result.fileAttachment as
            | NonNullable<NormalizedEvent['content']['fileAttachment']>
            | undefined,
        },
        replyToMessageId,
        ackMessageId,
        userMessageReactionId,
        sessionRow,
        extraConstraints: extraTaskConstraints,
      });

      // If runtime is being switched (e.g. via /use), clear the SDK session
      // since different backends can't resume each other's sessions
      if (isRuntimeSwitch) {
        await db
          .update(sessions)
          .set({
            sdkSessionId: null,
            sdkSessionMachineId: null,
            runtimeBackend: null,
            updatedAt: new Date(),
          })
          .where(eq(sessions.id, sessionId));
        logger.info(
          { sessionId, from: sessionRow.runtimeBackend, to: result.runtime },
          'Runtime switched, cleared SDK session',
        );
      }

      await queue.enqueue(job);
    } catch (err) {
      await failTaskCreatedPipeline({
        taskId: createdTaskId,
        goal: goalText,
        error: err,
        ackMessageId,
        feedback,
        persistFailedFeedbackState: async () => {
          await db
            .update(tasks)
            .set({
              feedbackState: 'failed',
              feedbackUpdatedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(tasks.id, createdTaskId));
        },
        transitionTaskFailed: async (message) => {
          await taskLifecycle.transitionTask(createdTaskId, TaskStatus.FAILED, {
            errorMessage: message,
          });
        },
        logger,
      });
      return;
    }

    logger.info({ taskId: createdTaskId, sessionId }, 'Task enqueued');
  }
}

function buildFeishuTaskSourceTopicKey(
  event: Pick<
    NormalizedEvent,
    'tenantKey' | 'chatId' | 'messageId' | 'threadId' | 'rootMessageId' | 'parentMessageId'
  >,
  sessionId: string,
  sessionScope: string,
): string {
  if (sessionScope === 'thread') {
    return `feishu:${event.tenantKey}:${event.chatId}:session:${sessionId}`;
  }

  const topicAnchor =
    event.threadId ?? event.rootMessageId ?? event.parentMessageId ?? event.messageId;
  return `feishu:${event.tenantKey}:${event.chatId}:topic:${topicAnchor}`;
}

// ── Adapt SDK flat format to normalizer's expected format ──
function adaptSdkEvent(data: Record<string, unknown>): Record<string, unknown> {
  // Official SDK EventDispatcher passes flat structure:
  //   { schema, event_id, token, create_time, event_type, tenant_key, app_id, message, sender }
  // normalizeEvent expects:
  //   { header: { event_id, ... }, event: { message, sender } }
  if (data.header && data.event) return data; // already in expected format
  if (data.message && data.sender && data.event_id) {
    return {
      schema: data.schema,
      header: {
        event_id: data.event_id,
        event_type: data.event_type,
        create_time: data.create_time,
        token: data.token ?? '',
        app_id: data.app_id,
        tenant_key: data.tenant_key,
      },
      event: {
        sender: data.sender,
        message: data.message,
      },
    };
  }
  return data;
}

function extractVirtualAgentHandle(event: NormalizedEvent): string | undefined {
  const text = event.content.text ?? '';
  const match = text.match(/(?:^|\s)@agent:([a-zA-Z0-9_-]+)/);
  return match?.[1];
}

async function loadUserAccessById(userId?: string | null): Promise<AgentAccessContext | null> {
  if (!userId) {
    return null;
  }

  const [user] = await db
    .select({ id: users.id, role: users.role })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  return user ? { userId: user.id, role: user.role } : null;
}

async function loadUserAccessByUnionId(
  unionId?: string | null,
): Promise<AgentAccessContext | null> {
  const normalizedUnionId = unionId?.trim();
  if (!normalizedUnionId) {
    return null;
  }

  const [user] = await db
    .select({ id: users.id, role: users.role })
    .from(users)
    .where(eq(users.feishuUnionId, normalizedUnionId))
    .limit(1);

  return user ? { userId: user.id, role: user.role } : null;
}

async function loadUserAccessByOpenId(openId: string): Promise<AgentAccessContext | null> {
  const [user] = await db
    .select({ id: users.id, role: users.role })
    .from(users)
    .where(eq(users.feishuOpenId, openId))
    .limit(1);

  return user ? { userId: user.id, role: user.role } : null;
}

async function resolveAgentAccessContextForFeishuIdentity(input: {
  tenantKey: string;
  senderOpenId: string;
  senderUnionId?: string | null;
  feishuAppId?: string;
}): Promise<AgentAccessContext> {
  let identityUserId: string | null | undefined;

  if (input.feishuAppId && input.senderOpenId) {
    const identity = await resolveUserIdentity(db, {
      tenantKey: input.tenantKey,
      feishuAppId: input.feishuAppId,
      openId: input.senderOpenId,
      unionId: input.senderUnionId ?? undefined,
    });
    identityUserId = identity.userId;
  }

  const userAccess =
    (await loadUserAccessById(identityUserId)) ??
    (await loadUserAccessByUnionId(input.senderUnionId)) ??
    (await loadUserAccessByOpenId(input.senderOpenId));

  if (userAccess) {
    return userAccess;
  }

  return {
    userId: identityUserId,
    role: await getUserRole(db, input.senderOpenId),
  };
}

async function resolveAgentAccessContext(
  event: NormalizedEvent,
  feishuAppId?: string,
): Promise<AgentAccessContext> {
  return resolveAgentAccessContextForFeishuIdentity({
    tenantKey: event.tenantKey,
    senderOpenId: event.senderOpenId,
    senderUnionId: event.senderUnionId,
    feishuAppId,
  });
}

async function resolveEventAgentRoute(
  event: NormalizedEvent,
  feishuAppId: string | undefined,
  access: AgentAccessContext,
) {
  return resolveAgentRoute(db, {
    tenantKey: event.tenantKey,
    chatId: event.chatId,
    feishuAppId,
    virtualHandle: extractVirtualAgentHandle(event),
    access,
    allowDefaultBuiltInFallback: !feishuAppId,
  });
}

function isRootGroupEvent(event: NormalizedEvent): boolean {
  return (
    event.chatType === 'group' && !event.threadId && !event.rootMessageId && !event.parentMessageId
  );
}

function isReferenceMention(rawText: string, participant: DiscussionMentionedAgent): boolean {
  const keyPattern = escapeRegExp(participant.mentionKey);
  const name = normalizeMentionName(participant.mentionName);
  const renderedPattern = name ? `@${escapeRegExp(name)}` : '';
  const objectPattern =
    '(?:结果|PR|pr|方案|代码|产物|输出|结论|实现|改动|变更|报告|回复|result|output|code|plan)';
  const patterns = [
    new RegExp(`${keyPattern}\\s*(?:的|\\'s)\\s*${objectPattern}`, 'i'),
    ...(renderedPattern
      ? [new RegExp(`${renderedPattern}\\s*(?:的|\\'s)\\s*${objectPattern}`, 'i')]
      : []),
  ];
  return patterns.some((pattern) => pattern.test(rawText));
}

function hasDiscussionIntent(text: string): boolean {
  return /(?:讨论|辩论|debate|discuss)/i.test(text);
}

function parseDiscussSlashTrigger(event: NormalizedEvent): { topic: string } | null {
  const renderedText = renderRawMentionText(event);
  const match = /(?:^|\s)\/discuss(?:\s+([\s\S]*))?$/i.exec(renderedText.trim());
  if (!match) return null;
  return { topic: match[1]?.trim() || 'Discussion' };
}

function isDiscussionCancelRequest(event: NormalizedEvent): boolean {
  let text = extractRawText(event).trim();
  for (const mention of [...(event.content.mentions ?? [])].sort(
    (left, right) => (left.index ?? 0) - (right.index ?? 0),
  )) {
    const key = mention.key?.trim();
    if (key && text.startsWith(key)) {
      text = text.slice(key.length).trimStart();
    }
  }
  return /^(?:\/(?:cancel|stop)-?discussion|\/discussion-cancel|取消讨论|停止讨论|终止讨论|结束讨论|cancel discussion|stop discussion)$/i.test(
    text,
  );
}

async function handleDiscussionInterruptIfNeeded(
  event: NormalizedEvent,
  appContext: FeishuAppRuntimeContext,
  replyToMessageId?: string,
): Promise<boolean> {
  if (
    !DISCUSSION_ORCHESTRATION_ENABLED ||
    (event.senderType != null && event.senderType !== 'user')
  ) {
    return false;
  }
  const rootThreadId = event.threadId ?? event.rootMessageId ?? event.parentMessageId;
  if (!rootThreadId || !isDiscussionCancelRequest(event)) {
    return false;
  }

  const discussion = await setDiscussionStatusByRootThread(db, {
    tenantKey: event.tenantKey,
    chatId: event.chatId,
    rootThreadId,
    status: 'cancelled',
  });
  if (!discussion) {
    return false;
  }

  await appContext.client.sendMessage(
    'chat_id',
    event.chatId,
    {
      msg_type: 'text',
      content: { text: 'Discussion cancelled.' },
    } as any,
    replyToMessageId,
  );
  logger.info(
    {
      eventId: event.eventId,
      discussionId: discussion.id,
      rootThreadId,
      status: discussion.status,
    },
    'Discussion cancelled by human interrupt',
  );
  return true;
}

function findRelayRoute(
  rawText: string,
  participants: DiscussionMentionedAgent[],
): { primary: DiscussionMentionedAgent; target: DiscussionMentionedAgent; ask: string } | null {
  // Sequence markers, longest-first. Bare verb+完(了) only counts when a
  // delegate verb or mention follows, so words like 完善/完成质量 never match.
  const markerMatch =
    /(?:完成之后|完成后|完了以后|完了之后|完了|完后|结束后|搞定后|好了之后|好了以后|之后|然后|接着|再|完(?=\s*(?:艾特|@))|then|after(?:wards)?|once\s+done|when\s+done)/i.exec(
      rawText,
    );
  if (!markerMatch) return null;

  const markerIndex = markerMatch.index;
  const sorted = [...participants].sort((a, b) => a.mentionIndex - b.mentionIndex);
  const references = new Set(
    sorted.filter((participant) => isReferenceMention(rawText, participant)).map((p) => p.agentId),
  );
  const primary = [...sorted]
    .reverse()
    .find(
      (participant) =>
        participant.mentionIndex < markerIndex && !references.has(participant.agentId),
    );
  if (!primary) return null;

  const afterMarker = rawText.slice(markerIndex + markerMatch[0].length);
  const target = sorted.find((participant) => {
    if (participant.agentId === primary.agentId || participant.mentionIndex <= markerIndex) {
      return false;
    }
    const renderedMentionName = normalizeMentionName(participant.mentionName);
    const mentionPatterns = [
      participant.mentionKey,
      renderedMentionName ? `@${renderedMentionName}` : '',
    ].filter(Boolean);
    return mentionPatterns.some((mentionPattern) =>
      new RegExp(`${escapeRegExp(mentionPattern)}`, 'i').test(afterMarker),
    );
  });

  if (!target) return null;
  const ask = extractRelayDelegateAction(afterMarker, target);
  if (!ask) return null;
  return { primary, target, ask };
}

function extractRelayDelegateAction(
  afterMarker: string,
  target: DiscussionMentionedAgent,
): string | null {
  const renderedMentionName = normalizeMentionName(target.mentionName);
  const mentionPatterns = [
    target.mentionKey,
    renderedMentionName ? `@${renderedMentionName}` : '',
    target.handle ? `@${normalizeMentionName(target.handle)}` : '',
    target.displayName ? `@${normalizeMentionName(target.displayName)}` : '',
  ].filter(Boolean);
  let action = afterMarker.trim();
  action = action.replace(/^(?:，|,|。|\.|\s)+/, '');
  action = action.replace(/^(?:请|让|叫|交给|艾特|at\b|handoff to|delegate to)\s*/i, '').trim();
  for (const mentionPattern of mentionPatterns) {
    action = action.replace(new RegExp(`^${escapeRegExp(mentionPattern)}\\s*`, 'i'), '').trim();
  }
  action = action.replace(/^(?:来|去|进行|帮忙|帮我|please)\s*/i, '').trim();
  action = action.replace(/^(?:，|,|。|\.|\s)+/, '').trim();
  return action.length > 0 ? action : null;
}

function classifyActorReferenceRoute(
  rawText: string,
  participants: DiscussionMentionedAgent[],
): {
  actors: DiscussionMentionedAgent[];
  references: DiscussionMentionedAgent[];
} | null {
  const references = participants.filter((participant) => isReferenceMention(rawText, participant));
  if (references.length === 0) return null;

  const referenceIds = new Set(references.map((participant) => participant.agentId));
  const actors = participants.filter((participant) => !referenceIds.has(participant.agentId));
  if (actors.length === 0) return null;
  return { actors, references };
}

function buildMentionedAgentMetadata(agent: DiscussionMentionedAgent): Record<string, unknown> {
  return {
    agentId: agent.agentId,
    feishuAppId: agent.feishuAppId,
    handle: agent.handle,
    displayName: agent.displayName,
    botOpenId: agent.mentionOpenId,
  };
}

function buildRelayPrimaryTaskId(
  event: NormalizedEvent,
  primary: DiscussionMentionedAgent,
): string {
  return stableUuidFromKey(
    ['relay-primary', event.tenantKey, event.chatId, event.messageId, primary.agentId].join(':'),
  );
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function isExistingDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

async function enrichReferenceReviewContext(
  sessionId: string,
  constraints: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const routing = constraints.multiMentionRouting;
  if (!isRecord(routing) || routing.route !== 'reference') {
    return constraints;
  }

  const references = Array.isArray(routing.references) ? routing.references : [];
  const [reference] = references.filter(isRecord);
  const referencedAgentId = stringValue(reference?.agentId);
  if (!referencedAgentId) {
    return constraints;
  }
  const delegateGoal = stringValue(routing.delegateGoal);
  const worktreeAccessMode = 'write' as const;

  const [recentCompletedTask] = await db
    .select({
      id: tasks.id,
      goal: tasks.goal,
      result: tasks.result,
      executedOnMachineId: tasks.executedOnMachineId,
      updatedAt: tasks.updatedAt,
      createdAt: tasks.createdAt,
    })
    .from(tasks)
    .where(
      and(
        eq(tasks.sessionId, sessionId),
        eq(tasks.agentId, referencedAgentId),
        eq(tasks.status, TaskStatus.COMPLETED),
      ),
    )
    .orderBy(desc(tasks.updatedAt), desc(tasks.createdAt))
    .limit(1);

  if (!recentCompletedTask) {
    return {
      ...constraints,
      reviewContext: {
        source: 'reference',
        referencedAgentId,
        referencedHandle: stringValue(reference?.handle),
        delegateGoal,
        worktreeAccessMode,
        missingReason: 'no_completed_task',
      },
    };
  }

  const [recentRun] = await db
    .select({ workspacePath: taskRuns.workspacePath })
    .from(taskRuns)
    .where(eq(taskRuns.taskId, recentCompletedTask.id))
    .orderBy(desc(taskRuns.completedAt), desc(taskRuns.startedAt))
    .limit(1);

  const referencedState = await loadAgentSessionState(db, {
    sessionId,
    agentId: referencedAgentId,
  });
  const workspacePath =
    stringValue(recentRun?.workspacePath) ?? stringValue(referencedState?.workspacePath);
  const sourceMachineId = recentCompletedTask.executedOnMachineId ?? null;
  const worktreePath =
    workspacePath &&
    isAbsolute(workspacePath) &&
    (sourceMachineId || isExistingDirectory(workspacePath))
      ? workspacePath
      : undefined;

  return {
    ...constraints,
    reviewContext: {
      source: 'reference',
      referencedAgentId,
      referencedHandle: stringValue(reference?.handle),
      reviewedTaskId: recentCompletedTask.id,
      reviewedGoal: recentCompletedTask.goal,
      reviewedResult: recentCompletedTask.result,
      delegateGoal,
      worktreeAccessMode,
      sourceMachineId,
      ...(worktreePath
        ? { worktreePath }
        : {
            missingReason: workspacePath ? 'worktree_unavailable' : 'no_worktree_record',
            missingWorktreePath: workspacePath,
          }),
      baseWorkDir: stringValue(referencedState?.adhocWorkDir),
    },
  };
}

interface RelayDeferredContractSpec {
  agent: DiscussionMentionedAgent;
  goal: string;
}

type MultiMentionIntakeDecision =
  | {
      action: 'continue';
      extraTaskConstraints?: Record<string, unknown>;
      explicitTaskId?: string;
      relayPrimaryBind?: { primaryTaskId: string; waitingOnAgentId: string };
      relayContracts?: RelayDeferredContractSpec[];
    }
  | { action: 'skip'; reason: string }
  | { action: 'defer'; primary: DiscussionMentionedAgent; goal: string; ack: string };

function buildWaitingAckTemplate(primary: DiscussionMentionedAgent, goal: string): string {
  return `收到，等 @${normalizeMentionName(primary.displayName) || primary.handle} 完成后我来${goal}`;
}

/**
 * The PRIMARY delivery is the source of truth for waiting contracts: it knows
 * every deferred agent and persists their contracts itself, so a dropped or
 * delayed deferred app delivery can never lose the relay. The deferred
 * delivery only adds the visible waiting ack on top of the existing contract.
 */
function relayPrimaryContinue(
  event: NormalizedEvent,
  primary: DiscussionMentionedAgent,
  deferred: RelayDeferredContractSpec[],
): MultiMentionIntakeDecision {
  const primaryTaskId = buildRelayPrimaryTaskId(event, primary);
  return {
    action: 'continue',
    explicitTaskId: primaryTaskId,
    relayPrimaryBind: { primaryTaskId, waitingOnAgentId: primary.agentId },
    relayContracts: deferred,
  };
}

function buildReferenceConstraints(
  rawText: string,
  actors: DiscussionMentionedAgent[],
  references: DiscussionMentionedAgent[],
): Record<string, unknown> {
  return {
    multiMentionRouting: {
      route: 'reference',
      actors: actors.map(buildMentionedAgentMetadata),
      references: references.map(buildMentionedAgentMetadata),
      delegateGoal: rawText,
    },
  };
}

function classifyMultiMentionIntake(
  event: NormalizedEvent,
  participants: DiscussionMentionedAgent[],
  currentAgentId?: string,
): MultiMentionIntakeDecision {
  if (!DISCUSSION_ORCHESTRATION_ENABLED || event.chatType !== 'group' || participants.length < 2) {
    return { action: 'continue' };
  }

  const rawText = renderRawMentionText(event);

  if (isRootGroupEvent(event)) {
    const relay = findRelayRoute(rawText, participants);
    if (relay) {
      if (currentAgentId === relay.primary.agentId) {
        return relayPrimaryContinue(event, relay.primary, [
          { agent: relay.target, goal: relay.ask },
        ]);
      }
      if (currentAgentId === relay.target.agentId) {
        return {
          action: 'defer',
          primary: relay.primary,
          goal: relay.ask,
          ack: buildWaitingAckTemplate(relay.primary, relay.ask),
        };
      }
      return { action: 'skip', reason: 'relay_non_primary_delivery' };
    }
  }

  const referenceRoute = classifyActorReferenceRoute(rawText, participants);
  if (referenceRoute) {
    const actorIds = new Set(referenceRoute.actors.map((actor) => actor.agentId));
    if (currentAgentId && !actorIds.has(currentAgentId)) {
      return { action: 'skip', reason: 'reference_non_actor_delivery' };
    }
    return {
      action: 'continue',
      extraTaskConstraints: buildReferenceConstraints(
        rawText,
        referenceRoute.actors,
        referenceRoute.references,
      ),
    };
  }

  return { action: 'continue' };
}

const mentionRoutingMemo = createMentionRoutingMemo();

async function hasExistingTopicSession(
  event: NormalizedEvent,
  topicMessageIds: string[],
): Promise<boolean> {
  const keys = [...new Set(topicMessageIds.filter(Boolean))].map(
    (threadId) => `feishu:${event.tenantKey}:${event.chatId}:thread:${threadId}`,
  );
  for (const key of keys) {
    const [session] = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.sessionKey, key))
      .limit(1);
    if (session) return true;

    const [alias] = await db
      .select({ id: sessionAliases.id })
      .from(sessionAliases)
      .where(eq(sessionAliases.aliasKey, key))
      .limit(1);
    if (alias) return true;
  }
  return false;
}

async function loadUnassignedBotIdentities(tenantKey: string): Promise<UnassignedBotIdentity[]> {
  const rows = await db
    .select({
      feishuAppId: feishuApps.id,
      appId: feishuApps.appId,
      botOpenId: feishuApps.botOpenId,
      botName: feishuApps.botName,
      bindingId: agentBotBindings.id,
    })
    .from(feishuApps)
    .leftJoin(
      agentBotBindings,
      and(eq(agentBotBindings.feishuAppId, feishuApps.id), eq(agentBotBindings.status, 'active')),
    )
    .where(
      and(
        eq(feishuApps.status, 'enabled'),
        or(eq(feishuApps.tenantKey, tenantKey), eq(feishuApps.tenantKey, 'default')),
      ),
    );

  return rows
    .filter((row) => !row.bindingId)
    .map((row) => ({
      feishuAppId: row.feishuAppId,
      appId: row.appId,
      botOpenId: row.botOpenId,
      botName: row.botName,
    }));
}

async function sanitizeAgentAssignedEvent(
  event: NormalizedEvent,
  agentContext: TaskAgentContext,
): Promise<NormalizedEvent> {
  if (!agentContext.agentId || !agentContext.feishuAppId) return event;
  const unassignedBots = await loadUnassignedBotIdentities(event.tenantKey);
  return stripUnassignedBotMentionsFromAgentEvent(event, agentContext.feishuAppId, unassignedBots);
}

function mapLlmMentionDecision(
  decision: MentionRoutingDecision,
  event: NormalizedEvent,
  participants: DiscussionMentionedAgent[],
  currentAgentId?: string,
): MultiMentionIntakeDecision | null {
  const byAgentId = new Map(participants.map((participant) => [participant.agentId, participant]));

  if (decision.route === 'fanout') {
    return { action: 'continue' };
  }

  if (decision.route === 'relay') {
    const primary = byAgentId.get(decision.primaryAgentId);
    if (!primary) return null;
    const deferredSpecs: RelayDeferredContractSpec[] = [];
    for (const entry of decision.deferred) {
      const agent = byAgentId.get(entry.agentId);
      if (!agent) return null;
      deferredSpecs.push({ agent, goal: entry.goal });
    }
    if (currentAgentId === primary.agentId) {
      return relayPrimaryContinue(event, primary, deferredSpecs);
    }
    const deferredEntry = decision.deferred.find((entry) => entry.agentId === currentAgentId);
    if (deferredEntry) {
      return {
        action: 'defer',
        primary,
        goal: deferredEntry.goal,
        ack: deferredEntry.ack || buildWaitingAckTemplate(primary, deferredEntry.goal),
      };
    }
    // The classifier enforces exhaustive relay coverage, so an unlisted
    // delivery here means the current agent is not in the roster at all.
    return { action: 'skip', reason: 'relay_unlisted_delivery' };
  }

  const actors = decision.actorAgentIds
    .map((agentId) => byAgentId.get(agentId))
    .filter((agent): agent is DiscussionMentionedAgent => Boolean(agent));
  const references = decision.referenceAgentIds
    .map((agentId) => byAgentId.get(agentId))
    .filter((agent): agent is DiscussionMentionedAgent => Boolean(agent));
  if (actors.length === 0 || references.length === 0) return null;
  if (currentAgentId && !actors.some((actor) => actor.agentId === currentAgentId)) {
    return { action: 'skip', reason: 'reference_non_actor_delivery' };
  }
  return {
    action: 'continue',
    extraTaskConstraints: buildReferenceConstraints(
      renderRawMentionText(event),
      actors,
      references,
    ),
  };
}

/**
 * Multi-mention routing: one LLM classification per message (memoized so all
 * concurrent app deliveries share the same decision), falling back to the
 * deterministic lexicon route whenever the LLM is unavailable or its output
 * fails roster validation.
 */
async function decideMultiMentionIntake(
  event: NormalizedEvent,
  participants: DiscussionMentionedAgent[],
  currentAgentId?: string,
): Promise<MultiMentionIntakeDecision> {
  if (!DISCUSSION_ORCHESTRATION_ENABLED || event.chatType !== 'group' || participants.length < 2) {
    return { action: 'continue' };
  }

  if (isRootGroupEvent(event) && feishuTrackingLlmClient) {
    const llmDecision = await mentionRoutingMemo.classifyOnce(
      `${event.tenantKey}:${event.chatId}:${event.messageId}`,
      {
        text: renderRawMentionText(event),
        candidates: participants.map((participant, index) => ({
          ref: `agent_${index + 1}`,
          agentId: participant.agentId,
          handle: participant.handle,
          displayName: participant.displayName,
        })),
      },
      feishuTrackingLlmClient,
    );
    if (llmDecision) {
      const mapped = mapLlmMentionDecision(llmDecision, event, participants, currentAgentId);
      if (mapped) {
        logger.info(
          {
            eventId: event.eventId,
            messageId: event.messageId,
            route: llmDecision.route,
            action: mapped.action,
            agentId: currentAgentId,
          },
          'Multi-mention routing decided by LLM',
        );
        return mapped;
      }
    }
  }

  return classifyMultiMentionIntake(event, participants, currentAgentId);
}

/**
 * A deferred (non-primary) agent in a relay decision: create no task, post a
 * visible waiting acknowledgment, persist the waiting contract. Idempotent per
 * (messageId, agentId) — a replayed delivery neither duplicates the contract
 * nor posts a second ack. The ack deliberately uses plain-text @names (no real
 * <at> tag) so it cannot re-trigger the primary bot.
 */
async function handleDeferredMentionDelivery(
  event: NormalizedEvent,
  route: { primary: DiscussionMentionedAgent; goal: string; ack: string },
  agentContext: TaskAgentContext,
  appContext: FeishuAppRuntimeContext,
  replyToMessageId?: string,
): Promise<void> {
  if (!agentContext.agentId) {
    logger.warn(
      { eventId: event.eventId, messageId: event.messageId },
      'Deferred mention delivery has no agent identity; skipping contract',
    );
    return;
  }

  const { contract } = await createWaitingContract(db, {
    tenantKey: event.tenantKey,
    chatId: event.chatId,
    messageId: event.messageId,
    agentId: agentContext.agentId,
    feishuAppId: agentContext.feishuAppId ?? null,
    waitingOnAgentId: route.primary.agentId,
    goal: route.goal,
  });
  // The primary delivery may have created the contract first (source of truth);
  // this delivery's job is the visible waiting ack. Replays (ack already
  // recorded) no-op; the ack send itself is idempotent via a deterministic
  // Feishu uuid, so a crash between send and record cannot double-post.
  if (contract.ackMessageId) {
    logger.info(
      { eventId: event.eventId, contractId: contract.id, agentId: agentContext.agentId },
      'Waiting contract ack already posted; deferred delivery replay no-op',
    );
    return;
  }

  // Best-effort bind: if the primary delivery already created its task (the id
  // is deterministic), attach it so the reconciler sees a live primary.
  try {
    const primaryTaskId = buildRelayPrimaryTaskId(event, route.primary);
    const [existingTask] = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(eq(tasks.id, primaryTaskId))
      .limit(1);
    if (existingTask) {
      await bindWaitingContractsToPrimaryTask(db, {
        tenantKey: event.tenantKey,
        chatId: event.chatId,
        messageId: event.messageId,
        waitingOnAgentId: route.primary.agentId,
        primaryTaskId,
      });
    }
  } catch (err) {
    logger.warn(
      { err, eventId: event.eventId, contractId: contract.id },
      'Failed best-effort bind of waiting contract to primary task',
    );
  }

  try {
    const ackReply = await appContext.client.sendMessage(
      'chat_id',
      event.chatId,
      {
        msg_type: 'text',
        content: { text: route.ack },
      } as any,
      replyToMessageId,
      { uuid: `wc:${contract.id}:ack` },
    );
    await setWaitingContractAckMessageId(db, contract.id, ackReply.messageId);
    logger.info(
      {
        eventId: event.eventId,
        contractId: contract.id,
        agentId: agentContext.agentId,
        ackMessageId: ackReply.messageId,
        waitingOn: route.primary.agentId,
      },
      'Deferred agent posted waiting ack',
    );
  } catch (err) {
    // Contract stands without the ack — the wake still works; only visibility suffered.
    logger.warn(
      { err, eventId: event.eventId, contractId: contract.id },
      'Failed to post waiting ack for deferred agent',
    );
  }
}

async function getOrCreateDiscussionSession(
  event: NormalizedEvent,
  topic: string,
): Promise<string> {
  const sessionKey = `feishu:${event.tenantKey}:${event.chatId}:discussion:${event.messageId}`;
  const sessionId = randomUUID();
  const [inserted] = await db
    .insert(sessions)
    .values({
      id: sessionId,
      sessionKey,
      chatId: event.chatId,
      scope: 'discussion',
      status: 'active',
      title: topic.slice(0, 256),
    })
    .onConflictDoNothing({ target: sessions.sessionKey })
    .returning({ id: sessions.id });
  if (inserted) return inserted.id;

  const [existing] = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.sessionKey, sessionKey))
    .limit(1);
  if (!existing) {
    throw new Error(`Failed to create or resolve discussion session for ${event.messageId}`);
  }
  return existing.id;
}

function buildDiscussionTurnGoal(input: {
  topic: string;
  participants: DiscussionMentionedAgent[];
  speaker: DiscussionMentionedAgent;
  round: number;
  turnIndex: number;
}): string {
  const roster = input.participants
    .map((participant, index) => {
      const role = participant.role ? ` (${participant.role})` : '';
      return `${index + 1}. ${participant.displayName}${role}`;
    })
    .join('\n');

  return [
    'You are participating in a turn-based multi-agent discussion.',
    '',
    '<discussion_topic>',
    input.topic,
    '</discussion_topic>',
    '',
    '<participants>',
    roster,
    '</participants>',
    '',
    `It is round ${input.round}, turn ${input.turnIndex + 1}.`,
    input.speaker.role ? `Your assigned role: ${input.speaker.role}.` : 'No role was assigned.',
    'Give your turn for the shared discussion. Future turns will receive the transcript.',
  ].join('\n');
}

async function createInitialDiscussionTurnTask(input: {
  event: NormalizedEvent;
  sessionId: string;
  discussionId: string;
  participantId: string;
  participant: DiscussionMentionedAgent;
  participants: DiscussionMentionedAgent[];
  topic: string;
  replyToMessageId?: string;
  sourceTrigger?: string;
}): Promise<string> {
  const taskId = stableUuidFromKey(`${input.discussionId}:1:0`);
  const goal = buildDiscussionTurnGoal({
    topic: input.topic,
    participants: input.participants,
    speaker: input.participant,
    round: 1,
    turnIndex: 0,
  });
  const constraints = {
    timeoutSec: 1800,
    approvalRequired: false,
    writeScope: [],
    networkPolicy: 'restricted',
    tenantKey: input.event.tenantKey,
    chatId: input.event.chatId,
    userMessageId: input.event.messageId,
    replyToMessageId: input.replyToMessageId,
    sourceCommand: input.sourceTrigger ?? '/discuss',
    discussionId: input.discussionId,
    discussionParticipantId: input.participantId,
    discussionRound: 1,
    discussionTurnIndex: 0,
    discussionRole: input.participant.role,
  };

  const [insertedTask] = await db
    .insert(tasks)
    .values({
      id: taskId,
      sessionId: input.sessionId,
      agentId: input.participant.agentId,
      feishuAppId: input.participant.feishuAppId,
      taskType: 'chat_reply',
      goal,
      runtimeHint: 'auto',
      status: TaskStatus.QUEUED,
      constraints,
    })
    .onConflictDoNothing({ target: tasks.id })
    .returning({ id: tasks.id });

  if (!insertedTask) {
    return taskId;
  }

  const job: TaskJobData = {
    taskId,
    sessionId: input.sessionId,
    agentId: input.participant.agentId,
    feishuAppId: input.participant.feishuAppId,
    taskType: 'chat_reply',
    goal,
    runtimeHint: 'auto',
    constraints,
  };
  await enqueueDiscussionTurnTaskOrFail(
    {
      enqueue: (turnJob) => queue.enqueue(turnJob),
      markTaskFailed: (failedTaskId, message) =>
        taskLifecycle.transitionTask(failedTaskId, TaskStatus.FAILED, { errorMessage: message }),
      logger,
    },
    job,
  );
  return taskId;
}

async function handleDiscussionCommandIfNeeded(
  event: NormalizedEvent,
  appContext: FeishuAppRuntimeContext,
  access: AgentAccessContext,
  replyToMessageId?: string,
): Promise<boolean> {
  const slashDiscuss = parseDiscussSlashTrigger(event);
  const heuristicDiscuss =
    DISCUSSION_ORCHESTRATION_ENABLED &&
    DISCUSSION_TRIGGER_MODE === 'heuristic' &&
    event.content.type !== 'command' &&
    isRootGroupEvent(event) &&
    hasDiscussionIntent(extractTextWithoutMentions(event));
  if (!DISCUSSION_ORCHESTRATION_ENABLED || (!slashDiscuss && !heuristicDiscuss)) {
    return false;
  }

  const participants = await resolveDiscussionMentionedAgents(db, event, access);
  if (participants.length < 2) {
    await appContext.client.sendMessage(
      'chat_id',
      event.chatId,
      {
        msg_type: 'text',
        content: { text: 'Usage: /discuss requires at least two mentioned agents.' },
      } as any,
      replyToMessageId,
    );
    return true;
  }

  const topic = slashDiscuss?.topic || event.content.text?.trim() || 'Discussion';
  const sessionId = await getOrCreateDiscussionSession(event, topic);
  const { discussion, participants: persistedParticipants } = await createDiscussion(db, {
    tenantKey: event.tenantKey,
    chatId: event.chatId,
    rootThreadId: event.threadId ?? event.rootMessageId ?? event.messageId,
    feishuAppId: appContext.persisted ? appContext.id : undefined,
    sessionId,
    topic,
    roundLimit: DISCUSSION_MAX_ROUNDS,
    participants: participants.map((participant, index) => ({
      agentId: participant.agentId,
      feishuAppId: participant.feishuAppId,
      botOpenId: participant.mentionOpenId,
      displayName: participant.displayName,
      role: participant.role,
      orderIndex: index,
    })),
  });

  const [existingUserMessage] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.sessionId, sessionId),
        eq(messages.feishuMessageId, event.messageId),
        eq(messages.role, 'user'),
      ),
    )
    .limit(1);
  if (!existingUserMessage) {
    await db.insert(messages).values({
      sessionId,
      feishuMessageId: event.messageId,
      role: 'user',
      content: event.content.text ?? topic,
      contentType: event.content.type,
      metadata: {
        replyLanguage: event.replyLanguage,
        discussionId: discussion.id,
        sourceCommand: slashDiscuss ? '/discuss' : 'discussion-heuristic',
      },
    });
  }

  const firstParticipant = participants[0];
  const firstPersistedParticipant = persistedParticipants.find(
    (participant) => participant.agentId === firstParticipant.agentId,
  );
  if (!firstPersistedParticipant) {
    throw new Error(`Failed to resolve first discussion participant for ${discussion.id}`);
  }

  const firstTaskId = await createInitialDiscussionTurnTask({
    event,
    sessionId,
    discussionId: discussion.id,
    participantId: firstPersistedParticipant.id,
    participant: firstParticipant,
    participants,
    topic,
    replyToMessageId,
    sourceTrigger: slashDiscuss ? '/discuss' : 'discussion-heuristic',
  });

  logger.info(
    {
      eventId: event.eventId,
      discussionId: discussion.id,
      sessionId,
      firstTaskId,
      participantCount: participants.length,
    },
    'Discussion command created initial turn task',
  );
  return true;
}

async function getOrCreateDocumentCommentSession(input: {
  event: NormalizedDocumentCommentEvent;
  chatId: string;
  sessionKey: string;
}): Promise<string> {
  const sessionId = randomUUID();
  const title = (input.event.text || input.event.documentUrl).slice(0, 256);
  const [inserted] = await db
    .insert(sessions)
    .values({
      id: sessionId,
      sessionKey: input.sessionKey,
      chatId: input.chatId,
      scope: 'doc-comment',
      status: 'active',
      title,
    })
    .onConflictDoNothing({ target: sessions.sessionKey })
    .returning({ id: sessions.id });
  if (inserted) return inserted.id;

  const [existing] = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.sessionKey, input.sessionKey))
    .limit(1);
  if (!existing) {
    throw new Error(`Failed to create or resolve document comment session ${input.sessionKey}`);
  }
  return existing.id;
}

async function handleDocumentCommentEvent(
  event: NormalizedDocumentCommentEvent,
  appContext: FeishuAppRuntimeContext,
  feishuAppId?: string,
): Promise<boolean> {
  const routingIds = buildDocumentCommentStorageIds({ event, feishuAppId });

  try {
    const dedup = await checkAndRecordEvent(
      db,
      event.eventId,
      routingIds.sourceMessageId,
      feishuAppId,
    );
    if (dedup.isDuplicate) {
      logger.debug({ eventId: event.eventId }, 'Duplicate document comment event, skipping');
      return true;
    }

    const senderAccess = await resolveAgentAccessContextForFeishuIdentity({
      tenantKey: event.tenantKey,
      senderOpenId: event.senderOpenId,
      senderUnionId: event.senderUnionId,
      feishuAppId,
    });
    const agentRoute = await resolveAgentRoute(db, {
      tenantKey: event.tenantKey,
      chatId: routingIds.chatId,
      feishuAppId,
      access: senderAccess,
      allowDefaultBuiltInFallback: !feishuAppId,
    });
    const agentContext = {
      agentId: agentRoute.agent.id,
      feishuAppId,
      senderAccess,
    };
    const ids = buildDocumentCommentStorageIds({
      event,
      feishuAppId,
      agentId: agentContext.agentId,
    });
    const sessionId = await getOrCreateDocumentCommentSession({
      event,
      chatId: ids.chatId,
      sessionKey: ids.sessionKey,
    });

    await touchSession(db, sessionId);
    await incrementMessageCount(db, sessionId);
    await db.insert(messages).values({
      sessionId,
      feishuMessageId: ids.sourceMessageId,
      agentId: agentContext.agentId,
      feishuAppId: agentContext.feishuAppId,
      role: 'user',
      content: event.text,
      contentType: 'doc_comment',
      metadata: {
        replyLanguage: event.replyLanguage,
        documentComment: {
          documentUrl: event.documentUrl,
          fileToken: event.fileToken,
          fileType: event.fileType,
          commentId: event.commentId,
          replyId: event.replyId,
          quote: event.quote,
          isWhole: event.isWhole,
          eventId: event.eventId,
          threadReplies: event.threadReplies,
        },
      },
    });

    const taskType = classifyIntent(event.text);
    const runtime = selectRuntime(taskType);
    const goal = buildDocumentCommentTaskGoal(event);
    const taskValues = {
      id: ids.taskId,
      sessionId,
      agentId: agentContext.agentId,
      feishuAppId: agentContext.feishuAppId,
      taskType,
      goal,
      runtimeHint: runtime === 'auto' ? null : runtime,
      status: TaskStatus.PENDING,
      constraints: {
        timeoutSec: 1800,
        approvalRequired: taskType === IntentType.SELF_IMPROVEMENT,
        tenantKey: event.tenantKey,
        agentId: agentContext.agentId,
        feishuAppId: agentContext.feishuAppId,
        userMessageId: ids.sourceMessageId,
        requesterOpenId: event.senderOpenId,
        replyLanguage: event.replyLanguage,
        feedbackChannel: 'document_comment',
        documentComment: {
          source: 'document_comment',
          tenantKey: event.tenantKey,
          documentUrl: event.documentUrl,
          fileToken: event.fileToken,
          fileType: event.fileType,
          commentId: event.commentId,
          replyId: event.replyId,
          quote: event.quote,
          isWhole: event.isWhole,
          eventId: event.eventId,
          noticeType: event.noticeType,
          senderOpenId: event.senderOpenId,
          senderUnionId: event.senderUnionId,
          text: event.text,
          threadReplies: event.threadReplies,
        },
      },
    } satisfies typeof tasks.$inferInsert;

    const [insertedTask] = await db
      .insert(tasks)
      .values(taskValues)
      .onConflictDoNothing({ target: tasks.id })
      .returning({ id: tasks.id });
    if (!insertedTask) {
      await markEventProcessed(db, event.eventId, feishuAppId);
      logger.info(
        { eventId: event.eventId, taskId: ids.taskId },
        'Document comment task already exists; event marked processed',
      );
      return true;
    }

    const [sessionRow] = await db
      .select({
        sdkSessionId: sessions.sdkSessionId,
        sdkSessionMachineId: sessions.sdkSessionMachineId,
        runtimeBackend: sessions.runtimeBackend,
      })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);

    const { isRuntimeSwitch, job } = buildDocumentCommentTaskInput({
      event,
      sessionId,
      taskId: ids.taskId,
      sourceMessageId: ids.sourceMessageId,
      taskType,
      runtime,
      agentId: agentContext.agentId,
      feishuAppId: agentContext.feishuAppId,
      sessionRow,
    });

    if (isRuntimeSwitch) {
      await db
        .update(sessions)
        .set({
          sdkSessionId: null,
          sdkSessionMachineId: null,
          runtimeBackend: null,
          updatedAt: new Date(),
        })
        .where(eq(sessions.id, sessionId));
    }

    try {
      await taskLifecycle.transitionTask(ids.taskId, TaskStatus.QUEUED);
      await queue.enqueue(job);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await taskLifecycle.transitionTask(ids.taskId, TaskStatus.FAILED, {
        errorMessage: message,
      });
      await markEventProcessed(db, event.eventId, feishuAppId);
      logger.error(
        { err, eventId: event.eventId, taskId: ids.taskId },
        'Document comment task enqueue failed',
      );
      return true;
    }

    await addDocumentCommentAckReaction({
      client: appContext.client,
      event,
      logger,
    });

    await markEventProcessed(db, event.eventId, feishuAppId);
    logger.info(
      {
        eventId: event.eventId,
        taskId: ids.taskId,
        sessionId,
        agentId: agentContext.agentId,
        routeSource: agentRoute.source,
      },
      'Document comment task enqueued',
    );
    return true;
  } catch (err) {
    if (err instanceof AgentAccessDeniedError) {
      await markEventProcessed(db, event.eventId, feishuAppId);
      logger.info(
        { eventId: event.eventId, senderOpenId: event.senderOpenId },
        'Private agent route rejected for document comment',
      );
      return true;
    }
    logger.error({ err, eventId: event.eventId }, 'Document comment event processing failed');
    return false;
  }
}

// ── Ambient proactive-post wiring (Stage 5) ──
//
// DEFAULT-OFF is airtight per-channel. A channel posts a proactive reply only
// when BOTH the global `OPEN_TAG_AMBIENT` switch is on AND the channel's chatId
// is in the explicit `OPEN_TAG_AMBIENT_CHANNELS` allowlist. An unconfigured
// channel — absent from the allowlist — NEVER posts, even with the global flag
// on. The env allowlist is the interim per-channel opt-in until the toggle moves
// into `chatConfigs` (Stage 5 follow-up).
const AMBIENT_GLOBAL_ENABLED = parseAmbientFlag(process.env.OPEN_TAG_AMBIENT);
const AMBIENT_CHANNEL_ALLOWLIST = parseAmbientChannelAllowlist(
  process.env.OPEN_TAG_AMBIENT_CHANNELS,
);
// Built once: a cheap judge LLM for the post gate. Null when no LLM is
// configured — the gate then relies on its cheap heuristic alone (documented).
const ambientJudge = buildAmbientJudge(createLlmClientFromEnv());

function parseAmbientChannelAllowlist(raw?: string | null): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

/**
 * Resolve the per-channel ambient config. Synchronous (env-only today) so the
 * tap's default-off check runs before any side effect. `channelEnabled` is an
 * explicit boolean — `global ∧ allowlisted` — so `isAmbientEnabled` yields the
 * airtight AND: a non-allowlisted channel is hard-off regardless of the global
 * flag (never inherits a global "on").
 */
function resolveAmbientConfig(event: NormalizedEvent): AmbientConfig {
  const channelEnabled = AMBIENT_GLOBAL_ENABLED && AMBIENT_CHANNEL_ALLOWLIST.has(event.chatId);
  return { globalEnabled: AMBIENT_GLOBAL_ENABLED, channelEnabled };
}

/** Extract the first JSON object from a model reply (tolerates code fences/prose). */
function extractFirstJsonObject(raw: string): string | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  return raw.slice(start, end + 1);
}

/**
 * Adapt an `LlmClient` into the gate's injected judge. Fail-closed: an
 * unparseable/odd response declines (the gate also treats a throw as no-post).
 * Returns undefined when no LLM is configured.
 */
function buildAmbientJudge(client: LlmClient | null): AmbientJudge | undefined {
  if (!client) return undefined;
  return async ({ message, context, heuristic }) => {
    const system = [
      'You decide whether an AI assistant should PROACTIVELY reply to an',
      'un-addressed group-chat message (the user did NOT @-mention the bot).',
      'Only say yes when a reply is clearly helpful, on-topic, and adds value;',
      'default to NOT posting. Respond with strict JSON:',
      '{"post": boolean, "rationale": string}.',
    ].join(' ');
    const user = [
      `Heuristic signal: ${heuristic}`,
      `Channel context:\n${context || '(none)'}`,
      `Message:\n${message.content.text ?? ''}`,
    ].join('\n\n');
    const reply = await client.chat(
      [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      { maxTokens: 128, temperature: 0 },
    );
    const json = extractFirstJsonObject(reply);
    if (!json) return { post: false, rationale: 'judge response had no JSON object' };
    try {
      const parsed = JSON.parse(json) as { post?: unknown; rationale?: unknown };
      return {
        post: parsed.post === true,
        rationale: typeof parsed.rationale === 'string' ? parsed.rationale : '',
      };
    } catch {
      return { post: false, rationale: 'unparseable judge response' };
    }
  };
}

/**
 * Resolve the {@link Identity} the ambient task would run as, for per-identity
 * budget enforcement in the ambient gate. Routes to the SAME responding agent as
 * {@link dispatchAmbientReply} (sender access → agent route), then composes it
 * into an Identity via the registry read model.
 *
 * Budget source: {@link resolveIdentity} composes the responding agent's persisted
 * `agents.budget` cap into `Identity.budget`. When the agent declares a cap the gate
 * enforces it against the `identity_usage` window the worker records each completed
 * turn into; an agent with no cap composes `budget` undefined ⇒ the gate treats the
 * channel as UNLIMITED (unchanged default). Recording and checking compose the SAME
 * agent through {@link resolveIdentity}, so the id and window always agree.
 *
 * Returns `undefined` when the responding agent is not accessible to the sender —
 * the budget gate then treats the channel as unlimited (fail-open; never block
 * ambient on a resolution outcome). Unexpected errors propagate to the tap's
 * fail-open budget catch. Resolution runs lazily, only for substantive
 * un-addressed messages on an enabled channel, bounded by the tap's in-flight cap.
 */
async function resolveAmbientIdentity(
  event: NormalizedEvent,
  feishuAppId: string | undefined,
): Promise<Identity | undefined> {
  try {
    const senderAccess = await resolveAgentAccessContext(event, feishuAppId);
    const agentRoute = await resolveEventAgentRoute(event, feishuAppId, senderAccess);
    // Composes the agent's persisted `agents.budget` cap into Identity.budget (or
    // undefined = unlimited). This is the SAME composition the worker records under.
    return resolveIdentity(agentRoute.agent);
  } catch (err) {
    if (err instanceof AgentAccessDeniedError) {
      return undefined;
    }
    throw err;
  }
}

/**
 * Build the per-event ambient tap deps. The dispatch seam closes over the
 * resolved Feishu app context so the proactive reply lands through the right
 * client. Everything else (db/audit/judge/config) is constant.
 */
function buildAmbientTapDeps(
  appContext: FeishuAppRuntimeContext,
  feishuAppId: string | undefined,
): AmbientTapDeps {
  return {
    db,
    audit: auditService,
    resolveConfig: resolveAmbientConfig,
    judge: ambientJudge,
    resolveIdentity: (event) => resolveAmbientIdentity(event, feishuAppId),
    dispatch: ({ event, decision }) =>
      dispatchAmbientReply(event, decision, appContext, feishuAppId),
  };
}

/**
 * Enqueue an AMBIENT-flagged task through the existing dispatch path so the
 * worker generates a reply and the channel posts it to the thread. Reuses the
 * same machinery as an addressed message (agent route → session → task row →
 * queued task) with three differences: it is marked `source: 'ambient'`, it adds
 * NO "OK" reaction on the user message, and it skips Feishu task-list tracking.
 *
 * It DOES seed a minimal feedback card. The worker's completion delivery PATCHes
 * that card (`ThreePhaseFeedback.updateDone` returns early without an
 * `ackMessageId`), so the seed is what makes the proactive reply actually land.
 * This is the documented minimal-ACK deviation; an ack-less proactive completion
 * path in the worker is the cleaner follow-up.
 *
 * Only ever reached for an explicitly-enabled channel (the tap's default-off
 * gate runs first), so this path is inert for every unconfigured channel.
 */
async function dispatchAmbientReply(
  sourceEvent: NormalizedEvent,
  decision: AmbientDecision,
  appContext: FeishuAppRuntimeContext,
  feishuAppId: string | undefined,
): Promise<void> {
  // Resolve the responding agent exactly like the addressed path. A private
  // agent the sender can't reach ⇒ no proactive post (fail closed).
  let agentId: string | undefined;
  try {
    const senderAccess = await resolveAgentAccessContext(sourceEvent, feishuAppId);
    const agentRoute = await resolveEventAgentRoute(sourceEvent, feishuAppId, senderAccess);
    agentId = agentRoute.agent.id;
  } catch (err) {
    if (err instanceof AgentAccessDeniedError) {
      logger.info(
        { eventId: sourceEvent.eventId, chatId: sourceEvent.chatId },
        'Ambient post skipped: responding agent not accessible',
      );
      return;
    }
    throw err;
  }

  const inbound = adaptNormalizedEvent(sourceEvent);
  const { sessionId } = await resolveSession(db, inbound);
  // Idempotency: the un-addressed branch skips the task-dedup table, so derive a
  // DETERMINISTIC task id from the source message. A Feishu redelivery of the
  // same event resolves to the SAME id → handleEvent's onConflictDoNothing
  // returns `task_duplicate` → this returns below WITHOUT a second enqueue. The
  // constraints stay stable (only `source: 'ambient'`; the volatile decision
  // reason lives in the audit row, not here) so duplicate-matching never trips.
  const ambientTaskId = stableUuidFromKey(`ambient:${feishuAppId ?? 'none'}:${sourceEvent.messageId}`);
  const result = await handleEvent(db, inbound, sessionId, {
    agentId,
    feishuAppId,
    taskId: ambientTaskId,
    extraTaskConstraints: { source: 'ambient' },
    // Non-lossless attachment payloads + the exact source message id (ADR-0004 1a-ii).
    ...deriveFeishuTaskAttachments(sourceEvent),
    userMessageId: sourceEvent.messageId,
  });
  // Ambient only ever dispatches a freshly created task; ops direct-replies and
  // duplicates (redeliveries) are not proactive posts.
  if (result.type !== 'task_created' || !result.taskId) {
    return;
  }
  const taskId = result.taskId;

  // The task row now exists under a deterministic id, so a redelivery resolves
  // to task_duplicate and will NOT retry. If anything between here and enqueue
  // fails we must therefore not strand it PENDING: compensate by failing it (a
  // failed proactive post is best-effort and intentionally not retried — better
  // than a stuck task or a double post). Mirrors the addressed path's "never
  // strand a created task" boundary.
  try {
    const replyToMessageId = getReplyToMessageId(sourceEvent);
    // The proactive ACK sender resolves from the same inbound message's channel
    // kind (`inbound` is adapted from `sourceEvent` above). For the lark ambient
    // path this is exactly `createFeishuChannelSender(appContext.client)`
    // (byte-identical); a non-Feishu kind resolves its own sender or fails fast.
    const feedback = new ThreePhaseFeedback(
      resolveChannelSender(inbound.channel.kind, { feishuAppContext: appContext }),
      sourceEvent.chatId,
      replyToMessageId,
    );
    let ackMessageId: string | null = null;
    try {
      await feedback.sendAck(result.intent);
      ackMessageId = feedback.getAckMessageId();
      if (ackMessageId) {
        await db
          .update(tasks)
          .set({
            feedbackMessageId: ackMessageId,
            feedbackCardType: 'task_status',
            feedbackState: 'queued',
            feedbackUpdatedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(tasks.id, taskId));
      }
    } catch (err) {
      logger.warn({ err, taskId }, 'Ambient seed card failed; continuing without a card');
    }

    await taskLifecycle.transitionTask(taskId, TaskStatus.QUEUED);

    const { job } = buildQueuedTaskInput({
      event: sourceEvent,
      sessionId,
      agentId,
      feishuAppId,
      result: {
        taskId,
        intent: result.intent,
        runtime: result.runtime,
        goal: result.goal,
        imageAttachment: result.imageAttachment,
        // result.fileAttachment is vendor-opaque (`unknown`) at the core boundary;
        // this Feishu layer threads the known descriptor back through.
        fileAttachment: result.fileAttachment as
          | NonNullable<NormalizedEvent['content']['fileAttachment']>
          | undefined,
      },
      replyToMessageId,
      ackMessageId,
      extraConstraints: { source: 'ambient' },
    });
    await queue.enqueue(job);
    logger.info(
      { taskId, chatId: sourceEvent.chatId, reason: decision.reason },
      'Ambient proactive task enqueued',
    );
  } catch (err) {
    logger.warn({ err, taskId }, 'Ambient dispatch failed after task creation; failing the task');
    await taskLifecycle
      .transitionTask(taskId, TaskStatus.FAILED, {
        errorMessage: err instanceof Error ? err.message : String(err),
      })
      .catch((compErr) => {
        logger.warn({ err: compErr, taskId }, 'Ambient failed-state compensation failed');
      });
  }
}

// ── Event processing pipeline ──
async function processEvent(raw: unknown, appContext?: FeishuAppRuntimeContext): Promise<boolean> {
  const adapted = isObjectRecord(raw) ? adaptSdkEvent(raw) : raw;
  const serialKey = getFeishuChatEventSerialKey(adapted, appContext?.appId);
  return feishuChatEventSerializer.run(serialKey, () => processEventInner(adapted, appContext));
}

async function processEventInner(
  raw: unknown,
  appContext?: FeishuAppRuntimeContext,
): Promise<boolean> {
  const currentAppContext = appContext ?? feishuAppRuntime?.getPrimaryContext();
  if (!currentAppContext) {
    throw new Error('No Feishu app context initialized');
  }
  const feishuAppId = currentAppContext.persisted ? currentAppContext.id : undefined;
  const config: NormalizerConfig = {
    botOpenId: currentAppContext.botOpenId ?? botOpenId,
    appId: currentAppContext.appId,
  };
  const adapted = isObjectRecord(raw) ? adaptSdkEvent(raw) : raw;
  let documentCommentInput = adapted;
  let documentCommentEnrichmentError: unknown;
  try {
    documentCommentInput = await enrichDocumentCommentEventIfNeeded(
      adapted,
      currentAppContext.client,
    );
  } catch (err) {
    documentCommentEnrichmentError = err;
    logger.warn(
      {
        err,
        rawKeys: isObjectRecord(raw) ? Object.keys(raw) : [],
      },
      'Failed to enrich Feishu document comment event',
    );
  }
  const documentCommentEvent = normalizeDocumentCommentEvent(documentCommentInput, config);
  if (documentCommentEvent) {
    logger.info(
      {
        eventId: documentCommentEvent.eventId,
        fileToken: documentCommentEvent.fileToken,
        commentId: documentCommentEvent.commentId,
      },
      'Document comment event normalized successfully',
    );
    return handleDocumentCommentEvent(documentCommentEvent, currentAppContext, feishuAppId);
  }
  if (
    shouldRetryDocumentCommentAfterEnrichmentFailure({
      raw: adapted,
      normalizedDocumentComment: documentCommentEvent,
      enrichmentError: documentCommentEnrichmentError,
    })
  ) {
    logger.warn(
      {
        err: documentCommentEnrichmentError,
        rawKeys: isObjectRecord(raw) ? Object.keys(raw) : [],
      },
      'Document comment event enrichment failed before required fields were available',
    );
    return false;
  }

  const event = normalizeEvent(adapted as any, config);
  if (!event) {
    // normalizeEvent drops un-addressed group messages (no @bot mention, @all,
    // or a slash command not addressed to this bot) so they never create a task.
    // They still carry channel context, so fold them into the always-on
    // "following the channel" observation memory here — WITHOUT routing,
    // acknowledging, or running a task, and without touching the task dedup
    // table. normalizeEventForObservation re-parses the same payload ignoring
    // only the group-addressing gate; it returns null for anything that is not a
    // parseable human message, so non-message events stay skipped.
    // ingestObservation applies its own bot/command/empty/sensitive/dedup
    // filters. This branch returns immediately, so an un-addressed message can
    // never reach the task pipeline below.
    const observationEvent = normalizeEventForObservation(adapted as any, config);
    if (observationEvent) {
      tapChannelObservation(db, observationEvent);
      // Ambient proactive-post tap (Stage 5): same un-addressed message, fired
      // right after the observation tap. Both observe; ambient additionally MAY
      // post a gated/budgeted/audited proactive reply. Default-OFF and airtight
      // per-channel — an unconfigured channel does nothing here (the tap's
      // synchronous enable check returns before any side effect). Non-blocking +
      // error-isolated by construction (see ambient-tap.ts), so it can never
      // delay or break this skip branch, which still returns immediately below.
      tapAmbient(buildAmbientTapDeps(currentAppContext, feishuAppId), observationEvent);
    }
    logger.info(
      { rawKeys: isObjectRecord(raw) ? Object.keys(raw) : [] },
      'Event normalized to null, skipping',
    );
    return true;
  }
  // ADR-0004 Stage 1a-i: the addressed-message dispatch core now ENTERS as a
  // channel-neutral InboundMessage. The Feishu edge adapts here; the seam recovers
  // the native event and runs the existing behavior verbatim (byte-identical,
  // because the same event object is threaded through `channel.native`).
  const inbound = adaptNormalizedEvent(event);
  return dispatchInboundMessageViaFeishuNative(inbound, { currentAppContext, feishuAppId });
}

/**
 * Stage 1a-i boundary bridge (ADR-0004): recover the Feishu-native
 * {@link NormalizedEvent} the dispatch core still consumes from the neutral
 * {@link InboundMessage}'s typed `native` escape hatch. `adaptNormalizedEvent`
 * preserves the original event by reference, so this is lossless. TEMPORARY: as
 * later slices migrate each consumer to read `message.*`, the recovery point moves
 * deeper and this helper is removed once nothing reads `native`.
 */
function recoverFeishuNormalizedEvent(message: InboundMessage): NormalizedEvent {
  if (message.channel.kind !== 'lark') {
    throw new Error(
      `recoverFeishuNormalizedEvent: expected a lark-native message, got ${message.channel.kind}`,
    );
  }
  return message.channel.native as NormalizedEvent;
}

/**
 * Neutral inbound dispatch seam (ADR-0004, Stage 1a-i). The addressed-message
 * dispatch core ENTERS as a channel-neutral {@link InboundMessage}. For this slice
 * it recovers the Feishu-native event and runs the existing dispatch verbatim, so
 * the Feishu path flows raw -> NormalizedEvent -> InboundMessage -> here ->
 * existing behavior with no observable change. The reply/Feishu-client side is
 * unchanged; later slices migrate downstream consumers to read `message.*`. Kept
 * private and named "...ViaFeishuNative" so a non-Feishu channel is never routed
 * here while replies still go through the Feishu client.
 */
async function dispatchInboundMessageViaFeishuNative(
  message: InboundMessage,
  ctx: { currentAppContext: FeishuAppRuntimeContext; feishuAppId: string | undefined },
): Promise<boolean> {
  const { currentAppContext, feishuAppId } = ctx;
  // `let` because the existing body enriches the event by reassignment below.
  let event = recoverFeishuNormalizedEvent(message);

  logger.info(
    { eventId: event.eventId, chatId: event.chatId, contentType: event.content.type },
    'Event normalized successfully',
  );

  try {
    // Dedup
    const dedup = await checkAndRecordEvent(db, event.eventId, event.messageId, feishuAppId);
    if (dedup.isDuplicate) {
      logger.debug({ eventId: event.eventId }, 'Duplicate event, skipping');
      return true;
    }

    // Always-on channel observation tap (Stage 1, "following the channel"):
    // fold every non-duplicate inbound human message into per-channel memory —
    // addressed (@mention) *and* un-addressed alike. Placed before routing /
    // intake / buffering so un-@-mentioned messages are followed too. The tap is
    // non-blocking + error-isolated (see channel-observation-tap.ts): a slow or
    // failing observation write can never delay or break ACK, routing, or task
    // dispatch. All filtering (bots/commands/sensitive/empty/dedup) lives in
    // ingestObservation, so it is safe to call for every normalized message.
    tapChannelObservation(db, event);

    event = await enrichEventWithCurrentMessageThread(event, currentAppContext.client, logger);
    event = await enrichEventWithReferencedMessage(event, currentAppContext.client, logger, {
      hasExistingTopic: hasExistingTopicSession,
    });
    event = await enrichEventWithCurrentMessageThread(event, currentAppContext.client, logger);

    let agentContext: TaskAgentContext = {};
    let senderAccess: AgentAccessContext | null = null;
    try {
      senderAccess = await resolveAgentAccessContext(event, feishuAppId);
      const agentRoute = await resolveEventAgentRoute(event, feishuAppId, senderAccess);
      agentContext = { agentId: agentRoute.agent.id, feishuAppId, senderAccess };
      logger.info(
        {
          eventId: event.eventId,
          agentId: agentContext.agentId,
          routeSource: agentRoute.source,
          feishuAppId,
          senderUserId: senderAccess.userId,
        },
        'Agent route resolved',
      );
    } catch (err) {
      if (err instanceof AgentAccessDeniedError) {
        const denialReplyMessageId = await sendDispatchReplyViaChannel(
          currentAppContext.client,
          message.scope.scopeId,
          {
            msg_type: 'text',
            content: { text: 'Permission denied: this agent is private.' },
          },
        );
        await markEventProcessed(db, event.eventId, feishuAppId);
        logger.info(
          {
            eventId: event.eventId,
            messageId: denialReplyMessageId,
            senderOpenId: event.senderOpenId,
          },
          'Private agent route rejected',
        );
        return true;
      }
      throw err;
    }

    const replyToMessageId = getReplyToMessageId(event);
    if (await handleDiscussionInterruptIfNeeded(event, currentAppContext, replyToMessageId)) {
      await markEventProcessed(db, event.eventId, feishuAppId);
      return true;
    }
    if (
      await handleDiscussionCommandIfNeeded(
        event,
        currentAppContext,
        senderAccess ?? {},
        replyToMessageId,
      )
    ) {
      await markEventProcessed(db, event.eventId, feishuAppId);
      return true;
    }

    const multiMentionParticipants = await resolveDiscussionMentionedAgents(
      db,
      event,
      senderAccess ?? {},
    );
    const intakeRoute = await decideMultiMentionIntake(
      event,
      multiMentionParticipants,
      agentContext.agentId,
    );
    if (intakeRoute.action === 'skip') {
      await markEventProcessed(db, event.eventId, feishuAppId);
      logger.info(
        {
          eventId: event.eventId,
          messageId: event.messageId,
          reason: intakeRoute.reason,
          feishuAppId,
          agentId: agentContext.agentId,
        },
        'Multi-mention intake skipped this delivery',
      );
      return true;
    }
    if (intakeRoute.action === 'defer') {
      await handleDeferredMentionDelivery(
        event,
        intakeRoute,
        agentContext,
        currentAppContext,
        getReplyToMessageId(event),
      );
      await markEventProcessed(db, event.eventId, feishuAppId);
      return true;
    }
    const intakeTaskConstraints = intakeRoute.extraTaskConstraints ?? {};
    const explicitTaskId = intakeRoute.explicitTaskId;
    const relayPrimaryBind = intakeRoute.relayPrimaryBind;
    // Primary delivery persists the waiting contracts itself (source of truth):
    // a dropped/delayed deferred app delivery must never lose the relay.
    // Contract creation is a hard precondition for starting the primary task —
    // a transient DB failure here must abort the whole event (it stays
    // unprocessed for redelivery) rather than be swallowed, which would
    // permanently lose the relay with no task ever created for the reconciler
    // to recover. createWaitingContract is idempotent, so the retry is safe.
    if (intakeRoute.relayContracts && relayPrimaryBind) {
      for (const spec of intakeRoute.relayContracts) {
        try {
          await createWaitingContract(db, {
            tenantKey: event.tenantKey,
            chatId: event.chatId,
            messageId: event.messageId,
            agentId: spec.agent.agentId,
            feishuAppId: spec.agent.feishuAppId || null,
            waitingOnAgentId: relayPrimaryBind.waitingOnAgentId,
            goal: spec.goal,
          });
        } catch (err) {
          logger.error(
            { err, eventId: event.eventId, deferredAgentId: spec.agent.agentId },
            'Failed to persist waiting contract from primary delivery; aborting event for redelivery',
          );
          throw err;
        }
      }
    }

    // Session routing — ADR-0004 Stage 1a: resolve from the neutral message
    // contract. Re-adapt the (thread/reference-)enriched event so the neutral
    // surface reflects the resolved thread/root/parent; the inbound `message`
    // captured at entry predates this enrichment, and `resolveSession` keys lark
    // sessions byte-identically off it.
    const sessionInbound = adaptNormalizedEvent(event);
    const { sessionId, scope: sessionScope } = await resolveSession(db, sessionInbound);
    await aliasQuotedImageTopicStart({
      event,
      sessionId,
      client: currentAppContext.client,
      aliasThreadKeys: (targetSessionId, threadIds, tenant, chatId) =>
        aliasThreadKeysForSession(db, targetSessionId, threadIds, tenant, chatId),
      logger,
    });
    logger.info({ eventId: event.eventId, sessionId }, 'Session resolved');

    // Touch session
    await touchSession(db, sessionId);
    await incrementMessageCount(db, sessionId);
    const enrichedTaskConstraints = await enrichReferenceReviewContext(
      sessionId,
      intakeTaskConstraints,
    );
    const taskEvent = await sanitizeAgentAssignedEvent(event, agentContext);

    // Store user message
    await db.insert(messages).values({
      sessionId,
      feishuMessageId: taskEvent.messageId,
      agentId: agentContext.agentId,
      feishuAppId: agentContext.feishuAppId,
      role: 'user',
      content: taskEvent.content.text ?? JSON.stringify(taskEvent.content.raw),
      contentType: taskEvent.content.type,
      metadata: buildUserMessageMetadata(taskEvent),
    });

    // Reply inside an existing thread, and also reply to root private messages
    // so Feishu creates a topic for the DM conversation.
    const replyLanguage = await resolvePreferredReplyLanguage(db, sessionId, event.replyLanguage);
    const localizedReply = createApiReplyLocalizer(replyLanguage);

    // Buffer-until-AT gate: when enabled, non-@mention messages are silently stored
    // without creating a task. Slash commands always bypass buffering.
    // The current message is already INSERT-ed above, so gatherPendingMessages
    // inside applyBufferGate can read it back (sequential, same connection).
    const effectiveEvent = BUFFER_UNTIL_AT
      ? await applyBufferGate(db, taskEvent, sessionId)
      : taskEvent;
    if (!effectiveEvent) {
      await markEventProcessed(db, event.eventId, feishuAppId);
      return true;
    }

    // ADR-0004 Stage 1a-ii: the slash-command routing/intent decisions below read
    // from the channel-neutral InboundMessage instead of the recovered native
    // event. `content.type` and `sender.id` are value-identical to the event
    // (direct copies adaptNormalizedEvent makes and the enrichment passes through
    // untouched); `content.command`/`args` are decision-equivalent for these
    // truthiness-guarded uses (the adapter drops only the empty-string-vs-undefined
    // distinction, which every guard collapses identically). `routedCommand`
    // single-sources the command so its truthiness guard narrows it for the
    // outbound text builders too, while the Feishu client write itself (chatId,
    // localizer, sendMessage) stays on the native event.
    const routedCommand = message.content.command;
    // --help is always allowed regardless of role — show help text and skip further processing
    const isHelpRequest =
      message.content.type === 'command' && message.content.args?.trim() === '--help';
    if (isHelpRequest && routedCommand && getHelpText(routedCommand, replyLanguage)) {
      const helpReplyMessageId = await sendDispatchReplyViaChannel(
        currentAppContext.client,
        message.scope.scopeId,
        {
          msg_type: 'text',
          content: { text: getHelpText(routedCommand, replyLanguage) },
        },
        replyToMessageId,
      );
      await upgradeRootProvisionalSession({
        db,
        event,
        logger,
        sessionId,
        sentMessageId: helpReplyMessageId,
      });
    } else if (
      message.content.type === 'command' &&
      routedCommand &&
      isOwnerOnlySlashCommand(routedCommand)
    ) {
      // Guard owner-only commands before they reach the orchestrator or handler
      const openAccess = process.env.OPEN_ACCESS === 'true';
      if (openAccess) {
        logger.info(
          {
            eventId: event.eventId,
            command: event.content.command,
            senderOpenId: event.senderOpenId,
          },
          'Open-access mode: bypassing owner role check for privileged command',
        );
      } else {
        const senderRole =
          agentContext.senderAccess?.role ?? (await getUserRole(db, message.sender.id));
        if (senderRole !== UserRole.OWNER) {
          const denialReplyMessageId = await sendDispatchReplyViaChannel(
            currentAppContext.client,
            message.scope.scopeId,
            {
              msg_type: 'text',
              content: {
                text: localizedReply.permissionDenied(routedCommand),
              },
            },
            replyToMessageId,
          );
          await upgradeRootProvisionalSession({
            db,
            event,
            logger,
            sessionId,
            sentMessageId: denialReplyMessageId,
          });
          await markEventProcessed(db, event.eventId, feishuAppId);
          logger.info(
            {
              eventId: event.eventId,
              command: event.content.command,
              senderOpenId: event.senderOpenId,
            },
            'Privileged command rejected: not owner',
          );
          return true;
        }
      }
      // Owner passed — route to orchestrator (TASK_COMMANDS) or slash handler
      if (isTaskSlashCommand(routedCommand)) {
        await handleNormalMessage(
          adaptNormalizedEvent(effectiveEvent),
          sessionId,
          sessionScope,
          replyToMessageId,
          currentAppContext,
          agentContext,
          enrichedTaskConstraints,
          explicitTaskId,
        );
      } else {
        await handleSlashCommand(
          adaptNormalizedEvent(event),
          sessionId,
          replyToMessageId,
          currentAppContext,
          agentContext,
        );
      }
    } else if (
      message.content.type === 'command' &&
      routedCommand &&
      !isTaskSlashCommand(routedCommand)
    ) {
      await handleSlashCommand(
        adaptNormalizedEvent(event),
        sessionId,
        replyToMessageId,
        currentAppContext,
        agentContext,
      );
    } else {
      await handleNormalMessage(
        adaptNormalizedEvent(effectiveEvent),
        sessionId,
        sessionScope,
        replyToMessageId,
        currentAppContext,
        agentContext,
        enrichedTaskConstraints,
        explicitTaskId,
      );
    }

    // Relay primary: bind any waiting contracts created by deferred deliveries
    // that landed before this task existed (the deferred side binds the other
    // ordering; the worker hook also resolves by message id as the backstop).
    if (relayPrimaryBind) {
      try {
        const bound = await bindWaitingContractsToPrimaryTask(db, {
          tenantKey: event.tenantKey,
          chatId: event.chatId,
          messageId: event.messageId,
          waitingOnAgentId: relayPrimaryBind.waitingOnAgentId,
          primaryTaskId: relayPrimaryBind.primaryTaskId,
        });
        if (bound > 0) {
          logger.info(
            { eventId: event.eventId, primaryTaskId: relayPrimaryBind.primaryTaskId, bound },
            'Bound waiting contracts to relay primary task',
          );
        }
      } catch (err) {
        logger.warn(
          { err, eventId: event.eventId, primaryTaskId: relayPrimaryBind.primaryTaskId },
          'Failed to bind waiting contracts to relay primary task',
        );
      }
    }

    // Mark processed
    await markEventProcessed(db, event.eventId, feishuAppId);
    logger.info({ eventId: event.eventId }, 'Event processed');
    return true;
  } catch (err) {
    logger.error({ err, eventId: event.eventId }, 'Event processing failed');
    return false;
  }
}

// ── Fastify app ──
const app = Fastify({ logger: false });

// The /debug/* endpoints and /api/audit drive the real event pipeline, write
// bot/agent registrations, and expose recorded bot traffic — they must not be
// reachable on a production primary. Allowed on an isolated instance, from a
// loopback client (the documented local-curl workflow), or behind an explicit
// flag; everything else gets a 404 (don't advertise the surface).
const DEBUG_SURFACE_FLAG_ENABLED = process.env.OPEN_TAG_DEBUG_ENDPOINTS === 'enabled';
const DEBUG_SURFACE_INSTANCE_ENABLED = INSTANCE_ROLE === 'isolated' || DEBUG_SURFACE_FLAG_ENABLED;

function isGatedDebugPath(url: string): boolean {
  const path = url.split('?')[0] ?? '';
  return path === '/api/audit' || path.startsWith('/debug/');
}

// Effective loopback: the socket peer must be loopback AND, behind a same-host
// reverse proxy (where request.ip is 127.0.0.1 for every caller), the first
// X-Forwarded-For hop must also be loopback. Without the XFF check a proxied
// remote attacker would read as loopback and the gate would be bypassable.
function isEffectivelyLoopbackRequest(request: FastifyRequest): boolean {
  if (!isLoopbackAddress(request.ip)) return false;
  const xff = request.headers['x-forwarded-for'];
  if (!xff) return true;
  const first = (Array.isArray(xff) ? xff[0] : xff).split(',')[0]?.trim();
  return isLoopbackAddress(first || undefined);
}

app.addHook('onRequest', async (request, reply) => {
  if (!isGatedDebugPath(request.url)) return;
  if (DEBUG_SURFACE_INSTANCE_ENABLED || isEffectivelyLoopbackRequest(request)) return;
  reply.code(404).send({ error: 'not found' });
});

const feishuWebhookPaths = new Set([FEISHU_WEBHOOK_PATH, LEGACY_FEISHU_WEBHOOK_PATH]);
const checkFeishuWebhookRateLimit = createFeishuWebhookRateLimiter({
  windowMs: FEISHU_WEBHOOK_RATE_WINDOW_MS,
  maxRequests: FEISHU_WEBHOOK_RATE_LIMIT_MAX,
  maxKeys: FEISHU_WEBHOOK_RATE_MAX_KEYS,
});

function isFeishuWebhookPath(url: string): boolean {
  return feishuWebhookPaths.has(url.split('?')[0] ?? '');
}

function isSlackEventsPath(url: string): boolean {
  return SLACK_SIGNING_SECRET !== '' && (url.split('?')[0] ?? '') === SLACK_EVENTS_PATH;
}

app.addHook('preParsing', async (request, _reply, payload) => {
  // Both the Feishu webhook and the Slack Events API need the EXACT raw bytes for
  // signature verification, so capture them here and re-stream so Fastify still
  // JSON-parses. This only ADDS the Slack path; Feishu paths are unchanged.
  if (!isFeishuWebhookPath(request.url) && !isSlackEventsPath(request.url)) {
    return payload;
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of payload) {
    const chunkBuffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += chunkBuffer.length;
    if (totalBytes > FEISHU_WEBHOOK_MAX_BODY_BYTES) {
      const err = new Error('Request body too large') as Error & { statusCode?: number };
      err.statusCode = 413;
      throw err;
    }
    chunks.push(chunkBuffer);
  }
  const rawBody = Buffer.concat(chunks);
  (request as unknown as { rawBody?: Buffer }).rawBody = rawBody;
  return Readable.from([rawBody]);
});

async function reloadFeishuRuntime(reason: string): Promise<void> {
  if (FEISHU_ACCESS_DISABLED) return;
  if (feishuRuntimeReloadPromise) {
    await feishuRuntimeReloadPromise;
    return;
  }

  feishuRuntimeReloadPromise = (async () => {
    logger.info({ reason }, 'Reloading Feishu app runtime');
    const primaryFeishuApp = await feishuAppRuntime.initialize();
    feishuClient = primaryFeishuApp.client;
    botOpenId = primaryFeishuApp.botOpenId;
    configureFeishuTaskLifecycle();
    configureTaskCardActionHandler();
    feishuWsManager.stopAll();
    await subscribeDocumentCommentEventsForHealthyApps();
    feishuWsManager.startAll();
    logger.info(
      {
        reason,
        primaryAppId: primaryFeishuApp.appId,
        healthyAppCount: feishuAppRuntime.getHealthyContexts().length,
      },
      'Feishu app runtime reloaded',
    );
  })().finally(() => {
    feishuRuntimeReloadPromise = null;
  });

  await feishuRuntimeReloadPromise;
}

async function reloadFeishuRuntimeFromAdmin(): Promise<void> {
  try {
    await reloadFeishuRuntime('admin');
  } catch (err) {
    logger.warn({ err }, 'Feishu app runtime reload after admin mutation failed');
  }
}

async function subscribeDocumentCommentEventsForHealthyApps(): Promise<void> {
  if (FEISHU_ACCESS_DISABLED) return;
  const contexts = feishuAppRuntime
    .getHealthyContexts()
    .filter(
      (context) =>
        context.eventMode === 'websocket' && (!context.persisted || context.hasActiveBotBinding),
    );
  await Promise.all(
    contexts.map(async (context) => {
      try {
        await context.client.subscribeDocumentCommentEvents();
        logger.info({ appId: context.appId }, 'Feishu document comment event subscription ensured');
      } catch (err) {
        logger.warn(
          { err, appId: context.appId },
          'Failed to ensure Feishu document comment event subscription',
        );
      }
    }),
  );
}

function configureFeishuTaskLifecycle(): void {
  feishuTaskSync = new FeishuTaskSyncService({
    client: feishuClient,
    repository: new DrizzleFeishuTaskTrackingRepository(db),
    config: createFeishuTaskTrackingConfigFromEnv(),
    logger,
  });
  taskLifecycle = new TaskLifecycleService(
    db,
    {
      async onTaskCreated(event) {
        const trackedEvent = await prepareFeishuTaskTrackingEvent(event);
        if (!trackedEvent) return;
        await feishuTaskSync.createTrackedTask(trackedEvent);
      },
      async onTaskStatusChanged(event) {
        await feishuTaskSync.syncTaskStatus({
          taskId: event.taskId,
          localStatus: event.localStatus,
          interactionReason: normalizeInteractionReason(event.interactionReason),
        });
      },
    },
    logger,
  );
}

async function loadRecentUserMessagesForTracking(
  sessionId: string | undefined,
  limit = 5,
): Promise<string[]> {
  if (!sessionId) return [];
  try {
    const rows = await db
      .select({ content: messages.content })
      .from(messages)
      .where(and(eq(messages.sessionId, sessionId), eq(messages.role, 'user')))
      .orderBy(desc(messages.createdAt))
      .limit(limit);

    return rows
      .map((row) => row.content.trim())
      .filter(Boolean)
      .reverse();
  } catch (err) {
    logger.warn({ err, sessionId }, 'Failed to load recent messages for Feishu tracking intent');
    return [];
  }
}

async function prepareFeishuTaskTrackingEvent(
  event: TaskCreatedEvent,
): Promise<CreateTrackedTaskInput | null> {
  const recentMessages =
    event.taskType === IntentType.CHAT_REPLY
      ? await loadRecentUserMessagesForTracking(event.sessionId)
      : [];
  const decision = await classifyFeishuTrackingIntent({
    taskType: event.taskType,
    currentMessage: event.summary,
    recentMessages,
    llmClient: feishuTrackingLlmClient,
  });

  if (!decision.track) {
    logger.info(
      { taskId: event.taskId, taskType: event.taskType, source: decision.source },
      'Feishu Task tracking skipped by intent',
    );
    return null;
  }

  return {
    ...event,
    summary: decision.title ?? event.summary,
    forceTrack: decision.source === 'intent' ? undefined : true,
  };
}

function configureTaskCardActionHandler(): void {
  taskCardActionHandler = createTaskCardActionHandler({
    db,
    feishuClient,
    feishuClientResolver: (feishuAppId) =>
      feishuAppId
        ? (feishuAppRuntime.getContextById(feishuAppId)?.client ?? null)
        : feishuAppRuntime.getPrimaryContext().client,
    queue,
    logger,
    taskLifecycle,
  });
}

function resolveFeishuWebhookAppContext(
  payload: Record<string, unknown>,
): FeishuAppRuntimeContext | null {
  const appId = getFeishuWebhookAppId(payload);
  let context: FeishuAppRuntimeContext | null;
  if (appId) {
    context =
      feishuAppRuntime?.getHealthyContexts().find((candidate) => candidate.appId === appId) ?? null;
  } else {
    try {
      context = feishuAppRuntime?.getPrimaryContext() ?? null;
    } catch {
      return null;
    }
  }

  if (!context || context.eventMode !== 'webhook') {
    return null;
  }
  return context;
}

function getFeishuWebhookTimestampSkewSeconds(): number {
  return Number.isFinite(FEISHU_WEBHOOK_MAX_TIMESTAMP_SKEW_SECONDS)
    ? Math.max(0, FEISHU_WEBHOOK_MAX_TIMESTAMP_SKEW_SECONDS)
    : 600;
}

async function isFeishuWebhookNonceReplay(headers: FastifyRequest['headers']): Promise<boolean> {
  const metadata = getFeishuWebhookSignatureMetadata(headers);
  if (!metadata) {
    return false;
  }

  const [existing] = await db
    .select({ id: feishuWebhookReceipts.id })
    .from(feishuWebhookReceipts)
    .where(eq(feishuWebhookReceipts.nonce, metadata.nonce))
    .limit(1);
  return Boolean(existing);
}

async function recordFeishuWebhookNonce(input: {
  headers: FastifyRequest['headers'];
  payload: Record<string, unknown>;
  appContext: FeishuAppRuntimeContext;
}): Promise<void> {
  const metadata = getFeishuWebhookSignatureMetadata(input.headers);
  if (!metadata) {
    return;
  }

  const timestampSeconds = Number.parseInt(metadata.timestamp, 10);
  if (!Number.isFinite(timestampSeconds)) {
    return;
  }

  const header = isObjectRecord(input.payload.header) ? input.payload.header : {};
  const eventId = typeof header.event_id === 'string' ? header.event_id : null;

  await db
    .insert(feishuWebhookReceipts)
    .values({
      nonce: metadata.nonce,
      feishuAppId: input.appContext.persisted ? input.appContext.id : null,
      appId: input.appContext.appId,
      eventId,
      timestampSeconds,
    })
    .onConflictDoNothing({ target: feishuWebhookReceipts.nonce });
}

async function handleFeishuWebhookRequest(request: FastifyRequest, reply: FastifyReply) {
  const remoteIp = request.ip ?? 'unknown';
  const rateKey = `feishu:${request.url.split('?')[0]}:${remoteIp}`;
  if (!checkFeishuWebhookRateLimit(rateKey)) {
    logger.warn({ remoteIp, path: request.url }, 'Feishu webhook rate limit exceeded');
    reply.code(429);
    return 'Too Many Requests';
  }

  const contentType = String(request.headers['content-type'] ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (contentType && contentType !== 'application/json') {
    reply.code(415);
    return 'Unsupported Media Type';
  }

  const contentLength = Number.parseInt(String(request.headers['content-length'] ?? '0'), 10);
  if (Number.isFinite(contentLength) && contentLength > FEISHU_WEBHOOK_MAX_BODY_BYTES) {
    reply.code(413);
    return 'Request body too large';
  }

  const rawBody =
    (request as unknown as { rawBody?: Buffer }).rawBody ??
    Buffer.from(JSON.stringify(request.body ?? {}));
  const verification = verifyFeishuWebhookRequest({
    payload: request.body,
    rawBody,
    headers: request.headers,
    verificationToken: FEISHU_WEBHOOK_VERIFICATION_TOKEN,
    encryptKey: FEISHU_ENCRYPT_KEY,
    requireAuthentication: true,
    maxTimestampSkewSeconds: getFeishuWebhookTimestampSkewSeconds(),
  });

  if (!verification.ok) {
    reply.code(verification.statusCode);
    return verification.response;
  }

  if (verification.challenge !== undefined) {
    return { challenge: verification.challenge };
  }

  try {
    if (await isFeishuWebhookNonceReplay(request.headers)) {
      reply.code(409);
      return { code: 409, msg: 'Duplicate webhook delivery' };
    }
  } catch (err) {
    logger.error({ err }, 'Failed to check Feishu webhook replay receipt');
    reply.code(500);
    return { code: 500, msg: 'failed to check webhook replay receipt' };
  }

  if (FEISHU_ACCESS_DISABLED) {
    reply.code(503);
    return { code: 503, msg: 'Feishu access is disabled for this instance' };
  }

  const appContext = resolveFeishuWebhookAppContext(verification.payload);
  if (!appContext) {
    reply.code(409);
    return { code: 409, msg: 'Feishu app is not configured for webhook mode' };
  }

  const eventType = getFeishuWebhookEventType(verification.payload);
  logger.info(
    { eventType, appId: appContext.appId, path: request.url.split('?')[0] },
    'Received Feishu webhook event',
  );

  if (eventType === 'im.message.receive_v1') {
    const processed = await processEvent(verification.payload, appContext);
    if (!processed) {
      reply.code(500);
      return { code: 500, msg: 'event processing failed' };
    }
    await recordFeishuWebhookNonce({
      headers: request.headers,
      payload: verification.payload,
      appContext,
    });
    return { code: 0, msg: 'ok' };
  }

  if (eventType === 'card.action.trigger') {
    if (!taskCardActionHandler) {
      reply.code(503);
      return { code: 503, msg: 'task card action handler is not initialized' };
    }
    const response = await taskCardActionHandler(
      adaptFeishuWebhookCardActionPayload(verification.payload),
    );
    await recordFeishuWebhookNonce({
      headers: request.headers,
      payload: verification.payload,
      appContext,
    });
    return response;
  }

  logger.debug({ eventType }, 'Ignoring unsupported Feishu webhook event type');
  await recordFeishuWebhookNonce({
    headers: request.headers,
    payload: verification.payload,
    appContext,
  });
  return { code: 0, msg: 'ok' };
}

for (const path of feishuWebhookPaths) {
  app.post(path, { bodyLimit: FEISHU_WEBHOOK_MAX_BODY_BYTES }, handleFeishuWebhookRequest);
}

// Slack Events API inbound (channel #2). Registered only when a signing secret is
// present, so an unconfigured instance has no Slack endpoint (404). Verification
// runs on the raw bytes captured by the preParsing hook BEFORE any JSON is trusted;
// accepted messages dispatch into channel-neutral observation memory.
if (SLACK_SIGNING_SECRET) {
  // `db` is assigned during async startup (below), after this synchronous route
  // registration, so build the dispatcher per-call to read `db` at request time
  // — the same deferred-`db` pattern the Feishu webhook handler uses.
  const slackHandler = createSlackEventsHandler({
    signingSecret: SLACK_SIGNING_SECRET,
    channel: new SlackChannel({ token: SLACK_BOT_TOKEN }),
    dispatch: (message, ctx) => createSlackInboundDispatch({ db, logger })(message, ctx),
    logger,
  });
  app.post(SLACK_EVENTS_PATH, { bodyLimit: FEISHU_WEBHOOK_MAX_BODY_BYTES }, slackHandler);
  logger.info({ path: SLACK_EVENTS_PATH }, 'Slack Events API inbound route registered');
}

app.get('/health', async () => {
  let dbStatus = 'connected';
  try {
    await db.execute(sql`SELECT 1`);
  } catch {
    dbStatus = 'disconnected';
  }

  let queueSize = 0;
  try {
    queueSize = await queue.getQueueSize();
  } catch {
    // queue may not be ready
  }

  const workerSnapshot = workerHealthMonitor?.getSnapshot() ?? { status: 'unknown' as const };
  const wsStatus = feishuWsManager.primaryWatchdog?.getStatus() ?? {
    status: 'connected' as const,
    lastActivityAt: new Date().toISOString(),
    restartCount: 0,
    currentThresholdMs: parseInt(process.env.WS_STALE_BASE_MS ?? '600000', 10),
  };
  const isDbDown = dbStatus !== 'connected';
  const isWorkerDown = workerSnapshot.status === 'down';
  const status = isDbDown || isWorkerDown ? 'degraded' : 'ok';
  return {
    status,
    instanceId: INSTANCE_ID,
    instanceRole: INSTANCE_ROLE,
    feishu: {
      access: FEISHU_ACCESS,
      websocket: FEISHU_ACCESS_DISABLED
        ? 'disabled'
        : feishuAppRuntime?.getHealthyContexts().length
          ? 'live'
          : 'unhealthy',
      apps: feishuAppRuntime?.getHealthSnapshot() ?? [],
    },
    timestamp: new Date().toISOString(),
    version: '0.1.0',
    db: dbStatus,
    port: PORT,
    queue: { size: queueSize },
    worker: workerSnapshot,
    ws: wsStatus,
  };
});

// ── Debug: simulate Feishu message (dev only) ──
app.post('/debug/register-agent-bot', async (request) => {
  const body = request.body as {
    tenantKey?: string;
    appId?: string;
    botOpenId?: string;
    botName?: string;
    handle?: string;
    displayName?: string;
  };
  const tenantKey = body.tenantKey ?? 'default';
  const botOpenId = body.botOpenId?.trim();
  const handle = body.handle?.trim();
  const displayName = body.displayName?.trim() || handle;
  if (!botOpenId || !handle || !displayName) {
    return { ok: false, error: 'botOpenId, handle and displayName are required' };
  }

  const [baseAgent] = await db
    .select({ profileId: agents.profileId })
    .from(agents)
    .where(and(eq(agents.tenantKey, tenantKey), eq(agents.status, 'active')))
    .limit(1);
  if (!baseAgent) {
    return { ok: false, error: `No active agent profile available for tenant ${tenantKey}` };
  }

  const appId = body.appId?.trim() || `debug-${handle}-${botOpenId}`;
  const [feishuApp] = await db
    .insert(feishuApps)
    .values({
      tenantKey,
      appId,
      appSecretRef: 'stored',
      appSecret: 'debug',
      botOpenId,
      botName: body.botName?.trim() || displayName,
      eventMode: 'webhook',
      status: 'enabled',
    })
    .onConflictDoUpdate({
      target: feishuApps.appId,
      set: {
        tenantKey,
        appSecretRef: 'stored',
        appSecret: 'debug',
        botOpenId,
        botName: body.botName?.trim() || displayName,
        eventMode: 'webhook',
        status: 'enabled',
        updatedAt: new Date(),
      },
    })
    .returning({ id: feishuApps.id, botOpenId: feishuApps.botOpenId });

  const [agent] = await db
    .insert(agents)
    .values({
      tenantKey,
      scopeType: 'system',
      scopeId: 'default',
      handle,
      displayName,
      description: 'Debug registered agent bot.',
      profileId: baseAgent.profileId,
      visibility: 'public',
      status: 'active',
    })
    .onConflictDoUpdate({
      // Debug agents are ops-owned (NULL platform_owner_id), so they conflict on
      // the partial `idx_agents_scope_handle` index (WHERE platform_owner_id IS
      // NULL); the ON CONFLICT predicate must match that partial index.
      target: [agents.tenantKey, agents.scopeType, agents.scopeId, agents.handle],
      targetWhere: isNull(agents.platformOwnerId),
      set: {
        displayName,
        description: 'Debug registered agent bot.',
        profileId: baseAgent.profileId,
        visibility: 'public',
        status: 'active',
        updatedAt: new Date(),
      },
    })
    .returning({ id: agents.id, handle: agents.handle, displayName: agents.displayName });

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

  const binding =
    existingBinding ??
    (
      await db
        .insert(agentBotBindings)
        .values({
          agentId: agent.id,
          feishuAppId: feishuApp.id,
          botOpenId,
          status: 'active',
        })
        .returning({ id: agentBotBindings.id })
    )[0];

  return {
    ok: true,
    agent,
    feishuApp: { id: feishuApp.id, botOpenId: feishuApp.botOpenId },
    binding,
  };
});

app.post('/debug/simulate', async (request) => {
  const body = request.body as {
    text?: string;
    chatId?: string;
    senderOpenId?: string;
    chatType?: 'p2p' | 'group';
    messageType?: string;
    imageKey?: string;
    postContent?: unknown;
    mentionBot?: boolean;
    threadId?: string;
    rootMessageId?: string;
    parentMessageId?: string;
    referenceMessageId?: string;
    quoteMessageId?: string;
    senderType?: string;
    extraMentions?: Array<{ key?: string; openId: string; name?: string }>;
    skipTaskExecution?: boolean;
    feishuAppId?: string;
    virtualAgentHandle?: string;
    expectedAgentId?: string;
    expectedAgentHandle?: string;
    tenantKey?: string;
    senderUnionId?: string;
    eventId?: string;
    messageId?: string;
    referencedMessage?: {
      messageId?: string;
      messageType?: string;
      content?: unknown;
      imageKey?: string;
      threadId?: string;
      rootMessageId?: string;
      parentMessageId?: string;
      referenceMessageId?: string;
      senderName?: string;
    };
    referencedMessages?: Array<{
      messageId: string;
      messageType?: string;
      content?: unknown;
      imageKey?: string;
      threadId?: string;
      rootMessageId?: string;
      parentMessageId?: string;
      referenceMessageId?: string;
      senderName?: string;
    }>;
  };
  const text = body.text ?? 'hello from debug';
  const chatId = body.chatId ?? 'debug_chat_001';
  const senderOpenId = body.senderOpenId ?? 'debug_user_001';
  const chatType = body.chatType === 'group' ? 'group' : 'p2p';
  const messageType = body.messageType ?? 'text';
  const tenantKey = body.tenantKey ?? 'default';
  const eventId = body.eventId ?? `debug_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const messageId = body.messageId ?? `om_debug_${Date.now()}`;
  const extraMentions = body.extraMentions ?? [];
  const eventReferenceMessageId = body.referenceMessageId ?? body.quoteMessageId;
  const singleReferencedMessageId =
    body.referencedMessage?.messageId ??
    eventReferenceMessageId ??
    body.parentMessageId ??
    (body.referencedMessage ? `om_debug_ref_${Date.now()}` : undefined);
  const eventParentMessageId =
    body.parentMessageId ??
    (body.referencedMessage && !eventReferenceMessageId ? singleReferencedMessageId : undefined);
  const extraMentionTokens =
    messageType === 'text'
      ? extraMentions.map(
          (mention, index) => mention.key ?? `@_user_${index + (body.mentionBot ? 2 : 1)}`,
        )
      : [];
  const missingExtraMentionText = extraMentionTokens
    .filter((token) => !text.includes(token))
    .join(' ');
  const mentionToken = body.mentionBot && messageType === 'text' ? '@_user_1 ' : '';
  const virtualAgentToken =
    body.virtualAgentHandle && messageType === 'text' ? `@agent:${body.virtualAgentHandle} ` : '';
  const appContext = await resolveDebugFeishuAppContext(body.feishuAppId);

  if (!appContext) {
    return { ok: false, error: `Feishu app context not found: ${body.feishuAppId}` };
  }

  if (body.referencedMessage && singleReferencedMessageId) {
    const referencedMessageType = body.referencedMessage.messageType ?? 'text';
    const referencedContent =
      body.referencedMessage.content ??
      (referencedMessageType === 'image'
        ? { image_key: body.referencedMessage.imageKey ?? 'img_debug_ref_001' }
        : { text: '' });
    recordDebugReferencedMessage({
      messageId: singleReferencedMessageId,
      messageType: referencedMessageType,
      content:
        typeof referencedContent === 'string'
          ? referencedContent
          : JSON.stringify(referencedContent),
      ...(body.referencedMessage.parentMessageId
        ? { parentMessageId: body.referencedMessage.parentMessageId }
        : {}),
      ...(body.referencedMessage.threadId ? { threadId: body.referencedMessage.threadId } : {}),
      ...(body.referencedMessage.rootMessageId
        ? { rootMessageId: body.referencedMessage.rootMessageId }
        : {}),
      ...(body.referencedMessage.referenceMessageId
        ? { referenceMessageId: body.referencedMessage.referenceMessageId }
        : {}),
      ...(body.referencedMessage.senderName
        ? { senderName: body.referencedMessage.senderName }
        : {}),
    });
  }
  for (const referencedMessage of body.referencedMessages ?? []) {
    const referencedMessageType = referencedMessage.messageType ?? 'text';
    const referencedContent =
      referencedMessage.content ??
      (referencedMessageType === 'image'
        ? { image_key: referencedMessage.imageKey ?? 'img_debug_ref_001' }
        : { text: '' });
    recordDebugReferencedMessage({
      messageId: referencedMessage.messageId,
      messageType: referencedMessageType,
      content:
        typeof referencedContent === 'string'
          ? referencedContent
          : JSON.stringify(referencedContent),
      ...(referencedMessage.parentMessageId
        ? { parentMessageId: referencedMessage.parentMessageId }
        : {}),
      ...(referencedMessage.threadId ? { threadId: referencedMessage.threadId } : {}),
      ...(referencedMessage.rootMessageId
        ? { rootMessageId: referencedMessage.rootMessageId }
        : {}),
      ...(referencedMessage.referenceMessageId
        ? { referenceMessageId: referencedMessage.referenceMessageId }
        : {}),
      ...(referencedMessage.senderName ? { senderName: referencedMessage.senderName } : {}),
    });
  }

  let messageContent: string;
  if (messageType === 'image') {
    messageContent = JSON.stringify({ image_key: body.imageKey ?? 'img_debug_001' });
  } else if (messageType === 'post' && body.postContent) {
    messageContent = JSON.stringify(body.postContent);
  } else {
    messageContent = JSON.stringify({
      text: `${mentionToken}${virtualAgentToken}${text}${missingExtraMentionText ? ` ${missingExtraMentionText}` : ''}`,
    });
  }

  const simulatedEvent = {
    schema: '2.0',
    event_id: eventId,
    token: '',
    create_time: String(Date.now()),
    event_type: 'im.message.receive_v1',
    tenant_key: tenantKey,
    app_id: appContext.appId,
    message: {
      chat_id: chatId,
      chat_type: chatType,
      content: messageContent,
      create_time: String(Date.now()),
      message_id: messageId,
      message_type: messageType,
      update_time: String(Date.now()),
      ...(body.mentionBot || extraMentions.length > 0
        ? {
            mentions: [
              ...(body.mentionBot
                ? [
                    {
                      key: '@_user_1',
                      id: { open_id: appContext.botOpenId },
                      name: appContext.botName ?? 'OpenClaudeTag',
                      tenant_key: tenantKey,
                    },
                  ]
                : []),
              ...extraMentions.map((mention, index) => ({
                key: mention.key ?? `@_user_${index + (body.mentionBot ? 2 : 1)}`,
                id: { open_id: mention.openId },
                name: mention.name ?? mention.openId,
                tenant_key: tenantKey,
              })),
            ],
          }
        : {}),
      ...(body.threadId ? { thread_id: body.threadId } : {}),
      ...(body.rootMessageId ? { root_id: body.rootMessageId } : {}),
      ...(eventParentMessageId ? { parent_id: eventParentMessageId } : {}),
      ...(body.referenceMessageId ? { reference_message_id: body.referenceMessageId } : {}),
      ...(body.quoteMessageId ? { quote_message_id: body.quoteMessageId } : {}),
      ...(body.skipTaskExecution
        ? {
            __openClaudeTagDebug: {
              skipTaskExecution: true,
            },
          }
        : {}),
    },
    sender: {
      sender_id: { open_id: senderOpenId, union_id: body.senderUnionId ?? '', user_id: '' },
      sender_type: body.senderType ?? 'user',
      tenant_key: tenantKey,
    },
  };

  try {
    const processed = await processEvent(simulatedEvent, appContext);
    if (!processed) {
      return { ok: false, error: 'event processing failed' };
    }
    const [messageRow] = await db
      .select({
        sessionId: messages.sessionId,
        agentId: messages.agentId,
        feishuAppId: messages.feishuAppId,
      })
      .from(messages)
      .where(eq(messages.feishuMessageId, messageId))
      .limit(1);
    const [taskRow] = messageRow
      ? await db
          .select({
            id: tasks.id,
            agentId: tasks.agentId,
            feishuAppId: tasks.feishuAppId,
          })
          .from(tasks)
          .where(eq(tasks.sessionId, messageRow.sessionId))
          .orderBy(desc(tasks.createdAt))
          .limit(1)
      : [];
    const actualAgentId = taskRow?.agentId ?? messageRow?.agentId;
    const actualFeishuAppId = taskRow?.feishuAppId ?? messageRow?.feishuAppId;
    const [actualAgent] = actualAgentId
      ? await db
          .select({ handle: agents.handle, displayName: agents.displayName })
          .from(agents)
          .where(eq(agents.id, actualAgentId))
          .limit(1)
      : [];

    if (body.expectedAgentId && actualAgentId !== body.expectedAgentId) {
      return {
        ok: false,
        eventId,
        messageId,
        error: `Expected agentId ${body.expectedAgentId}, got ${actualAgentId ?? 'none'}`,
      };
    }
    if (body.expectedAgentHandle && actualAgent?.handle !== body.expectedAgentHandle) {
      return {
        ok: false,
        eventId,
        messageId,
        error: `Expected agent handle ${body.expectedAgentHandle}, got ${actualAgent?.handle ?? 'none'}`,
      };
    }

    return {
      ok: true,
      eventId,
      messageId,
      feishuAppId: actualFeishuAppId,
      agent: actualAgentId
        ? {
            id: actualAgentId,
            handle: actualAgent?.handle,
            displayName: actualAgent?.displayName,
          }
        : null,
      taskId: taskRow?.id,
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message, stack: (err as Error).stack };
  }
});

app.post('/debug/latest-task', async (request) => {
  const body = request.body as { chatId?: string; goal?: string };
  const chatId = body.chatId ?? 'debug_chat_001';

  if (body.goal) {
    const [taskRow] = await db
      .select({
        id: tasks.id,
        sessionId: tasks.sessionId,
        parentTaskId: tasks.parentTaskId,
        agentId: tasks.agentId,
        feishuAppId: tasks.feishuAppId,
        taskType: tasks.taskType,
        goal: tasks.goal,
        status: tasks.status,
        runtimeHint: tasks.runtimeHint,
        feedbackState: tasks.feedbackState,
        feedbackMessageId: tasks.feedbackMessageId,
        createdAt: tasks.createdAt,
      })
      .from(tasks)
      .where(eq(tasks.goal, body.goal))
      .orderBy(desc(tasks.createdAt))
      .limit(1);

    return { ok: true, task: taskRow ?? null };
  }

  const [sessionRow] = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.chatId, chatId))
    .orderBy(desc(sessions.updatedAt))
    .limit(1);

  if (!sessionRow) {
    return { ok: true, task: null };
  }

  const [taskRow] = await db
    .select({
      id: tasks.id,
      sessionId: tasks.sessionId,
      parentTaskId: tasks.parentTaskId,
      agentId: tasks.agentId,
      feishuAppId: tasks.feishuAppId,
      taskType: tasks.taskType,
      goal: tasks.goal,
      status: tasks.status,
      runtimeHint: tasks.runtimeHint,
      feedbackState: tasks.feedbackState,
      feedbackMessageId: tasks.feedbackMessageId,
      createdAt: tasks.createdAt,
    })
    .from(tasks)
    .where(eq(tasks.sessionId, sessionRow.id))
    .orderBy(desc(tasks.createdAt))
    .limit(1);

  return { ok: true, task: taskRow ?? null };
});

app.post('/debug/session-tasks', async (request) => {
  const body = request.body as { chatId?: string; messageId?: string };
  const chatId = body.chatId ?? 'debug_chat_001';

  const [sessionRow] = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.chatId, chatId))
    .orderBy(desc(sessions.updatedAt))
    .limit(1);

  if (!sessionRow) {
    return { ok: true, sessionId: null, tasks: [] };
  }

  const taskRows = await db
    .select({
      id: tasks.id,
      sessionId: tasks.sessionId,
      agentId: tasks.agentId,
      feishuAppId: tasks.feishuAppId,
      taskType: tasks.taskType,
      goal: tasks.goal,
      status: tasks.status,
      runtimeHint: tasks.runtimeHint,
      constraints: tasks.constraints,
      createdAt: tasks.createdAt,
    })
    .from(tasks)
    .where(eq(tasks.sessionId, sessionRow.id))
    .orderBy(desc(tasks.createdAt));

  const filteredRows = body.messageId
    ? taskRows.filter((task) => {
        const constraints = isObjectRecord(task.constraints) ? task.constraints : {};
        return constraints.userMessageId === body.messageId;
      })
    : taskRows;

  return {
    ok: true,
    sessionId: sessionRow.id,
    tasks: filteredRows.map((task) => {
      const constraints = isObjectRecord(task.constraints) ? task.constraints : {};
      return {
        id: task.id,
        sessionId: task.sessionId,
        agentId: task.agentId,
        feishuAppId: task.feishuAppId,
        taskType: task.taskType,
        goal: task.goal,
        status: task.status,
        runtimeHint: task.runtimeHint,
        constraints,
        userMessageId:
          typeof constraints.userMessageId === 'string' ? constraints.userMessageId : null,
        createdAt: task.createdAt,
      };
    }),
  };
});

app.post('/debug/latest-discussion', async (request) => {
  const body = request.body as { chatId?: string; rootThreadId?: string };
  const chatId = body.chatId ?? 'debug_chat_001';
  const [discussion] = await db
    .select({
      id: discussions.id,
      sessionId: discussions.sessionId,
      topic: discussions.topic,
      status: discussions.status,
      roundLimit: discussions.roundLimit,
      currentRound: discussions.currentRound,
      currentTurnIndex: discussions.currentTurnIndex,
      rootThreadId: discussions.rootThreadId,
      createdAt: discussions.createdAt,
    })
    .from(discussions)
    .where(
      body.rootThreadId
        ? and(eq(discussions.chatId, chatId), eq(discussions.rootThreadId, body.rootThreadId))
        : eq(discussions.chatId, chatId),
    )
    .orderBy(desc(discussions.createdAt))
    .limit(1);

  if (!discussion) {
    return { ok: true, discussion: null, participants: [], tasks: [] };
  }

  const participantRows = await db
    .select({
      id: discussionParticipants.id,
      agentId: discussionParticipants.agentId,
      feishuAppId: discussionParticipants.feishuAppId,
      botOpenId: discussionParticipants.botOpenId,
      role: discussionParticipants.role,
      orderIndex: discussionParticipants.orderIndex,
      handle: agents.handle,
      displayName: agents.displayName,
    })
    .from(discussionParticipants)
    .innerJoin(agents, eq(agents.id, discussionParticipants.agentId))
    .where(eq(discussionParticipants.discussionId, discussion.id))
    .orderBy(discussionParticipants.orderIndex);

  const taskRows = await db
    .select({
      id: tasks.id,
      agentId: tasks.agentId,
      feishuAppId: tasks.feishuAppId,
      status: tasks.status,
      constraints: tasks.constraints,
    })
    .from(tasks)
    .where(
      and(
        eq(tasks.sessionId, discussion.sessionId),
        sql`${tasks.constraints}->>'discussionId' = ${discussion.id}`,
      ),
    )
    .orderBy(tasks.createdAt);

  return { ok: true, discussion, participants: participantRows, tasks: taskRows };
});

app.post('/debug/task-status', async (request) => {
  const body = request.body as {
    taskId?: string;
    status?: string;
    result?: unknown;
    workspacePath?: string;
  };

  if (!body.taskId) {
    return { ok: false, error: 'taskId is required' };
  }

  if (body.status !== TaskStatus.COMPLETED && body.status !== TaskStatus.FAILED) {
    return { ok: false, error: 'status must be completed or failed' };
  }

  await db
    .update(tasks)
    .set({
      status: body.status,
      ...(body.result !== undefined ? { result: body.result } : {}),
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, body.taskId));

  if (body.workspacePath) {
    await db.insert(taskRuns).values({
      taskId: body.taskId,
      runtimeBackend: 'debug',
      workspacePath: body.workspacePath,
      status: body.status === TaskStatus.COMPLETED ? 'completed' : 'failed',
      exitCode: body.status === TaskStatus.COMPLETED ? 0 : 1,
      completedAt: new Date(),
      lastHeartbeatAt: new Date(),
    });
  }

  return { ok: true, taskId: body.taskId, status: body.status };
});

app.post('/debug/task-link', async (request) => {
  const body = request.body as { taskId?: string };
  if (!body.taskId) {
    return { ok: false, error: 'taskId is required' };
  }

  const [link] = await db
    .select({
      taskId: feishuTaskLinks.taskId,
      feishuTaskGuid: feishuTaskLinks.feishuTaskGuid,
      feishuTaskUrl: feishuTaskLinks.feishuTaskUrl,
      sourceMessageId: feishuTaskLinks.sourceMessageId,
      sourceTopicKey: feishuTaskLinks.sourceTopicKey,
      sourceTopicUrl: feishuTaskLinks.sourceTopicUrl,
      lastSyncedStatus: feishuTaskLinks.lastSyncedStatus,
      lastSyncError: feishuTaskLinks.lastSyncError,
    })
    .from(feishuTaskLinks)
    .where(eq(feishuTaskLinks.taskId, body.taskId))
    .limit(1);

  return { ok: true, link: link ?? null };
});

app.post('/debug/task-tracking-space', async (request) => {
  const body = request.body as { scopeType?: string; scopeId?: string };
  const scopeType = body.scopeType ?? 'global';
  const scopeId = body.scopeId ?? 'default';

  const [space] = await db
    .select({
      id: feishuTaskTrackingSpaces.id,
      scopeType: feishuTaskTrackingSpaces.scopeType,
      scopeId: feishuTaskTrackingSpaces.scopeId,
      tasklistGuid: feishuTaskTrackingSpaces.tasklistGuid,
      statusFieldGuid: feishuTaskTrackingSpaces.statusFieldGuid,
      statusOptions: feishuTaskTrackingSpaces.statusOptions,
      sections: feishuTaskTrackingSpaces.sections,
      updatedAt: feishuTaskTrackingSpaces.updatedAt,
    })
    .from(feishuTaskTrackingSpaces)
    .where(
      and(
        eq(feishuTaskTrackingSpaces.scopeType, scopeType),
        eq(feishuTaskTrackingSpaces.scopeId, scopeId),
      ),
    )
    .limit(1);

  return { ok: true, space: space ?? null };
});

app.post('/debug/delete-task-tracking-space', async (request) => {
  const body = request.body as { scopeType?: string; scopeId?: string };
  const scopeType = body.scopeType ?? 'global';
  const scopeId = body.scopeId ?? 'default';

  const deleted = await db
    .delete(feishuTaskTrackingSpaces)
    .where(
      and(
        eq(feishuTaskTrackingSpaces.scopeType, scopeType),
        eq(feishuTaskTrackingSpaces.scopeId, scopeId),
      ),
    )
    .returning({ id: feishuTaskTrackingSpaces.id });

  return { ok: true, deletedCount: deleted.length };
});

app.post('/debug/task-feedback', async (request) => {
  const body = request.body as {
    taskId?: string;
    status?: 'completed' | 'failed';
    resultText?: string;
    errorText?: string;
  };

  if (!body.taskId) {
    return { ok: false, error: 'taskId is required' };
  }

  if (body.status !== TaskStatus.COMPLETED && body.status !== TaskStatus.FAILED) {
    return { ok: false, error: 'status must be completed or failed' };
  }

  const [taskRow] = await db
    .select({
      id: tasks.id,
      sessionId: tasks.sessionId,
      goal: tasks.goal,
      feedbackMessageId: tasks.feedbackMessageId,
      constraints: tasks.constraints,
    })
    .from(tasks)
    .where(eq(tasks.id, body.taskId))
    .limit(1);

  if (!taskRow) {
    return { ok: false, error: 'task not found' };
  }

  const constraints = isObjectRecord(taskRow.constraints) ? taskRow.constraints : {};
  const tenantKey = typeof constraints.tenantKey === 'string' ? constraints.tenantKey : undefined;
  let chatId = typeof constraints.chatId === 'string' ? constraints.chatId : '';
  const replyToMessageId =
    typeof constraints.replyToMessageId === 'string' ? constraints.replyToMessageId : undefined;

  if (!chatId) {
    const [sessionRow] = await db
      .select({ chatId: sessions.chatId })
      .from(sessions)
      .where(eq(sessions.id, taskRow.sessionId))
      .limit(1);
    chatId = sessionRow?.chatId ?? '';
  }

  if (!chatId) {
    return { ok: false, error: 'task chatId is missing' };
  }

  if (!taskRow.feedbackMessageId) {
    return { ok: false, error: 'task feedbackMessageId is missing' };
  }

  const feedback = new ThreePhaseFeedback(
    createFeishuChannelSender(feishuClient),
    chatId,
    replyToMessageId,
    taskRow.feedbackMessageId,
  );
  const replyTarget = replyToMessageId ?? taskRow.feedbackMessageId;

  let sentMessageIds: string[] = [];
  let completionMessageId: string | undefined;
  if (body.status === TaskStatus.COMPLETED) {
    const doneResult = await feedback.updateDone(taskRow.goal, body.resultText);
    sentMessageIds = doneResult?.sentMessageIds ?? [];
    completionMessageId = doneResult?.completionMessageId;
  } else {
    await feedback.updateFailed(taskRow.goal, body.errorText ?? 'debug failure');
  }

  if (tenantKey && sentMessageIds.length > 0) {
    try {
      await aliasThreadKeysForSession(db, taskRow.sessionId, sentMessageIds, tenantKey, chatId);
    } catch (err) {
      logger.warn(
        { err, taskId: body.taskId, sessionId: taskRow.sessionId, sentMessageIds },
        'Failed to alias debug feedback message ids to session',
      );
    }
  }

  await db
    .update(tasks)
    .set({
      status: body.status,
      feedbackState: body.status === TaskStatus.COMPLETED ? 'completed' : 'failed',
      feedbackUpdatedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, body.taskId));

  return {
    ok: true,
    taskId: body.taskId,
    status: body.status,
    replyTarget,
    completionMessageId,
    sentMessageIds,
  };
});

app.post('/debug/simulate-card-action', async (request) => {
  const body = request.body as {
    taskId?: string;
    action?: string;
    runtime?: string;
    openMessageId?: string;
    openChatId?: string;
    openId?: string;
    tenantKey?: string;
    token?: string;
  };

  if (!taskCardActionHandler) {
    return { ok: false, error: 'taskCardActionHandler not initialized' };
  }

  if (!body.taskId) {
    return { ok: false, error: 'taskId is required' };
  }

  const action = body.action ?? 'task_retry';

  try {
    const response = await taskCardActionHandler({
      open_message_id: body.openMessageId ?? `om_debug_card_${Date.now()}`,
      ...(body.openChatId ? { context: { open_chat_id: body.openChatId } } : {}),
      tenant_key: body.tenantKey ?? 'default',
      open_id: body.openId ?? 'debug_user_001',
      token: body.token ?? '',
      action: {
        tag: 'button',
        value: {
          action,
          task_id: body.taskId,
          ...(body.runtime ? { runtime: body.runtime } : {}),
        },
      },
    });

    return { ok: true, response };
  } catch (err) {
    return { ok: false, error: (err as Error).message, stack: (err as Error).stack };
  }
});

app.get('/debug/sent-messages', async (request) => {
  const query = request.query as {
    chatId?: string;
    receiveIdType?: 'chat_id' | 'open_id';
    receiveId?: string;
    msgType?: string;
    limit?: string;
  };
  let messages = listDebugSentMessages();

  if (query.chatId) {
    messages = messages.filter(
      (message) => message.receiveIdType === 'chat_id' && message.receiveId === query.chatId,
    );
  }
  if (query.receiveIdType) {
    messages = messages.filter((message) => message.receiveIdType === query.receiveIdType);
  }
  if (query.receiveId) {
    messages = messages.filter((message) => message.receiveId === query.receiveId);
  }
  if (query.msgType) {
    messages = messages.filter((message) => message.msgType === query.msgType);
  }

  const limit = query.limit ? Math.max(parseInt(query.limit, 10), 1) : 20;
  return {
    ok: true,
    messages: messages.slice(-limit).reverse(),
  };
});

app.get('/api/audit', async (request) => {
  const query = request.query as Record<string, string>;
  return auditService.query({
    actorId: query.actorId,
    action: query.action,
    targetType: query.targetType,
    targetId: query.targetId,
    severity: query.severity as any,
    limit: query.limit ? parseInt(query.limit, 10) : undefined,
    offset: query.offset ? parseInt(query.offset, 10) : undefined,
  });
});

function checkDefaultWorkdirEnv(): void {
  const raw = process.env.OPEN_TAG_DEFAULT_WORKDIR?.trim();
  if (!raw) return;
  if (!isAbsolute(raw)) {
    logger.warn(
      { defaultWorkDir: raw },
      'OPEN_TAG_DEFAULT_WORKDIR is not an absolute path and will be ignored',
    );
    return;
  }
  let exists: boolean;
  try {
    exists = existsSync(raw) && statSync(raw).isDirectory();
  } catch {
    exists = false;
  }
  if (exists) {
    logger.info(
      { defaultWorkDir: raw },
      'OPEN_TAG_DEFAULT_WORKDIR will seed adhocWorkDir on new sessions',
    );
  } else {
    logger.warn(
      { defaultWorkDir: raw },
      'OPEN_TAG_DEFAULT_WORKDIR is set but the directory does not exist; tasks may fail when sessions try to use it',
    );
  }
}

// ── Startup ──
async function start(): Promise<void> {
  logger.info('API server starting...');
  registerManagedService('api');

  // 1. Database
  db = createDb(DATABASE_URL);
  logger.info('Database connected');

  feishuTrackingLlmClient = createLlmClientFromEnv();
  if (feishuTrackingLlmClient) {
    logger.info(
      { provider: feishuTrackingLlmClient.provider() },
      'LLM client configured for Feishu Task tracking intent',
    );
  } else {
    logger.info(
      'No LLM client configured for Feishu Task tracking intent; keyword fallback will be used',
    );
  }

  checkDefaultWorkdirEnv();
  registerAdminApiRoutes(app, {
    db,
    adminToken: process.env.OPEN_TAG_ADMIN_TOKEN,
    // Local dev-auth login mode (design D-A6). Secure by default OFF; enable with
    // OPEN_TAG_DEV_AUTH=enabled to obtain a real (non-superadmin) platform-user
    // identity — required to mint owner-scoped machine pairing tokens, which the
    // break-glass token/loopback superadmin cannot do. When off, the dev-auth
    // endpoints 404 and the cc_dev_user cookie is never honored.
    devAuthEnabled: process.env.OPEN_TAG_DEV_AUTH === 'enabled',
    // Daemon install-guide config for the Machines page. `SERVER_PUBLIC_URL` is
    // the worker daemon gateway URL a user's daemon dials; the daemon version is
    // read from apps/daemon/package.json so the guide can pin a concrete version.
    // `DAEMON_ARTIFACT_PATH` (read inside admin-api) points at the packed tarball
    // streamed by GET /admin/daemon/artifact.
    serverPublicUrl: process.env.SERVER_PUBLIC_URL ?? null,
    daemonVersion: readDaemonVersion(),
    // Mac app artifacts streamed by GET /admin/desktop/artifact; per-arch paths
    // point at DMGs placed on the host (post-merge ops step, see server-mode.md).
    desktopArtifactPathArm64: process.env.DESKTOP_ARTIFACT_PATH_ARM64 ?? null,
    desktopArtifactPathX64: process.env.DESKTOP_ARTIFACT_PATH_X64 ?? null,
    desktopVersion: readDesktopVersion(),
    resolveFeishuChatDisplayName: resolveAdminConsoleChatDisplayName,
    feishuTaskTrackingEnabled: createFeishuTaskTrackingConfigFromEnv().enabled,
    afterFeishuRuntimeChange: reloadFeishuRuntimeFromAdmin,
  });

  // 2. Feishu app runtime and primary REST client
  feishuAppRuntime = new MultiFeishuAppRuntime({
    db,
    disabled: FEISHU_ACCESS_DISABLED,
    primaryAppId: FEISHU_APP_ID,
    primaryAppSecret: FEISHU_APP_SECRET,
    primaryEventMode: FEISHU_EVENT_MODE,
    disabledBotOpenId: DISABLED_FEISHU_BOT_OPEN_ID,
    createLoopbackClient: () =>
      createLoopbackFeishuClient(recordDebugSentMessage, lookupDebugReferencedMessage),
    // Outbound recording stays on; the recorded buffer is only readable through
    // /debug/sent-messages, which the onRequest gate locks to isolated / true
    // (XFF-aware) loopback / explicit flag.
    applyClientDebugOverrides: (client) =>
      applyDebugFeishuOverrides(client, recordDebugSentMessage, lookupDebugReferencedMessage),
    logger,
  });
  const primaryFeishuApp = await feishuAppRuntime.initialize();
  feishuClient = primaryFeishuApp.client;
  botOpenId = primaryFeishuApp.botOpenId;
  logger.info(
    {
      appId: primaryFeishuApp.appId,
      botOpenId,
      status: primaryFeishuApp.status,
      instanceId: INSTANCE_ID,
      instanceRole: INSTANCE_ROLE,
    },
    'Primary Feishu app context initialized',
  );

  configureFeishuTaskLifecycle();
  logger.info(
    { enabled: createFeishuTaskTrackingConfigFromEnv().enabled },
    'Feishu Task tracking lifecycle observer configured',
  );

  // 3. Task queue
  queue = new TaskQueue(DATABASE_URL);
  await queue.start();
  logger.info('Task queue started');

  // 4. Services
  memoryHandler = new MemoryHandler(db);
  auditService = new AuditService(db);

  // 4a. Review request polling service — monitors sessions with open PRs/MRs for new comments
  prPollingService = new PrPollingService(db, queue);
  app.addHook('onClose', async () => {
    prPollingService.stop();
    worktreeRetentionCleanupService?.stop();
  });

  if (shouldRunWorktreeRetentionCleanup({ instanceRole: INSTANCE_ROLE, processType: 'api' })) {
    worktreeRetentionCleanupService = new WorktreeRetentionCleanupService(db, OPEN_TAG_REPO_ROOT);
  } else {
    logger.info(
      { instanceId: INSTANCE_ID, instanceRole: INSTANCE_ROLE },
      'Worktree retention cleanup service disabled for this API instance',
    );
  }

  configureTaskCardActionHandler();
  await subscribeDocumentCommentEventsForHealthyApps();
  // 6. Setup official Feishu SDK WSClient with EventDispatcher
  feishuWsManager.startAll();

  // 8. Start HTTP server
  await app.listen({ host: HOST, port: PORT });
  logger.info(`API server listening on ${HOST}:${PORT}`);

  // 8b. Start review request polling (after HTTP server is up so onClose hook is active)
  await prPollingService.start();
  worktreeRetentionCleanupService?.start();

  // 9. Start worker health monitor
  workerHealthMonitor = new WorkerHealthMonitor({
    feishuClient: FEISHU_ACCESS_DISABLED ? undefined : feishuClient,
    instanceId: INSTANCE_ID,
    repoRoot: OPEN_TAG_REPO_ROOT,
    autoRestart: process.env.WORKER_AUTO_RESTART === 'true',
  });
  workerHealthMonitor.start();
}

async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info({ signal }, 'Received shutdown signal, stopping API server...');
  feishuWsManager.stopAll();
  workerHealthMonitor?.stop();

  try {
    await app.close();
  } catch (err) {
    logger.warn({ err, signal }, 'API close encountered an error during shutdown');
  } finally {
    unregisterManagedService('api');
  }

  process.exit(0);
}

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});
process.on('SIGINT', () => {
  void shutdown('SIGINT');
});
process.on('exit', () => {
  unregisterManagedService('api');
});
installFatalProcessHandlers({
  logger,
  cleanup: () => {
    feishuWsManager.stopAll();
    workerHealthMonitor?.stop();
    unregisterManagedService('api');
  },
});

start().catch((err) => {
  unregisterManagedService('api');
  logger.error(err, 'API server failed to start');
  process.exit(1);
});

export { app };
