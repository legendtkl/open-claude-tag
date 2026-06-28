/**
 * Neutral (non-lark) inbound task dispatch (ADR-0005). A minimal, channel-neutral
 * task-creation path that mirrors the lark dispatch's essential subset
 * (`resolveSession` → orchestrator task → enqueue → ACK) WITHOUT any lark-native
 * assumptions, so a Slack (or any future channel) message can dispatch a task and
 * get an ACK. The 378-line `dispatchInboundMessageViaFeishuNative` body is left
 * untouched; this is the separate seam non-lark inbound enters through.
 *
 * Pure orchestration over injected deps (composition / DI): it never learns the
 * resolver's context shape, a DB handle, or a queue instance, so it unit-tests
 * with stubs. The API composition root binds the real implementations.
 *
 * Failure semantics (resolved in the Codex design gate): enqueue is the DURABLE
 * boundary. A post-creation failure is never turned into a terminal `FAILED`; an
 * enqueue failure propagates so the caller keeps the dedup claim open for a
 * stale-claim redelivery to recover (re-enqueue is idempotent per task id). The
 * ACK is best-effort (a send failure, or an unconfigured sender, can never lose
 * an already-queued task).
 *
 * ACK ordering (ADR-0008, amends ADR-0005): the ACK is sent BEFORE the enqueue —
 * but ONLY on the `task_created` path — so the channel's ack-message handle can
 * be captured and threaded into the job (`constraints.ackDelivery`) for the
 * worker to update that same message in place to its terminal state (UX parity
 * with lark's live card). The handle is also persisted to the task row
 * (`constraints.ackDelivery`) so a recovery redelivery can recover it (issue #14).
 * A `task_duplicate` (recovery redelivery) re-enqueues idempotently and does NOT
 * re-ACK: the original `task_created` dispatch already posted the one ACK. Instead
 * it REHYDRATES the persisted handle into the job so the worker still updates that
 * first message in place rather than orphaning it and posting a separate terminal.
 * Because same-task dispatch is serialized by the route's held dedup claim, two
 * dispatches for one task can never run concurrently, so the captured ack handle
 * and the enqueued job stay consistent.
 */
import { TaskStatus, stableUuidFromKey, normalizeRuntimeHint } from '@open-tag/core-types';
import type { ChannelKind, ConversationRef, InboundMessage } from '@open-tag/channel-core';
import type { FeedbackChannelSender } from '@open-tag/feishu-adapter';
import { isTerminal } from '@open-tag/orchestrator';
import type { OrchestratorResult } from '@open-tag/orchestrator';
import type { Logger } from '@open-tag/observability';
import type { TaskJobData } from '@open-tag/queue';

/** Orchestrator task-creation options the neutral path supplies. */
export interface NeutralCreateTaskOptions {
  taskId?: string;
  userMessageId?: string;
}

/**
 * The injected collaborators for {@link dispatchNeutralMessage}. The API root
 * binds these to `resolveSession(db, …)`, orchestrator `handleEvent` /
 * `transitionTask` (bound to `db`), `queue.enqueue`, and a kind-resolved
 * {@link FeedbackChannelSender}.
 */
export interface NeutralDispatchContext {
  resolveSession(message: InboundMessage): Promise<{ sessionId: string }>;
  createTask(
    message: InboundMessage,
    sessionId: string,
    options: NeutralCreateTaskOptions,
  ): Promise<OrchestratorResult>;
  /** Read a task's current status; used to short-circuit terminal-task recovery. */
  getTaskStatus(taskId: string): Promise<string | null>;
  transitionTask(taskId: string, status: TaskStatus): Promise<void>;
  enqueue(job: TaskJobData): Promise<string>;
  resolveSender(kind: ChannelKind): FeedbackChannelSender;
  /**
   * Persist the captured ACK-message handle for `taskId` (issue #14) so a recovery
   * redelivery can rehydrate it. Called best-effort at the call site: a failure
   * must never block the durable enqueue.
   */
  persistAckDelivery(taskId: string, ack: NeutralAckDelivery): Promise<void>;
  /**
   * Load a previously persisted ACK handle for `taskId`, or null when none was
   * stored (e.g. the original ACK send failed). Used only on the recovery
   * (`task_duplicate`) path to rehydrate the handle WITHOUT re-ACKing.
   */
  loadAckDelivery(taskId: string): Promise<NeutralAckDelivery | null>;
  logger: Logger;
}

export interface NeutralDispatchResult {
  type: OrchestratorResult['type'];
  taskId?: string;
}

/**
 * A serializable handle over the ack message the dispatch posted, threaded to the
 * worker through `constraints.ackDelivery` so the worker can update THAT message
 * in place to the task's terminal state. Plain strings only — it must survive the
 * JSON round-trip through the queue. `scopeId` is the conversation the ack landed
 * in (the channel id); `messageId` is the posted message's physical id (Slack
 * `ts`). Captured vendor-neutrally — never by reaching into a channel's `native`.
 */
export interface NeutralAckDelivery {
  kind: ChannelKind;
  scopeId: string;
  messageId: string;
}

