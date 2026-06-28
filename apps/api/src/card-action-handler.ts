import { randomUUID } from 'crypto';
import type { Logger } from 'pino';
import { desc, eq } from 'drizzle-orm';
import { feishuCardActionReceipts, sessions, taskRuns, tasks } from '@open-tag/storage';
import type { Database } from '@open-tag/storage';
import { TaskStatus, errorMessage } from '@open-tag/core-types';
import type { IntentType } from '@open-tag/core-types';
import {
  FeishuClient,
  TASK_CARD_ACTION_RETRY,
  TASK_CARD_ACTION_RETRY_RUNTIME,
  WORKDIR_FORM_SUBMIT,
  WORKDIR_FORM_CANCEL,
  ThreePhaseFeedback,
  createFeishuChannelSender,
  type TaskCardActionValue,
  type WorkDirFormActionValue,
} from '@open-tag/feishu-adapter';
import type { TaskQueue } from '@open-tag/queue';
import { transitionTask } from '@open-tag/orchestrator';
import { getRuntimeDescriptor } from '@open-tag/runtime-adapters';
import { buildQueuedTaskInput } from './task-dispatch.js';

interface TaskCardActionEvent {
  event_id?: string;
  open_message_id?: string;
  open_chat_id?: string;
  tenant_key?: string;
  open_id?: string;
  token?: string;
  header?: {
    event_id?: string;
  };
  context?: {
    open_chat_id?: string;
  };
  operator?: {
    open_id?: string;
  };
  action?: {
    value?: Record<string, unknown>;
    tag?: string;
    form_value?: Record<string, unknown>;
  };
}

interface TaskCardActionResponse {
  toast: {
    type: 'success' | 'info' | 'warning' | 'error';
    content: string;
  };
}

interface TaskCardActionHandlerDeps {
  db: Database;
  feishuClient: FeishuClient;
  feishuClientResolver?: (feishuAppId?: string | null) => FeishuClient | null;
  queue: TaskQueue;
  logger: Logger;
  taskLifecycle?: {
    transitionTask(
      taskId: string,
      newStatus: TaskStatus,
      extra?: { errorMessage?: string; result?: unknown; interactionReason?: string | null },
    ): Promise<void>;
  };
}

const CARD_ACTION_DEDUP_TTL_MS = 15 * 60 * 1000;

interface OriginalTaskRecord {
  id: string;
  sessionId: string;
  taskType: string;
  goal: string;
  status: string;
  runtimeHint: string | null;
  constraints: unknown;
  agentId: string | null;
  feishuAppId: string | null;
}

type TaskFileAttachment = {
  resourceKey: string;
  messageId: string;
  resourceType: 'file' | 'audio' | 'media';
  fileName?: string;
  mimeType?: string;
};

