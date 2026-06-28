/**
 * Unit tests for the neutral (non-lark) dispatch path (ADR-0005). Pure
 * orchestration: every collaborator is stubbed, so these pin the durable-enqueue
 * ordering and failure contract without a DB or a queue.
 */
import { describe, expect, it, vi } from 'vitest';
import { IntentType, TaskStatus } from '@open-tag/core-types';
import type { ConversationRef, DeliveryRef, InboundMessage, OutboundMessage } from '@open-tag/channel-core';
import type { FeedbackChannelSender } from '@open-tag/feishu-adapter';
import type { OrchestratorResult } from '@open-tag/orchestrator';
import type { Logger } from '@open-tag/observability';
import {
  buildNeutralQueuedTask,
  dispatchNeutralMessage,
  isMessageAddressedToBot,
  type NeutralAckDelivery,
  type NeutralCreateTaskOptions,
  type NeutralDispatchContext,
} from '../neutral-dispatch.js';

const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

function makeMessage(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    channel: { kind: 'slack', native: { raw: true } },
    eventId: 'Ev_unit',
    messageId: '1710000000.000100',
    eventType: 'created',
    occurredAt: 1710000000000,
    dedupeKey: 'slack:Ev_unit',
    conversation: { kind: 'slack', scopeId: 'C_chat' },
    scope: {
      kind: 'slack',
      scopeId: 'C_chat',
      installationId: 'T_team',
      isPrivate: false,
    },
    sender: { id: 'U_human', isBot: false },
    content: {
      type: 'text',
      text: '<@Ubot> please do the thing',
      mentions: [{ id: 'Ubot', type: 'user' }],
      attachments: [],
    },
    ...overrides,
  };
}

/** A recording FeedbackChannelSender returning a deterministic delivery ref. */
function makeRecordingSender() {
  const sends: Array<{ to: ConversationRef; msg: OutboundMessage }> = [];
  const sendMock = vi.fn(async (to: ConversationRef, msg: OutboundMessage): Promise<DeliveryRef> => {
    sends.push({ to, msg });
    return { kind: to.kind, logicalMessageId: 'ack_ts', revision: 0, physicalIds: ['ack_ts'] };
  });
  const sender: FeedbackChannelSender = {
    send: sendMock,
    update: vi.fn(async (ref: DeliveryRef): Promise<DeliveryRef> => ref),
  };
  return { sender, sends, sendMock };
}

interface HarnessOptions {
  result?: OrchestratorResult;
  enqueueImpl?: (job: unknown) => Promise<string>;
  transitionImpl?: (taskId: string, status: TaskStatus) => Promise<void>;
  senderImpl?: FeedbackChannelSender;
  taskStatus?: string | null;
  persistAckImpl?: (taskId: string, ack: NeutralAckDelivery) => Promise<void>;
  loadAckImpl?: (taskId: string) => Promise<NeutralAckDelivery | null>;
}

function makeCtx(opts: HarnessOptions = {}) {
  const recording = makeRecordingSender();
  const resolveSession = vi.fn(async () => ({ sessionId: 'sess-1' }));
  // Mirror handleEvent: a created task echoes the caller-supplied (deterministic)
  // task id. An explicit `opts.result` overrides for the duplicate / direct paths.
  const createTask = vi.fn(
    async (
      _m: InboundMessage,
      _sid: string,
      options: NeutralCreateTaskOptions,
    ): Promise<OrchestratorResult> =>
      opts.result ?? {
        type: 'task_created',
        taskId: options.taskId ?? 'fallback-id',
        intent: IntentType.ANALYSIS,
        runtime: 'codex',
        goal: 'please do the thing',
      },
  );
  const getTaskStatus = vi.fn(async () => opts.taskStatus ?? null);
  const transitionTask = vi.fn(opts.transitionImpl ?? (async () => {}));
  const enqueue = vi.fn(opts.enqueueImpl ?? (async () => 'job-1'));
  const sender = opts.senderImpl ?? recording.sender;
  const resolveSender = vi.fn(() => sender);
  const persistAckDelivery = vi.fn(opts.persistAckImpl ?? (async () => {}));
  const loadAckDelivery = vi.fn(opts.loadAckImpl ?? (async () => null));
  const ctx: NeutralDispatchContext = {
    resolveSession,
    createTask,
    getTaskStatus,
    transitionTask,
    enqueue,
    resolveSender,
    persistAckDelivery,
    loadAckDelivery,
    logger: silentLogger,
  };
  return {
    ctx,
    resolveSession,
    createTask,
    getTaskStatus,
    transitionTask,
    enqueue,
    resolveSender,
    persistAckDelivery,
    loadAckDelivery,
    sends: recording.sends,
    sendMock: recording.sendMock,
  };
}