/** The orchestrator-result fields {@link buildNeutralQueuedTask} consumes. */
export interface NeutralQueuedTaskResult {
  taskId: string;
  intent: string;
  runtime?: string;
  goal?: string;
}

const INVALID_TRANSITION_MARKER = 'Invalid task state transition';

/**
 * Is the message @-addressed to the bot? Mention-only and safe-by-default: with
 * no configured `botUserId` nothing is addressed, so a channel that has not opted
 * in never dispatches a task. Neutral — reads only `content.mentions`.
 */
export function isMessageAddressedToBot(
  message: InboundMessage,
  botUserId: string | undefined,
): boolean {
  if (!botUserId) return false;
  return message.content.mentions.some((mention) => mention.id === botUserId);
}

/**
 * Build the minimal neutral queue job directly from the inbound message — no
 * `NormalizedEvent`, no `feishuContext` (that is the lark-only
 * `buildQueuedTaskInput`). `runtimeHint` mirrors the task row written by
 * `handleEvent` (`'auto'` collapses to `null`).
 */
export function buildNeutralQueuedTask(
  message: InboundMessage,
  sessionId: string,
  result: NeutralQueuedTaskResult,
  ackDelivery?: NeutralAckDelivery,
): TaskJobData {
  const runtime = result.runtime;
  return {
    taskId: result.taskId,
    sessionId,
    taskType: result.intent,
    goal: result.goal ?? message.content.text ?? '',
    runtimeHint: normalizeRuntimeHint(runtime),
    constraints: {
      timeoutSec: 1800,
      tenantKey: message.scope.installationId,
      chatId: message.scope.scopeId,
      channelKind: message.channel.kind,
      // Carry the thread target so the worker's terminal feedback lands in the
      // same thread the task started in (only set when the message is threaded).
      ...(message.conversation.threadId ? { threadId: message.conversation.threadId } : {}),
      // The ack-message handle (only present for a freshly created task whose ACK
      // posted) so the worker updates that same message in place (ADR-0008). A
      // missing handle ⇒ the worker posts a fresh terminal message (back-compat).
      ...(ackDelivery ? { ackDelivery } : {}),
      userMessageId: message.messageId,
      requesterOpenId: message.sender.id,
      replyLanguage: message.locale,
    },
  };
}

/**
 * Deterministic task id, fully scoped by channel kind + installation + scope +
 * dedupe key, so two workspaces that share a vendor event id can never collide on
 * one task row. With the route's dedup claim this is belt-and-suspenders: a
 * redelivery resolves to the same id, so `handleEvent`'s `onConflictDoNothing`
 * yields `task_duplicate` instead of a second task.
 */
function neutralTaskId(message: InboundMessage): string {
  return stableUuidFromKey(
    `neutral-task:${message.channel.kind}:${message.scope.installationId}:${message.scope.scopeId}:${message.dedupeKey}`,
  );
}

/** The ACK destination: the message's conversation, keyed to its own scope. */
function neutralAckConversation(message: InboundMessage): ConversationRef {
  const { conversation } = message;
  return {
    kind: message.channel.kind,
    scopeId: message.scope.scopeId,
    ...(conversation.threadId ? { threadId: conversation.threadId } : {}),
    ...(conversation.reply ? { reply: conversation.reply } : {}),
  };
}

/**
 * Move a freshly created task to QUEUED before the worker can consume the job
 * (the worker advances QUEUED → RUNNING). A recovery redelivery may find the task
 * already advanced; that invalid transition is a benign, idempotent no-op.
 */
async function ensureQueued(ctx: NeutralDispatchContext, taskId: string): Promise<void> {
  try {
    await ctx.transitionTask(taskId, TaskStatus.QUEUED);
  } catch (err) {
    if (err instanceof Error && err.message.includes(INVALID_TRANSITION_MARKER)) {
      ctx.logger.info(
        { taskId },
        'Neutral dispatch: task already past PENDING; skipping QUEUED transition',
      );
      return;
    }
    throw err;
  }
}

/**
 * Best-effort neutral ACK. Returns a serializable {@link NeutralAckDelivery}
 * handle over the posted ack message (for in-place terminal updates) when the
 * send succeeds and yields a physical message id; returns `undefined` on a send
 * failure, an unconfigured sender, or an id-less delivery (the worker then posts
 * a fresh terminal message). Never throws — the task is already durable-bound.
 */
async function sendNeutralAck(
  ctx: NeutralDispatchContext,
  message: InboundMessage,
  result: NeutralQueuedTaskResult,
): Promise<NeutralAckDelivery | undefined> {
  try {
    const sender = ctx.resolveSender(message.channel.kind);
    const conversation = neutralAckConversation(message);
    const ref = await sender.send(conversation, {
      kind: 'text',
      markdown: `Task queued: ${result.intent}`,
    });
    const messageId = ref.physicalIds[0];
    ctx.logger.info(
      { taskId: result.taskId, ackMessageId: messageId },
      'Neutral dispatch ACK sent',
    );
    if (!messageId) return undefined;
    return { kind: message.channel.kind, scopeId: conversation.scopeId, messageId };
  } catch (err) {
    ctx.logger.warn(
      { err, taskId: result.taskId },
      'Neutral dispatch ACK send failed (best-effort, non-fatal)',
    );
    return undefined;
  }
}

