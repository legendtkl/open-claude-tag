import { randomUUID } from 'crypto';
import { TaskStatus, IntentType, isObjectRecord } from '@open-tag/core-types';
import type { NormalizedEvent } from '@open-tag/core-types';
import type { Database } from '@open-tag/storage';
import { tasks } from '@open-tag/storage';
import { and, eq } from 'drizzle-orm';
import { classifyIntent, selectRuntime } from './intent-classifier.js';
import { assertTransition } from './task-state-machine.js';

export interface OrchestratorResult {
  type: 'direct_reply' | 'task_created' | 'task_duplicate';
  reply?: string;
  taskId?: string;
  intent: IntentType;
  runtime?: string;
  goal?: string;
  imageAttachment?: { imageKey: string; messageId: string };
  fileAttachment?: NonNullable<NormalizedEvent['content']['fileAttachment']>;
}

export interface HandleEventOptions {
  agentId?: string;
  feishuAppId?: string;
  extraTaskConstraints?: Record<string, unknown>;
  taskId?: string;
}

function jsonLikeEquals(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((item, index) => jsonLikeEquals(item, right[index]));
  }
  if (isObjectRecord(left) || isObjectRecord(right)) {
    if (!isObjectRecord(left) || !isObjectRecord(right)) {
      return false;
    }
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    if (leftKeys.length !== rightKeys.length) {
      return false;
    }
    return leftKeys.every(
      (key, index) => key === rightKeys[index] && jsonLikeEquals(left[key], right[key]),
    );
  }
  return false;
}

function nullableEquals(left: string | null | undefined, right: string | null | undefined): boolean {
  return (left ?? null) === (right ?? null);
}

function assertDuplicateTaskMatches(
  existing: typeof tasks.$inferSelect,
  expected: typeof tasks.$inferInsert,
): void {
  const existingConstraints = isObjectRecord(existing.constraints) ? existing.constraints : {};
  const expectedConstraints = isObjectRecord(expected.constraints) ? expected.constraints : {};
  if (
    existing.sessionId !== expected.sessionId ||
    !nullableEquals(existing.agentId, expected.agentId) ||
    !nullableEquals(existing.feishuAppId, expected.feishuAppId) ||
    existing.taskType !== expected.taskType ||
    existing.goal !== expected.goal ||
    !nullableEquals(existing.runtimeHint, expected.runtimeHint)
  ) {
    throw new Error(`Task id conflict: ${expected.id}`);
  }

  for (const [key, value] of Object.entries(expectedConstraints)) {
    if (!jsonLikeEquals(existingConstraints[key], value)) {
      throw new Error(`Task id conflict: ${expected.id}`);
    }
  }
}

function buildCurrentImageAttachment(
  event: NormalizedEvent,
): { imageKey: string; messageId: string } | undefined {
  return event.content.type === 'image' && event.content.imageKey && event.content.imageMessageId
    ? { imageKey: event.content.imageKey, messageId: event.content.imageMessageId }
    : undefined;
}

function buildReferencedImageAttachment(
  event: NormalizedEvent,
): { imageKey: string; messageId: string } | undefined {
  return event.content.referencedMessages?.find((message) => message.imageAttachment)
    ?.imageAttachment;
}

function buildCurrentFileAttachment(
  event: NormalizedEvent,
): NonNullable<NormalizedEvent['content']['fileAttachment']> | undefined {
  return event.content.type === 'file' ? event.content.fileAttachment : undefined;
}

function appendReferencedContext(goal: string, event: NormalizedEvent): string {
  const sections = (event.content.referencedMessages ?? [])
    .map((message) => {
      const lines = message.entries.map((entry) =>
        entry.author ? `${entry.author}: ${entry.text}` : entry.text,
      );
      if (lines.length === 0) return '';
      return [`[Referenced Feishu message: ${message.messageId}]`, ...lines].join('\n');
    })
    .filter(Boolean);

  if (sections.length === 0) return goal;
  return [goal, ...sections].join('\n\n');
}

