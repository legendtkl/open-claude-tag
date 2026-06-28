import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IntentType, TaskStatus } from '@open-tag/core-types';
import type { NormalizedEvent } from '@open-tag/core-types';
import { adaptNormalizedEvent, deriveFeishuTaskAttachments } from '@open-tag/feishu-adapter';
import { handleEvent, type HandleEventOptions } from '../orchestrator.js';

/**
 * Mirror the production call site (ADR-0004 1a-ii): the vendor-aware caller adapts
 * the Feishu event to the neutral InboundMessage and supplies the non-lossless
 * attachment payloads + the exact source message id as options. Tests drive
 * `handleEvent` through this seam so they exercise the migrated contract.
 */
function dispatch(
  db: unknown,
  event: NormalizedEvent,
  sessionId: string,
  opts: HandleEventOptions = {},
) {
  return handleEvent(db as never, adaptNormalizedEvent(event), sessionId, {
    ...deriveFeishuTaskAttachments(event),
    userMessageId: event.messageId,
    ...opts,
  });
}

// ── Mock DB ──
function createMockDb(input: { createdRows?: unknown[]; existingRows?: unknown[] } = {}) {
  const mockReturning = vi.fn().mockResolvedValue(input.createdRows ?? [{ id: 'mock-task-id' }]);
  const mockOnConflictDoNothing = vi.fn().mockReturnValue({ returning: mockReturning });
  const mockValues = vi.fn().mockReturnValue({
    onConflictDoNothing: mockOnConflictDoNothing,
    returning: mockReturning,
  });
  const mockInsert = vi.fn().mockReturnValue({ values: mockValues });
  const mockLimit = vi.fn().mockResolvedValue(input.existingRows ?? []);
  const mockWhere = vi.fn().mockReturnValue({ limit: mockLimit });
  const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
  const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });
  return {
    insert: mockInsert,
    select: mockSelect,
    _getInsertedValues: () => mockValues.mock.calls[0]?.[0],
    _getMocks: () => ({
      mockOnConflictDoNothing,
      mockReturning,
      mockSelect,
    }),
  };
}

function makeEvent(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    eventId: 'evt_1',
    messageId: 'msg_1',
    chatId: 'chat_1',
    chatType: 'group',
    senderOpenId: 'user_1',
    tenantKey: 'tenant_1',
    content: {
      type: 'text',
      text: 'hello world',
      raw: {},
    },
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('handleEvent: runtime selection without per-message override', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    db = createMockDb();
  });

  it('creates tasks with auto runtime (null runtimeHint) for plain text', async () => {
    const event = makeEvent({
      content: { type: 'text', text: '写一个排序函数并解释思路设计取舍', raw: {} },
    });
    const result = await dispatch(db, event, 'session_1');

    expect(result.type).toBe('task_created');
    expect(result.runtime).toBe('auto');
    const inserted = db._getInsertedValues();
    expect(inserted.runtimeHint).toBeNull();
  });
});

describe('handleEvent: dispatch contract (no keyword intent classifier)', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    db = createMockDb();
  });

  it('labels analysis-style text as CHAT_REPLY (the keyword classifier is gone)', async () => {
    // The removed classifier would have called this ANALYSIS; every non-ops
    // message is now a chat_reply and the runtime decides its own approach.
    const event = makeEvent({
      content: { type: 'text', text: '分析这个仓库的整体架构并解释为什么这样设计', raw: {} },
    });
    const result = await dispatch(db, event, 'session_1');

    expect(result.type).toBe('task_created');
    expect(result.intent).toBe(IntentType.CHAT_REPLY);
    const inserted = db._getInsertedValues();
    expect(inserted.taskType).toBe(IntentType.CHAT_REPLY);
    expect(inserted.runtimeHint).toBeNull();
  });

  it('short-circuits an ops slash command to a direct reply (OPS_TASK), no task row', async () => {
    const event = makeEvent({
      content: { type: 'command', command: '/status', text: '/status', raw: {} },
    });
    const result = await dispatch(db, event, 'session_1');

    expect(result.type).toBe('direct_reply');
    expect(result.intent).toBe(IntentType.OPS_TASK);
    expect(db._getInsertedValues()).toBeUndefined();
  });

  it('treats a non-ops command reaching handleEvent as a CHAT_REPLY task', async () => {
    const event = makeEvent({
      content: { type: 'command', command: '/unknown', text: '/unknown do work', raw: {} },
    });
    const result = await dispatch(db, event, 'session_1');

    expect(result.type).toBe('task_created');
    expect(result.intent).toBe(IntentType.CHAT_REPLY);
  });
});

