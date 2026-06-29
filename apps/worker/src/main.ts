import { createLogger, installFatalProcessHandlers } from '@open-tag/observability';
import {
  createDb,
  tasks,
  taskRuns,
  taskRunEvents,
  artifacts as artifactsTable,
  sessions,
  projects,
  messages,
  agents,
  agentProfiles,
  agentBotBindings,
  feishuApps,
  loadAgentSessionState,
  loadChatDefaultWorkDir,
  resolveActiveAgentByHandle,
  completeAgentDelegationForChildTask,
  evaluateDelegationBarrierForChildTask,
  failAgentDelegationForChildTask,
  findDiscussionById,
  listReadyDelegationBarriers,
  listDiscussionParticipants,
  loadDiscussionTranscript,
  completeDiscussionTaskTurnAndAdvance,
  markDiscussionTurnFeishuRendered,
  reconcileTerminalChildDelegationEdges,
  upsertAdmissionLease,
  deleteAdmissionLease,
  listDueAdmissionLeases,
  markAdmissionLeaseRescheduled,
  listWaitingContractsByMessage,
  listStaleWaitingContracts,
  transitionWaitingContract,
  revertWaitingContractClaim,
  bindWaitingContractsToPrimaryTask,
  listDueChatMemoryConfigs,
  markChatMemorySummaryEnqueued,
  markChatMemorySummaryResult,
  commitChatMemoryUpdate,
} from '@open-tag/storage';
import type { Database, DueChatMemoryConfig } from '@open-tag/storage';
import { auditEvents } from '@open-tag/storage';
import type { IdentityAgentSource } from '@open-tag/registry';
import { AuditSeverity, TaskStatus } from '@open-tag/core-types';
import type { RuntimeEvent, TaskResult, TaskSpec } from '@open-tag/core-types';
import { TaskQueue } from '@open-tag/queue';
import type { TaskJobData } from '@open-tag/queue';
import {
  AgentAdmissionScheduler,
  parseSchedulerConfigFromEnv,
  type AdmissionHandle,
} from '@open-tag/scheduler';
import {
  TaskLifecycleService,
  createDelegatedTask,
  extractPromptMetadata,
  resolveWorkDir,
  classifyWriteIntent,
} from '@open-tag/orchestrator';
import {
  aliasThreadKeysForSession,
  estimateTokens,
  selectContextStrategy,
} from '@open-tag/session';
import {
  discardAgentTaskMemory,
  finalizeAgentTaskMemory,
  prepareAgentTaskMemory,
  sweepAgentMemoryRuns,
} from '@open-tag/memory';
import { recordTurnGistBestEffort } from './shared-context-writeback.js';
import { recordTaskUsageBestEffort, type TaskUsageMetrics } from './usage-recording.js';
import { resolveTaskCredentialEnv } from './task-credential-injection.js';
import {
  BUDGET_ADMISSION_BLOCKED_AUDIT_ACTION,
  BudgetExceededError,
  enforceTaskAdmissionBudget,
} from './budget-admission.js';
import { join as joinPath } from 'path';
import { randomUUID } from 'node:crypto';
import { buildContextualExecutionContext, buildContextualGoal } from './context-builders.js';
import { RemoteExecutionTracker } from './remote-execution-tracker.js';
import {
  FeishuClient,
  ThreePhaseFeedback,
  buildWorkDirConfirmCard,
  DrizzleFeishuTaskTrackingRepository,
  FeishuTaskSyncService,
  createFeishuTaskTrackingConfigFromEnv,
  normalizeInteractionReason,
} from '@open-tag/feishu-adapter';
import { createLlmClientFromEnv } from '@open-tag/llm-client';
import type { LlmClient } from '@open-tag/llm-client';
import {
  RuntimeManager,
  buildRuntimeManager,
  claudeRuntimeRegistration,
  CodexAdapter,
  createWorkspace,
  ensureConversationWorkspace,
  openClaudeTagHome,
  ensureAgentHomeDir,
  collectArtifactsFromDir,
  createWorktree,
  getWorktree,
  bootstrapWorktree,
  resolveExternalProjectWorkspace,
  getSelfDevSystemPrompt,
  EXTERNAL_DEV_SYSTEM_PROMPT,
  READONLY_SYSTEM_PROMPT,
  loadSoul,
} from '@open-tag/runtime-adapters';
import type { RuntimeAdapter } from '@open-tag/runtime-adapters';
import { eq, and, desc, ne } from 'drizzle-orm';
import { clearWorkerSdkSessionState, persistWorkerRuntimeState } from './session-persistence.js';
import { registerWorkerProcess, unregisterWorkerProcess } from './process-registration.js';
import { recoverStaleRunningTasks } from './startup-recovery.js';
import { shouldSkipTaskExecution, shouldSuppressLoopbackFeishuFeedback } from './debug-task-control.js';
import { prepareResumeImagePaths } from './runtime-image-prepare.js';
import {
  appendReplyLanguageGuidance,
  extractReplyLanguageFromConstraints,
} from './reply-language-guidance.js';
import {
  appendFeishuRuntimeContextGuidance,
  extractRuntimeFinalReply,
  getFeishuRuntimeContextFromConstraints,
} from './feishu-runtime-context.js';
import { refreshTaskSessionCanonicalId } from './task-session-canonicalization.js';
import {
  selectAssistantHistoryContent,
  selectUserFacingResponseContent,
  truncateAssistantHistoryContent,
} from './assistant-response-content.js';
import { buildTaskRunEventInsert } from './task-run-event-persistence.js';
import { appendRunningActivity, shouldFlushRunningCardUpdate } from './running-activity.js';
import { toRunningCardUpdate, type RunningCardSource } from './runtime-event-routing.js';
import {
  decidePromptMetadataConfirmation,
  decideStickyAdhocWorkDirFallback,
  isExplicitRuntimeSource,
  maybeExtractPromptMetadata,
  resolveTaskRuntime,
  resolveTaskRuntimeWithSource,
} from './prompt-metadata.js';
import { selectLocalRuntimeAdapter, type RuntimeFallbackRecord } from './runtime-selection.js';
import { decideWorkspaceMode } from './workspace-mode.js';
import { resolveTaskWorkDir, readDefaultWorkDirEnv } from './agent-workdir.js';
import { resolveCodexBinaryPath } from './codex-binary.js';
import {
  buildAgentIdentityPrompt,
  buildAgentSystemPrompt,
  buildWorkerWorkspaceKey,
  deriveConversationThreadId,
  mergeAgentProfileSystemPrompt,
  normalizeRuntimeEnv,
  resolveEffectiveRuntimeState,
  resolveTaskAgentIdentity,
  resolveTaskFeishuClient,
  shouldClearSdkSessionForRuntimeSwitch,
} from './agent-runtime.js';
import {
  createWorkerFeishuClientRegistry,
  type WorkerFeishuClientRegistry,
} from './feishu-client-registry.js';
import {
  createWorkerSlackClientRegistry,
  type WorkerSlackClientRegistry,
} from './slack-client-registry.js';
import {
  buildTaskConversationRef,
  createLarkChannelSender,
  reconstructAckDeliveryRef,
  removeAckReactionViaChannel,
  resolveTaskChannelSender,
  updateRunningFeedbackCard,
  NeutralChannelFeedback,
  type ChannelSender,
  type TaskFeedback,
} from './channel-sender.js';
import { ChecklistFeedback } from './checklist-feedback.js';
import { runAdmissionReschedulerOnce as runAdmissionRescheduler } from './admission-rescheduler.js';
import { runDelegationBarrierReconcilerOnce as runDelegationBarrierReconciler } from './delegation-barrier-reconciler.js';
import { runWaitingContractReconcilerOnce } from './waiting-contract-reconciler.js';
import {
  CHAT_MEMORY_SUMMARY_TASK_TYPE,
  buildChatMemorySummaryGoal,
  handleChatMemorySummaryCompletion,
  handleChatMemorySummaryFailure,
  runChatMemorySummarySchedulerOnce,
} from './chat-memory-summary.js';
import { createAdmissionSlotReleaser } from './admission-slot-release.js';
import {
  resolveRuntimeCancellationSource,
  type RuntimeCancellationSource,
  runtimeOutcomeToTaskRunStatus,
  shouldFallbackToFreshExecutionAfterResume,
} from './resume-fallback.js';
import { RuntimeWatchdog } from './runtime-watchdog.js';
import { RuntimeSettlementFence, RuntimeWatchdogSettledError } from './runtime-settlement-fence.js';
import { deliverDelegationBarrierWake } from './delegation-barrier-wake.js';
import { deliverDiscussionTurnAdvance } from './discussion-turn-orchestration.js';
import {
  DiscussionTurnRenderError,
  renderDiscussionTurnsThrough,
} from './discussion-turn-renderer.js';
import {
  appendHandoffToolGuidance,
  deliverWaitingContractWakes,
  type HandoffCandidate,
} from './handoff-delivery.js';
import {
  appendReviewContextGuidance,
  getReviewContext,
  getReviewContextWorkDir,
  getReviewContextWorktreeAccessMode,
} from './review-context.js';
import { getEffectiveTaskConstraints } from './task-constraints.js';
import {
  rethrowDiscussionTerminalCommitError,
  transitionTaskOrDeliverDiscussionTurn as transitionTaskOrDeliverDiscussionTurnWithDeps,
} from './task-terminal-transition.js';
import { completeSuccessfulTaskAfterHandoffs } from './task-successful-completion.js';
import { skipInactiveDiscussionTurnIfNeeded } from './discussion-turn-guard.js';
import {
  buildDocumentCommentFailureReply,
  deliverDocumentCommentTaskReply,
} from './document-comment-delivery.js';
import { DaemonGateway } from './daemon-gateway/index.js';
import {
  resolveMachineForTask,
  decideMachineDispatch,
  loadStoredSdkSessionMachineId,
  isMachineSwitch,
  buildRemoteAdapter,
  machineSupportsAgentHome,
  remoteAgentHomeDisplayPath,
} from './remote-dispatch.js';
import { RemoteDispatchError } from './remote-runtime-adapter.js';
import type { MachineRow } from './machine-routing.js';

const logger = createLogger('worker');

function isQuotaExceededError(message: string): boolean {
  return /usage.?limit/i.test(message) || /quota.?exceeded/i.test(message);
}

/**
 * Append the executing machine footer (`🖥 <name>`) to a remote task's card body.
 * Returns the text unchanged when the task ran server-local (no machine).
 */
function withMachineFooter(
  text: string | undefined,
  machine: MachineRow | null,
): string | undefined {
  if (!machine) return text;
  const footer = `🖥 ${machine.name}`;
  return text && text.trim() ? `${text}\n\n${footer}` : footer;
}

async function deliverDocumentCommentTaskFailure(input: {
  taskId: string;
  feishuAppId: string | null;
  client: FeishuClient | null;
  constraints: Record<string, unknown>;
  failureBody: string;
}): Promise<void> {
  const delivery = await deliverDocumentCommentTaskReply({
    client: input.client,
    constraints: input.constraints,
    content: buildDocumentCommentFailureReply(input.failureBody),
  });

  if (delivery.status === 'delivered') {
    logger.info(
      {
        taskId: input.taskId,
        commentId: delivery.target?.commentId,
        replyId: delivery.replyId,
      },
      'Delivered document comment task failure reply',
    );
  } else if (delivery.status === 'delivered_fallback') {
    logger.info(
      {
        taskId: input.taskId,
        commentId: delivery.target?.commentId,
        fallbackCommentId: delivery.fallbackCommentId,
        fallbackReplyId: delivery.fallbackReplyId,
        originalError: delivery.error,
      },
      'Delivered document comment task failure reply via fallback comment',
    );
  } else if (delivery.status === 'failed') {
    logger.warn(
      {
        taskId: input.taskId,
        commentId: delivery.target?.commentId,
        err: delivery.error,
      },
      'Failed to deliver document comment task failure reply',
    );
  } else if (delivery.status === 'missing_client') {
    logger.warn(
      { taskId: input.taskId, feishuAppId: input.feishuAppId },
      'Missing Feishu client for document comment failure reply',
    );
  } else if (input.constraints.feedbackChannel === 'document_comment') {
    logger.warn(
      { taskId: input.taskId },
      'Document comment feedback channel missing delivery target',
    );
  }
}

// ── Environment ──
const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://open-claude-tag:open-claude-tag@localhost:5432/open-claude-tag';
const FEISHU_APP_ID = process.env.FEISHU_APP_ID ?? '';
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET ?? '';
// Optional Slack bot token for delivering a Slack-dispatched task's terminal
// feedback to its own channel. Mirrors how the API builds its Slack sender
// (apps/api/src/server.ts); absent ⇒ Slack tasks complete but skip delivery.
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN?.trim() ?? '';
const GRACEFUL_SHUTDOWN_TIMEOUT = parseInt(process.env.GRACEFUL_SHUTDOWN_TIMEOUT ?? '30000', 10);
const WORKER_CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY ?? '5', 10);
// Layer A agent workspace memory (local file store). Enabled by default for
// agent-owned tasks; set OPEN_TAG_AGENT_MEMORY=disabled to turn off.
const AGENT_MEMORY_ENABLED = process.env.OPEN_TAG_AGENT_MEMORY !== 'disabled';
// Channel kind baked into the conversation-workspace key. Today every session
// originates from the Lark/Feishu channel; it is a stable constant (not parsed)
// so a thread's path stays identical across turns.
const CONVERSATION_CHANNEL_KIND = 'lark';
// Write side of the verified shared context (DeLM): externalize each successful
// turn as a compact verified gist so `@`-driven handoffs gain cross-kind /
// cross-machine shared memory. Read/hydration is already wired in context-builders.
const SHARED_CONTEXT_WRITE_ENABLED = process.env.OPEN_TAG_SHARED_CONTEXT_WRITE !== 'disabled';
const ADMISSION_RESCHEDULER_INTERVAL_MS = parseInt(
  process.env.ADMISSION_RESCHEDULER_INTERVAL_MS ?? '1000',
  10,
);
const ADMISSION_RESCHEDULER_BATCH_SIZE = parseInt(
  process.env.ADMISSION_RESCHEDULER_BATCH_SIZE ?? '25',
  10,
);
const WAITING_CONTRACT_TTL_MS = parseInt(
  process.env.WAITING_CONTRACT_TTL_MS ?? String(24 * 60 * 60 * 1000),
  10,
);
const WAITING_CONTRACT_ORPHAN_MS = parseInt(
  process.env.WAITING_CONTRACT_ORPHAN_MS ?? String(5 * 60 * 1000),
  10,
);
const CHAT_MEMORY_SUMMARY_RECENT_MESSAGE_LIMIT = parseInt(
  process.env.CHAT_MEMORY_SUMMARY_RECENT_MESSAGE_LIMIT ?? '80',
  10,
);
const RUNTIME_WATCHDOG_INTERVAL_MS = parseInt(
  process.env.RUNTIME_WATCHDOG_INTERVAL_MS ?? '30000',
  10,
);
const RUNTIME_STARTUP_TIMEOUT_MS = parseInt(process.env.RUNTIME_STARTUP_TIMEOUT_MS ?? '120000', 10);
const RUNTIME_STALLED_TIMEOUT_MS = parseInt(
  process.env.RUNTIME_STALLED_TIMEOUT_MS ?? String(15 * 60 * 1000),
  10,
);
const STALLED_RECOVERY_SIGTERM_TIMEOUT_MS = parseInt(
  process.env.STALLED_RECOVERY_SIGTERM_TIMEOUT_MS ?? '10000',
  10,
);
const RUNTIME_WATCHDOG_ERROR_BACKOFF_MS = parseInt(
  process.env.RUNTIME_WATCHDOG_ERROR_BACKOFF_MS ?? '60000',
  10,
);
const INSTANCE_ROLE = process.env.OPEN_TAG_INSTANCE_ROLE === 'isolated' ? 'isolated' : 'primary';
const INSTANCE_ID = process.env.OPEN_TAG_INSTANCE_ID ?? INSTANCE_ROLE;
// Mirrors apps/api/src/server.ts: isolated default-disabled, opt-in via
// OPEN_TAG_FEISHU_ACCESS=enabled (used with a distinct dev bot app id).
const FEISHU_ACCESS_DISABLED =
  process.env.OPEN_TAG_FEISHU_ACCESS === 'disabled' ||
  (INSTANCE_ROLE === 'isolated' && process.env.OPEN_TAG_FEISHU_ACCESS !== 'enabled');
const DAEMON_GATEWAY_PORT = parseInt(process.env.DAEMON_GATEWAY_PORT ?? '3001', 10);
const DAEMON_GATEWAY_PUBLIC = process.env.DAEMON_GATEWAY_PUBLIC === 'true';