describe('isMessageAddressedToBot', () => {
  it('is false when no bot user id is configured (safe default)', () => {
    expect(isMessageAddressedToBot(makeMessage(), undefined)).toBe(false);
    expect(isMessageAddressedToBot(makeMessage(), '')).toBe(false);
  });

  it('is true only when the message @-mentions the configured bot id', () => {
    expect(isMessageAddressedToBot(makeMessage(), 'Ubot')).toBe(true);
  });

  it('is false for a human-only mention', () => {
    const msg = makeMessage({
      content: { type: 'text', text: '<@Uhuman> hi', mentions: [{ id: 'Uhuman', type: 'user' }], attachments: [] },
    });
    expect(isMessageAddressedToBot(msg, 'Ubot')).toBe(false);
  });

  it('is false when there are no mentions', () => {
    const msg = makeMessage({ content: { type: 'text', text: 'no mention', mentions: [], attachments: [] } });
    expect(isMessageAddressedToBot(msg, 'Ubot')).toBe(false);
  });
});

describe('buildNeutralQueuedTask', () => {
  it('builds a minimal neutral job (no feishuContext); collapses auto runtime to null', () => {
    const job = buildNeutralQueuedTask(makeMessage(), 'sess-1', {
      taskId: 'task-1',
      intent: IntentType.CHAT_REPLY,
      runtime: 'auto',
      goal: 'g',
    });
    expect(job).toEqual({
      taskId: 'task-1',
      sessionId: 'sess-1',
      taskType: IntentType.CHAT_REPLY,
      goal: 'g',
      runtimeHint: null,
      constraints: {
        timeoutSec: 1800,
        tenantKey: 'T_team',
        chatId: 'C_chat',
        channelKind: 'slack',
        userMessageId: '1710000000.000100',
        requesterOpenId: 'U_human',
        replyLanguage: undefined,
      },
    });
    expect(job.constraints).not.toHaveProperty('feishuContext');
  });

  it('carries the thread target when the message is threaded (for worker terminal feedback)', () => {
    const job = buildNeutralQueuedTask(
      makeMessage({ conversation: { kind: 'slack', scopeId: 'C_chat', threadId: '169.42' } }),
      'sess-1',
      { taskId: 'task-3', intent: IntentType.CHAT_REPLY, runtime: 'auto', goal: 'g' },
    );
    expect(job.constraints.threadId).toBe('169.42');
  });

  it('keeps an explicit runtime and falls back to message text for the goal', () => {
    const job = buildNeutralQueuedTask(makeMessage(), 'sess-1', {
      taskId: 'task-2',
      intent: IntentType.RESEARCH,
      runtime: 'codex',
    });
    expect(job.runtimeHint).toBe('codex');
    expect(job.goal).toBe('<@Ubot> please do the thing');
  });

  it('omits ackDelivery when no ack handle is given (back-compat)', () => {
    const job = buildNeutralQueuedTask(makeMessage(), 'sess-1', {
      taskId: 'task-4',
      intent: IntentType.CHAT_REPLY,
      runtime: 'auto',
      goal: 'g',
    });
    expect(job.constraints).not.toHaveProperty('ackDelivery');
  });

  it('threads the ack handle into constraints.ackDelivery when provided', () => {
    const job = buildNeutralQueuedTask(
      makeMessage(),
      'sess-1',
      { taskId: 'task-5', intent: IntentType.CHAT_REPLY, runtime: 'auto', goal: 'g' },
      { kind: 'slack', scopeId: 'C_chat', messageId: '1710000000.000200' },
    );
    expect(job.constraints.ackDelivery).toEqual({
      kind: 'slack',
      scopeId: 'C_chat',
      messageId: '1710000000.000200',
    });
  });
});