describe('handleEvent: task creation metadata', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    db = createMockDb();
  });

  it('persists replyLanguage into task constraints', async () => {
    const event = makeEvent({
      replyLanguage: 'zh-CN',
      content: {
        type: 'text',
        text: '修复语言透传',
        raw: {},
      },
    });

    const result = await dispatch(db, event, 'session_1');

    expect(result.type).toBe('task_created');
    const inserted = db._getInsertedValues();
    expect(inserted.constraints).toMatchObject({
      timeoutSec: 1800,
      approvalRequired: false,
      tenantKey: 'tenant_1',
      chatId: 'chat_1',
      userMessageId: 'msg_1',
      requesterOpenId: 'user_1',
      replyLanguage: 'zh-CN',
    });
  });

  it('persists agent identity on created tasks and constraints when provided', async () => {
    const event = makeEvent({
      content: {
        type: 'text',
        text: '修复 agent context',
        raw: {},
      },
    });

    const result = await dispatch(db, event, 'session_1', {
      agentId: 'agent_123',
      feishuAppId: 'app_123',
    });

    expect(result.type).toBe('task_created');
    const inserted = db._getInsertedValues();
    expect(inserted).toMatchObject({
      agentId: 'agent_123',
      feishuAppId: 'app_123',
    });
    expect(inserted.constraints).toMatchObject({
      agentId: 'agent_123',
      feishuAppId: 'app_123',
    });
  });

  it('persists extra task constraints on created tasks', async () => {
    const event = makeEvent({
      content: {
        type: 'text',
        text: '@A 完成后 @B review',
        raw: {},
      },
    });

    const result = await dispatch(db, event, 'session_1', {
      extraTaskConstraints: {
        multiMentionRouting: {
          route: 'relay',
          status: 'pending',
          relayKey: 'relay:tenant:chat:msg:a:b',
        },
      },
    });

    expect(result.type).toBe('task_created');
    const inserted = db._getInsertedValues();
    expect(inserted.constraints).toMatchObject({
      multiMentionRouting: {
        route: 'relay',
        status: 'pending',
        relayKey: 'relay:tenant:chat:msg:a:b',
      },
    });
  });

  it('uses an explicit task id when provided', async () => {
    const event = makeEvent({
      content: {
        type: 'text',
        text: 'hello',
        raw: {},
      },
    });

    const result = await dispatch(db, event, 'session_1', {
      taskId: 'task_stable_123',
    });

    expect(result).toMatchObject({ type: 'task_created', taskId: 'task_stable_123' });
    const inserted = db._getInsertedValues();
    expect(inserted.id).toBe('task_stable_123');
  });

  it('returns a duplicate no-op when an explicit task id already exists with matching data', async () => {
    const event = makeEvent({
      content: {
        type: 'text',
        text: 'hello duplicate',
        raw: {},
      },
    });
    const db = createMockDb({
      createdRows: [],
      existingRows: [
        {
          id: 'task_stable_123',
          sessionId: 'session_1',
          agentId: 'agent_123',
          feishuAppId: 'app_123',
          taskType: IntentType.CHAT_REPLY,
          goal: 'hello duplicate',
          runtimeHint: null,
          status: TaskStatus.PENDING,
          constraints: {
            timeoutSec: 1800,
            approvalRequired: false,
            tenantKey: 'tenant_1',
            chatId: 'chat_1',
            agentId: 'agent_123',
            feishuAppId: 'app_123',
            userMessageId: 'msg_1',
            requesterOpenId: 'user_1',
            relayKey: 'relay:task_stable_123:reviewer:0',
          },
        },
      ],
    });

    const result = await dispatch(db, event, 'session_1', {
      taskId: 'task_stable_123',
      agentId: 'agent_123',
      feishuAppId: 'app_123',
      extraTaskConstraints: {
        relayKey: 'relay:task_stable_123:reviewer:0',
      },
    });

    expect(result).toMatchObject({ type: 'task_duplicate', taskId: 'task_stable_123' });
    expect(db._getMocks().mockOnConflictDoNothing).toHaveBeenCalled();
    expect(db._getMocks().mockSelect).toHaveBeenCalled();
  });

  it('matches duplicate explicit task constraints regardless of JSON object key order', async () => {
    const event = makeEvent({
      content: {
        type: 'text',
        text: 'hello relay duplicate',
        raw: {},
      },
    });
    const db = createMockDb({
      createdRows: [],
      existingRows: [
        {
          id: 'task_stable_456',
          sessionId: 'session_1',
          agentId: 'agent_123',
          feishuAppId: 'app_123',
          taskType: IntentType.CHAT_REPLY,
          goal: 'hello relay duplicate',
          runtimeHint: null,
          status: TaskStatus.PENDING,
          constraints: {
            timeoutSec: 1800,
            approvalRequired: false,
            tenantKey: 'tenant_1',
            chatId: 'chat_1',
            agentId: 'agent_123',
            feishuAppId: 'app_123',
            userMessageId: 'msg_1',
            requesterOpenId: 'user_1',
            multiMentionRouting: {
              status: 'pending',
              route: 'relay',
              target: {
                handle: 'reviewer',
                agentId: 'agent_456',
              },
              primary: {
                agentId: 'agent_123',
                handle: 'developer',
              },
            },
          },
        },
      ],
    });

    const result = await dispatch(db, event, 'session_1', {
      taskId: 'task_stable_456',
      agentId: 'agent_123',
      feishuAppId: 'app_123',
      extraTaskConstraints: {
        multiMentionRouting: {
          route: 'relay',
          status: 'pending',
          primary: {
            handle: 'developer',
            agentId: 'agent_123',
          },
          target: {
            agentId: 'agent_456',
            handle: 'reviewer',
          },
        },
      },
    });

    expect(result).toMatchObject({ type: 'task_duplicate', taskId: 'task_stable_456' });
    expect(db._getMocks().mockOnConflictDoNothing).toHaveBeenCalled();
    expect(db._getMocks().mockSelect).toHaveBeenCalled();
  });

  // Regression for #10: a recovery redelivery (task_duplicate) is re-enqueued on
  // the neutral/Slack path using result.goal, so the duplicate branch must return
  // the persisted goal (with referenced context), not the bare current text.
  it('duplicate recovery returns the persisted goal incl. referenced context, not the bare text', async () => {
    const bareText = '学习这些进度，给我下周计划';
    const fullGoal = [
      bareText,
      ['[Referenced Feishu message: om_record_1]', '周俊戈: 第一条', '乐露薇: 第二条'].join('\n'),
    ].join('\n\n');
    const event = makeEvent({
      content: {
        type: 'text',
        text: bareText,
        referencedMessages: [
          {
            messageId: 'om_record_1',
            contentType: 'rich_text',
            entries: [
              { author: '周俊戈', text: '第一条' },
              { author: '乐露薇', text: '第二条' },
            ],
          },
        ],
        raw: {},
      },
    });
    const db = createMockDb({
      createdRows: [],
      existingRows: [
        {
          id: 'task_ref_dup',
          sessionId: 'session_1',
          agentId: null,
          feishuAppId: null,
          taskType: IntentType.CHAT_REPLY,
          goal: fullGoal,
          runtimeHint: null,
          status: TaskStatus.PENDING,
          constraints: {
            timeoutSec: 1800,
            approvalRequired: false,
            tenantKey: 'tenant_1',
            chatId: 'chat_1',
            userMessageId: 'msg_1',
            requesterOpenId: 'user_1',
          },
        },
      ],
    });

    const result = await dispatch(db, event, 'session_1', { taskId: 'task_ref_dup' });

    expect(result.type).toBe('task_duplicate');
    expect(result.goal).toBe(fullGoal);
    expect(result.goal).toContain('[Referenced Feishu message: om_record_1]');
    expect(result.goal).not.toBe(bareText);
  });

});

