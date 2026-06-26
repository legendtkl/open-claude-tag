import { beforeEach, describe, expect, it, vi } from 'vitest';

const { transitionTaskMock } = vi.hoisted(() => ({
  transitionTaskMock: vi.fn(),
}));

vi.mock('@open-tag/orchestrator', () => ({
  transitionTask: transitionTaskMock,
}));

import { TaskStatus } from '@open-tag/core-types';
import {
  TASK_CARD_ACTION_RETRY,
  TASK_CARD_ACTION_RETRY_RUNTIME,
  WORKDIR_FORM_SUBMIT,
} from '@open-tag/feishu-adapter';
import { createTaskCardActionHandler } from '../card-action-handler.js';

function makeDbStub(selectResults: unknown[]) {
  const remainingResults = [...selectResults];
  const inserted: Record<string, unknown>[] = [];
  const updates: Array<{ values: Record<string, unknown> }> = [];
  const receiptInsertResults: unknown[][] = [[{ id: 'receipt_001' }]];

  const selectChain = {
    from: () => selectChain,
    where: () => selectChain,
    orderBy: () => selectChain,
    limit: async () => (remainingResults.shift() as unknown[]) ?? [],
  };

  return {
    select: vi.fn(() => selectChain),
    insert: vi.fn(() => ({
      values: vi.fn((row: Record<string, unknown>) => {
        inserted.push(row);
        return {
          onConflictDoNothing: vi.fn(() => ({
            returning: vi.fn(async () => receiptInsertResults.shift() ?? [{ id: 'receipt_001' }]),
          })),
          returning: vi.fn(async () => [{ id: 'inserted_001' }]),
        };
      }),
    })),
    update: vi.fn(() => ({
      set: (values: Record<string, unknown>) => ({
        where: vi.fn(async () => {
          updates.push({ values });
        }),
      }),
    })),
    _inserted: inserted,
    _receiptInsertResults: receiptInsertResults,
    _updates: updates,
  };
}