export async function handleEvent(
  db: Database,
  event: NormalizedEvent,
  sessionId: string,
  options: HandleEventOptions = {},
): Promise<OrchestratorResult> {
  const text = event.content.text ?? '';
  const command = event.content.command;
  const currentImageAttachment = buildCurrentImageAttachment(event);
  const referencedImageAttachment = buildReferencedImageAttachment(event);
  const imageAttachment = currentImageAttachment ?? referencedImageAttachment;
  const hasImageAttachment = Boolean(imageAttachment);
  const fileAttachment = buildCurrentFileAttachment(event);
  const hasFileAttachment = Boolean(fileAttachment);

  // For resource-only messages, use a default goal.
  const effectiveText =
    hasImageAttachment && !text ? '请分析这张图片' : hasFileAttachment && !text ? '请分析这个文件' : text;

  const intent = classifyIntent(effectiveText, command);
  const taskGoal = appendReferencedContext(effectiveText, event);

  // Intake: ops_task → handle directly (slash commands are dispatched by server)
  if (intent === IntentType.OPS_TASK) {
    return {
      type: 'direct_reply',
      reply: `Processing command: ${command ?? text}`,
      intent,
    };
  }

  // All other intents (including chat) → create task for worker/AI processing
  // Router: keep image handling separate from runtime selection.
  const runtime = selectRuntime(intent);

  // Create task
  const taskId = options.taskId ?? randomUUID();
  const taskValues = {
    id: taskId,
    sessionId,
    agentId: options.agentId,
    feishuAppId: options.feishuAppId,
    taskType: intent,
    goal: taskGoal,
    runtimeHint: runtime === 'auto' ? null : runtime,
    status: TaskStatus.PENDING,
    constraints: {
      timeoutSec: 1800,
      approvalRequired: intent === IntentType.SELF_IMPROVEMENT,
      tenantKey: event.tenantKey,
      chatId: event.chatId,
      agentId: options.agentId,
      feishuAppId: options.feishuAppId,
      userMessageId: event.messageId,
      requesterOpenId: event.senderOpenId,
      replyLanguage: event.replyLanguage,
      ...(imageAttachment ? { imageAttachment } : {}),
      ...(fileAttachment ? { fileAttachment } : {}),
      ...(options.extraTaskConstraints ?? {}),
    },
  } satisfies typeof tasks.$inferInsert;
  const [created] = await db
    .insert(tasks)
    .values(taskValues)
    .onConflictDoNothing({ target: tasks.id })
    .returning({ id: tasks.id });

  if (!created) {
    const [existing] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
    if (!existing) {
      throw new Error(`Failed to create or resolve task ${taskId}`);
    }
    assertDuplicateTaskMatches(existing, taskValues);
    return {
      type: 'task_duplicate',
      taskId,
      intent,
      runtime,
      goal: effectiveText,
      imageAttachment,
      fileAttachment,
    };
  }

  return {
    type: 'task_created',
    taskId,
    intent,
    runtime,
    goal: taskGoal,
    imageAttachment,
    fileAttachment,
  };
}

const MAX_TRANSITION_ATTEMPTS = 3;

export async function transitionTask(
  db: Database,
  taskId: string,
  newStatus: TaskStatus,
  extra?: { errorMessage?: string; result?: unknown; interactionReason?: string | null },
): Promise<void> {
  for (let attempt = 0; attempt < MAX_TRANSITION_ATTEMPTS; attempt += 1) {
    const current = await db
      .select({ status: tasks.status })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .limit(1);

    if (current.length === 0) {
      throw new Error(`Task not found: ${taskId}`);
    }

    const currentStatus = current[0].status as TaskStatus;
    assertTransition(currentStatus, newStatus);

    const updateData: Record<string, unknown> = {
      status: newStatus,
      updatedAt: new Date(),
    };

    if (extra?.errorMessage) updateData.errorMessage = extra.errorMessage;
    if (extra?.result) updateData.result = extra.result;
    if ('interactionReason' in (extra ?? {})) {
      updateData.interactionReason = (
        extra as { interactionReason?: string | null }
      ).interactionReason;
    }

    // Compare-and-swap: only write if the status we validated is still
    // current. A concurrent transition (e.g. cancel vs complete) turns this
    // into a no-op; re-read and re-validate instead of blindly overwriting,
    // so terminal states can never be clobbered by a stale writer.
    const updated = await db
      .update(tasks)
      .set(updateData)
      .where(and(eq(tasks.id, taskId), eq(tasks.status, currentStatus)))
      .returning({ id: tasks.id });

    if (updated.length > 0) {
      return;
    }
  }

  throw new Error(
    `Task transition contention: ${taskId} → ${newStatus} (status changed concurrently on every attempt)`,
  );
}