function buildToast(
  type: TaskCardActionResponse['toast']['type'],
  content: string,
): TaskCardActionResponse {
  return {
    toast: {
      type,
      content,
    },
  };
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function getRecordString(record: Record<string, unknown>, key: string): string | undefined {
  return nonEmptyString(record[key]);
}

function normalizeTaskFileAttachment(value: unknown): TaskFileAttachment | undefined {
  if (!isObjectRecord(value)) {
    return undefined;
  }

  const resourceKey = nonEmptyString(value.resourceKey);
  const messageId = nonEmptyString(value.messageId);
  if (!resourceKey || !messageId) {
    return undefined;
  }

  const resourceType =
    value.resourceType === 'audio' || value.resourceType === 'media'
      ? value.resourceType
      : 'file';

  return {
    resourceKey,
    messageId,
    resourceType,
    ...(typeof value.fileName === 'string' ? { fileName: value.fileName } : {}),
    ...(typeof value.mimeType === 'string' ? { mimeType: value.mimeType } : {}),
  };
}

function getCardActionDedupKey(event: TaskCardActionEvent): string | undefined {
  return (
    nonEmptyString(event.header?.event_id) ??
    nonEmptyString(event.event_id) ??
    nonEmptyString(event.token)
  );
}

function buildPersistentCardActionDedupKey(input: {
  sourceTaskId: string;
  action: string;
  operatorOpenId?: string;
}): string {
  return [
    'task-card-action',
    input.sourceTaskId,
    input.action,
    input.operatorOpenId ?? 'unknown-operator',
  ].join(':');
}

function isDuplicateCardAction(
  seenActionKeys: Map<string, number>,
  dedupKey: string | undefined,
): boolean {
  if (!dedupKey) {
    return false;
  }

  const now = Date.now();
  for (const [key, firstSeenAt] of seenActionKeys) {
    if (now - firstSeenAt > CARD_ACTION_DEDUP_TTL_MS) {
      seenActionKeys.delete(key);
    }
  }

  if (seenActionKeys.has(dedupKey)) {
    return true;
  }

  seenActionKeys.set(dedupKey, now);
  return false;
}

function getOperatorOpenId(event: TaskCardActionEvent): string | undefined {
  return nonEmptyString(event.open_id) ?? nonEmptyString(event.operator?.open_id);
}

function getEventChatId(event: TaskCardActionEvent): string | undefined {
  return nonEmptyString(event.open_chat_id) ?? nonEmptyString(event.context?.open_chat_id);
}

function getRequesterOpenIdFromConstraints(value: unknown): string | undefined {
  if (!isObjectRecord(value)) {
    return undefined;
  }

  const direct =
    getRecordString(value, 'requesterOpenId') ??
    getRecordString(value, 'senderOpenId') ??
    getRecordString(value, 'openId');
  if (direct) {
    return direct;
  }

  const feishuContext = value.feishuContext;
  return isObjectRecord(feishuContext)
    ? getRecordString(feishuContext, 'senderOpenId')
    : undefined;
}

function isOperatorAuthorized(event: TaskCardActionEvent, constraints: unknown): boolean {
  const requesterOpenId = getRequesterOpenIdFromConstraints(constraints);
  if (!requesterOpenId) {
    return true;
  }

  return getOperatorOpenId(event) === requesterOpenId;
}

function isEventChatAuthorized(event: TaskCardActionEvent, expectedChatId: string): boolean {
  const eventChatId = getEventChatId(event);
  return !eventChatId || eventChatId === expectedChatId;
}

function extractReplyLanguageFromConstraints(value: unknown): 'zh-CN' | 'en-US' | undefined {
  if (!isObjectRecord(value)) {
    return undefined;
  }

  return value.replyLanguage === 'zh-CN' || value.replyLanguage === 'en-US'
    ? value.replyLanguage
    : undefined;
}

function resolveTaskFeishuClient(
  deps: TaskCardActionHandlerDeps,
  feishuAppId?: string | null,
): FeishuClient | null {
  if (!feishuAppId) {
    return deps.feishuClientResolver?.(null) ?? deps.feishuClient;
  }
  return deps.feishuClientResolver?.(feishuAppId) ?? null;
}

async function transitionTaskForDeps(
  deps: TaskCardActionHandlerDeps,
  taskId: string,
  newStatus: TaskStatus,
  extra?: { errorMessage?: string; result?: unknown; interactionReason?: string | null },
): Promise<void> {
  if (deps.taskLifecycle) {
    if (extra === undefined) {
      await deps.taskLifecycle.transitionTask(taskId, newStatus);
    } else {
      await deps.taskLifecycle.transitionTask(taskId, newStatus, extra);
    }
    return;
  }
  if (extra === undefined) {
    await transitionTask(deps.db, taskId, newStatus);
  } else {
    await transitionTask(deps.db, taskId, newStatus, extra);
  }
}

async function markQueuedTaskEnqueueFailed(
  deps: TaskCardActionHandlerDeps,
  taskId: string,
  goal: string,
  feedback: ThreePhaseFeedback | null,
  err: unknown,
): Promise<string> {
  const message = errorMessage(err);
  deps.logger.error({ err, taskId }, 'Failed to enqueue task from card action');

  try {
    await transitionTaskForDeps(deps, taskId, TaskStatus.FAILED, { errorMessage: message });
  } catch (transitionErr) {
    deps.logger.error(
      { err: transitionErr, taskId },
      'Failed to mark card action task failed after enqueue failure',
    );
  }

  if (feedback) {
    try {
      await feedback.updateFailed(goal, message);
    } catch (feedbackErr) {
      deps.logger.warn(
        { err: feedbackErr, taskId },
        'Failed to update card action feedback after enqueue failure',
      );
    }
  }

  const hasFeedbackMessage = Boolean(feedback?.getAckMessageId());
  await deps.db
    .update(tasks)
    .set({
      feedbackState: hasFeedbackMessage ? 'failed' : null,
      feedbackUpdatedAt: hasFeedbackMessage ? new Date() : null,
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, taskId));

  return message;
}

function parseActionValue(value: unknown): TaskCardActionValue | null {
  if (!isObjectRecord(value)) {
    return null;
  }

  const action = value.action;
  const taskId = value.task_id;
  const runtime = value.runtime;

  if (action !== TASK_CARD_ACTION_RETRY && action !== TASK_CARD_ACTION_RETRY_RUNTIME) {
    return null;
  }

  if (typeof taskId !== 'string' || taskId.length === 0) {
    return null;
  }

  if (runtime !== undefined && runtime !== 'codex') {
    return null;
  }

  return {
    action,
    task_id: taskId,
    ...(runtime === 'codex' ? { runtime } : {}),
  };
}

function cloneTaskConstraints(value: unknown, originalTaskId: string, sourceAction: string) {
  const base = isObjectRecord(value) ? { ...value } : {};
  return {
    ...base,
    sourceTaskId: originalTaskId,
    sourceAction,
  };
}

// A known persisted runtime is one present in the data-driven registry (its
// `name()` keys). Behavior-equivalent to the prior `claude_code|codex` literal
// set, but a runtime added to the registry is recognized with no change here.
function isKnownRuntime(
  value: string | null | undefined,
): value is 'claude_code' | 'codex' {
  return value != null && getRuntimeDescriptor(value) !== undefined;
}

function resolveRetryRuntime(
  actionValue: TaskCardActionValue,
  latestRuntime: string | null | undefined,
  originalRuntimeHint: string | null,
): 'claude_code' | 'codex' | 'auto' {
  if (actionValue.action === TASK_CARD_ACTION_RETRY_RUNTIME) {
    return actionValue.runtime ?? 'codex';
  }

  if (isKnownRuntime(latestRuntime)) {
    return latestRuntime;
  }

  if (isKnownRuntime(originalRuntimeHint)) {
    return originalRuntimeHint;
  }

  return 'auto';
}

function parseWorkDirFormAction(value: unknown): WorkDirFormActionValue | null {
  if (!isObjectRecord(value)) return null;
  const action = value.action;
  if (action !== WORKDIR_FORM_SUBMIT && action !== WORKDIR_FORM_CANCEL) return null;
  if (typeof value.taskId !== 'string') return null;
  return value as unknown as WorkDirFormActionValue;
}

export function createTaskCardActionHandler(deps: TaskCardActionHandlerDeps) {
  const seenActionKeys = new Map<string, number>();

  return async function handleTaskCardAction(
    event: TaskCardActionEvent,
  ): Promise<TaskCardActionResponse> {
    const dedupKey = getCardActionDedupKey(event);
    if (isDuplicateCardAction(seenActionKeys, dedupKey)) {
      deps.logger.info({ dedupKey }, 'Ignored duplicate Feishu card action');
      return buildToast('info', 'This card action has already been processed.');
    }

    // Check for workdir form actions first
    const workdirAction = parseWorkDirFormAction(event.action?.value);
    if (workdirAction) {
      return handleWorkDirFormAction(deps, event, workdirAction);
    }

    const actionValue = parseActionValue(event.action?.value);
    if (!actionValue) {
      return buildToast('info', 'Unsupported card action.');
    }

    const [originalTask] = await deps.db
      .select({
        id: tasks.id,
        sessionId: tasks.sessionId,
        taskType: tasks.taskType,
        goal: tasks.goal,
        status: tasks.status,
        runtimeHint: tasks.runtimeHint,
        constraints: tasks.constraints,
        agentId: tasks.agentId,
        feishuAppId: tasks.feishuAppId,
      })
      .from(tasks)
      .where(eq(tasks.id, actionValue.task_id))
      .limit(1);

    const taskRecord = originalTask as OriginalTaskRecord | undefined;
    if (!taskRecord) {
      return buildToast('warning', 'The original task could not be found.');
    }

    if (!isOperatorAuthorized(event, taskRecord.constraints)) {
      deps.logger.warn(
        {
          taskId: taskRecord.id,
          requesterOpenId: getRequesterOpenIdFromConstraints(taskRecord.constraints),
          operatorOpenId: getOperatorOpenId(event),
        },
        'Rejected Feishu card action from non-requester operator',
      );
      return buildToast('warning', 'Only the original requester can use this card action.');
    }

    if (taskRecord.status !== TaskStatus.COMPLETED && taskRecord.status !== TaskStatus.FAILED) {
      return buildToast('warning', 'This task is not ready to rerun yet.');
    }

    const [sessionRow] = await deps.db
      .select({
        chatId: sessions.chatId,
        sdkSessionId: sessions.sdkSessionId,
        runtimeBackend: sessions.runtimeBackend,
      })
      .from(sessions)
      .where(eq(sessions.id, taskRecord.sessionId))
      .limit(1);

    if (!sessionRow?.chatId) {
      return buildToast('error', 'The task session is no longer available.');
    }

    if (!isEventChatAuthorized(event, sessionRow.chatId)) {
      deps.logger.warn(
        {
          taskId: taskRecord.id,
          expectedChatId: sessionRow.chatId,
          eventChatId: getEventChatId(event),
        },
        'Rejected Feishu card action from mismatched chat',
      );
      return buildToast('warning', 'This card action is not valid in this chat.');
    }

    const [latestRun] = await deps.db
      .select({
        runtimeBackend: taskRuns.runtimeBackend,
      })
      .from(taskRuns)
      .where(eq(taskRuns.taskId, taskRecord.id))
      .orderBy(desc(taskRuns.startedAt))
      .limit(1);

    const retryRuntime = resolveRetryRuntime(
      actionValue,
      latestRun?.runtimeBackend ?? null,
      taskRecord.runtimeHint,
    );
    const newTaskId = randomUUID();
    const feedbackClient = resolveTaskFeishuClient(deps, taskRecord.feishuAppId);
    if (!feedbackClient) {
      return buildToast('error', 'The task Feishu app client is unavailable.');
    }

    const feedback = new ThreePhaseFeedback(
      createFeishuChannelSender(feedbackClient),
      sessionRow.chatId,
      event.open_message_id,
    );
    await feedback.sendAck(taskRecord.goal);
    const ackMessageId = feedback.getAckMessageId();
    const persistentDedupKey = buildPersistentCardActionDedupKey({
      sourceTaskId: taskRecord.id,
      action: actionValue.action,
      operatorOpenId: getOperatorOpenId(event),
    });
    const [receipt] = await deps.db
      .insert(feishuCardActionReceipts)
      .values({
        dedupKey: persistentDedupKey,
        sourceTaskId: taskRecord.id,
        newTaskId,
        action: actionValue.action,
        operatorOpenId: getOperatorOpenId(event) ?? null,
        eventId: dedupKey ?? null,
      })
      .onConflictDoNothing({ target: feishuCardActionReceipts.dedupKey })
      .returning({ id: feishuCardActionReceipts.id });

    if (!receipt) {
      deps.logger.info(
        { dedupKey: persistentDedupKey, sourceTaskId: taskRecord.id, action: actionValue.action },
        'Ignored persistent duplicate Feishu card action',
      );
      return buildToast('info', 'This card action has already been processed.');
    }

    await deps.db.insert(tasks).values({
      id: newTaskId,
      sessionId: taskRecord.sessionId,
      agentId: taskRecord.agentId,
      feishuAppId: taskRecord.feishuAppId,
      parentTaskId: taskRecord.id,
      taskType: taskRecord.taskType,
      goal: taskRecord.goal,
      runtimeHint: retryRuntime === 'auto' ? null : retryRuntime,
      status: TaskStatus.PENDING,
      constraints: cloneTaskConstraints(taskRecord.constraints, taskRecord.id, actionValue.action),
      feedbackMessageId: ackMessageId || null,
      feedbackCardType: ackMessageId ? 'task_status' : null,
      feedbackState: ackMessageId ? 'queued' : null,
      feedbackUpdatedAt: ackMessageId ? new Date() : null,
    });

    await transitionTaskForDeps(deps, newTaskId, TaskStatus.QUEUED);

    const { isRuntimeSwitch, job } = buildQueuedTaskInput({
      event: {
        chatId: sessionRow.chatId,
        messageId: event.open_message_id ?? `task-card-action:${newTaskId}`,
        content: {
          text: taskRecord.goal,
        },
      } as any,
      sessionId: taskRecord.sessionId,
      agentId: taskRecord.agentId ?? undefined,
      feishuAppId: taskRecord.feishuAppId ?? undefined,
      result: {
        taskId: newTaskId,
        intent: taskRecord.taskType as IntentType,
        runtime: retryRuntime,
        goal: taskRecord.goal,
        imageAttachment: isObjectRecord(taskRecord.constraints)
          ? (taskRecord.constraints.imageAttachment as
              | { imageKey: string; messageId: string }
              | undefined)
          : undefined,
        fileAttachment: isObjectRecord(taskRecord.constraints)
          ? normalizeTaskFileAttachment(taskRecord.constraints.fileAttachment)
          : undefined,
      },
      replyToMessageId: event.open_message_id,
      ackMessageId,
      replyLanguage: extractReplyLanguageFromConstraints(taskRecord.constraints),
      sessionRow: {
        sdkSessionId: sessionRow.sdkSessionId,
        runtimeBackend: sessionRow.runtimeBackend,
      },
    });

    // Retry actions build a synthetic event without content.raw, so the debug
    // skip flag must be copied from the original task constraints explicitly.
    if (
      isObjectRecord(taskRecord.constraints) &&
      taskRecord.constraints.debugSkipExecution === true
    ) {
      job.constraints.debugSkipExecution = true;
    }

    if (isRuntimeSwitch) {
      await deps.db
        .update(sessions)
        .set({ sdkSessionId: null, runtimeBackend: null, updatedAt: new Date() })
        .where(eq(sessions.id, taskRecord.sessionId));
      deps.logger.info(
        {
          sessionId: taskRecord.sessionId,
          from: sessionRow.runtimeBackend,
          to: retryRuntime,
          sourceTaskId: taskRecord.id,
          newTaskId,
        },
        'Task card action switched runtime and cleared SDK session',
      );
    }

    try {
      await deps.queue.enqueue(job);
    } catch (err) {
      const message = await markQueuedTaskEnqueueFailed(
        deps,
        newTaskId,
        taskRecord.goal,
        feedback,
        err,
      );
      return buildToast('error', `Failed to queue task: ${message}`);
    }
    deps.logger.info(
      {
        sourceTaskId: taskRecord.id,
        newTaskId,
        action: actionValue.action,
        runtime: retryRuntime,
      },
      'Task card action enqueued follow-up task',
    );

    return buildToast(
      'success',
      actionValue.action === TASK_CARD_ACTION_RETRY_RUNTIME
        ? 'Queued a new Codex run.'
        : 'Queued a new task run.',
    );
  };
}

function getString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function normalizeRuntime(value: string): 'claude_code' | 'codex' {
  return value === 'codex' ? 'codex' : 'claude_code';
}

async function handleWorkDirFormAction(
  deps: TaskCardActionHandlerDeps,
  event: TaskCardActionEvent,
  actionValue: WorkDirFormActionValue,
): Promise<TaskCardActionResponse> {
  // Idempotency: check that the original task is still in WAITING_APPROVAL
  const [origTask] = await deps.db
    .select({
      status: tasks.status,
      taskType: tasks.taskType,
      constraints: tasks.constraints,
      agentId: tasks.agentId,
      feishuAppId: tasks.feishuAppId,
    })
    .from(tasks)
    .where(eq(tasks.id, actionValue.taskId))
    .limit(1);

  if (!origTask) {
    return buildToast('warning', 'The original task could not be found.');
  }

  if (!isOperatorAuthorized(event, origTask.constraints)) {
    deps.logger.warn(
      {
        taskId: actionValue.taskId,
        requesterOpenId: getRequesterOpenIdFromConstraints(origTask.constraints),
        operatorOpenId: getOperatorOpenId(event),
      },
      'Rejected Feishu workdir form action from non-requester operator',
    );
    return buildToast('warning', 'Only the original requester can use this card action.');
  }

  if (!isEventChatAuthorized(event, actionValue.chatId)) {
    deps.logger.warn(
      {
        taskId: actionValue.taskId,
        expectedChatId: actionValue.chatId,
        eventChatId: getEventChatId(event),
      },
      'Rejected Feishu workdir form action from mismatched chat',
    );
    return buildToast('warning', 'This card action is not valid in this chat.');
  }

  if (origTask.status !== TaskStatus.WAITING_APPROVAL) {
    return buildToast('info', 'This task has already been processed.');
  }

  // Cancel action
  if (actionValue.action === WORKDIR_FORM_CANCEL) {
    try {
      await transitionTaskForDeps(deps, actionValue.taskId, TaskStatus.CANCELLED);
    } catch {
      // Task may already be in a terminal state
    }
    deps.logger.info({ taskId: actionValue.taskId }, 'Workdir form cancelled');
    return buildToast('info', 'Task cancelled.');
  }

  // Submit action — read user-edited values from form_value with safe type checks
  const formValue = event.action?.form_value ?? {};
  const formWorkDir = getString(formValue.workDir) || getString(actionValue.workDir);
  const formGoal = getString(formValue.goal) || getString(actionValue.goal);
  const formRuntime = normalizeRuntime(
    getString(formValue.runtime) || getString(actionValue.runtime) || 'claude_code',
  );
  const originalConstraints = isObjectRecord(origTask.constraints) ? origTask.constraints : {};
  const sourceCommand =
    typeof originalConstraints.sourceCommand === 'string'
      ? originalConstraints.sourceCommand
      : undefined;

  // Persist adhocWorkDir to session
  if (formWorkDir.trim()) {
    await deps.db
      .update(sessions)
      .set({ adhocWorkDir: formWorkDir, updatedAt: new Date() })
      .where(eq(sessions.id, actionValue.sessionId));
  }

  // Create new confirmed task
  const newTaskId = randomUUID();
  const replyToMessageId = actionValue.replyToMessageId;
  const chatId = actionValue.chatId;
  const replyLanguage = actionValue.replyLanguage || 'en-US';

  // Send ACK card for the confirmed task
  const feedbackClient = resolveTaskFeishuClient(deps, origTask.feishuAppId);
  if (!feedbackClient) {
    return buildToast('error', 'The task Feishu app client is unavailable.');
  }
  const feedback = new ThreePhaseFeedback(
    createFeishuChannelSender(feedbackClient),
    chatId,
    replyToMessageId,
  );
  await feedback.sendAck(formGoal);
  const ackMessageId = feedback.getAckMessageId();
  const confirmedConstraints = {
    chatId,
    agentId: origTask.agentId ?? undefined,
    feishuAppId: origTask.feishuAppId ?? undefined,
    ...(formWorkDir.trim() ? { confirmedWorkDir: formWorkDir } : {}),
    confirmedRuntime: formRuntime,
    ...(sourceCommand ? { sourceCommand } : {}),
    replyLanguage,
    replyToMessageId,
    ackMessageId: ackMessageId || undefined,
  };

  await deps.db.insert(tasks).values({
    id: newTaskId,
    sessionId: actionValue.sessionId,
    agentId: origTask.agentId,
    feishuAppId: origTask.feishuAppId,
    parentTaskId: actionValue.taskId,
    taskType: origTask.taskType,
    goal: formGoal,
    runtimeHint: formRuntime,
    status: TaskStatus.PENDING,
    constraints: confirmedConstraints,
    feedbackMessageId: ackMessageId || null,
    feedbackCardType: ackMessageId ? 'task_status' : null,
    feedbackState: ackMessageId ? 'queued' : null,
    feedbackUpdatedAt: ackMessageId ? new Date() : null,
  });

  await transitionTaskForDeps(deps, newTaskId, TaskStatus.QUEUED);

  try {
    await deps.queue.enqueue({
      taskId: newTaskId,
      sessionId: actionValue.sessionId,
      agentId: origTask.agentId ?? undefined,
      feishuAppId: origTask.feishuAppId ?? undefined,
      taskType: origTask.taskType,
      goal: formGoal,
      runtimeHint: formRuntime,
      constraints: confirmedConstraints,
    });
  } catch (err) {
    const message = await markQueuedTaskEnqueueFailed(deps, newTaskId, formGoal, feedback, err);
    return buildToast('error', `Failed to queue task: ${message}`);
  }

  // Mark original task as completed so duplicate clicks are rejected only after
  // the confirmed follow-up has a runnable queue job.
  try {
    await transitionTaskForDeps(deps, actionValue.taskId, TaskStatus.COMPLETED);
  } catch {
    // Original task may already be in a terminal state
  }

  deps.logger.info(
    {
      sourceTaskId: actionValue.taskId,
      newTaskId,
      workDir: formWorkDir,
      runtime: formRuntime,
    },
    'Workdir form confirmed, task enqueued',
  );

  return buildToast('success', 'Task confirmed, starting execution.');
}