// ── Globals ──
let db: Database;
let feishuClient: FeishuClient | null = null;
let feishuClientRegistry: WorkerFeishuClientRegistry | null = null;
// Per-team Slack sender registry for non-Lark terminal feedback (Slack Milestone
// 1a, ADR-0013). Resolves a SlackChannel by the task's team_id from the
// slack_installations store; the env SLACK_BOT_TOKEN is the single-workspace
// fallback (registry.primarySender). Null until built in main().
let slackClientRegistry: WorkerSlackClientRegistry | null = null;
let slackSender: ChannelSender | null = null;
let runtimeManager: RuntimeManager;
let daemonGateway: DaemonGateway | null = null;
let queue: TaskQueue;
let taskLifecycle: TaskLifecycleService;
let SOUL: string;
let llmClient: LlmClient | null = null;
let admissionScheduler: AgentAdmissionScheduler;
let admissionReschedulerTimer: NodeJS.Timeout | null = null;
let admissionReschedulerRunning = false;
let runtimeWatchdog: RuntimeWatchdog | null = null;
let runtimeWatchdogTimer: NodeJS.Timeout | null = null;
const runtimeCancellationSourceOverrides = new Map<string, RuntimeCancellationSource>();

// In-flight machine-bound executions; the watchdog/shutdown cancellation
// channel reaches RemoteRuntimeAdapter instances through this tracker (they
// are per-dispatch and never registered with RuntimeManager).
const remoteExecutionTracker = new RemoteExecutionTracker();
const runtimeSettlementFence = new RuntimeSettlementFence();

const OPEN_TAG_REPO_ROOT = process.env.OPEN_TAG_REPO_ROOT ?? process.cwd();

/** Resolve or create a worktree for self-dev tasks, persisting info to DB. */
async function resolveDevWorkspace(
  sessionId: string,
  options: {
    workspaceKey?: string;
    existingWorktreePath?: string | null;
    persistWorkspace?: (worktreePath: string, branchName: string | null) => Promise<void>;
  } = {},
): Promise<{ worktreePath: string; branchName: string }> {
  const workspaceKey = options.workspaceKey ?? sessionId;
  let existingWorktreePath = options.existingWorktreePath ?? null;

  if (existingWorktreePath == null) {
    const [sessionInfo] = await db
      .select({ worktreePath: sessions.worktreePath, worktreeBranch: sessions.worktreeBranch })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    existingWorktreePath = sessionInfo?.worktreePath ?? null;
  }

  if (existingWorktreePath) {
    // Verify it still exists
    const existing = await getWorktree(workspaceKey, OPEN_TAG_REPO_ROOT);
    if (existing) return existing;
  }

  // Create new worktree
  const wt = await createWorktree(workspaceKey, OPEN_TAG_REPO_ROOT);
  await bootstrapWorktree(wt.worktreePath);

  // Persist to DB
  if (options.persistWorkspace) {
    await options.persistWorkspace(wt.worktreePath, wt.branchName);
  } else {
    await db
      .update(sessions)
      .set({
        worktreePath: wt.worktreePath,
        worktreeBranch: wt.branchName,
        updatedAt: new Date(),
      })
      .where(eq(sessions.id, sessionId));
  }

  logger.info(
    { sessionId, workspaceKey, worktreePath: wt.worktreePath, branch: wt.branchName },
    'Created dev worktree',
  );
  return wt;
}

function buildAdmissionAgentKey(agentId: string | undefined): string {
  return agentId ?? '__legacy__';
}

function isTerminalTaskStatus(status: string | null | undefined): boolean {
  return (
    status === TaskStatus.COMPLETED ||
    status === TaskStatus.FAILED ||
    status === TaskStatus.CANCELLED
  );
}