describe('dispatchNeutralMessage — task_created (happy path, durable ordering)', () => {
  it('queues, ACKs (capturing the handle), then enqueues with constraints.ackDelivery', async () => {
    const { ctx, createTask, transitionTask, enqueue, resolveSender, sends, sendMock } = makeCtx();
    const message = makeMessage();

    const out = await dispatchNeutralMessage(message, ctx);

    // createTask got a deterministic task id + the exact source message id.
    const createOpts = createTask.mock.calls[0][2];
    expect(typeof createOpts.taskId).toBe('string');
    expect(createOpts.taskId).toBeTruthy();
    expect(createOpts.userMessageId).toBe('1710000000.000100');

    // QUEUED transition uses the created task id.
    expect(transitionTask).toHaveBeenCalledWith(createOpts.taskId, TaskStatus.QUEUED);

    // enqueue carries the same task id; ordering: transition before enqueue.
    expect(enqueue).toHaveBeenCalledTimes(1);
    const job = enqueue.mock.calls[0][0] as {
      taskId: string;
      constraints: Record<string, unknown>;
    };
    expect(job.taskId).toBe(createOpts.taskId);
    expect(transitionTask.mock.invocationCallOrder[0]).toBeLessThan(
      enqueue.mock.invocationCallOrder[0],
    );

    // ACK sent through the kind-resolved sender, BEFORE enqueue (so its handle
    // can be threaded), as neutral text into the message's conversation.
    expect(resolveSender).toHaveBeenCalledWith('slack');
    expect(sends).toHaveLength(1);
    expect(sends[0].msg).toMatchObject({ kind: 'text' });
    expect(sends[0].to).toMatchObject({ kind: 'slack', scopeId: 'C_chat' });
    expect(sendMock.mock.invocationCallOrder[0]).toBeLessThan(
      enqueue.mock.invocationCallOrder[0],
    );

    // The captured ack handle is threaded into the job for in-place updates.
    expect(job.constraints.ackDelivery).toEqual({
      kind: 'slack',
      scopeId: 'C_chat',
      messageId: 'ack_ts',
    });

    expect(out).toEqual({ type: 'task_created', taskId: createOpts.taskId });
  });

  it('persists the captured ack handle before the enqueue (issue #14)', async () => {
    const { ctx, createTask, persistAckDelivery, enqueue } = makeCtx();

    await dispatchNeutralMessage(makeMessage(), ctx);

    const createdTaskId = createTask.mock.calls[0][2].taskId;
    // Persisted with the same handle the recording sender returned, keyed to the task.
    expect(persistAckDelivery).toHaveBeenCalledTimes(1);
    expect(persistAckDelivery).toHaveBeenCalledWith(createdTaskId, {
      kind: 'slack',
      scopeId: 'C_chat',
      messageId: 'ack_ts',
    });
    // The persist must precede the durable enqueue so a recovery can rehydrate it.
    expect(persistAckDelivery.mock.invocationCallOrder[0]).toBeLessThan(
      enqueue.mock.invocationCallOrder[0],
    );
  });

  it('treats a failed ack-handle persist as best-effort: still enqueues, no throw', async () => {
    const { ctx, enqueue } = makeCtx({
      persistAckImpl: async () => {
        throw new Error('db write failed');
      },
    });
    await expect(dispatchNeutralMessage(makeMessage(), ctx)).resolves.toMatchObject({
      type: 'task_created',
    });
    // The handle still rides the job payload even though the DB backup failed.
    expect(enqueue).toHaveBeenCalledTimes(1);
    const job = enqueue.mock.calls[0][0] as { constraints: Record<string, unknown> };
    expect(job.constraints.ackDelivery).toEqual({
      kind: 'slack',
      scopeId: 'C_chat',
      messageId: 'ack_ts',
    });
  });

  it('derives disjoint task ids for the same dedupe key across two installations', async () => {
    const a = makeCtx();
    const b = makeCtx();
    await dispatchNeutralMessage(makeMessage(), a.ctx);
    await dispatchNeutralMessage(
      makeMessage({ scope: { kind: 'slack', scopeId: 'C_chat', installationId: 'T_other', isPrivate: false } }),
      b.ctx,
    );
    expect(a.createTask.mock.calls[0][2].taskId).not.toBe(b.createTask.mock.calls[0][2].taskId);
  });
});