describe('handleEvent: image message routing', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    db = createMockDb();
  });

  it('image message preserves automatic runtime selection', async () => {
    const event = makeEvent({
      content: {
        type: 'image',
        imageKey: 'img_v2_abc123',
        imageMessageId: 'msg_1',
        raw: {},
      },
    });
    const result = await dispatch(db, event, 'session_1');

    expect(result.type).toBe('task_created');
    expect(result.runtime).toBe('auto');
  });

  it('image message with no text uses default goal', async () => {
    const event = makeEvent({
      content: {
        type: 'image',
        imageKey: 'img_v2_abc123',
        imageMessageId: 'msg_1',
        raw: {},
      },
    });
    await dispatch(db, event, 'session_1');

    const inserted = db._getInsertedValues();
    expect(inserted.goal).toBe('请分析这张图片');
  });

  it('image message includes imageAttachment in result', async () => {
    const event = makeEvent({
      content: {
        type: 'image',
        imageKey: 'img_v2_abc123',
        imageMessageId: 'msg_1',
        raw: {},
      },
    });
    const result = await dispatch(db, event, 'session_1');

    expect(result.imageAttachment).toEqual({ imageKey: 'img_v2_abc123', messageId: 'msg_1' });
    expect(db._getInsertedValues().constraints.imageAttachment).toEqual({
      imageKey: 'img_v2_abc123',
      messageId: 'msg_1',
    });
  });

  it('file message includes fileAttachment in result and task constraints', async () => {
    const fileAttachment = {
      resourceKey: 'file_v2_abc123',
      messageId: 'msg_file_1',
      resourceType: 'file' as const,
      fileName: 'report.pdf',
      mimeType: 'application/pdf',
    };
    const event = makeEvent({
      content: {
        type: 'file',
        fileAttachment,
        raw: {},
      },
    });
    const result = await dispatch(db, event, 'session_1');

    expect(result.fileAttachment).toEqual(fileAttachment);
    expect(result.goal).toBe('请分析这个文件');
    expect(db._getInsertedValues().constraints.fileAttachment).toEqual(fileAttachment);
  });

  it('referenced image message preserves automatic runtime selection and includes imageAttachment', async () => {
    const event = makeEvent({
      content: {
        type: 'text',
        text: '分析一下引用的图片',
        referencedMessages: [
          {
            messageId: 'om_ref_image_1',
            contentType: 'image',
            entries: [],
            imageAttachment: {
              imageKey: 'img_ref_1',
              messageId: 'om_ref_image_1',
            },
          },
        ],
        raw: {},
      },
    });

    const result = await dispatch(db, event, 'session_1');

    expect(result.type).toBe('task_created');
    expect(result.runtime).toBe('auto');
    expect(result.imageAttachment).toEqual({
      imageKey: 'img_ref_1',
      messageId: 'om_ref_image_1',
    });
    expect(db._getInsertedValues().constraints.imageAttachment).toEqual({
      imageKey: 'img_ref_1',
      messageId: 'om_ref_image_1',
    });
  });


  it('appends every referenced chat record entry to the task goal', async () => {
    const event = makeEvent({
      content: {
        type: 'text',
        text: '学习一下这些进度，给我下周计划',
        referencedMessages: [
          {
            messageId: 'om_record_1',
            contentType: 'rich_text',
            entries: [
              { author: '周俊戈', text: '第一条收支差更新' },
              { author: '周俊戈', text: '第二条治理进度' },
              { author: '乐露薇', text: '第三条分析诉求' },
            ],
          },
        ],
        raw: {},
      },
    });

    const result = await dispatch(db, event, 'session_1');

    expect(result.type).toBe('task_created');
    expect(result.goal).toContain('学习一下这些进度，给我下周计划');
    expect(result.goal).toContain('[Referenced Feishu message: om_record_1]');
    expect(result.goal).toContain('周俊戈: 第一条收支差更新');
    expect(result.goal).toContain('周俊戈: 第二条治理进度');
    expect(result.goal).toContain('乐露薇: 第三条分析诉求');

    const inserted = db._getInsertedValues();
    expect(inserted.goal).toBe(result.goal);
  });

  it('image message with text uses the text as goal', async () => {
    const event = makeEvent({
      content: {
        type: 'image',
        text: '这个错误是什么意思',
        imageKey: 'img_v2_abc123',
        imageMessageId: 'msg_1',
        raw: {},
      },
    });
    await dispatch(db, event, 'session_1');

    const inserted = db._getInsertedValues();
    expect(inserted.goal).toBe('这个错误是什么意思');
  });

  it('image message without imageKey has no imageAttachment', async () => {
    const event = makeEvent({
      content: {
        type: 'image',
        raw: {},
      },
    });
    const result = await dispatch(db, event, 'session_1');

    expect(result.imageAttachment).toBeUndefined();
  });
});

describe('handleEvent: default routing', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    db = createMockDb();
  });

  it('normal text returns auto runtime (inherits session runtime)', async () => {
    const event = makeEvent({
      content: { type: 'text', text: '帮我写一个排序函数', raw: {} },
    });
    const result = await dispatch(db, event, 'session_1');

    expect(result.type).toBe('task_created');
    expect(result.runtime).toBe('auto'); // no explicit --runtime; preserves session runtime
    expect(result.intent).toBe(IntentType.CHAT_REPLY);
  });

  it('chat message returns auto runtime (inherits session runtime)', async () => {
    const event = makeEvent({
      content: { type: 'text', text: '你好', raw: {} },
    });
    const result = await dispatch(db, event, 'session_1');

    expect(result.type).toBe('task_created');
    expect(result.runtime).toBe('auto'); // no explicit --runtime; preserves session runtime
    expect(result.intent).toBe(IntentType.CHAT_REPLY);
  });
});