/**
 * Best-effort persist of the captured ack handle (issue #14). Mirrors the ACK's
 * best-effort contract: a failure is logged and swallowed so it can never block
 * the durable enqueue. The handle still rides the job payload regardless; this DB
 * copy only backstops a recovery redelivery (`task_duplicate`) that must rehydrate
 * the handle WITHOUT re-ACKing.
 */
async function persistAckDeliveryBestEffort(
  ctx: NeutralDispatchContext,
  taskId: string,
  ack: NeutralAckDelivery,
): Promise<void> {
  try {
    await ctx.persistAckDelivery(taskId, ack);
  } catch (err) {
    ctx.logger.warn(
      { err, taskId },
      'Neutral dispatch: persisting ack handle failed (best-effort, non-fatal)',
    );
  }
}

/**
 * Dispatch a neutral inbound message: resolve the session, create the task with a
 * deterministic id, move it to QUEUED, send a best-effort ACK (only on
 * `task_created`, capturing its message handle), then enqueue the durable job with
 * that handle. The ACK precedes the enqueue — see the module header (ADR-0008) —
 * so its handle rides in the job payload (`constraints.ackDelivery`) for the
 * worker's in-place terminal update; an enqueue failure after the ACK propagates
 * so the caller keeps the dedup claim open, and the recovery redelivery
 * re-enqueues idempotently without re-ACKing. Returns the orchestrator outcome so
 * the caller can observe whether a task was created.
 */
export async function dispatchNeutralMessage(
  message: InboundMessage,
  ctx: NeutralDispatchContext,
): Promise<NeutralDispatchResult> {
  const { sessionId } = await ctx.resolveSession(message);
  const taskId = neutralTaskId(message);
  const result = await ctx.createTask(message, sessionId, {
    taskId,
    userMessageId: message.messageId,
  });

  // Only an ops/direct reply skips the queue. Both task_created and task_duplicate
  // carry a task id and must reach the durable enqueue — a duplicate here is the
  // recovery redelivery of a dispatch that failed before enqueue, and re-enqueue
  // is idempotent per task id.
  if (result.type === 'direct_reply' || !result.taskId) {
    return { type: result.type };
  }

  // A duplicate of an ALREADY-TERMINAL task (rare: a redelivery that slipped past
  // the dedup claim after the task ran to completion) must NOT be re-enqueued or
  // re-ACKed — that would re-run finished work and post a misleading "queued".
  if (result.type === 'task_duplicate') {
    const status = await ctx.getTaskStatus(result.taskId);
    if (status && isTerminal(status as TaskStatus)) {
      ctx.logger.info(
        { taskId: result.taskId, status },
        'Neutral dispatch: duplicate of a terminal task; skipping re-dispatch',
      );
      return { type: result.type, taskId: result.taskId };
    }
  }

  const queuedResult: NeutralQueuedTaskResult = {
    taskId: result.taskId,
    intent: result.intent,
    runtime: result.runtime,
    goal: result.goal,
  };

  await ensureQueued(ctx, result.taskId);
  // Send the ACK BEFORE the enqueue, but ONLY for a freshly created task, so its
  // ack-message handle can be threaded into the job for in-place terminal updates
  // (ADR-0008). A `task_duplicate` is a recovery redelivery: the original
  // `task_created` dispatch already posted the one ACK, so it must not re-ACK —
  // that also avoids a second ack competing with the already-enqueued handle.
  let ackDelivery: NeutralAckDelivery | undefined;
  if (result.type === 'task_created') {
    ackDelivery = await sendNeutralAck(ctx, message, queuedResult);
    // Persist the captured handle BEFORE the enqueue so a recovery redelivery can
    // rehydrate it (issue #14). Best-effort: a persistence failure is swallowed so
    // it never blocks the durable enqueue (the handle still rides the job payload).
    if (ackDelivery) {
      await persistAckDeliveryBestEffort(ctx, result.taskId, ackDelivery);
    }
  } else {
    // A non-terminal `task_duplicate` is the recovery redelivery of a dispatch that
    // ACKed then failed before (or during) enqueue. Rehydrate the persisted ack
    // handle so the worker still updates that first "Task queued" message in place
    // instead of posting an orphaned second terminal message — WITHOUT re-ACKing
    // (issue #14). A missing handle (original ACK failed) threads none (back-compat).
    ackDelivery = (await ctx.loadAckDelivery(result.taskId)) ?? undefined;
  }
  // Durable boundary: a failure propagates so the caller keeps the dedup claim
  // open for recovery. The task is never marked terminal for a transient failure.
  await ctx.enqueue(buildNeutralQueuedTask(message, sessionId, queuedResult, ackDelivery));

  return { type: result.type, taskId: result.taskId };
}