function makeDeps(selectResults: unknown[]) {
  return {
    db: makeDbStub(selectResults),
    feishuClient: {
      sendMessage: vi.fn(async () => ({ messageId: 'msg_ack_001' })),
      updateMessage: vi.fn(async () => undefined),
    },
    queue: {
      enqueue: vi.fn(async () => 'job-123'),
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  };
}

function findInsertedTask(deps: ReturnType<typeof makeDeps>) {
  return deps.db._inserted.find((row) => typeof row.taskType === 'string');
}

function findInsertedReceipt(deps: ReturnType<typeof makeDeps>) {
  return deps.db._inserted.find((row) => typeof row.dedupKey === 'string');
}

function makeEvent(value: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return {
    open_message_id: 'om_123',
    ...overrides,
    action: {
      tag: 'button',
      value,
    },
  };
}

describe('createTaskCardActionHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transitionTaskMock.mockResolvedValue(undefined);
  });

  it('enqueues a retry task using the original runtime', async () => {
    const deps = makeDeps([
      [
        {
          id: 'task_original',
          sessionId: 'session_123',
          taskType: 'self_dev',
          goal: 'fix the failing tests',
          status: TaskStatus.FAILED,
          runtimeHint: 'claude_code',
          constraints: {
            timeoutSec: 1800,
            approvalRequired: false,
            replyLanguage: 'zh-CN',
            imageAttachment: { imageKey: 'img_v2_retry', messageId: 'om_image_original' },
            fileAttachment: {
              resourceKey: 'file_v2_retry',
              messageId: 'om_file_original',
              resourceType: 'file',
              fileName: 'report.pdf',
            },
          },
        },
      ],
      [
        {
          chatId: 'oc_chat_123',
          sdkSessionId: 'sdk_123',
          runtimeBackend: 'claude_code',
        },
      ],
      [{ runtimeBackend: 'claude_code' }],
    ]);
    const handler = createTaskCardActionHandler(deps as any);

    const response = await handler(
      makeEvent({
        action: TASK_CARD_ACTION_RETRY,
        task_id: 'task_original',
      }),
    );

    expect(response.toast.type).toBe('success');
    expect(deps.feishuClient.sendMessage).toHaveBeenCalledWith(
      'chat_id',
      'oc_chat_123',
      expect.objectContaining({ msg_type: 'interactive' }),
      'om_123',
    );
    expect(findInsertedReceipt(deps)).toMatchObject({
      dedupKey: 'task-card-action:task_original:task_retry:unknown-operator',
      sourceTaskId: 'task_original',
      action: TASK_CARD_ACTION_RETRY,
    });
    expect(findInsertedTask(deps)).toMatchObject({
      sessionId: 'session_123',
      parentTaskId: 'task_original',
      taskType: 'self_dev',
      goal: 'fix the failing tests',
      runtimeHint: 'claude_code',
      status: TaskStatus.PENDING,
      feedbackMessageId: 'msg_ack_001',
      feedbackCardType: 'task_status',
      feedbackState: 'queued',
      constraints: expect.objectContaining({
        replyLanguage: 'zh-CN',
        imageAttachment: { imageKey: 'img_v2_retry', messageId: 'om_image_original' },
        fileAttachment: {
          resourceKey: 'file_v2_retry',
          messageId: 'om_file_original',
          resourceType: 'file',
          fileName: 'report.pdf',
        },
      }),
    });
    expect(transitionTaskMock).toHaveBeenCalledWith(deps.db, expect.any(String), TaskStatus.QUEUED);
    expect(deps.queue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session_123',
        taskType: 'self_dev',
        goal: 'fix the failing tests',
        runtimeHint: 'claude_code',
        sdkSessionId: 'sdk_123',
        runtimeBackend: 'claude_code',
        constraints: expect.objectContaining({
          chatId: 'oc_chat_123',
          ackMessageId: 'msg_ack_001',
          replyToMessageId: 'om_123',
          userMessageId: 'om_123',
          replyLanguage: 'zh-CN',
          imageAttachment: { imageKey: 'img_v2_retry', messageId: 'om_image_original' },
          fileAttachment: {
            resourceKey: 'file_v2_retry',
            messageId: 'om_file_original',
            resourceType: 'file',
            fileName: 'report.pdf',
          },
        }),
      }),
    );
    expect(deps.db._updates).toHaveLength(0);
  });

  it('rejects retry actions from a different Feishu operator', async () => {
    const deps = makeDeps([
      [
        {
          id: 'task_original',
          sessionId: 'session_123',
          taskType: 'self_dev',
          goal: 'fix the failing tests',
          status: TaskStatus.FAILED,
          runtimeHint: 'claude_code',
          constraints: {
            feishuContext: { senderOpenId: 'ou_owner' },
          },
        },
      ],
    ]);
    const handler = createTaskCardActionHandler(deps as any);

    const response = await handler(
      makeEvent(
        {
          action: TASK_CARD_ACTION_RETRY,
          task_id: 'task_original',
        },
        { open_id: 'ou_intruder' },
      ),
    );

    expect(response.toast).toMatchObject({
      type: 'warning',
      content: 'Only the original requester can use this card action.',
    });
    expect(deps.feishuClient.sendMessage).not.toHaveBeenCalled();
    expect(deps.queue.enqueue).not.toHaveBeenCalled();
    expect(deps.db._inserted).toHaveLength(0);
  });

  it('rejects retry actions from a mismatched Feishu chat', async () => {
    const deps = makeDeps([
      [
        {
          id: 'task_original',
          sessionId: 'session_123',
          taskType: 'self_dev',
          goal: 'fix the failing tests',
          status: TaskStatus.FAILED,
          runtimeHint: 'claude_code',
          constraints: { timeoutSec: 1800 },
        },
      ],
      [
        {
          chatId: 'oc_chat_123',
          sdkSessionId: 'sdk_123',
          runtimeBackend: 'claude_code',
        },
      ],
    ]);
    const handler = createTaskCardActionHandler(deps as any);

    const response = await handler(
      makeEvent(
        {
          action: TASK_CARD_ACTION_RETRY,
          task_id: 'task_original',
        },
        { context: { open_chat_id: 'oc_chat_elsewhere' } },
      ),
    );

    expect(response.toast).toMatchObject({
      type: 'warning',
      content: 'This card action is not valid in this chat.',
    });
    expect(deps.feishuClient.sendMessage).not.toHaveBeenCalled();
    expect(deps.queue.enqueue).not.toHaveBeenCalled();
    expect(deps.db._inserted).toHaveLength(0);
  });

  it('ignores duplicate retry action event keys', async () => {
    const deps = makeDeps([
      [
        {
          id: 'task_original',
          sessionId: 'session_123',
          taskType: 'self_dev',
          goal: 'fix the failing tests',
          status: TaskStatus.FAILED,
          runtimeHint: 'claude_code',
          constraints: { timeoutSec: 1800 },
        },
      ],
      [
        {
          chatId: 'oc_chat_123',
          sdkSessionId: 'sdk_123',
          runtimeBackend: 'claude_code',
        },
      ],
      [{ runtimeBackend: 'claude_code' }],
    ]);
    const handler = createTaskCardActionHandler(deps as any);
    const event = makeEvent(
      {
        action: TASK_CARD_ACTION_RETRY,
        task_id: 'task_original',
      },
      { header: { event_id: 'evt_card_action_001' } },
    );

    const firstResponse = await handler(event);
    const secondResponse = await handler(event);

    expect(firstResponse.toast.type).toBe('success');
    expect(secondResponse.toast).toMatchObject({
      type: 'info',
      content: 'This card action has already been processed.',
    });
    expect(deps.feishuClient.sendMessage).toHaveBeenCalledTimes(1);
    expect(deps.queue.enqueue).toHaveBeenCalledTimes(1);
    expect(findInsertedTask(deps)).toBeDefined();
    expect(findInsertedReceipt(deps)).toBeDefined();
  });

  it('ignores persistent duplicate retry actions with distinct event keys', async () => {
    const taskRecord = {
      id: 'task_original',
      sessionId: 'session_123',
      taskType: 'self_dev',
      goal: 'fix the failing tests',
      status: TaskStatus.FAILED,
      runtimeHint: 'claude_code',
      constraints: { timeoutSec: 1800, requesterOpenId: 'ou_user_001' },
    };
    const sessionRecord = {
      chatId: 'oc_chat_123',
      sdkSessionId: 'sdk_123',
      runtimeBackend: 'claude_code',
    };
    const latestRunRecord = { runtimeBackend: 'claude_code' };
    const deps = makeDeps([
      [taskRecord],
      [sessionRecord],
      [latestRunRecord],
      [taskRecord],
      [sessionRecord],
      [latestRunRecord],
    ]);
    deps.db._receiptInsertResults.push([]);
    const handler = createTaskCardActionHandler(deps as any);

    const firstResponse = await handler(
      makeEvent(
        {
          action: TASK_CARD_ACTION_RETRY,
          task_id: 'task_original',
        },
        { header: { event_id: 'evt_card_action_001' }, open_id: 'ou_user_001' },
      ),
    );
    const secondResponse = await handler(
      makeEvent(
        {
          action: TASK_CARD_ACTION_RETRY,
          task_id: 'task_original',
        },
        { header: { event_id: 'evt_card_action_002' }, open_id: 'ou_user_001' },
      ),
    );

    expect(firstResponse.toast.type).toBe('success');
    expect(secondResponse.toast).toMatchObject({
      type: 'info',
      content: 'This card action has already been processed.',
    });
    expect(deps.queue.enqueue).toHaveBeenCalledTimes(1);
    expect(deps.db._inserted.filter((row) => typeof row.taskType === 'string')).toHaveLength(1);
    expect(deps.db._inserted.filter((row) => typeof row.dedupKey === 'string')).toHaveLength(2);
  });

  it('marks retry tasks failed when enqueue fails', async () => {
    const deps = makeDeps([
      [
        {
          id: 'task_original',
          sessionId: 'session_123',
          taskType: 'self_dev',
          goal: 'fix the failing tests',
          status: TaskStatus.FAILED,
          runtimeHint: 'claude_code',
          constraints: { timeoutSec: 1800, approvalRequired: false },
        },
      ],
      [
        {
          chatId: 'oc_chat_123',
          sdkSessionId: 'sdk_123',
          runtimeBackend: 'claude_code',
        },
      ],
      [{ runtimeBackend: 'claude_code' }],
    ]);
    (deps.queue.enqueue as any).mockRejectedValueOnce(new Error('queue down'));
    const handler = createTaskCardActionHandler(deps as any);

    const response = await handler(
      makeEvent({
        action: TASK_CARD_ACTION_RETRY,
        task_id: 'task_original',
      }),
    );

    expect(response.toast.type).toBe('error');
    expect(response.toast.content).toContain('queue down');
    expect(transitionTaskMock).toHaveBeenCalledWith(deps.db, expect.any(String), TaskStatus.QUEUED);
    expect(transitionTaskMock).toHaveBeenCalledWith(
      deps.db,
      expect.any(String),
      TaskStatus.FAILED,
      {
        errorMessage: 'queue down',
      },
    );
    expect(deps.db._updates).toContainEqual({
      values: expect.objectContaining({ feedbackState: 'failed' }),
    });
  });

  it('keeps feedback state empty when enqueue fails without an ack message', async () => {
    const deps = makeDeps([
      [
        {
          id: 'task_original',
          sessionId: 'session_123',
          taskType: 'self_dev',
          goal: 'fix the failing tests',
          status: TaskStatus.FAILED,
          runtimeHint: 'claude_code',
          constraints: { timeoutSec: 1800, approvalRequired: false },
        },
      ],
      [
        {
          chatId: 'oc_chat_123',
          sdkSessionId: 'sdk_123',
          runtimeBackend: 'claude_code',
        },
      ],
      [{ runtimeBackend: 'claude_code' }],
    ]);
    deps.feishuClient.sendMessage.mockResolvedValueOnce({} as any);
    (deps.queue.enqueue as any).mockRejectedValueOnce(new Error('queue down'));
    const handler = createTaskCardActionHandler(deps as any);

    const response = await handler(
      makeEvent({
        action: TASK_CARD_ACTION_RETRY,
        task_id: 'task_original',
      }),
    );

    expect(response.toast.type).toBe('error');
    expect(findInsertedTask(deps)).toMatchObject({
      feedbackMessageId: null,
      feedbackCardType: null,
      feedbackState: null,
      feedbackUpdatedAt: null,
    });
    expect(deps.db._updates).toContainEqual({
      values: expect.objectContaining({
        feedbackState: null,
        feedbackUpdatedAt: null,
      }),
    });
  });

  it('preserves debug execution skip on retry jobs', async () => {
    const deps = makeDeps([
      [
        {
          id: 'task_original',
          sessionId: 'session_123',
          taskType: 'self_dev',
          goal: 'fix the failing tests',
          status: TaskStatus.FAILED,
          runtimeHint: 'claude_code',
          constraints: {
            timeoutSec: 1800,
            approvalRequired: false,
            replyLanguage: 'en-US',
            debugSkipExecution: true,
          },
        },
      ],
      [
        {
          chatId: 'oc_chat_123',
          sdkSessionId: 'sdk_123',
          runtimeBackend: 'claude_code',
        },
      ],
      [{ runtimeBackend: 'claude_code' }],
    ]);
    const handler = createTaskCardActionHandler(deps as any);

    await handler(
      makeEvent({
        action: TASK_CARD_ACTION_RETRY,
        task_id: 'task_original',
      }),
    );

    expect(deps.queue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        constraints: expect.objectContaining({
          debugSkipExecution: true,
        }),
      }),
    );
  });

  it('inherits agent and Feishu app identity on retry tasks', async () => {
    const appClient = {
      sendMessage: vi.fn(async () => ({ messageId: 'msg_app_ack_001' })),
    };
    const deps = {
      ...makeDeps([
        [
          {
            id: 'task_original',
            sessionId: 'session_123',
            agentId: 'agent_123',
            feishuAppId: 'app_123',
            taskType: 'self_dev',
            goal: 'fix the failing tests',
            status: TaskStatus.FAILED,
            runtimeHint: 'claude_code',
            constraints: { timeoutSec: 1800, approvalRequired: false },
          },
        ],
        [
          {
            chatId: 'oc_chat_123',
            sdkSessionId: 'sdk_123',
            runtimeBackend: 'claude_code',
          },
        ],
        [{ runtimeBackend: 'claude_code' }],
      ]),
      feishuClientResolver: vi.fn(() => appClient),
    };
    const handler = createTaskCardActionHandler(deps as any);

    await handler(
      makeEvent({
        action: TASK_CARD_ACTION_RETRY,
        task_id: 'task_original',
      }),
    );

    expect(deps.feishuClientResolver).toHaveBeenCalledWith('app_123');
    expect(appClient.sendMessage).toHaveBeenCalled();
    expect(findInsertedTask(deps)).toMatchObject({
      agentId: 'agent_123',
      feishuAppId: 'app_123',
      feedbackMessageId: 'msg_app_ack_001',
    });
    expect(deps.queue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent_123',
        feishuAppId: 'app_123',
        constraints: expect.objectContaining({
          agentId: 'agent_123',
          feishuAppId: 'app_123',
        }),
      }),
    );
  });

  it('forces codex for the runtime override action and clears the session resume state', async () => {
    const deps = makeDeps([
      [
        {
          id: 'task_original',
          sessionId: 'session_123',
          taskType: 'analysis',
          goal: 'summarize the implementation',
          status: TaskStatus.COMPLETED,
          runtimeHint: 'claude_code',
          constraints: { timeoutSec: 1800, approvalRequired: false },
        },
      ],
      [
        {
          chatId: 'oc_chat_123',
          sdkSessionId: 'sdk_claude',
          runtimeBackend: 'claude_code',
        },
      ],
      [{ runtimeBackend: 'claude_code' }],
    ]);
    const handler = createTaskCardActionHandler(deps as any);

    const response = await handler(
      makeEvent({
        action: TASK_CARD_ACTION_RETRY_RUNTIME,
        task_id: 'task_original',
        runtime: 'codex',
      }),
    );

    expect(response).toEqual({
      toast: {
        type: 'success',
        content: 'Queued a new Codex run.',
      },
    });
    expect(findInsertedTask(deps)).toMatchObject({
      runtimeHint: 'codex',
    });
    expect(deps.queue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeHint: 'codex',
        sdkSessionId: undefined,
        runtimeBackend: undefined,
      }),
    );
    expect(deps.db._updates).toHaveLength(1);
    expect(deps.db._updates[0].values).toMatchObject({
      sdkSessionId: null,
      runtimeBackend: null,
    });
  });

  it('returns a safe toast for unsupported action payloads', async () => {
    const deps = makeDeps([]);
    const handler = createTaskCardActionHandler(deps as any);

    const response = await handler(
      makeEvent({
        action: 'unknown_action',
        task_id: 'task_original',
      }),
    );

    expect(response).toEqual({
      toast: {
        type: 'info',
        content: 'Unsupported card action.',
      },
    });
    expect(deps.db.select).not.toHaveBeenCalled();
    expect(deps.db.insert).not.toHaveBeenCalled();
    expect(deps.queue.enqueue).not.toHaveBeenCalled();
    expect(deps.feishuClient.sendMessage).not.toHaveBeenCalled();
  });

  it('accepts runtime-only workdir form confirmation without requiring workDir', async () => {
    const deps = makeDeps([
      [
        {
          status: TaskStatus.WAITING_APPROVAL,
          taskType: 'self_dev',
          constraints: {},
        },
      ],
    ]);
    const handler = createTaskCardActionHandler(deps as any);

    const response = await handler({
      open_message_id: 'om_123',
      action: {
        tag: 'button',
        value: {
          action: WORKDIR_FORM_SUBMIT,
          sessionId: 'session_123',
          chatId: 'oc_chat_123',
          taskId: 'task_waiting',
          replyLanguage: 'en-US',
          goal: 'compare cards',
          runtime: 'claude_code',
        },
        form_value: {
          goal: 'compare cards',
          runtime: 'codex',
          workDir: '',
        },
      },
    });

    expect(response.toast.type).toBe('success');
    expect(deps.db._inserted).toHaveLength(1);
    expect(deps.db._inserted[0]).toMatchObject({
      sessionId: 'session_123',
      parentTaskId: 'task_waiting',
      taskType: 'self_dev',
      goal: 'compare cards',
      runtimeHint: 'codex',
      constraints: expect.objectContaining({
        chatId: 'oc_chat_123',
        confirmedRuntime: 'codex',
        replyLanguage: 'en-US',
      }),
    });
    expect(
      (deps.db._inserted[0].constraints as Record<string, unknown>).confirmedWorkDir,
    ).toBeUndefined();
    expect(deps.queue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeHint: 'codex',
        taskType: 'self_dev',
        constraints: expect.objectContaining({
          confirmedRuntime: 'codex',
        }),
      }),
    );
    expect(
      (deps.queue.enqueue as any).mock.calls[0][0].constraints.confirmedWorkDir,
    ).toBeUndefined();
    expect(deps.db._updates).toHaveLength(0);
  });

  it('rejects workdir form confirmations from a different Feishu operator', async () => {
    const deps = makeDeps([
      [
        {
          status: TaskStatus.WAITING_APPROVAL,
          taskType: 'self_dev',
          constraints: {
            sourceCommand: '/dev',
            feishuContext: { senderOpenId: 'ou_owner' },
          },
        },
      ],
    ]);
    const handler = createTaskCardActionHandler(deps as any);

    const response = await handler({
      open_message_id: 'om_123',
      open_id: 'ou_intruder',
      action: {
        tag: 'button',
        value: {
          action: WORKDIR_FORM_SUBMIT,
          sessionId: 'session_123',
          chatId: 'oc_chat_123',
          taskId: 'task_waiting',
          replyLanguage: 'en-US',
          goal: 'compare cards',
          runtime: 'claude_code',
        },
        form_value: {
          goal: 'compare cards',
          runtime: 'codex',
          workDir: '',
        },
      },
    });

    expect(response.toast).toMatchObject({
      type: 'warning',
      content: 'Only the original requester can use this card action.',
    });
    expect(deps.feishuClient.sendMessage).not.toHaveBeenCalled();
    expect(deps.queue.enqueue).not.toHaveBeenCalled();
    expect(deps.db._inserted).toHaveLength(0);
  });

  it('inherits agent and Feishu app identity on workdir confirmations', async () => {
    const appClient = {
      sendMessage: vi.fn(async () => ({ messageId: 'msg_app_ack_002' })),
    };
    const deps = {
      ...makeDeps([
        [
          {
            status: TaskStatus.WAITING_APPROVAL,
            taskType: 'self_dev',
            agentId: 'agent_123',
            feishuAppId: 'app_123',
            constraints: {},
          },
        ],
      ]),
      feishuClientResolver: vi.fn(() => appClient),
    };
    const handler = createTaskCardActionHandler(deps as any);

    await handler({
      open_message_id: 'om_123',
      action: {
        tag: 'button',
        value: {
          action: WORKDIR_FORM_SUBMIT,
          sessionId: 'session_123',
          chatId: 'oc_chat_123',
          taskId: 'task_waiting',
          replyLanguage: 'en-US',
          goal: 'continue with confirmed workdir',
          runtime: 'claude_code',
        },
        form_value: {
          goal: 'continue with confirmed workdir',
          runtime: 'claude_code',
          workDir: '/tmp/project',
        },
      },
    });

    expect(deps.feishuClientResolver).toHaveBeenCalledWith('app_123');
    expect(appClient.sendMessage).toHaveBeenCalled();
    expect(deps.db._inserted[0]).toMatchObject({
      agentId: 'agent_123',
      feishuAppId: 'app_123',
      feedbackMessageId: 'msg_app_ack_002',
      constraints: expect.objectContaining({
        agentId: 'agent_123',
        feishuAppId: 'app_123',
      }),
    });
    expect(deps.queue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent_123',
        feishuAppId: 'app_123',
        constraints: expect.objectContaining({
          agentId: 'agent_123',
          feishuAppId: 'app_123',
        }),
      }),
    );
  });
});