function stringConstraint(constraints: Record<string, unknown>, key: string): string | undefined {
  const value = constraints[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

async function deferTaskForAdmission(input: {
  taskId: string;
  agentId?: string;
  sessionId: string;
  jobData: TaskJobData;
  retryAfterMs: number;
}): Promise<void> {
  const notBefore = new Date(Date.now() + Math.max(1, input.retryAfterMs));
  await upsertAdmissionLease(db, {
    taskId: input.taskId,
    agentId: input.agentId,
    sessionId: input.sessionId,
    jobData: input.jobData as unknown as Record<string, unknown>,
    notBefore,
  });
  logger.info(
    {
      taskId: input.taskId,
      agentId: input.agentId,
      sessionId: input.sessionId,
      notBefore,
    },
    'Task deferred by admission scheduler',
  );
}

async function runAdmissionReschedulerOnce(): Promise<void> {
  if (admissionReschedulerRunning) return;
  admissionReschedulerRunning = true;
  try {
    await runAdmissionRescheduler({
      listDueLeases: async ({ limit }) =>
        (await listDueAdmissionLeases(db, { limit })).map((lease) => ({
          taskId: lease.taskId,
          sessionId: lease.sessionId,
          jobData: lease.jobData as TaskJobData,
        })),
      loadTask: async (taskId) => {
        const [taskRow] = await db
          .select({
            status: tasks.status,
          })
          .from(tasks)
          .where(eq(tasks.id, taskId))
          .limit(1);
        return taskRow ?? null;
      },
      enqueue: (data, options) => queue.enqueue(data, options),
      deleteLease: (taskId) => deleteAdmissionLease(db, taskId),
      markLeaseRescheduled: ({ taskId, nextNotBefore }) =>
        markAdmissionLeaseRescheduled(db, { taskId, nextNotBefore }),
      logger,
      batchSize: ADMISSION_RESCHEDULER_BATCH_SIZE,
      retryDelayMs: ADMISSION_RESCHEDULER_INTERVAL_MS,
    });
    await runDelegationBarrierReconciler({
      reconcileTerminalChildEdges: ({ limit }) =>
        reconcileTerminalChildDelegationEdges(db, { limit }),
      listReadyBarriers: ({ limit }) => listReadyDelegationBarriers(db, { limit }),
      deliverWake: (childTaskId) => enqueueDelegationBarrierWake(childTaskId),
      logger,
      batchSize: ADMISSION_RESCHEDULER_BATCH_SIZE,
    });
  } catch (err) {
    logger.error({ err }, 'Admission rescheduler failed');
  }
  // Own try block: an admission/delegation reconciler failure must not strand
  // waiting contracts for the tick.
  try {
    await runWaitingContractReconcilerOnce({
      listStale: (query) => listStaleWaitingContracts(db, query),
      findTaskById: async (taskId) => {
        const [taskRow] = await db
          .select({ id: tasks.id })
          .from(tasks)
          .where(eq(tasks.id, taskId))
          .limit(1);
        return taskRow ?? null;
      },
      bindContracts: (input) => bindWaitingContractsToPrimaryTask(db, input),
      transitionContract: (contractId, to) => transitionWaitingContract(db, contractId, to),
      revertContract: (contractId, from) => revertWaitingContractClaim(db, contractId, from),
      sendNotice: async (notice) => {
        const client = feishuClientRegistry
          ? await feishuClientRegistry.getClient(notice.feishuAppId)
          : null;
        if (!client) {
          throw new Error('No Feishu client available for waiting-contract notice');
        }
        await client.sendMessage(
          'chat_id',
          notice.chatId,
          { msg_type: 'text', content: { text: notice.text } },
          notice.replyToMessageId,
          { uuid: notice.uuid },
        );
      },
      logger,
      batchSize: ADMISSION_RESCHEDULER_BATCH_SIZE,
      ttlMs: WAITING_CONTRACT_TTL_MS,
      orphanMs: WAITING_CONTRACT_ORPHAN_MS,
    });
  } catch (err) {
    logger.error({ err }, 'Waiting contract reconciler failed');
  }
  try {
    await runChatMemorySummarySchedulerTick();
  } catch (err) {
    logger.error({ err }, 'Chat memory summary scheduler tick failed');
  } finally {
    admissionReschedulerRunning = false;
  }
}

/**
 * Tasks whose settlement fence the watchdog already settled but whose terminal
 * DB writes failed (transient DB error). The watchdog keeps the execution
 * registered and calls back on the next scan; without this set the early
 * fence check would swallow the retry as "already settled" and the task would
 * never be marked failed.
 */
const watchdogTerminalWritePending = new Set<string>();

async function failRuntimeExecutionFromWatchdog(
  taskId: string,
  reason: 'startup_timeout' | 'progress_stalled',
): Promise<void> {
  const errorMessage =
    reason === 'startup_timeout'
      ? `Runtime startup timed out after ${RUNTIME_STARTUP_TIMEOUT_MS}ms before an active execution was registered`
      : `Runtime stalled for ${RUNTIME_STALLED_TIMEOUT_MS}ms but no killable runtime process was active`;

  if (!watchdogTerminalWritePending.has(taskId)) {
    try {
      runtimeSettlementFence.throwIfSettled(taskId);
    } catch {
      return;
    }
    runtimeCancellationSourceOverrides.set(taskId, 'watchdog');
    runtimeSettlementFence.settle(taskId, errorMessage);
    watchdogTerminalWritePending.add(taskId);
  }

  // Terminal writes are idempotent because this path retries on subsequent
  // watchdog scans after a transient DB failure.
  const [existingRun] = await db
    .select({ id: taskRuns.id })
    .from(taskRuns)
    .where(and(eq(taskRuns.taskId, taskId), eq(taskRuns.runtimeBackend, 'watchdog')))
    .limit(1);
  if (!existingRun) {
    await db.insert(taskRuns).values({
      taskId,
      runtimeBackend: 'watchdog',
      status: 'failed',
      exitCode: 1,
      completedAt: new Date(),
    });
  }

  const [taskRow] = await db
    .select({ status: tasks.status })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1);
  const terminalStatuses: string[] = [
    TaskStatus.COMPLETED,
    TaskStatus.FAILED,
    TaskStatus.CANCELLED,
  ];
  if (taskRow && !terminalStatuses.includes(taskRow.status)) {
    await taskLifecycle.transitionTask(taskId, TaskStatus.FAILED, { errorMessage });
  }
  watchdogTerminalWritePending.delete(taskId);
  logger.warn({ taskId, reason }, 'Runtime watchdog settled task as failed');
}

function throwIfRuntimeWatchdogSettled(taskId: string): void {
  runtimeSettlementFence.throwIfSettled(taskId);
}

async function enqueueDelegationBarrierWake(childTaskId: string) {
  return deliverDelegationBarrierWake(
    {
      evaluateBarrier: (taskId) => evaluateDelegationBarrierForChildTask(db, taskId),
      enqueue: (jobData) => queue.enqueue(jobData),
      deleteLease: (taskId) => deleteAdmissionLease(db, taskId),
      logger,
    },
    childTaskId,
  );
}

async function deliverCompletedDiscussionTurn(input: {
  taskId: string;
  sessionId: string;
  agentId?: string;
  feishuAppId?: string;
  taskType: string;
  goal: string;
  runtimeHint: string | null;
  constraints: Record<string, unknown>;
  content?: string | null;
  status?: 'completed' | 'failed' | 'cancelled';
  errorMessage?: string | null;
  result?: unknown;
}) {
  return deliverDiscussionTurnAdvance(
    {
      loadDiscussion: (discussionId) => findDiscussionById(db, discussionId),
      listParticipants: (discussionId) => listDiscussionParticipants(db, discussionId),
      loadTranscript: (discussionId) => loadDiscussionTranscript(db, discussionId),
      completeTaskAndAdvance: (taskInput, turnInput, advanceInput) =>
        completeDiscussionTaskTurnAndAdvance(db, taskInput, turnInput, advanceInput),
      enqueue: (jobData) => queue.enqueue(jobData),
      deleteLease: (nextTaskId) => deleteAdmissionLease(db, nextTaskId),
      renderCommittedTurns: (renderInput) => renderCommittedDiscussionTurns(renderInput),
      logger,
    },
    input,
  );
}

async function renderCommittedDiscussionTurns(input: {
  discussionId: string;
  throughTaskId: string;
  includeClosing?: boolean;
}) {
  return renderDiscussionTurnsThrough(
    {
      loadDiscussion: (discussionId) => findDiscussionById(db, discussionId),
      listParticipants: (discussionId) => listDiscussionParticipants(db, discussionId),
      loadTranscript: (discussionId) => loadDiscussionTranscript(db, discussionId),
      getChannelSender: async (feishuAppId) => {
        const { client } = await resolveTaskFeishuClient({
          feishuAppId,
          resolver: feishuClientRegistry,
          defaultClient: feishuClient,
        });
        return client ? createLarkChannelSender(client) : null;
      },
      markRendered: (renderInput) => markDiscussionTurnFeishuRendered(db, renderInput),
      logger,
    },
    {
      discussionId: input.discussionId,
      throughTaskId: input.throughTaskId,
      includeClosing: input.includeClosing,
    },
  );
}

/**
 * Build the handoff roster offered to the executing agent: every active agent in
 * the same tenant that has an active bot binding (so the delegated turn can be
 * delivered), minus the caller itself, under stable session-local short codes.
 * The model picks a code; {@link resolveHandoffTargetFromCandidates} maps it back
 * to a real agent id, so routing is by id and display names may repeat across
 * owners. Tenant scope here only trims what the model sees — not a permission
 * gate (cross-tenant handoff is a future extension; ids stay globally unique).
 */
async function loadHandoffCandidates(
  callerAgentId: string | undefined,
  tenantKey: string,
): Promise<HandoffCandidate[]> {
  const rows = await db
    .select({
      agentId: agents.id,
      displayName: agents.displayName,
      feishuAppId: agentBotBindings.feishuAppId,
    })
    .from(agents)
    .innerJoin(
      agentBotBindings,
      and(eq(agentBotBindings.agentId, agents.id), eq(agentBotBindings.status, 'active')),
    )
    .innerJoin(
      feishuApps,
      and(eq(feishuApps.id, agentBotBindings.feishuAppId), eq(feishuApps.status, 'enabled')),
    )
    .where(and(eq(agents.tenantKey, tenantKey), eq(agents.status, 'active')))
    .orderBy(agents.createdAt);
  return rows
    .filter((row) => row.agentId !== callerAgentId)
    .map((row, index) => ({
      ref: `agent_${index + 1}`,
      agentId: row.agentId,
      displayName: row.displayName,
      feishuAppId: row.feishuAppId ?? null,
    }));
}

/**
 * Resolve an agent to its display name and (when bound) the bot open id used
 * for real `<at>` mentions in waiting-contract wakes.
 */
async function resolveAgentMentionTarget(
  agentId: string,
): Promise<{ botOpenId: string | null; displayName: string } | null> {
  const [row] = await db
    .select({
      displayName: agents.displayName,
      bindingBotOpenId: agentBotBindings.botOpenId,
      appBotOpenId: feishuApps.botOpenId,
    })
    .from(agents)
    .leftJoin(
      agentBotBindings,
      and(eq(agentBotBindings.agentId, agents.id), eq(agentBotBindings.status, 'active')),
    )
    .leftJoin(
      feishuApps,
      and(eq(feishuApps.id, agentBotBindings.feishuAppId), eq(feishuApps.status, 'enabled')),
    )
    .where(eq(agents.id, agentId))
    .limit(1);
  if (!row) return null;
  return {
    botOpenId: row.bindingBotOpenId ?? row.appBotOpenId ?? null,
    displayName: row.displayName,
  };
}

/** Map a handoff short code back to its real agent target, or null if unknown. */
function resolveHandoffTargetFromCandidates(
  ref: string,
  candidates: HandoffCandidate[],
): { agentId: string; feishuAppId?: string | null; handle?: string | null } | null {
  const match = candidates.find((candidate) => candidate.ref === ref);
  return match
    ? { agentId: match.agentId, feishuAppId: match.feishuAppId ?? null, handle: match.displayName }
    : null;
}

async function resolveHandoffTargetByHandle(
  handle: string,
  tenantKey: string,
): Promise<{ agentId: string; feishuAppId?: string | null; handle?: string | null } | null> {
  const agent = await resolveActiveAgentByHandle(db, { tenantKey, handle });
  if (!agent) return null;

  const [binding] = await db
    .select({ feishuAppId: agentBotBindings.feishuAppId })
    .from(agentBotBindings)
    .innerJoin(feishuApps, eq(agentBotBindings.feishuAppId, feishuApps.id))
    .where(
      and(
        eq(agentBotBindings.agentId, agent.id),
        eq(agentBotBindings.status, 'active'),
        eq(feishuApps.status, 'enabled'),
      ),
    )
    .limit(1);

  return {
    agentId: agent.id,
    feishuAppId: binding?.feishuAppId ?? null,
    handle: agent.handle,
  };
}

async function transitionTaskOrDeliverDiscussionTurn(input: {
  taskId: string;
  sessionId: string;
  agentId?: string;
  feishuAppId?: string;
  taskType: string;
  goal: string;
  runtimeHint: string | null;
  constraints: Record<string, unknown>;
  status: TaskStatus.COMPLETED | TaskStatus.FAILED | TaskStatus.CANCELLED;
  result?: unknown;
  errorMessage?: string | null;
  content?: string | null;
}) {
  await transitionTaskOrDeliverDiscussionTurnWithDeps(
    {
      deliverCompletedDiscussionTurn,
      taskLifecycle,
    },
    {
      taskId: input.taskId,
      sessionId: input.sessionId,
      agentId: input.agentId,
      feishuAppId: input.feishuAppId,
      taskType: input.taskType,
      goal: input.goal,
      runtimeHint: input.runtimeHint,
      constraints: input.constraints,
      content: input.content,
      status: input.status,
      errorMessage: input.errorMessage,
      result: input.result,
    },
  );
}

async function loadRecentChatMessagesForSummary(input: {
  chatId: string;
}): Promise<Array<{ role: string; content: string; createdAt: Date | null }>> {
  const limit = Number.isFinite(CHAT_MEMORY_SUMMARY_RECENT_MESSAGE_LIMIT)
    ? Math.max(1, CHAT_MEMORY_SUMMARY_RECENT_MESSAGE_LIMIT)
    : 80;
  const rows = await db
    .select({
      role: messages.role,
      content: messages.content,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .innerJoin(sessions, eq(messages.sessionId, sessions.id))
    .where(and(eq(sessions.chatId, input.chatId), ne(sessions.scope, 'chat_memory_summary')))
    .orderBy(desc(messages.createdAt))
    .limit(limit);

  return rows.reverse().map((row) => ({
    role: row.role,
    content: truncateSummaryTranscriptContent(row.content),
    createdAt: row.createdAt,
  }));
}

async function createChatMemorySummaryTask(input: {
  config: DueChatMemoryConfig;
  now: Date;
}): Promise<void> {
  const agentId = input.config.memorySummaryAgentId;
  if (!agentId) {
    throw new Error('No active chat agent is available for chat memory summary');
  }

  const runtimeHint = input.config.agentDefaultRuntime ?? null;
  const sessionKey = `chat-memory-summary:${input.config.tenantKey}:${input.config.chatId}`;
  const [summarySession] = await db
    .insert(sessions)
    .values({
      sessionKey,
      chatId: input.config.chatId,
      scope: 'chat_memory_summary',
      title: 'Chat memory summary',
      runtimeBackend: runtimeHint,
      updatedAt: input.now,
    })
    .onConflictDoUpdate({
      target: sessions.sessionKey,
      set: {
        runtimeBackend: runtimeHint,
        updatedAt: input.now,
      },
    })
    .returning({
      id: sessions.id,
      sdkSessionId: sessions.sdkSessionId,
      sdkSessionMachineId: sessions.sdkSessionMachineId,
      runtimeBackend: sessions.runtimeBackend,
    });
  if (!summarySession) {
    throw new Error('Failed to create or resolve chat memory summary session');
  }

  const recentMessages = await loadRecentChatMessagesForSummary({ chatId: input.config.chatId });
  const goal = buildChatMemorySummaryGoal({
    tenantKey: input.config.tenantKey,
    chatId: input.config.chatId,
    generatedAt: input.now,
    recentMessages,
  });
  const taskId = randomUUID();
  const constraints = {
    tenantKey: input.config.tenantKey,
    chatId: input.config.chatId,
    chatMemorySummary: true,
    summaryConfigId: input.config.id,
    timeoutSec: 1800,
  };
  const jobData: TaskJobData = {
    taskId,
    sessionId: summarySession.id,
    agentId,
    feishuAppId: input.config.feishuAppId ?? undefined,
    taskType: CHAT_MEMORY_SUMMARY_TASK_TYPE,
    goal,
    runtimeHint,
    constraints,
    sdkSessionId: summarySession.sdkSessionId ?? undefined,
    sdkSessionMachineId: summarySession.sdkSessionMachineId ?? undefined,
    runtimeBackend: summarySession.runtimeBackend ?? undefined,
  };

  try {
    await db.insert(tasks).values({
      id: taskId,
      sessionId: summarySession.id,
      agentId,
      feishuAppId: input.config.feishuAppId ?? null,
      taskType: CHAT_MEMORY_SUMMARY_TASK_TYPE,
      goal,
      runtimeHint,
      constraints,
    });
    await taskLifecycle.transitionTask(taskId, TaskStatus.QUEUED);
    await queue.enqueue(jobData);
  } catch (err) {
    try {
      await taskLifecycle.transitionTask(taskId, TaskStatus.FAILED, {
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    } catch (transitionErr) {
      logger.warn({ taskId, transitionErr }, 'Failed to mark chat memory summary task failed');
    }
    throw err;
  }
}

async function runChatMemorySummarySchedulerTick(): Promise<void> {
  try {
    const result = await runChatMemorySummarySchedulerOnce(
      {
        listDueConfigs: (query) => listDueChatMemoryConfigs(db, query),
        markEnqueued: (input) => markChatMemorySummaryEnqueued(db, input),
        markResult: (input) => markChatMemorySummaryResult(db, input),
        createSummaryTask: ({ config, now }) => createChatMemorySummaryTask({ config, now }),
        logger,
      },
      { now: new Date(), limit: ADMISSION_RESCHEDULER_BATCH_SIZE },
    );
    if (result.due > 0) {
      logger.info(result, 'Processed due chat memory summary configs');
    }
  } catch (err) {
    logger.error({ err }, 'Chat memory summary scheduler failed');
  }
}

function truncateSummaryTranscriptContent(content: string): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  return normalized.length <= 1200 ? normalized : `${normalized.slice(0, 1197)}...`;
}

interface AgentExecutionConfig {
  handle: string;
  displayName: string;
  agentDefaultRuntime: string | null;
  defaultWorkDir: string | null;
  runtimeEnv: Record<string, string>;
  memoryEnabled: boolean;
  projectId: string | null;
  profileSystemPrompt: string | null;
  profileStylePrompt: string | null;
  profileDefaultRuntime: string | null;
  profileDefaultModel: string | null;
}

async function loadAgentExecutionConfig(agentId: string): Promise<AgentExecutionConfig | null> {
  const [config] = await db
    .select({
      handle: agents.handle,
      displayName: agents.displayName,
      agentDefaultRuntime: agents.defaultRuntime,
      defaultWorkDir: agents.defaultWorkDir,
      runtimeEnv: agents.runtimeEnv,
      memoryEnabled: agents.memoryEnabled,
      projectId: agents.projectId,
      profileSystemPrompt: agentProfiles.systemPrompt,
      profileStylePrompt: agentProfiles.stylePrompt,
      profileDefaultRuntime: agentProfiles.defaultRuntime,
      profileDefaultModel: agentProfiles.defaultModel,
    })
    .from(agents)
    .innerJoin(agentProfiles, eq(agents.profileId, agentProfiles.id))
    .where(eq(agents.id, agentId))
    .limit(1);

  return config ? { ...config, runtimeEnv: normalizeRuntimeEnv(config.runtimeEnv) } : null;
}

/**
 * Load the agent row as an {@link IdentityAgentSource} (incl. the `budget` cap) so
 * the worker can compose the SAME identity the ambient budget gate composes when it
 * records this turn's usage. Returns null when the agent no longer exists.
 */
async function loadIdentityAgentSource(agentId: string): Promise<IdentityAgentSource | null> {
  const [row] = await db
    .select({
      id: agents.id,
      handle: agents.handle,
      profileId: agents.profileId,
      defaultRuntime: agents.defaultRuntime,
      scopeType: agents.scopeType,
      scopeId: agents.scopeId,
      status: agents.status,
      budget: agents.budget,
    })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);

  return row ?? null;
}

// ── Task processor ──
function withContextImages(
  spec: TaskSpec,
  imageAttachments: Array<{ imageKey: string; messageId: string }>,
): TaskSpec {
  if (imageAttachments.length === 0) return spec;
  return {
    ...spec,
    context: {
      ...spec.context,
      imageAttachments,
    },
  };
}

async function processTask(job: { id: string; data: TaskJobData }): Promise<void> {
  const { taskId, goal, runtimeHint, constraints } = job.data;
  let { sessionId } = job.data;
  sessionId = await refreshTaskSessionCanonicalId({
    db,
    taskId,
    sessionId,
    logger,
    stage: 'start',
  });
  const rawTaskConstraints = constraints as Record<string, unknown>;
  const taskConstraints = getEffectiveTaskConstraints(rawTaskConstraints);
  const tenantKey = taskConstraints.tenantKey as string | undefined;
  const chatId = taskConstraints.chatId as string | undefined;
  const ackMessageId = taskConstraints.ackMessageId as string | undefined;
  const replyToMessageId = taskConstraints.replyToMessageId as string | undefined;
  // The task's own channel kind (neutral dispatch stamps it; legacy/Lark jobs
  // omit it ⇒ default 'lark'), plus the neutral thread target for non-lark replies.
  const channelKind = (taskConstraints.channelKind as string | undefined) ?? 'lark';
  const channelThreadId = taskConstraints.threadId as string | undefined;
  const userMessageId = taskConstraints.userMessageId as string | undefined;
  const userMessageReactionId = taskConstraints.userMessageReactionId as string | undefined;
  const imageAttachment = taskConstraints.imageAttachment as
    | { imageKey: string; messageId: string }
    | undefined;
  const rawFileAttachment = taskConstraints.fileAttachment as
    | {
        resourceKey: string;
        messageId: string;
        resourceType?: 'file' | 'audio' | 'media';
        fileName?: string;
        mimeType?: string;
      }
    | undefined;
  const fileAttachment = rawFileAttachment
    ? { ...rawFileAttachment, resourceType: rawFileAttachment.resourceType ?? 'file' }
    : undefined;
  const replyLanguage = extractReplyLanguageFromConstraints(taskConstraints);
  const feishuRuntimeContext = getFeishuRuntimeContextFromConstraints(taskConstraints);
  const isDelegatedTask = taskConstraints.delegatedTask === true;
  const chatMemoryContext = chatId ? { tenantKey: tenantKey ?? 'default', chatId } : undefined;
  const runtimeCancellationSource = resolveRuntimeCancellationSource(
    taskConstraints.runtimeCancellationSource,
  );
  const delegationContextPackage = isDelegatedTask
    ? JSON.stringify(rawTaskConstraints.delegationPackage ?? {}, null, 2)
    : undefined;

  logger.info({ taskId, sessionId, runtimeHint }, 'Processing task');

  let feedback: TaskFeedback | null = null;
  let taskFeishuClient: FeishuClient | null = null;
  let taskChannelSender: ChannelSender | null = null;
  // Additional "show your work" surface: a live named-stage checklist driven by
  // the runtime's plan/tool events. Created lazily on the first plan step.
  let checklist: ChecklistFeedback | null = null;
  let taskAgentId: string | undefined;
  let taskFeishuAppId: string | undefined;
  let admissionHandle: AdmissionHandle | null = null;
  const admissionSlotReleaser = createAdmissionSlotReleaser(() => admissionHandle);
  let runtimeStarted = false;

  let runningDescription = 'Preparing task...';
  let runningProgress: number | undefined;
  let runningActivity: string[] = [];
  let lastRunningCardUpdateAt = 0;
  let executionGoal = goal;
  let runningWorkDir: string | undefined;
  let remoteMachine: MachineRow | null = null;
  let taskRunRecord: typeof taskRuns.$inferSelect | null = null;
  let taskRunEventIndex = 0;

  const watchdogSettlement = runtimeSettlementFence.watch(taskId);
  void watchdogSettlement.promise
    .then(() => {
      admissionSlotReleaser.releaseAll();
    })
    .catch((err) => {
      logger.error({ taskId, err }, 'Failed to release admission slots after watchdog settlement');
    });

  const updateRunningCard = async (
    message: string,
    source: RunningCardSource,
    progress?: number,
    updateDescription = true,
    force = false,
  ) => {
    runningActivity = appendRunningActivity(runningActivity, message, source);

    if (updateDescription) {
      runningDescription = message;
      runningProgress = progress;
    }

    if (feedback) {
      const now = Date.now();
      const shouldFlush = shouldFlushRunningCardUpdate({
        now,
        lastUpdatedAt: lastRunningCardUpdateAt,
        source,
        force,
      });
      if (!shouldFlush) {
        return;
      }
      await updateRunningFeedbackCard(
        taskChannelSender,
        {
          ackMessageId,
          description: runningDescription,
          progress: runningProgress,
          recentActivity: runningActivity,
          workDir: runningWorkDir,
        },
        logger,
      );
      lastRunningCardUpdateAt = now;
    }
  };

  const updateFeedbackState = async (state: 'running' | 'completed' | 'failed') => {
    if (!ackMessageId) return;
    await db
      .update(tasks)
      .set({
        feedbackState: state,
        feedbackUpdatedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, taskId));
  };

  const aliasSentFeedbackMessages = async (messageIds?: string[]) => {
    const uniqueMessageIds = [...new Set((messageIds ?? []).filter(Boolean))];
    if (!tenantKey || !chatId || uniqueMessageIds.length === 0) return;

    try {
      await aliasThreadKeysForSession(db, sessionId, uniqueMessageIds, tenantKey, chatId);
    } catch (err) {
      logger.warn(
        { err, taskId, sessionId, messageIds: uniqueMessageIds },
        'Failed to alias feedback message ids to session',
      );
    }
  };

  const persistRuntimeEvent = async (event: RuntimeEvent) => {
    if (!taskRunRecord) return;
    taskRunEventIndex += 1;
    try {
      await db.insert(taskRunEvents).values(
        buildTaskRunEventInsert({
          taskId,
          runId: taskRunRecord.id,
          eventIndex: taskRunEventIndex,
          event,
        }),
      );
    } catch (err) {
      logger.warn({ taskId, runId: taskRunRecord.id, err }, 'Failed to persist runtime event');
    }
  };

  try {
    // Guard: skip if task is not QUEUED (e.g., duplicate job from pg-boss retry)
    const [currentTask] = await db
      .select({ status: tasks.status, agentId: tasks.agentId, feishuAppId: tasks.feishuAppId })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .limit(1);

    if (!currentTask || currentTask.status !== TaskStatus.QUEUED) {
      const discussionId = stringConstraint(rawTaskConstraints, 'discussionId');
      if (currentTask && isTerminalTaskStatus(currentTask.status) && discussionId) {
        await renderCommittedDiscussionTurns({
          discussionId,
          throughTaskId: taskId,
        });
      }
      logger.warn(
        { taskId, currentStatus: currentTask?.status },
        'Task is not in QUEUED state, skipping (likely duplicate processing)',
      );
      return;
    }

    const taskIdentity = resolveTaskAgentIdentity(job.data, currentTask);
    taskAgentId = taskIdentity.agentId;
    taskFeishuAppId = taskIdentity.feishuAppId;
    const suppressLoopbackFeedback = shouldSuppressLoopbackFeishuFeedback(
      taskConstraints,
      taskFeishuAppId,
    );
    const feedbackClientResolution = suppressLoopbackFeedback
      ? { client: null, missingAppClient: false }
      : await resolveTaskFeishuClient({
          feishuAppId: taskFeishuAppId,
          resolver: feishuClientRegistry,
          defaultClient: feishuClient,
        });
    taskFeishuClient = feedbackClientResolution.client;
    if (channelKind === 'lark') {
      // Lark path — unchanged. Route the primary task-feedback card through the
      // neutral ChannelSender (same expression/calls as before): wrap the exact
      // client ThreePhaseFeedback uses for done/failed so the running card cannot
      // drift to a different/rotated client instance.
      taskChannelSender = resolveTaskChannelSender('lark', { feishuClient: taskFeishuClient });
      // The live checklist posts a separate card into the same chat; only wire it
      // when we have both a sender and a destination chat.
      if (taskChannelSender && chatId) {
        const checklistTitle = (
          goal.split('\n').find((line) => line.trim()) ?? 'Working on the task'
        )
          .trim()
          .slice(0, 120);
        checklist = new ChecklistFeedback({
          sender: taskChannelSender,
          conversation: buildTaskConversationRef(chatId, replyToMessageId),
          title: checklistTitle,
          logger,
        });
      }

      // Setup feedback (will update the ACK card if chatId is available).
      // replyToMessageId: thread-aware (only set in topic threads) so completion cards
      // follow the same reply convention as other messages.
      // ackMessageId: pre-existing ACK card from the API server for updateRunning to PATCH.
      if (chatId && taskChannelSender) {
        feedback = new ThreePhaseFeedback(taskChannelSender, chatId, replyToMessageId, ackMessageId);
      } else if (chatId && feedbackClientResolution.missingAppClient) {
        logger.error(
          { taskId, feishuAppId: taskFeishuAppId },
          'Cannot resolve Feishu client for task app; feedback will be skipped',
        );
      }
    } else {
      // Non-lark (e.g. Slack): deliver the task's terminal outcome to ITS OWN
      // channel through the kind-resolved sender. taskChannelSender stays null so
      // the Lark-only running card + checklist are never wired for this kind (the
      // neutral feedback owns its sender). When the dispatch threaded an ack
      // handle (constraints.ackDelivery, ADR-0008), the terminal state UPDATES
      // that same ack message in place; otherwise a fresh terminal message is
      // sent. Running-card live updates + full Block Kit parity are deferred.
      // Resolve the Slack sender by the task's team_id (Slack Milestone 1a): the
      // neutral dispatch stamps constraints.tenantKey = the Slack team_id, so the
      // registry returns ITS workspace's SlackChannel (env fallback only in
      // single-workspace mode). getClient never throws; a null keeps the existing
      // no-throw/null-skip contract below. Non-slack kinds keep the env slackSender.
      const teamSlackSender =
        channelKind === 'slack' && slackClientRegistry
          ? await slackClientRegistry.getClient(tenantKey)
          : slackSender;
      const neutralSender = resolveTaskChannelSender(channelKind, { slackSender: teamSlackSender });
      const ackDeliveryRef = reconstructAckDeliveryRef(taskConstraints.ackDelivery);
      if (chatId && neutralSender) {
        feedback = new NeutralChannelFeedback({
          sender: neutralSender,
          conversation: {
            kind: channelKind,
            scopeId: chatId,
            ...(channelThreadId ? { threadId: channelThreadId } : {}),
          },
          ...(ackDeliveryRef ? { ackRef: ackDeliveryRef } : {}),
          logger,
        });
      } else {
        logger.warn(
          {
            taskId,
            channelKind,
            hasSender: Boolean(neutralSender),
            hasChatId: Boolean(chatId),
          },
          'No channel sender resolved for non-lark task; terminal feedback delivery skipped',
        );
      }
    }

    if (
      await skipInactiveDiscussionTurnIfNeeded(
        {
          findDiscussionById: (discussionId) => findDiscussionById(db, discussionId),
          transitionTask: (staleTaskId, status, extra) =>
            taskLifecycle.transitionTask(staleTaskId, status, extra),
          logger,
        },
        { taskId, constraints: rawTaskConstraints },
      )
    ) {
      logger.info({ taskId, sessionId }, 'Skipped discussion turn because discussion is inactive');
      return;
    }

    if (shouldSkipTaskExecution(taskConstraints)) {
      const outputText = 'Debug test mode: task execution was intentionally skipped.';

      await taskLifecycle.transitionTask(taskId, TaskStatus.RUNNING);
      if (feedback) {
        await updateRunningCard(
          'Skipping runtime execution for debug test task...',
          'status',
          undefined,
          true,
          true,
        );
        const doneResult = await feedback.updateDone(goal, outputText, {
          allowedMentions: feishuRuntimeContext?.mentions ?? [],
        });
        await aliasSentFeedbackMessages(doneResult?.sentMessageIds);
      }
      // Keep the existing ordering used elsewhere in processTask(): update the
      // card state first, then persist the terminal task transition.
      await updateFeedbackState('completed');
      const debugTaskResult = {
        taskId,
        status: 'completed',
        output: {
          text: outputText,
        },
        metrics: {
          durationMs: 0,
          tokenIn: 0,
          tokenOut: 0,
          estimatedCostUsd: 0,
        },
      };
      await transitionTaskOrDeliverDiscussionTurn({
        taskId,
        sessionId,
        agentId: taskAgentId,
        feishuAppId: taskFeishuAppId,
        taskType: job.data.taskType,
        goal,
        runtimeHint,
        constraints: rawTaskConstraints,
        status: TaskStatus.COMPLETED,
        result: debugTaskResult,
        content: outputText,
      });

      if (taskFeishuClient && userMessageId && userMessageReactionId) {
        await removeAckReactionViaChannel(
          taskChannelSender ?? createLarkChannelSender(taskFeishuClient),
          { messageId: userMessageId, reactionId: userMessageReactionId, reason: 'after debug task skip' },
          logger,
        );
      }

      logger.info({ taskId, sessionId }, 'Skipped runtime execution for debug test task');
      return;
    }

    // ── Per-identity budget gate (task-admission boundary) ──
    // Block an already-over-budget identity BEFORE claiming an admission slot,
    // before the (token-spending) metadata-extraction LLM call, and before the
    // runtime. Reuses the SAME resolveIdentity path recordTaskUsage records
    // under, so the checking-id == recording-id. Fail-OPEN on resolution/DB
    // error (a DB blip must not block legitimate work); fail-CLOSED only on a
    // confirmed cap exhaustion, surfaced as BudgetExceededError and finalized by
    // the shared terminal-failure catch below (mirrors the RemoteDispatchError
    // fail-fast precedent). Uncapped identities (the default) short-circuit with
    // zero usage-table cost.
    await enforceTaskAdmissionBudget(
      db,
      { taskId, agentId: taskAgentId, occurredAt: new Date().toISOString() },
      {
        loadAgent: (agentId) => loadIdentityAgentSource(agentId),
        deleteLease: (blockedTaskId) => deleteAdmissionLease(db, blockedTaskId),
        recordBlockAudit: async ({ taskId: auditTaskId, agentId, decision }) => {
          await db.insert(auditEvents).values({
            actorId: null,
            action: BUDGET_ADMISSION_BLOCKED_AUDIT_ACTION,
            targetType: 'task',
            targetId: auditTaskId,
            severity: AuditSeverity.WARN,
            detail: {
              agentId,
              identityId: decision.identityId,
              window: decision.window ?? null,
              windowKey: decision.windowKey ?? null,
              remaining: decision.remaining ?? null,
              chatId: chatId ?? null,
              tenantKey: tenantKey ?? null,
              reason: 'budget_exhausted',
            },
          });
        },
        logger,
      },
    );

    const admissionAgentKey = buildAdmissionAgentKey(taskAgentId);
    const admission = admissionScheduler.admit({
      taskId,
      agentId: admissionAgentKey,
    });
    if (!admission.admitted) {
      if (admission.reason !== 'duplicate') {
        await deferTaskForAdmission({
          taskId,
          agentId: taskAgentId,
          sessionId,
          jobData: job.data,
          retryAfterMs: admission.retryAfterMs,
        });
      }
      logger.info(
        {
          taskId,
          agentId: taskAgentId,
          admissionAgentKey,
          reason: admission.reason,
          retryAfterMs: admission.retryAfterMs,
        },
        'Task not admitted for runtime execution',
      );
      return;
    }
    admissionHandle = admission.handle;
    await deleteAdmissionLease(db, taskId);
    runtimeWatchdog?.register({ taskId, sessionId });

    const agentSessionState = taskAgentId
      ? await loadAgentSessionState(db, { agentId: taskAgentId, sessionId })
      : null;
    const agentExecutionConfig = taskAgentId ? await loadAgentExecutionConfig(taskAgentId) : null;
    const effectiveRuntimeState = resolveEffectiveRuntimeState({
      agentId: taskAgentId,
      agentSessionState,
      jobData: job.data,
    });
    const agentDefaultRuntime =
      agentExecutionConfig?.agentDefaultRuntime ??
      agentExecutionConfig?.profileDefaultRuntime ??
      null;
    const runtimeHintForSelection =
      runtimeHint == null || runtimeHint === 'auto'
        ? (agentDefaultRuntime ?? runtimeHint)
        : runtimeHint;
    // Task workdir precedence is session → chat → env (evaluated per task).
    // The chat binding and env default are loaded once and reused below.
    const chatDefaultWorkDir = chatId
      ? await loadChatDefaultWorkDir(db, tenantKey ?? 'default', chatId)
      : null;
    const envDefaultWorkDir = readDefaultWorkDirEnv();

    // ── Ad-hoc workspace: extract workDir via LLM and send confirmation card ──
    const hasReviewContext = getReviewContext(taskConstraints) !== null;
    const reviewContextWorktreeAccessMode = getReviewContextWorktreeAccessMode(taskConstraints);
    const confirmedWorkDir = taskConstraints.confirmedWorkDir as string | undefined;
    const confirmedRuntime = taskConstraints.confirmedRuntime as string | undefined;
    const hasConfirmedMetadata =
      hasReviewContext || confirmedWorkDir !== undefined || confirmedRuntime !== undefined;

    // If not already confirmed and LLM client is available, run extraction
    if (!hasConfirmedMetadata) {
      // Look up session's existing adhocWorkDir for stickiness
      const [sessionForSticky] = await db
        .select({ adhocWorkDir: sessions.adhocWorkDir, projectId: sessions.projectId })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1);
      const stickyAdhocWorkDir = resolveTaskWorkDir({
        sessionWorkDir: sessionForSticky?.adhocWorkDir ?? null,
        chatWorkDir: chatDefaultWorkDir,
        envWorkDir: envDefaultWorkDir,
      });
      const stickyProjectId =
        agentExecutionConfig?.projectId ?? sessionForSticky?.projectId ?? null;

      // Skip extraction for /project sessions (they have their own flow)
      if (!stickyProjectId) {
        const extraction = await maybeExtractPromptMetadata({
          taskType: job.data.taskType,
          constraints: rawTaskConstraints,
          goal,
          llmClient,
          extractor: extractPromptMetadata,
        });

        if (extraction) {
          const resolvedDir = extraction.workDir
            ? resolveWorkDir(extraction.workDir, OPEN_TAG_REPO_ROOT)
            : null;
          const currentRuntime = resolveTaskRuntime(
            runtimeHintForSelection,
            effectiveRuntimeState.runtimeBackend,
            confirmedRuntime,
          );
          const decision = decidePromptMetadataConfirmation({
            effectiveGoal: extraction.goal || goal,
            resolvedWorkDir: resolvedDir,
            extractedRuntime: extraction.runtime,
            existingAdhocWorkDir: stickyAdhocWorkDir,
            currentRuntime,
          });
          executionGoal = decision.effectiveGoal;

          if (decision.needsConfirmation) {
            // Transition to RUNNING first (to update card), then send confirm card and wait
            await taskLifecycle.transitionTask(taskId, TaskStatus.RUNNING);

            if (chatId && taskFeishuClient) {
              const confirmCard = buildWorkDirConfirmCard({
                workDir: decision.displayWorkDir,
                goal: executionGoal,
                defaultRuntime: decision.defaultRuntime,
                sessionId,
                chatId,
                taskId,
                replyLanguage: replyLanguage ?? 'en-US',
                replyToMessageId,
              });
              await taskFeishuClient.sendMessage('chat_id', chatId, confirmCard, replyToMessageId);
            }

            // Transition to WAITING_APPROVAL, worker releases this job
            await taskLifecycle.transitionTask(taskId, TaskStatus.WAITING_APPROVAL, {
              interactionReason: 'clarify',
            });
            logger.info(
              {
                taskId,
                resolvedDir: decision.displayWorkDir,
                runtime: decision.defaultRuntime,
                goal: executionGoal,
              },
              'Sent metadata confirmation card, waiting for user approval',
            );
            return;
          }

          // Stickiness: use session's existing adhocWorkDir without re-confirming
          if (decision.confirmedWorkDir || decision.confirmedRuntime) {
            logger.info(
              {
                taskId,
                adhocWorkDir: decision.confirmedWorkDir,
                runtime: decision.confirmedRuntime,
              },
              'Reusing extracted prompt metadata without confirmation',
            );
            if (decision.confirmedWorkDir) {
              taskConstraints.confirmedWorkDir = decision.confirmedWorkDir;
            }
            taskConstraints.confirmedRuntime = decision.confirmedRuntime;
          }
        } else {
          // Extraction unavailable (e.g. OPEN_TAG_LLM_* unset) but the session
          // may already carry an adhocWorkDir — apply it directly so passthrough
          // still fires. self_dev paths return null here.
          const fallback = decideStickyAdhocWorkDirFallback(
            job.data.taskType,
            taskConstraints,
            stickyAdhocWorkDir,
          );
          if (fallback) {
            taskConstraints.confirmedWorkDir = fallback;
            logger.info(
              { taskId, adhocWorkDir: fallback },
              'Using seeded adhocWorkDir without LLM extraction',
            );
          }
        }
      }
    }

    // Re-read confirmedWorkDir after stickiness logic; review worktree availability
    // is resolved after machine routing because machine-local paths are only safe
    // on the machine that produced them.
    let reviewContextWorkDir: string | undefined;
    let effectiveWorkDir = taskConstraints.confirmedWorkDir as string | undefined;

    // Transition: QUEUED → RUNNING
    await taskLifecycle.transitionTask(taskId, TaskStatus.RUNNING);

    // Select runtime adapter — prefer the runtime from previous turn for resume continuity.
    // 'auto' from runtimeHint means no explicit user choice; resolve to the default runtime
    // explicitly so the fallback does not depend on adapter registration order.
    //
    // We track the SELECTION SOURCE (issue #8): an explicit user choice
    // (confirmed runtime or an explicit per-message hint) must run EXACTLY that
    // runtime and fail fast if it is unavailable, never silently substituting
    // another. Auto/default/resume selections may fall back. The resolved
    // runtime VALUE is unchanged vs the prior `resolveTaskRuntime` call — the
    // raw hint + agent default are passed separately so the source classifier
    // can distinguish "user asked for X" from "agent default is X".
    //
    // Source classification uses the GENUINE confirmation captured BEFORE the
    // sticky-passthrough write above. The passthrough re-persists the
    // auto-resolved runtime into `taskConstraints.confirmedRuntime` to avoid
    // re-confirming, so reading it back here would mislabel an auto/default/
    // resume turn as `confirmed` and wrongly force fail-fast. The resolved VALUE
    // is unaffected: the passthrough only ever writes the auto-resolved runtime,
    // which the lower-precedence inputs reproduce.
    const runtimeSelection = resolveTaskRuntimeWithSource({
      confirmedRuntime,
      runtimeBackend: effectiveRuntimeState.runtimeBackend,
      runtimeHint,
      agentDefaultRuntime,
    });
    const preferredRuntime = runtimeSelection.runtime;
    const runtimeExplicitlySelected = isExplicitRuntimeSource(runtimeSelection.source);
    let adapter: RuntimeAdapter | undefined;
    let runtimeFallback: RuntimeFallbackRecord | null = null;

    // ── Machine routing (D6/D7/D13) ──
    // Resolve the task's execution machine BEFORE local adapter selection: the
    // remote runtime must be chosen from the user/session preference validated
    // against the MACHINE's capabilities, never constrained (or silently
    // substituted) by which adapters the server itself has credentials for — a
    // control-plane-only server with zero local runtimes must still dispatch
    // remote work.
    //
    // The resolution runs even when the gateway is down: a machine-bound task
    // must FAIL FAST with a clear reason rather than silently fall back to
    // server-local execution (D8 — local fallback could run repo-editing work
    // against the wrong checkout).
    let executedOnMachineId: string | null = null;
    {
      const resolution = await resolveMachineForTask({
        db,
        taskType: job.data.taskType,
        ownerOpenId: feishuRuntimeContext?.senderOpenId,
        tenantKey,
        sessionId,
        chatId,
        confirmedMachineId: taskConstraints.confirmedMachine as string | undefined,
        // D-A8: the acting agent's machine binding ranks above session/chat bindings.
        agentId: taskAgentId,
      });
      // Classify the resolution into local / remote / fail-fast (D8). A
      // machine-bound task NEVER silently falls back to server-local: an invalid
      // binding (not_found / revoked / owner_mismatch) or a downed gateway for a
      // bound task fails fast with an actionable card, surfaced via the catch
      // block below. Only `self_dev` / `no_binding` resolve to server-local.
      const dispatchDecision = decideMachineDispatch(
        resolution,
        Boolean(daemonGateway),
        resolution.machine && daemonGateway
          ? daemonGateway.isMachineOnline(resolution.machine.id)
          : false,
      );
      if (dispatchDecision.kind === 'fail-fast') {
        throw new RemoteDispatchError(dispatchDecision.message);
      }
      if (dispatchDecision.kind === 'remote' && daemonGateway) {
        const machine: MachineRow = dispatchDecision.machine;
        const remoteReviewContextWorkDir = getReviewContextWorkDir(taskConstraints, {
          currentMachineId: machine.id,
        });
        const remoteEffectiveWorkDir =
          remoteReviewContextWorkDir ?? (taskConstraints.confirmedWorkDir as string | undefined);
        // Remote runtime follows the user/session preference verbatim;
        // buildRemoteAdapter validates it against the machine's advertised
        // capabilities (and fails fast otherwise). Passing the resolved runtime
        // through — instead of a name-string allowlist — keeps remote dispatch
        // data-driven: a runtime added to the registry needs no change here.
        const remoteRuntime = preferredRuntime;
        const remoteBuild = await buildRemoteAdapter({
          gateway: daemonGateway,
          machine,
          runtime: remoteRuntime,
          workdirHints: {
            confirmedWorkDir: remoteEffectiveWorkDir,
            defaultWorkDir: chatDefaultWorkDir ?? envDefaultWorkDir ?? undefined,
            // Daemons with the `agent_home` feature fall back to a stable
            // machine-local per-agent home when no dir hint resolves; older
            // daemons strip the unknown key (scratch behavior unchanged).
            agentId: taskAgentId,
          },
          runtimeEnv: agentExecutionConfig?.runtimeEnv,
          taskSpec: {
            taskId,
            sessionId,
            taskType: job.data.taskType as 'chat_reply',
            goal: executionGoal,
            runtimeHint: 'auto',
            constraints: {},
            context: { systemPrompt: '', recentTurns: [], imageAttachment },
          } as never,
          imageDownloader: feishuClient ?? undefined,
          logger,
        });
        if (!remoteBuild.ok) {
          throw new RemoteDispatchError(remoteBuild.reason);
        }
        adapter = remoteBuild.adapter;
        executedOnMachineId = machine.id;
        reviewContextWorkDir = remoteReviewContextWorkDir;
        effectiveWorkDir = remoteEffectiveWorkDir;
        remoteMachine = machine;
        remoteExecutionTracker.register(taskId, remoteBuild.adapter);
        logger.info(
          { taskId, machineId: machine.id, machineName: machine.name, runtime: remoteRuntime },
          'Dispatching task to remote machine',
        );
      } else {
        reviewContextWorkDir = getReviewContextWorkDir(taskConstraints, {
          currentMachineId: null,
        });
        effectiveWorkDir =
          reviewContextWorkDir ?? (taskConstraints.confirmedWorkDir as string | undefined);
        // Only self_dev / no_binding reach here (invalid bindings + downed
        // gateway already threw above), so server-local is correct (D8).
        logger.debug(
          { taskId, reason: resolution.reason },
          'No machine binding, executing server-local',
        );
      }
    }

    // Local adapter selection only when no remote machine took the task. An
    // explicit runtime fails fast here (requireHealthy throws → terminal-failure
    // catch surfaces a clear failed card); an auto/default selection may fall
    // back, and the substitution is logged now + persisted as a task run event
    // once the run record exists below.
    if (!adapter) {
      const localSelection = await selectLocalRuntimeAdapter(
        runtimeManager,
        preferredRuntime,
        runtimeExplicitlySelected,
      );
      adapter = localSelection.adapter;
      runtimeFallback = localSelection.fallback;
      if (runtimeFallback) {
        logger.warn(
          {
            taskId,
            preferredRuntime: runtimeFallback.preferredRuntime,
            fallbackRuntime: runtimeFallback.fallbackRuntime,
            reason: runtimeFallback.reason,
          },
          'Runtime fallback used for non-explicit selection',
        );
      }
    }

    logger.info(
      { taskId, agentId: taskAgentId, runtime: adapter.name() },
      'Selected runtime adapter',
    );
    let resumeSdkSessionId = effectiveRuntimeState.sdkSessionId ?? null;
    // Machine switch clears the SDK session (D15): the stored sdkSessionId names
    // machine-local SDK state, so resuming it on a different substrate is
    // undefined. Compare against the substrate persisted alongside the stored
    // sdkSessionId (`sdk_session_machine_id`), which is exact across arbitrary
    // local↔remote sequences.
    if (resumeSdkSessionId) {
      const previousMachineId = await loadStoredSdkSessionMachineId(db, {
        sessionId,
        agentId: taskAgentId,
      });
      if (isMachineSwitch(previousMachineId, executedOnMachineId)) {
        await clearWorkerSdkSessionState(db, { sessionId, agentId: taskAgentId });
        resumeSdkSessionId = null;
        logger.info(
          { taskId, sessionId, agentId: taskAgentId, previousMachineId, executedOnMachineId },
          'Cleared SDK session because execution machine changed',
        );
      }
    }
    if (
      shouldClearSdkSessionForRuntimeSwitch(effectiveRuntimeState.runtimeBackend, adapter.name())
    ) {
      await clearWorkerSdkSessionState(db, { sessionId, agentId: taskAgentId });
      resumeSdkSessionId = null;
      logger.info(
        {
          taskId,
          sessionId,
          agentId: taskAgentId,
          previousRuntimeBackend: effectiveRuntimeState.runtimeBackend,
          runtimeBackend: adapter.name(),
        },
        'Cleared SDK session because runtime backend changed',
      );
    }

    // Detect task type: passthrough (ad-hoc workdir), external-project, self-dev, or generic
    const [sessionInfo] = await db
      .select({
        sessionKey: sessions.sessionKey,
        worktreePath: sessions.worktreePath,
        worktreeBranch: sessions.worktreeBranch,
        projectId: sessions.projectId,
        adhocWorkDir: sessions.adhocWorkDir,
      })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    const persistedWorktreePath = taskAgentId
      ? (effectiveRuntimeState.workspacePath ?? null)
      : (sessionInfo?.worktreePath ?? null);
    let currentWorktreeBranch = taskAgentId
      ? (effectiveRuntimeState.worktreeBranch ?? null)
      : (sessionInfo?.worktreeBranch ?? null);
    // Session → chat → env. The session-level binding (shared by all agents in
    // the session) is the source for agent runs too, so a workdir bound by one
    // agent is seen by the others.
    const persistedAdhocWorkDir = resolveTaskWorkDir({
      sessionWorkDir: sessionInfo?.adhocWorkDir ?? null,
      chatWorkDir: chatDefaultWorkDir,
      envWorkDir: envDefaultWorkDir,
    });
    const effectiveProjectId = agentExecutionConfig?.projectId ?? sessionInfo?.projectId ?? null;
    const workspaceKey = buildWorkerWorkspaceKey(sessionId, taskAgentId);

    const isPassthrough = Boolean(effectiveWorkDir) && !effectiveProjectId;
    const isExternalProject = !isPassthrough && Boolean(effectiveProjectId);
    const isSelfDev =
      !isPassthrough &&
      (job.data.taskType === 'self_dev' || (!isExternalProject && Boolean(persistedWorktreePath)));

    // Classify whether this turn requests file edits or is a read-only Q&A.
    // Readonly path skips git-worktree creation and runs the agent against the
    // target directory directly with a non-mutating workflow prompt.
    //
    // Pass the last assistant message as context so contextual confirmations
    // ("yes", "go ahead", "改") after a previously proposed code change are
    // correctly classified as write (codex review feedback).
    const [lastAssistantMsg] = await db
      .select({ content: messages.content })
      .from(messages)
      .where(and(eq(messages.sessionId, sessionId), eq(messages.role, 'assistant')))
      .orderBy(desc(messages.createdAt))
      .limit(1);
    const isWrite = await classifyWriteIntent(executionGoal, llmClient, {
      recentAssistantContext: lastAssistantMsg?.content ?? null,
    });
    const workspaceMode = decideWorkspaceMode({
      isPassthrough,
      isExternalProject,
      isSelfDev,
      isWrite,
    });
    logger.info(
      { taskId, isWrite, workspaceMode, taskType: job.data.taskType },
      'Write-intent classification',
    );
    const hasUsableReviewWorkDir = reviewContextWorkDir !== undefined;

    // Use session-stable workspace so SDK sessions (stored per cwd) survive across turns.
    // Claude Agent SDK stores sessions in ~/.claude/projects/{cwd-encoded}/, so resume
    // MUST use the same cwd as the original execution to find the session data.
    const workspaceRunId = `session-${workspaceKey}`;
    const workspace = await createWorkspace(workspaceRunId);
    // Per-agent runtime env (BASE_URL / API_KEY) plus any access-bundle credentials
    // the running identity has installed. Copied so the per-task injection never
    // mutates the loaded agent config. Access-bundle credentials are injected ONLY
    // on the server-local path (this workspace.runtimeEnv feeds the LOCAL adapter);
    // resolveTaskCredentialEnv fail-fasts a machine-bound task that has granted
    // bundles rather than running it remotely without its creds (the registered
    // remote adapter has not dispatched yet and is unregistered in the finally).
    const runtimeEnv = { ...(agentExecutionConfig?.runtimeEnv ?? {}) };
    if (taskAgentId) {
      const credentialIdentitySource = await loadIdentityAgentSource(taskAgentId);
      if (credentialIdentitySource) {
        const credentialEnv = await resolveTaskCredentialEnv(
          db,
          { agent: credentialIdentitySource, remoteDispatch: remoteMachine !== null },
          { logger },
        );
        Object.assign(runtimeEnv, credentialEnv);
      }
    }
    if (Object.keys(runtimeEnv).length > 0) {
      workspace.runtimeEnv = runtimeEnv;
    }

    const persistWorkspaceState = async (worktreePath: string, branchName: string | null) => {
      currentWorktreeBranch = branchName;
      if (taskAgentId) {
        await persistWorkerRuntimeState(db, {
          sessionId,
          agentId: taskAgentId,
          runtimeBackend: adapter.name(),
          sdkSessionId: null,
          sdkSessionMachineId: null,
          workspacePath: worktreePath,
          worktreeBranch: branchName,
          adhocWorkDir: hasUsableReviewWorkDir
            ? persistedAdhocWorkDir
            : (effectiveWorkDir ?? persistedAdhocWorkDir),
        });
        return;
      }

      await db
        .update(sessions)
        .set({ worktreePath, worktreeBranch: branchName, updatedAt: new Date() })
        .where(eq(sessions.id, sessionId));
    };

    let workflowPrompt: string | undefined;

    if (workspaceMode === 'passthrough_write' || workspaceMode === 'passthrough_readonly') {
      // effectiveWorkDir is guaranteed truthy when isPassthrough is true
      if (!effectiveWorkDir) throw new Error('passthrough mode without effectiveWorkDir');
      if (hasUsableReviewWorkDir && reviewContextWorktreeAccessMode === 'write') {
        workspace.cwd = effectiveWorkDir;
        workspace.readOnly = false;
        runningWorkDir = effectiveWorkDir;
        logger.info(
          {
            taskId,
            adhocWorkDir: effectiveWorkDir,
            cwd: effectiveWorkDir,
            reviewContext: true,
            worktreeAccessMode: reviewContextWorktreeAccessMode,
          },
          'Delegated shared worktree resolved (write)',
        );
      } else if (remoteMachine) {
        // Remote dispatch: the bound workdir lives on the MACHINE — the daemon
        // materializes its own worktree (or runs in place) from the workdir
        // hints. Resolving it server-side would create a worktree of, or throw
        // on, a path that only exists on the machine. Display the hint dir.
        runningWorkDir = effectiveWorkDir;
        if (workspaceMode === 'passthrough_readonly') {
          workflowPrompt = READONLY_SYSTEM_PROMPT;
        }
        logger.info(
          {
            taskId,
            adhocWorkDir: effectiveWorkDir,
            machineId: remoteMachine.id,
            workspaceMode,
          },
          'Ad-hoc passthrough deferred to remote daemon',
        );
      } else if (workspaceMode === 'passthrough_write') {
        // Ad-hoc workspace passthrough: set cwd to confirmed directory, no workflow injection.
        // Runtime will auto-read project CLAUDE.md and other config from cwd.
        const wt = await resolveExternalProjectWorkspace(
          workspaceKey,
          effectiveWorkDir,
          persistedWorktreePath,
          persistWorkspaceState,
        );
        workspace.workspacePath = wt.worktreePath;
        runningWorkDir = wt.worktreePath;
        logger.info(
          {
            taskId,
            adhocWorkDir: effectiveWorkDir,
            cwd: wt.worktreePath,
            reviewContext: hasUsableReviewWorkDir,
          },
          'Ad-hoc passthrough workspace resolved (write)',
        );
      } else {
        // Readonly: do not create a worktree. If the session already has one
        // from a prior write turn, reuse it as cwd so the agent sees in-progress
        // edits AND the SDK session (stored per cwd) can resume; otherwise fall
        // back to the project root. Set `workspace.cwd` rather than overriding
        // `workspace.workspacePath` so adapter scratch writes (TASK.md, etc.)
        // stay in the temp dir instead of dirtying the user's repo.
        const existing = persistedWorktreePath
          ? await getWorktree(workspaceKey, effectiveWorkDir)
          : null;
        const cwd = existing?.worktreePath ?? effectiveWorkDir;
        workspace.cwd = cwd;
        workspace.readOnly = true;
        runningWorkDir = cwd;
        workflowPrompt = READONLY_SYSTEM_PROMPT;
        logger.info(
          {
            taskId,
            adhocWorkDir: effectiveWorkDir,
            cwd,
            reusedWorktree: Boolean(existing),
            reviewContext: hasUsableReviewWorkDir,
          },
          'Ad-hoc passthrough workspace resolved (readonly, no worktree creation)',
        );
      }
      // Persist the effective workdir to the session-level binding (for agent
      // runs too) so every agent in the session reuses it — the session → chat
      // → env resolution reads `sessions.adhocWorkDir` first.
      if (!hasUsableReviewWorkDir && persistedAdhocWorkDir !== effectiveWorkDir) {
        await db
          .update(sessions)
          .set({ adhocWorkDir: effectiveWorkDir, updatedAt: new Date() })
          .where(eq(sessions.id, sessionId));
      }
    } else if (workspaceMode === 'external_write' || workspaceMode === 'external_readonly') {
      // Look up the project path from the registry
      const [projectRow] = await db
        .select({ path: projects.path })
        .from(projects)
        .where(eq(projects.id, effectiveProjectId!))
        .limit(1);

      if (!projectRow) throw new Error(`Project not found for session ${sessionId}`);

      if (workspaceMode === 'external_write') {
        const wt = await resolveExternalProjectWorkspace(
          workspaceKey,
          projectRow.path,
          persistedWorktreePath,
          persistWorkspaceState,
        );
        workspace.workspacePath = wt.worktreePath;
        runningWorkDir = wt.worktreePath;
        workflowPrompt = EXTERNAL_DEV_SYSTEM_PROMPT;
        logger.info(
          { taskId, projectPath: projectRow.path, cwd: wt.worktreePath },
          'External project workspace resolved (write)',
        );
      } else {
        // Readonly: reuse existing worktree as cwd if it's still on disk
        // (preserves in-progress edits and SDK session resume); otherwise run
        // against the project root. Do NOT create a new worktree. Set
        // `workspace.cwd` (not `workspacePath`) so adapter scratch writes stay
        // in the temp dir.
        const existing = persistedWorktreePath
          ? await getWorktree(workspaceKey, projectRow.path)
          : null;
        const cwd = existing?.worktreePath ?? projectRow.path;
        workspace.cwd = cwd;
        workspace.readOnly = true;
        runningWorkDir = cwd;
        workflowPrompt = READONLY_SYSTEM_PROMPT;
        logger.info(
          { taskId, projectPath: projectRow.path, cwd, reusedWorktree: Boolean(existing) },
          'External project workspace resolved (readonly, no worktree creation)',
        );
      }
    } else if (workspaceMode === 'self_dev_write' || workspaceMode === 'self_dev_readonly') {
      if (workspaceMode === 'self_dev_write') {
        const wt = await resolveDevWorkspace(sessionId, {
          workspaceKey,
          existingWorktreePath: persistedWorktreePath,
          persistWorkspace: persistWorkspaceState,
        });
        workspace.workspacePath = wt.worktreePath;
        runningWorkDir = wt.worktreePath;
        workflowPrompt = getSelfDevSystemPrompt(adapter.name());
      } else {
        // Readonly self-dev: reuse existing worktree as cwd if it's still on disk
        // (preserves same-session continuity with in-progress edits); otherwise
        // run against the main repo. Either way, do NOT create a new worktree.
        // Set `workspace.cwd` (not `workspacePath`) so adapter scratch writes
        // (TASK.md, image.png) stay in the temp dir instead of dirtying the
        // OpenClaudeTag repo when there's no existing worktree to absorb them.
        const existing = persistedWorktreePath
          ? await getWorktree(workspaceKey, OPEN_TAG_REPO_ROOT)
          : null;
        const cwd = existing?.worktreePath ?? OPEN_TAG_REPO_ROOT;
        workspace.cwd = cwd;
        workspace.readOnly = true;
        runningWorkDir = cwd;
        workflowPrompt = READONLY_SYSTEM_PROMPT;
        logger.info(
          { taskId, cwd, reusedWorktree: Boolean(existing) },
          'Self-dev workspace resolved (readonly, no worktree creation)',
        );
      }
    } else if (workspaceMode === 'generic' && taskAgentId) {
      if (remoteMachine) {
        // Remote dispatch: the daemon resolves (and creates) the per-agent home
        // on ITS filesystem from `workdirHints.agentId`. Creating one here would
        // pollute the server and put a server-local path on the task card for a
        // run that never touches this host. Show the machine-side home only when
        // the daemon actually supports it; older daemons run in their scratch.
        if (machineSupportsAgentHome(remoteMachine)) {
          runningWorkDir = remoteAgentHomeDisplayPath(taskAgentId);
        }
        logger.info(
          {
            taskId,
            agentId: taskAgentId,
            machineId: remoteMachine.id,
            agentHome: runningWorkDir ?? null,
          },
          'Generic agent run deferred to remote daemon',
        );
      } else {
        // No bound workdir (session/chat/env all empty). Prefer a
        // conversation-scoped workspace so a thread's successive turns share
        // working state (clones, edits, scratch) without crossing into other
        // conversations. The path is a pure function of the conversation key, so
        // a later turn — even on another worker process — re-derives the same
        // dir with no persisted binding. Non-thread sessions (group-main /
        // manual / bootstrap / no thread) fall back to the stable per-agent home
        // under ~/.open-claude-tag/agents/<agentId>, unchanged. Either way set
        // `workspace.cwd` (not `workspacePath`) so adapter scratch files
        // (TASK.md, image.png) stay in the temp dir, and do NOT persist a
        // worktree/adhoc binding so the next turn re-resolves the same dir.
        const conversationThreadId = deriveConversationThreadId(sessionInfo?.sessionKey);
        const conversationWorkspace = await ensureConversationWorkspace({
          channelKind: CONVERSATION_CHANNEL_KIND,
          installationId: tenantKey ?? 'default',
          scopeId: chatId ?? sessionId,
          threadId: conversationThreadId,
        });
        if (conversationWorkspace) {
          workspace.cwd = conversationWorkspace;
          runningWorkDir = conversationWorkspace;
          logger.info(
            { taskId, agentId: taskAgentId, cwd: conversationWorkspace },
            'Generic agent run resolved to conversation workspace',
          );
        } else {
          const home = await ensureAgentHomeDir(taskAgentId);
          workspace.cwd = home;
          runningWorkDir = home;
          logger.info(
            { taskId, agentId: taskAgentId, cwd: home },
            'Generic agent run resolved to per-agent home',
          );
        }
      }
    }
    const agentProfileSystemPrompt = mergeAgentProfileSystemPrompt({
      systemPrompt: agentExecutionConfig?.profileSystemPrompt,
      legacyStylePrompt: agentExecutionConfig?.profileStylePrompt,
    });
    const agentIdentityPrompt = buildAgentIdentityPrompt({
      agentId: taskAgentId,
      handle: agentExecutionConfig?.handle,
      displayName: agentExecutionConfig?.displayName,
    });
    let systemPromptAppend = buildAgentSystemPrompt({
      platformPrompt: SOUL,
      identityPrompt: agentIdentityPrompt,
      agentSystemPrompt: agentProfileSystemPrompt,
      workflowPrompt,
    });
    systemPromptAppend = appendReplyLanguageGuidance(systemPromptAppend, replyLanguage);
    systemPromptAppend = appendFeishuRuntimeContextGuidance(
      systemPromptAppend,
      feishuRuntimeContext,
    );
    systemPromptAppend = appendReviewContextGuidance(systemPromptAppend, taskConstraints, {
      currentMachineId: executedOnMachineId,
    });
    // Roster of delegable agents (by session-local short code). Built once here
    // so the guidance the model reads and the resolver used at completion below
    // share the exact same code→id mapping.
    const handoffCandidates = taskAgentId
      ? await loadHandoffCandidates(taskAgentId, tenantKey ?? 'default')
      : [];
    systemPromptAppend = appendHandoffToolGuidance(systemPromptAppend ?? '', handoffCandidates);

    // Layer A agent workspace memory: materialize an isolated checkout of the
    // agent's MEMORY.md + notes/ and inject the index + memory contract.
    // Failures are non-fatal — memory is advisory context, never a task gate.
    // Phase 0 is server-local only: a remote-dispatched task would receive a
    // checkout path that does not exist on the executing machine, so memory
    // is skipped there until the daemon protocol carries snapshots (phase 2).
    let agentTaskMemory: { homeDir: string; checkoutPath: string } | null = null;
    // Per-agent opt-out from the console ("Long-term memory" toggle) stacks on
    // top of the worker-global env kill switch.
    const agentMemoryOptedIn = agentExecutionConfig?.memoryEnabled !== false;
    if (AGENT_MEMORY_ENABLED && agentMemoryOptedIn && taskAgentId && executedOnMachineId === null) {
      try {
        const memoryHomeDir = await ensureAgentHomeDir(taskAgentId);
        const preparedMemory = await prepareAgentTaskMemory({
          homeDir: memoryHomeDir,
          taskId,
          displayName: agentExecutionConfig?.displayName ?? undefined,
        });
        agentTaskMemory = { homeDir: memoryHomeDir, checkoutPath: preparedMemory.checkoutPath };
        systemPromptAppend = [systemPromptAppend, preparedMemory.promptSection]
          .filter((section): section is string => Boolean(section))
          .join('\n\n---\n\n');
        logger.info(
          { taskId, agentId: taskAgentId, checkoutPath: preparedMemory.checkoutPath },
          'Agent memory checkout prepared',
        );
      } catch (error) {
        logger.warn(
          {
            taskId,
            agentId: taskAgentId,
            error: error instanceof Error ? error.message : String(error),
          },
          'Agent memory preparation failed (non-fatal)',
        );
      }
    }

    // Update card to RUNNING
    if (feedback) {
      await updateRunningCard(
        `Executing with ${adapter.name()}...`,
        'status',
        undefined,
        true,
        true,
      );
    }
    await updateFeedbackState('running');

    const runtimeWorkspacePath = runningWorkDir ?? workspace.cwd ?? workspace.workspacePath;
    const [createdTaskRun] = await db
      .insert(taskRuns)
      .values({
        taskId,
        runtimeBackend: adapter.name(),
        workspacePath: runtimeWorkspacePath,
        status: 'running',
        startedAt: new Date(),
        lastHeartbeatAt: new Date(),
      })
      .returning();
    taskRunRecord = createdTaskRun;

    // Persist a runtime-fallback marker now that a run record (and thus a valid
    // run id FK) exists. This records preferredRuntime, fallbackRuntime, and the
    // reason for the substitution so auto/default fallbacks are auditable.
    if (runtimeFallback) {
      await persistRuntimeEvent({
        type: 'status',
        message: `Runtime fallback: requested "${runtimeFallback.preferredRuntime}" unavailable (${runtimeFallback.reason}); using "${runtimeFallback.fallbackRuntime}"`,
      });
    }

    // Prepare task spec
    // Effective model: the agent profile's defaultModel, with an ops-level env
    // fallback. Flows to local AND remote runtimes because it rides on the spec.
    const effectiveModel =
      agentExecutionConfig?.profileDefaultModel?.trim() ||
      process.env.OPEN_TAG_DEFAULT_MODEL?.trim() ||
      undefined;
    const taskSpec = {
      taskId,
      sessionId,
      taskType: job.data.taskType as 'chat_reply',
      goal: executionGoal,
      runtimeHint: (runtimeHint ?? 'auto') as 'auto',
      ...(effectiveModel ? { model: effectiveModel } : {}),
      constraints: {
        timeoutSec: 1800,
        approvalRequired: false,
        writeScope: [] as string[],
        networkPolicy: 'restricted' as const,
      },
      context: { systemPrompt: '', recentTurns: [] as unknown[], imageAttachment, fileAttachment },
    };

    // Helper: consume an event stream and collect results
    async function consumeEvents(stream: AsyncGenerator<RuntimeEvent>) {
      let result: TaskResult | null = null;
      let error: string | null = null;
      let sdkSessId: string | null = null;
      let cancelled = false;
      const iterator = stream[Symbol.asyncIterator]();

      try {
        while (true) {
          throwIfRuntimeWatchdogSettled(taskId);
          const next = await runtimeSettlementFence.race(taskId, iterator.next());
          throwIfRuntimeWatchdogSettled(taskId);
          if (next.done) break;

          const event = next.value;
          if (event.type === 'runtime_started') {
            runtimeStarted = true;
            admissionSlotReleaser.releaseStartSlot();
            runtimeWatchdog?.markRuntimeStarted(taskId);
            logger.info({ taskId, executionId: event.executionId }, 'Runtime execution started');
            throwIfRuntimeWatchdogSettled(taskId);
            continue;
          }
          if (runtimeStarted) {
            runtimeWatchdog?.markProgress(taskId);
          }

          await persistRuntimeEvent(event);

          // Drive the live named-stage checklist (additive — a separate card
          // from the running-feedback path below). No-op for unrelated events.
          await checklist?.onEvent(event);

          const runningCardUpdate = toRunningCardUpdate(event, runningProgress);
          if (runningCardUpdate) {
            if (event.type === 'progress') {
              logger.debug({ taskId, percent: event.percent }, event.message);
            } else if (event.type === 'status') {
              logger.info({ taskId }, event.message);
            } else if (event.type === 'stdout' || event.type === 'stderr') {
              logger.debug({ taskId, stream: event.type }, event.data);
            } else if (event.type === 'reasoning') {
              logger.debug({ taskId, stream: 'reasoning' }, event.summary);
            }

            await updateRunningCard(
              runningCardUpdate.message,
              runningCardUpdate.source,
              runningCardUpdate.progress,
              runningCardUpdate.updateDescription,
            );
            throwIfRuntimeWatchdogSettled(taskId);
            continue;
          }

          switch (event.type) {
            case 'completed':
              result = event.result;
              await checklist?.finalize('done');
              break;
            case 'failed':
              error = event.error;
              cancelled = event.reason === 'cancelled';
              // Accumulate any partial usage the runtime knew at failure. The
              // `failed` event carries no `result`, so this is the only spend
              // signal on a failure terminal. Summed (not overwritten) so a
              // failed resume plus a failed fresh fallback both count.
              if (event.metrics) {
                runtimeFailureMetrics = {
                  tokenIn: (runtimeFailureMetrics?.tokenIn ?? 0) + event.metrics.tokenIn,
                  tokenOut: (runtimeFailureMetrics?.tokenOut ?? 0) + event.metrics.tokenOut,
                  estimatedCostUsd:
                    (runtimeFailureMetrics?.estimatedCostUsd ?? 0) +
                    event.metrics.estimatedCostUsd,
                };
              }
              await checklist?.finalize('failed');
              break;
            case 'artifact':
              logger.info({ taskId, artifact: event.ref.name }, 'Artifact produced');
              break;
            case 'session_created':
              sdkSessId = event.sdkSessionId;
              logger.info({ taskId, sdkSessionId: event.sdkSessionId }, 'SDK session created');
              break;
          }
          throwIfRuntimeWatchdogSettled(taskId);
        }
      } catch (err) {
        if (err instanceof RuntimeWatchdogSettledError) {
          const returnPromise = iterator.return?.(undefined);
          if (returnPromise) {
            void returnPromise.catch((returnErr) => {
              logger.warn({ taskId, returnErr }, 'Runtime stream return failed after settlement');
            });
          }
        }
        throw err;
      }
      return { result, error, sdkSessId, cancelled };
    }

    // Determine whether to resume or hydrate from the verified shared context.
    // `resumeSdkSessionId` was already nulled above on a machine switch (D15) or a
    // runtime-backend switch, so this two-tier selection is equivalent to the
    // previous `Boolean(resumeSdkSessionId && supportsResume)` gate while making
    // the cross-kind / cross-machine decision explicit and observable.
    const contextStrategy = selectContextStrategy({
      stored: {
        sdkSessionId: resumeSdkSessionId,
        agentId: taskAgentId,
        runtimeBackend: effectiveRuntimeState.runtimeBackend,
        machineId: effectiveRuntimeState.sdkSessionMachineId,
      },
      next: {
        agentId: taskAgentId,
        runtimeBackend: adapter.name(),
        machineId: executedOnMachineId,
      },
      adapterSupportsResume: adapter.supportsResume(),
    });
    const canResume = contextStrategy.mode === 'resume';
    logger.info(
      {
        taskId,
        agentId: taskAgentId,
        strategy: contextStrategy.mode,
        reason: contextStrategy.reason,
      },
      'Context strategy selected',
    );
    let taskResult: TaskResult | null = null;
    let errorMessage: string | null = null;
    let newSdkSessionId: string | null = null;
    let taskCancelled = false;
    // Partial token/spend a runtime knew at the moment it emitted `failed`. The
    // `failed` event carries no `result`, so this is the ONLY usage signal on a
    // failure terminal. Accumulated across BOTH consumeEvents calls (a failed
    // resume followed by a failed fresh fallback) so a finally-failed task is
    // charged the sum of every attempt's spend. Stays null when the runtime
    // never ran or exposed no usage at failure → recording no-ops.
    let runtimeFailureMetrics: TaskUsageMetrics | null = null;

    if (canResume && resumeSdkSessionId) {
      throwIfRuntimeWatchdogSettled(taskId);
      logger.info(
        { taskId, agentId: taskAgentId, sdkSessionId: resumeSdkSessionId },
        'Resuming previous SDK session',
      );
      const resumeImagePaths = await prepareResumeImagePaths(adapter, taskSpec, workspace);
      const resumeGoal = await buildContextualGoal(
        db,
        logger,
        sessionId,
        executionGoal,
        taskId,
        systemPromptAppend ?? '',
        {
          agentId: taskAgentId,
          includeSessionHistory: false,
          delegationContextPackage,
          chatMemory: chatMemoryContext,
        },
      );
      const resumeResult = await consumeEvents(
        adapter.resume(resumeSdkSessionId, resumeGoal, workspace, systemPromptAppend, {
          taskId,
          executionId: taskId,
          imagePaths: resumeImagePaths,
          ...(effectiveModel ? { model: effectiveModel } : {}),
        }),
      );

      if (resumeResult.cancelled) {
        logger.warn(
          {
            taskId,
            agentId: taskAgentId,
            sdkSessionId: resumeSdkSessionId,
            error: resumeResult.error,
          },
          'Resume cancelled; skipping fresh execution fallback',
        );
        taskResult = resumeResult.result;
        errorMessage = resumeResult.error ?? 'Runtime execution cancelled';
        newSdkSessionId = resumeResult.sdkSessId;
        taskCancelled = true;
      } else if (shouldFallbackToFreshExecutionAfterResume(resumeResult)) {
        // Resume failed (e.g. session expired) — fallback to fresh execution
        logger.warn(
          {
            taskId,
            agentId: taskAgentId,
            sdkSessionId: resumeSdkSessionId,
            error: resumeResult.error,
          },
          'Resume failed, falling back to fresh execution',
        );
        await updateRunningCard(
          'Previous session unavailable, starting fresh...',
          'status',
          runningProgress,
          true,
          true,
        );
        // Clear stale SDK session from DB
        await clearWorkerSdkSessionState(db, { sessionId, agentId: taskAgentId });

        // Inject conversation history for fresh execution after resume failure
        const contextualExecution = await buildContextualExecutionContext(
          db,
          logger,
          sessionId,
          executionGoal,
          taskId,
          systemPromptAppend ?? '',
          {
            agentId: taskAgentId,
            includeSessionHistory: !isDelegatedTask,
            delegationContextPackage,
            currentMessageId: userMessageId,
            currentImageAttachment: imageAttachment,
            chatMemory: chatMemoryContext,
          },
        );
        const contextualSpec = withContextImages(
          { ...taskSpec, goal: contextualExecution.goal },
          contextualExecution.imageAttachments,
        );
        const prepareSpec = withContextImages(taskSpec, contextualExecution.imageAttachments);

        throwIfRuntimeWatchdogSettled(taskId);
        const handle = await adapter.prepare(prepareSpec, workspace);
        throwIfRuntimeWatchdogSettled(taskId);
        const freshResult = await consumeEvents(
          adapter.execute(
            handle,
            contextualSpec,
            systemPromptAppend,
          ) as AsyncGenerator<RuntimeEvent>,
        );
        taskResult = freshResult.result;
        errorMessage = freshResult.error;
        newSdkSessionId = freshResult.sdkSessId;
        taskCancelled = freshResult.cancelled;
      } else {
        taskResult = resumeResult.result;
        errorMessage = resumeResult.error;
        newSdkSessionId = resumeResult.sdkSessId;
        taskCancelled = resumeResult.cancelled;
      }
    } else {
      // Inject conversation history for fresh execution (no SDK session available)
      const contextualExecution = await buildContextualExecutionContext(
        db,
        logger,
        sessionId,
        executionGoal,
        taskId,
        systemPromptAppend ?? '',
        {
          agentId: taskAgentId,
          includeSessionHistory: !isDelegatedTask,
          delegationContextPackage,
          currentMessageId: userMessageId,
          currentImageAttachment: imageAttachment,
          chatMemory: chatMemoryContext,
        },
      );
      const contextualSpec = withContextImages(
        { ...taskSpec, goal: contextualExecution.goal },
        contextualExecution.imageAttachments,
      );
      const prepareSpec = withContextImages(taskSpec, contextualExecution.imageAttachments);

      throwIfRuntimeWatchdogSettled(taskId);
      const handle = await adapter.prepare(prepareSpec, workspace);
      throwIfRuntimeWatchdogSettled(taskId);
      const freshResult = await consumeEvents(
        adapter.execute(handle, contextualSpec, systemPromptAppend) as AsyncGenerator<RuntimeEvent>,
      );
      taskResult = freshResult.result;
      errorMessage = freshResult.error;
      newSdkSessionId = freshResult.sdkSessId;
      taskCancelled = freshResult.cancelled;
    }

    throwIfRuntimeWatchdogSettled(taskId);

    // ── Per-identity usage accounting (single seam, runs ONCE) ──
    // Charge this turn's settled token/spend against the running identity's
    // budget window as soon as the runtime outcome is known, BEFORE any of the
    // fallible post-processing below (memory sync, session refresh, state
    // persist, artifact collection/insert, the terminal transition). Recording
    // here — not inside the terminal success/failure branches — guarantees a
    // failed-but-token-spending task is still charged even if a later step
    // throws into the catch, and makes success vs failure a single mutually
    // exclusive choice so a task is never double-charged. On success the source
    // is `taskResult.metrics`; on failure it is the partial usage the runtime
    // exposed on its `failed` event (`runtimeFailureMetrics`). A thrown failure
    // that never reaches here (e.g. a BudgetExceededError admission reject) ran
    // no runtime and records nothing. Error-isolated and a clean no-op when no
    // usage is known or the identity is uncapped. `occurredAt` is a single
    // boundary clock read.
    await recordTaskUsageBestEffort(
      db,
      {
        taskId,
        agentId: taskAgentId,
        metrics: errorMessage ? runtimeFailureMetrics : (taskResult?.metrics ?? null),
        occurredAt: new Date().toISOString(),
      },
      { loadAgent: loadIdentityAgentSource, logger },
    );

    // Sync the agent memory checkout back into the agent home. Runs on
    // success and on clean failure alike (failure lessons are memory too);
    // cancelled tasks discard, and dirty exits leave the checkout for the
    // startup janitor. Never fails the task.
    if (agentTaskMemory) {
      if (taskCancelled) {
        await discardAgentTaskMemory({ homeDir: agentTaskMemory.homeDir, taskId }).catch(
          () => undefined,
        );
      } else {
        try {
          const memorySync = await finalizeAgentTaskMemory({
            homeDir: agentTaskMemory.homeDir,
            taskId,
          });
          const hasIssues = memorySync.conflicted.length > 0 || memorySync.rejected.length > 0;
          logger[hasIssues ? 'warn' : 'info'](
            {
              taskId,
              agentId: taskAgentId,
              applied: memorySync.applied,
              merged: memorySync.merged,
              conflicted: memorySync.conflicted,
              deleted: memorySync.deleted,
              rejected: memorySync.rejected,
            },
            'Agent memory synced',
          );
        } catch (error) {
          logger.warn(
            {
              taskId,
              agentId: taskAgentId,
              error: error instanceof Error ? error.message : String(error),
            },
            'Agent memory sync failed (non-fatal)',
          );
        }
      }
    }

    sessionId = await refreshTaskSessionCanonicalId({
      db,
      taskId,
      sessionId,
      logger,
      stage: 'pre-completion',
    });

    // Persist runtime backend (always) and SDK session ID (when available).
    // runtimeBackend must be written unconditionally so that subsequent messages
    // in the same thread inherit the runtime (e.g. codex) even when no
    // sdkSessionId is returned (codex does not use the Agent SDK).
    try {
      const runtimeWorkspacePath = runningWorkDir ?? workspace.cwd ?? workspace.workspacePath;
      await persistWorkerRuntimeState(db, {
        sessionId,
        agentId: taskAgentId,
        runtimeBackend: adapter.name(),
        sdkSessionId: newSdkSessionId,
        // Substrate that produced this sdkSessionId (D15): the remote machine
        // when dispatched remotely, NULL for a server-local turn. Written in the
        // same statement as sdkSessionId so the next turn's switch check is exact.
        sdkSessionMachineId: executedOnMachineId,
        // Generic runs have no worktree; persisting the per-agent home (or
        // scratch) as `workspacePath` would make the next turn mistake it for a
        // worktree and switch into self-dev mode. Clear any stale worktree state
        // (explicit null, not undefined, so it overwrites a prior value) so the
        // run stays generic and resolves the same home again.
        workspacePath: hasUsableReviewWorkDir
          ? (persistedWorktreePath ?? null)
          : workspaceMode === 'generic'
            ? null
            : runtimeWorkspacePath,
        worktreeBranch: hasUsableReviewWorkDir
          ? currentWorktreeBranch
          : workspaceMode === 'generic'
            ? null
            : currentWorktreeBranch,
        adhocWorkDir: hasUsableReviewWorkDir
          ? persistedAdhocWorkDir
          : (effectiveWorkDir ?? persistedAdhocWorkDir),
      });
      logger.info(
        {
          sessionId,
          agentId: taskAgentId,
          runtimeBackend: adapter.name(),
          sdkSessionId: newSdkSessionId,
        },
        'Persisted session state',
      );
    } catch (err) {
      logger.error({ sessionId, err }, 'Failed to persist session state');
    }

    // Audit: record the machine a remote task executed on (D8/execution-audit).
    if (executedOnMachineId) {
      try {
        await db
          .update(tasks)
          .set({ executedOnMachineId, updatedAt: new Date() })
          .where(eq(tasks.id, taskId));
      } catch (err) {
        logger.warn(
          { taskId, executedOnMachineId, err },
          'Failed to record executed_on_machine_id',
        );
      }
    }
    throwIfRuntimeWatchdogSettled(taskId);

    // Collect artifacts: a remote dispatch reports refs via the daemon's
    // artifacts frame (the server-local scratch dir is empty by definition);
    // local runs scan the workspace artifacts directory as before.
    const collectedArtifacts =
      remoteMachine && adapter
        ? await adapter.collectArtifacts(taskId)
        : await collectArtifactsFromDir(workspace.artifactsDir);
    throwIfRuntimeWatchdogSettled(taskId);

    const taskRunStatus = runtimeOutcomeToTaskRunStatus(
      {
        error: errorMessage,
        cancelled: taskCancelled,
      },
      runtimeCancellationSourceOverrides.get(taskId) ?? runtimeCancellationSource,
    );
    if (taskRunRecord) {
      await db
        .update(taskRuns)
        .set({
          status: taskRunStatus,
          exitCode: errorMessage ? 1 : 0,
          completedAt: new Date(),
          lastHeartbeatAt: new Date(),
        })
        .where(eq(taskRuns.id, taskRunRecord.id));
    }

    // Store artifacts in DB
    for (const artifact of collectedArtifacts) {
      await db.insert(artifactsTable).values({
        taskId,
        runId: taskRunRecord?.id ?? null,
        artifactType: 'output',
        name: artifact.name,
        storageUri: artifact.path,
        sha256: artifact.sha256,
        mimeType: artifact.mimeType,
        sizeBytes: artifact.sizeBytes ?? null,
      });
    }
    throwIfRuntimeWatchdogSettled(taskId);

    const contractWakeDeps = {
      listWaitingContracts: (query: { messageId: string; waitingOnAgentId: string }) =>
        listWaitingContractsByMessage(db, query),
      transitionContract: (contractId: string, to: 'woken' | 'cancelled') =>
        transitionWaitingContract(db, contractId, to),
      revertContract: (contractId: string, from: 'woken' | 'cancelled') =>
        revertWaitingContractClaim(db, contractId, from),
      resolveAgentMention: resolveAgentMentionTarget,
      ...(taskFeishuClient
        ? {
            sendVisibleRelayWake: async (message: {
              chatId: string;
              text: string;
              replyToMessageId?: string;
              uuid: string;
            }) => {
              const result = await taskFeishuClient!.sendMessage(
                'chat_id',
                message.chatId,
                { msg_type: 'text', content: { text: message.text } },
                message.replyToMessageId,
                { uuid: message.uuid },
              );
              await aliasSentFeedbackMessages([result.messageId]);
              return { messageId: result.messageId };
            },
          }
        : {}),
      logger,
    };

    // Final transition and feedback
    if (errorMessage) {
      const failedStatus = taskRunStatus === 'cancelled' ? TaskStatus.CANCELLED : TaskStatus.FAILED;
      await transitionTaskOrDeliverDiscussionTurn({
        taskId,
        sessionId,
        agentId: taskAgentId,
        feishuAppId: taskFeishuAppId,
        taskType: job.data.taskType,
        goal,
        runtimeHint,
        constraints: rawTaskConstraints,
        content: null,
        status: failedStatus,
        errorMessage,
      });
      try {
        const delegation = await failAgentDelegationForChildTask(db, taskId, errorMessage);
        if (delegation) {
          await enqueueDelegationBarrierWake(taskId);
        }
      } catch (delegationErr) {
        logger.warn({ taskId, delegationErr }, 'Failed to persist delegated task failure');
      }
      try {
        await deliverWaitingContractWakes(contractWakeDeps, {
          taskId,
          agentId: taskAgentId,
          constraints: rawTaskConstraints,
          outcome: 'failed',
        });
      } catch (contractErr) {
        logger.warn({ taskId, contractErr }, 'Failed to cancel waiting contracts on task failure');
      }
      const failureBody = withMachineFooter(errorMessage, remoteMachine) ?? errorMessage;
      await handleChatMemorySummaryFailure(
        {
          markResult: (input) => markChatMemorySummaryResult(db, input),
          logger,
        },
        {
          taskId,
          taskType: job.data.taskType,
          constraints: rawTaskConstraints,
          errorMessage,
        },
      );
      if (feedback) {
        if (isQuotaExceededError(errorMessage)) {
          await feedback.notifyQuotaExceeded(executionGoal, failureBody);
        } else {
          await feedback.updateFailed(executionGoal, failureBody);
        }
      }
      try {
        await deliverDocumentCommentTaskFailure({
          taskId,
          feishuAppId: taskFeishuAppId ?? null,
          client: taskFeishuClient,
          constraints: rawTaskConstraints,
          failureBody,
        });
      } catch (documentCommentErr) {
        logger.warn(
          { taskId, documentCommentErr },
          'Failed to send document comment failure reply',
        );
      }
      await updateFeedbackState('failed');
      if (taskFeishuClient && userMessageId && userMessageReactionId) {
        await removeAckReactionViaChannel(
          taskChannelSender ?? createLarkChannelSender(taskFeishuClient),
          { messageId: userMessageId, reactionId: userMessageReactionId, reason: 'after task failure' },
          logger,
        );
      }
      logger.error({ taskId, error: errorMessage }, 'Task failed');
    } else {
      // Per-identity usage for this completed turn was already charged at the
      // single accounting seam above (right after the runtime outcome settled),
      // so there is no recording here — keeping success vs failure a single
      // mutually exclusive charge.
      const outputText = taskResult?.output?.text ?? '';
      const finalReply = extractRuntimeFinalReply(outputText);
      const completionOutputText = finalReply.outputText;
      const assistantHistoryContent = selectAssistantHistoryContent({
        outputText: completionOutputText,
        finalReplyText: finalReply.finalReplyText,
      });
      const userFacingCompletionContent = selectUserFacingResponseContent({
        outputText: completionOutputText,
        finalReplyText: finalReply.finalReplyText,
      });
      const completedTaskResult = taskResult
        ? {
            ...taskResult,
            output: {
              ...taskResult.output,
              text: completionOutputText,
            },
          }
        : { output: completionOutputText };

      const handoffDeps = {
        createDelegatedTask: (delegationInput: Parameters<typeof createDelegatedTask>[1]) =>
          createDelegatedTask(db, delegationInput),
        resolveAgentByHandle: async (ref: string) => {
          const fromRoster = resolveHandoffTargetFromCandidates(ref, handoffCandidates);
          if (fromRoster) return fromRoster;
          // An unknown `agent_N` short code (model hallucinated a code not in the
          // roster) must NOT fall through to the legacy handle lookup — a real
          // agent literally named "agent_5" would then receive the handoff. Only
          // non-shortcode refs (older `{"handle":"<name>"}` prompts) fall back.
          if (/^agent_\d+$/.test(ref)) return null;
          return resolveHandoffTargetByHandle(ref, tenantKey ?? 'default');
        },
        enqueue: (jobData: TaskJobData) => queue.enqueue(jobData),
        deleteLease: (delegatedTaskId: string) => deleteAdmissionLease(db, delegatedTaskId),
        ...(taskFeishuClient
          ? {
              sendVisibleRelayWake: async (message: {
                chatId: string;
                text: string;
                replyToMessageId?: string;
                uuid: string;
              }) => {
                const result = await taskFeishuClient!.sendMessage(
                  'chat_id',
                  message.chatId,
                  { msg_type: 'text', content: { text: message.text } },
                  message.replyToMessageId,
                  { uuid: message.uuid },
                );
                await aliasSentFeedbackMessages([result.messageId]);
                return { messageId: result.messageId };
              },
            }
          : {}),
        logger,
      };
      const completion = await completeSuccessfulTaskAfterHandoffs(
        {
          handoff: handoffDeps,
          contractWake: contractWakeDeps,
          terminalTransition: {
            deliverCompletedDiscussionTurn,
            taskLifecycle,
          },
          logger,
        },
        {
          taskId,
          sessionId,
          agentId: taskAgentId,
          feishuAppId: taskFeishuAppId,
          taskType: job.data.taskType,
          goal,
          runtimeHint,
          constraints: rawTaskConstraints,
          result: completedTaskResult,
          content: assistantHistoryContent,
          parentWorkspacePath: runningWorkDir ?? workspace.cwd ?? workspace.workspacePath,
        },
      );
      if (completion.status !== 'completed') return;
      await handleChatMemorySummaryCompletion(
        {
          commitUpdate: (input) => commitChatMemoryUpdate(db, input),
          markResult: (input) => markChatMemorySummaryResult(db, input),
          logger,
        },
        {
          taskId,
          taskType: job.data.taskType,
          constraints: rawTaskConstraints,
          outputText: assistantHistoryContent,
        },
      );
      try {
        const delegation = await completeAgentDelegationForChildTask(
          db,
          taskId,
          completedTaskResult,
        );
        if (delegation) {
          await enqueueDelegationBarrierWake(taskId);
        }
      } catch (delegationErr) {
        logger.warn({ taskId, delegationErr }, 'Failed to persist delegated task result');
      }

      // Write side of the verified shared context (DeLM): fire-and-forget
      // externalize this turn's result as a verified gist. `@`-mention
      // coordination is unchanged — this only populates the shared memory the
      // read path hydrates, and never blocks or fails the completed task.
      recordTurnGistBestEffort(
        { db, logger, enabled: SHARED_CONTEXT_WRITE_ENABLED },
        {
          sessionId,
          authorAgentId: taskAgentId,
          authorAgentKind: adapter.name(),
          authorMachineId: executedOnMachineId,
          taskType: job.data.taskType,
          goal,
          resultText: assistantHistoryContent,
        },
      );
      if (feedback) {
        const doneResult = await feedback.updateDone(
          executionGoal,
          withMachineFooter(completionOutputText || undefined, remoteMachine),
          {
            completionText: finalReply.finalReplyText,
            allowedMentions: feishuRuntimeContext?.mentions ?? [],
          },
        );
        await aliasSentFeedbackMessages(doneResult?.sentMessageIds);
      }
      const documentCommentDelivery = await deliverDocumentCommentTaskReply({
        client: taskFeishuClient,
        constraints: rawTaskConstraints,
        content: userFacingCompletionContent,
      });
      if (documentCommentDelivery.status === 'delivered') {
        logger.info(
          {
            taskId,
            commentId: documentCommentDelivery.target?.commentId,
            replyId: documentCommentDelivery.replyId,
          },
          'Delivered document comment task reply',
        );
      } else if (documentCommentDelivery.status === 'delivered_fallback') {
        logger.info(
          {
            taskId,
            commentId: documentCommentDelivery.target?.commentId,
            fallbackCommentId: documentCommentDelivery.fallbackCommentId,
            fallbackReplyId: documentCommentDelivery.fallbackReplyId,
            originalError: documentCommentDelivery.error,
          },
          'Delivered document comment task reply via fallback comment',
        );
      } else if (documentCommentDelivery.status === 'failed') {
        logger.warn(
          {
            taskId,
            commentId: documentCommentDelivery.target?.commentId,
            err: documentCommentDelivery.error,
          },
          'Failed to deliver document comment task reply',
        );
      } else if (documentCommentDelivery.status === 'missing_client') {
        logger.warn(
          { taskId, feishuAppId: taskFeishuAppId },
          'Missing Feishu client for document comment reply',
        );
      } else if (rawTaskConstraints.feedbackChannel === 'document_comment') {
        logger.warn({ taskId }, 'Document comment feedback channel missing delivery target');
      }
      await updateFeedbackState('completed');
      if (taskFeishuClient && userMessageId && userMessageReactionId) {
        await removeAckReactionViaChannel(
          taskChannelSender ?? createLarkChannelSender(taskFeishuClient),
          { messageId: userMessageId, reactionId: userMessageReactionId, reason: 'after task completion' },
          logger,
        );
      }

      // Capture PR URL from dev task output.
      if ((isExternalProject || isSelfDev) && assistantHistoryContent) {
        const prMatch = assistantHistoryContent.match(/https:\/\/github\.com\/[^\s)]+\/pull\/\d+/);
        if (prMatch) {
          await db
            .update(sessions)
            .set({ prUrl: prMatch[0], updatedAt: new Date() })
            .where(eq(sessions.id, sessionId));
          logger.info({ sessionId, prUrl: prMatch[0] }, 'Captured PR URL from dev task');
        }
      }

      // Store assistant response for conversation history (truncate to prevent budget overflow)
      if (assistantHistoryContent.trim()) {
        try {
          const storedContent = truncateAssistantHistoryContent(assistantHistoryContent);
          await db.insert(messages).values({
            sessionId,
            agentId: taskAgentId,
            feishuAppId: taskFeishuAppId,
            role: 'assistant',
            content: storedContent,
            contentType: 'text',
            tokenEstimate: estimateTokens(storedContent),
          });
        } catch (err) {
          logger.warn({ taskId, sessionId, err }, 'Failed to store assistant message');
        }
      }

      logger.info({ taskId }, 'Task completed successfully');
    }
  } catch (err) {
    if (err instanceof RuntimeWatchdogSettledError) {
      logger.warn({ taskId, err }, 'Task processing stopped after watchdog settlement');
      return;
    }
    if (err instanceof DiscussionTurnRenderError) {
      logger.error(
        { taskId, err: err.cause },
        'Discussion turn render failed after terminal commit; retrying without rewriting task state',
      );
      throw err;
    }
    rethrowDiscussionTerminalCommitError(err, logger, taskId);
    const errMsg = err instanceof Error ? err.message : 'Unknown error';
    if (err instanceof BudgetExceededError) {
      // Deliberate fail-closed admission block (already audited + logged with
      // full context by the gate). Finalize through the shared failure path, but
      // at warn — this is policy enforcement, not a fault.
      logger.warn({ taskId }, 'Task blocked at admission by identity budget; finalizing as failed');
    } else {
      logger.error({ taskId, err }, 'Task processing failed');
    }

    // Resolve the live checklist to a failed state on the abnormal (thrown)
    // path too; no-op when no checklist was ever created. Swallows internally.
    await checklist?.finalize('failed');

    await persistRuntimeEvent({ type: 'failed', error: errMsg });
    if (taskRunRecord) {
      try {
        await db
          .update(taskRuns)
          .set({
            status: 'failed',
            exitCode: 1,
            completedAt: new Date(),
            lastHeartbeatAt: new Date(),
          })
          .where(eq(taskRuns.id, taskRunRecord.id));
      } catch (runErr) {
        logger.warn({ taskId, runId: taskRunRecord.id, runErr }, 'Failed to mark task run failed');
      }
    }

    // The catch below rethrows, so reaching the code after this try/catch
    // means the terminal state transition was committed.
    try {
      sessionId = await refreshTaskSessionCanonicalId({
        db,
        taskId,
        sessionId,
        logger,
        stage: 'pre-failure-transition',
      });
      await transitionTaskOrDeliverDiscussionTurn({
        taskId,
        sessionId,
        agentId: taskAgentId,
        feishuAppId: taskFeishuAppId,
        taskType: job.data.taskType,
        goal,
        runtimeHint,
        constraints: rawTaskConstraints,
        status: TaskStatus.FAILED,
        errorMessage: errMsg,
        content: null,
      });
    } catch (transitionErr) {
      logger.error({ taskId, transitionErr }, 'Failed to atomically transition failed task state');
      throw transitionErr;
    }

    try {
      const delegation = await failAgentDelegationForChildTask(db, taskId, errMsg);
      if (delegation) {
        await enqueueDelegationBarrierWake(taskId);
      }
    } catch (delegationErr) {
      logger.warn({ taskId, delegationErr }, 'Failed to persist delegated task failure');
    }

    const failureBody = withMachineFooter(errMsg, remoteMachine) ?? errMsg;
    if (feedback) {
      try {
        if (isQuotaExceededError(errMsg)) {
          await feedback.notifyQuotaExceeded(executionGoal, failureBody);
        } else {
          await feedback.updateFailed(executionGoal, failureBody);
        }
      } catch {
        logger.error({ taskId }, 'Failed to send failure card');
      }
    }
    try {
      await deliverDocumentCommentTaskFailure({
        taskId,
        feishuAppId: taskFeishuAppId ?? null,
        client: taskFeishuClient,
        constraints: rawTaskConstraints,
        failureBody,
      });
    } catch (documentCommentErr) {
      logger.warn({ taskId, documentCommentErr }, 'Failed to send document comment failure reply');
    }
    try {
      await updateFeedbackState('failed');
    } catch (feedbackStateErr) {
      logger.warn({ taskId, feedbackStateErr }, 'Failed to persist feedback failure state');
    }
    if (taskFeishuClient && userMessageId && userMessageReactionId) {
      await removeAckReactionViaChannel(
        taskChannelSender ?? createLarkChannelSender(taskFeishuClient),
        { messageId: userMessageId, reactionId: userMessageReactionId, reason: 'after task error' },
        logger,
      );
    }
  } finally {
    runtimeWatchdog?.unregister(taskId);
    remoteExecutionTracker.unregister(taskId);
    runtimeCancellationSourceOverrides.delete(taskId);
    admissionSlotReleaser.releaseAll();
    runtimeSettlementFence.clear(taskId);
    // NOTE: We intentionally do NOT clean up session-stable workspaces here.
    // Claude Agent SDK stores session data in ~/.claude/projects/{cwd-encoded}/,
    // so the workspace directory must persist for future resume() calls.
    // Workspace cleanup should be handled by a separate garbage collection process.
  }
}

// ── Main ──
async function main(): Promise<void> {
  logger.info('Worker starting...');
  logger.info({ instanceId: INSTANCE_ID }, 'Worker instance configured');
  registerWorkerProcess();

  // 0. Load soul (identity + style prompt prefix)
  SOUL = loadSoul();
  if (SOUL) {
    logger.info('Soul loaded successfully');
  } else {
    logger.info('No soul files found, running without soul');
  }

  // 1. Database
  db = createDb(DATABASE_URL);
  logger.info({ databaseUrl: DATABASE_URL.replace(/:[^:@]+@/, ':***@') }, 'Database configured');

  // 2. LLM client (for workdir extraction and other agent-level tasks)
  llmClient = createLlmClientFromEnv();
  if (llmClient) {
    logger.info({ provider: llmClient.provider() }, 'LLM client configured for workdir extraction');
  } else {
    logger.info(
      'No LLM client configured (OPEN_TAG_LLM_PROVIDER not set), workdir extraction disabled',
    );
  }

  // 3. Feishu clients (for sending replies)
  feishuClientRegistry = await createWorkerFeishuClientRegistry({
    db,
    disabled: FEISHU_ACCESS_DISABLED,
    primaryAppId: FEISHU_APP_ID,
    primaryAppSecret: FEISHU_APP_SECRET,
    logger,
  });
  feishuClient = feishuClientRegistry.primaryClient;
  // Slack senders (optional): a per-team SlackChannel registry resolves a
  // Slack-dispatched task's terminal feedback to ITS OWN workspace's channel by
  // team_id (Slack Milestone 1a). The env SLACK_BOT_TOKEN is the single-workspace
  // fallback (registry.primarySender); both API and worker read the same store.
  slackClientRegistry = await createWorkerSlackClientRegistry({
    db,
    primaryToken: SLACK_BOT_TOKEN,
    logger,
  });
  slackSender = slackClientRegistry.primarySender;
  logger.info(
    {
      registeredTeamCount: slackClientRegistry.registeredTeamIds().length,
      hasEnvFallback: Boolean(slackSender),
    },
    'Slack client registry configured for non-lark task feedback delivery',
  );
  if (FEISHU_ACCESS_DISABLED) {
    logger.info(
      { instanceId: INSTANCE_ID, instanceRole: INSTANCE_ROLE },
      'Feishu access disabled for this worker instance',
    );
  } else {
    logger.info(
      { registeredAppCount: feishuClientRegistry.registeredAppIds().length },
      'Feishu client registry configured',
    );
  }

  const feishuTaskSync = feishuClient
    ? new FeishuTaskSyncService({
        client: feishuClient,
        repository: new DrizzleFeishuTaskTrackingRepository(db),
        config: createFeishuTaskTrackingConfigFromEnv(),
        logger,
      })
    : null;
  taskLifecycle = new TaskLifecycleService(
    db,
    feishuTaskSync
      ? {
          async onTaskStatusChanged(event) {
            await feishuTaskSync.syncTaskStatus({
              taskId: event.taskId,
              localStatus: event.localStatus,
              interactionReason: normalizeInteractionReason(event.interactionReason),
            });
          },
        }
      : undefined,
    logger,
  );
  logger.info(
    { enabled: createFeishuTaskTrackingConfigFromEnv().enabled },
    'Feishu Task tracking lifecycle observer configured',
  );

  // 4. Runtime adapters — built from a single data-driven registration list
  // (the same `buildRuntimeManager` factory the daemon uses). Adding a runtime
  // is one more list entry, not another bespoke registration block.
  const codexBinaryPath = resolveCodexBinaryPath();
  runtimeManager = buildRuntimeManager([
    // Claude registers unconditionally; per-agent BASE_URL / API_KEY (runtimeEnv)
    // can supply custom credentials at execution time. Without those, Claude Code
    // can use the local login state on the execution host, with global
    // ANTHROPIC_* env as an optional fallback default.
    claudeRuntimeRegistration({ imageDownloader: feishuClient ?? undefined }),
    {
      // Codex registers unconditionally; an unresolved binary falls back to the
      // SDK-default codex.
      isAvailable: () => true,
      create: () =>
        new CodexAdapter({
          binaryPath: codexBinaryPath,
          imageDownloader: feishuClient ?? undefined,
        }),
    },
  ]);
  logger.info(
    { globalFallback: Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) },
    'Registered ClaudeCodeAdapter',
  );
  logger.info({ binaryPath: codexBinaryPath ?? 'sdk-default' }, 'Registered CodexAdapter');

  // 4b. Daemon gateway (remote execution). Started with the worker lifecycle.
  // A bind failure (e.g. port conflict) must not take the worker down: local
  // execution keeps working, and machine-bound tasks fail fast with a clear
  // gateway-unavailable reason instead (D8 — never silently fall back local).
  daemonGateway = new DaemonGateway({
    db,
    logger,
    port: DAEMON_GATEWAY_PORT,
    publicBind: DAEMON_GATEWAY_PUBLIC,
    // Announce successful pairing in the issuing chat — skipped silently when
    // Feishu access is disabled (mirrors the FEISHU_ACCESS gate above).
    announcePairing:
      FEISHU_ACCESS_DISABLED || !feishuClient
        ? undefined
        : async ({ chatId, machineName }) => {
            await feishuClient!.sendMessage('chat_id', chatId, {
              msg_type: 'text',
              content: { text: `🖥 Machine "${machineName}" paired and ready to run tasks.` },
            });
          },
  });
  try {
    await daemonGateway.start();
  } catch (gatewayErr) {
    logger.error(
      { err: gatewayErr, port: DAEMON_GATEWAY_PORT },
      'Daemon gateway failed to start; continuing without remote execution',
    );
    daemonGateway = null;
  }

  runtimeWatchdog = new RuntimeWatchdog({
    startupTimeoutMs: RUNTIME_STARTUP_TIMEOUT_MS,
    stalledTimeoutMs: RUNTIME_STALLED_TIMEOUT_MS,
    stalledRecoverySigtermTimeoutMs: STALLED_RECOVERY_SIGTERM_TIMEOUT_MS,
    errorBackoffMs: RUNTIME_WATCHDOG_ERROR_BACKOFF_MS,
    cancelExecution: async (executionId, source, options) => {
      runtimeCancellationSourceOverrides.set(executionId, source);
      // Machine-bound executions live in the tracker, not the local manager —
      // without this, a stalled remote task was failed server-side while the
      // user's machine kept executing it (task_cancel was never sent).
      const remoteOutcome = await remoteExecutionTracker.cancel(executionId, options);
      if (remoteOutcome !== null) return remoteOutcome;
      return runtimeManager.cancel(executionId, options);
    },
    failExecution: (executionId, source, reason) => {
      runtimeCancellationSourceOverrides.set(executionId, source);
      return failRuntimeExecutionFromWatchdog(executionId, reason);
    },
    logger,
  });
  runtimeWatchdogTimer = setInterval(() => {
    void runtimeWatchdog?.scan().catch((err) => {
      logger.error({ err }, 'Runtime watchdog scan failed');
    });
  }, RUNTIME_WATCHDOG_INTERVAL_MS);
  runtimeWatchdogTimer.unref();
  logger.info(
    {
      intervalMs: RUNTIME_WATCHDOG_INTERVAL_MS,
      startupTimeoutMs: RUNTIME_STARTUP_TIMEOUT_MS,
      stalledTimeoutMs: RUNTIME_STALLED_TIMEOUT_MS,
      stalledRecoverySigtermTimeoutMs: STALLED_RECOVERY_SIGTERM_TIMEOUT_MS,
      errorBackoffMs: RUNTIME_WATCHDOG_ERROR_BACKOFF_MS,
    },
    'Runtime watchdog configured',
  );

  // Health checks disabled — SDK availability is determined by config at
  // registration time. Runtime failures surface naturally during execution.

  // 5. Task queue
  admissionScheduler = new AgentAdmissionScheduler(
    parseSchedulerConfigFromEnv({
      ...process.env,
      AGENT_MAX_CONCURRENCY: process.env.AGENT_MAX_CONCURRENCY ?? String(WORKER_CONCURRENCY),
    }),
  );
  logger.info(
    {
      scheduler: admissionScheduler.snapshot(),
      reschedulerIntervalMs: ADMISSION_RESCHEDULER_INTERVAL_MS,
    },
    'Admission scheduler configured',
  );

  queue = new TaskQueue(DATABASE_URL);
  await queue.start();
  admissionReschedulerTimer = setInterval(() => {
    void runAdmissionReschedulerOnce();
  }, ADMISSION_RESCHEDULER_INTERVAL_MS);
  admissionReschedulerTimer.unref();
  const recoveryResult = await recoverStaleRunningTasks({ db, queue, logger });
  logger.info(recoveryResult, 'Startup recovery finished');
  if (AGENT_MEMORY_ENABLED) {
    // Janitor: clear memory checkouts left behind by crashed runs.
    void sweepAgentMemoryRuns(joinPath(openClaudeTagHome(), 'agents'))
      .then((removed) => {
        if (Object.keys(removed).length > 0) {
          logger.info({ removed }, 'Swept stale agent memory checkouts');
        }
      })
      .catch((error: unknown) => {
        logger.warn(
          { error: error instanceof Error ? error.message : String(error) },
          'Agent memory janitor failed',
        );
      });
  }
  await queue.subscribe(processTask, WORKER_CONCURRENCY);
  logger.info('Worker is ready and waiting for tasks');

  // 6. Graceful shutdown
  let shuttingDown = false;
  const stopWorkerResources = async (queueTimeoutMs: number): Promise<void> => {
    // Cancel all active runtime executions first so child processes are killed
    // before the queue shuts down (prevents orphaned codex/claude processes).
    runtimeManager.cancelAll();
    remoteExecutionTracker.cancelAll();
    if (admissionReschedulerTimer) {
      clearInterval(admissionReschedulerTimer);
      admissionReschedulerTimer = null;
    }
    if (runtimeWatchdogTimer) {
      clearInterval(runtimeWatchdogTimer);
      runtimeWatchdogTimer = null;
    }
    if (daemonGateway) {
      try {
        await daemonGateway.stop();
      } catch (gatewayErr) {
        logger.warn({ gatewayErr }, 'Failed to stop daemon gateway cleanly');
      }
      daemonGateway = null;
    }
    if (queue) {
      await queue.gracefulShutdown(queueTimeoutMs);
    }
    unregisterWorkerProcess();
  };

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Received shutdown signal, gracefully stopping...');
    try {
      await stopWorkerResources(GRACEFUL_SHUTDOWN_TIMEOUT);
    } catch (err) {
      logger.error({ err, signal }, 'Error during graceful shutdown');
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('exit', () => {
    unregisterWorkerProcess();
  });
  installFatalProcessHandlers({
    logger,
    // Keep the fatal path short: kill child processes and release the queue
    // so another worker can pick up the jobs, then exit non-zero.
    cleanup: () => stopWorkerResources(5000),
  });

  // Keep process alive
  await new Promise(() => {});
}

main().catch((err) => {
  unregisterWorkerProcess();
  logger.error(err, 'Worker failed to start');
  process.exit(1);
});