describe('dispatchNeutralMessage — non-creating and failure paths', () => {
  it('does nothing for a direct_reply (no transition / enqueue / ack)', async () => {
    const { ctx, transitionTask, enqueue, sends } = makeCtx({
      result: { type: 'direct_reply', reply: 'ok', intent: IntentType.OPS_TASK },
    });
    const out = await dispatchNeutralMessage(makeMessage(), ctx);
    expect(out).toEqual({ type: 'direct_reply' });
    expect(transitionTask).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(sends).toHaveLength(0);
  });

  it('rehydrates the persisted ack handle on a non-terminal task_duplicate, without re-ACKing', async () => {
    const persisted: NeutralAckDelivery = {
      kind: 'slack',
      scopeId: 'C_chat',
      messageId: 'orig_ack_ts',
    };
    const { ctx, enqueue, sends, getTaskStatus, loadAckDelivery } = makeCtx({
      taskStatus: 'queued',
      loadAckImpl: async () => persisted,
      result: {
        type: 'task_duplicate',
        taskId: 'task-dupe',
        intent: IntentType.ANALYSIS,
        runtime: 'codex',
        goal: 'g',
      },
    });
    const out = await dispatchNeutralMessage(makeMessage(), ctx);
    expect(out).toEqual({ type: 'task_duplicate', taskId: 'task-dupe' });
    expect(getTaskStatus).toHaveBeenCalledWith('task-dupe');
    expect(enqueue).toHaveBeenCalledTimes(1);
    // The original task_created dispatch already posted the one ACK; a recovery
    // redelivery must NOT post a second (issue #14 no-re-ACK invariant).
    expect(sends).toHaveLength(0);
    // ...but it rehydrates the persisted handle so the worker updates that first
    // ACK message in place instead of orphaning it.
    expect(loadAckDelivery).toHaveBeenCalledWith('task-dupe');
    const job = enqueue.mock.calls[0][0] as { constraints: Record<string, unknown> };
    expect(job.constraints.ackDelivery).toEqual(persisted);
  });

  it('threads no ack handle on a recovery when none was persisted (back-compat)', async () => {
    const { ctx, enqueue, sends, loadAckDelivery } = makeCtx({
      taskStatus: 'queued',
      // Default loadAckImpl resolves null (e.g. the original ACK send failed).
      result: {
        type: 'task_duplicate',
        taskId: 'task-dupe',
        intent: IntentType.ANALYSIS,
        runtime: 'codex',
        goal: 'g',
      },
    });
    await dispatchNeutralMessage(makeMessage(), ctx);
    expect(loadAckDelivery).toHaveBeenCalledWith('task-dupe');
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(sends).toHaveLength(0);
    const job = enqueue.mock.calls[0][0] as { constraints: Record<string, unknown> };
    expect(job.constraints).not.toHaveProperty('ackDelivery');
  });

  it('skips re-dispatch for a duplicate of an already-terminal task', async () => {
    const { ctx, enqueue, transitionTask, sends } = makeCtx({
      taskStatus: 'completed',
      result: { type: 'task_duplicate', taskId: 'task-done', intent: IntentType.ANALYSIS },
    });
    const out = await dispatchNeutralMessage(makeMessage(), ctx);
    expect(out).toEqual({ type: 'task_duplicate', taskId: 'task-done' });
    expect(transitionTask).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(sends).toHaveLength(0);
  });

  it('swallows an "already advanced" QUEUED transition during recovery', async () => {
    const { ctx, enqueue, sends } = makeCtx({
      result: { type: 'task_duplicate', taskId: 'task-dupe', intent: IntentType.ANALYSIS },
      transitionImpl: async () => {
        throw new Error('Invalid task state transition: running → queued');
      },
    });
    await expect(dispatchNeutralMessage(makeMessage(), ctx)).resolves.toMatchObject({
      type: 'task_duplicate',
    });
    expect(enqueue).toHaveBeenCalledTimes(1);
    // A duplicate never re-ACKs.
    expect(sends).toHaveLength(0);
  });

  it('propagates an enqueue failure and never marks the task FAILED', async () => {
    const { ctx, transitionTask } = makeCtx({
      enqueueImpl: async () => {
        throw new Error('queue down');
      },
    });
    await expect(dispatchNeutralMessage(makeMessage(), ctx)).rejects.toThrow('queue down');
    // Only the QUEUED transition happened — never a terminal FAILED. (The ACK is
    // best-effort and now precedes the enqueue, so it may already be posted; a
    // recovery redelivery re-enqueues idempotently.)
    expect(transitionTask).toHaveBeenCalledTimes(1);
    expect(transitionTask).toHaveBeenCalledWith(expect.any(String), TaskStatus.QUEUED);
  });

  it('treats an ACK send failure as best-effort: enqueues with no ackDelivery, no throw', async () => {
    const failingSender: FeedbackChannelSender = {
      send: vi.fn(async () => {
        throw new Error('slack not configured yet');
      }),
      update: vi.fn(async (ref) => ref),
    };
    const { ctx, enqueue } = makeCtx({ senderImpl: failingSender });
    await expect(dispatchNeutralMessage(makeMessage(), ctx)).resolves.toMatchObject({
      type: 'task_created',
    });
    expect(enqueue).toHaveBeenCalledTimes(1);
    // A failed ACK yields no handle, so the worker will post a fresh terminal
    // message (back-compat) rather than updating in place.
    const job = enqueue.mock.calls[0][0] as { constraints: Record<string, unknown> };
    expect(job.constraints).not.toHaveProperty('ackDelivery');
  });
});
