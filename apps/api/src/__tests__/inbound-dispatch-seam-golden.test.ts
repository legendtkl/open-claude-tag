/**
 * Golden characterization tests for the inbound dispatch seam (Stage 1a-i).
 *
 * These pin the CURRENT observable behavior of the channel boundary the new
 * `dispatchInboundMessageViaFeishuNative` seam relies on, so any later slice of
 * the `NormalizedEvent` -> `InboundMessage` reshape is guarded:
 *
 *  1. The seam recovers the Feishu-native `NormalizedEvent` from
 *     `InboundMessage.channel.native`. That recovery MUST be lossless — both
 *     reference-equal and deep-equal to the event the adapter was given — or the
 *     dispatch core would see a different event and change behavior.
 *  2. The dispatch outcome (orchestrator task row + enqueued queue job) MUST be
 *     identical whether the dispatch core is fed the original event or the
 *     seam-recovered event. Today that is true by construction (same reference);
 *     pinning it now turns every future "read `inbound.*` instead of `event.*`"
 *     slice into a guarded change.
 *
 * Scope note (per the design review): the un-addressed/observation branch and the
 * document-comment branch stay OUTSIDE the seam, so they are not exercised here.
 * The DB-backed end-to-end dispatch body (dedupe, enrichment, routing, session,
 * buffer gate, feedback, enqueue) is characterized by the existing
 * `/debug/simulate` e2e suite (`self-dev.e2e.test.ts`).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { IntentType } from '@open-tag/core-types';
import type { NormalizedEvent } from '@open-tag/core-types';
import { adaptNormalizedEvent, deriveFeishuTaskAttachments } from '@open-tag/feishu-adapter';
import { handleEvent } from '@open-tag/orchestrator';
import { buildQueuedTaskInput } from '../task-dispatch.js';

// ── Mock DB mirroring orchestrator.test.ts: captures the inserted task row. ──
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
  };
}

/** Recover the dispatch event exactly as the seam does (`channel.native`). */
function recover(event: NormalizedEvent): NormalizedEvent {
  const inbound = adaptNormalizedEvent(event);
  expect(inbound.channel.kind).toBe('lark');
  return inbound.channel.native as NormalizedEvent;
}

/**
 * Drive the dispatch core exactly as the production caller does after the
 * ADR-0004 1a-ii migration: adapt the Feishu event to the neutral InboundMessage
 * and supply the non-lossless attachment payloads + exact source message id as
 * options. The behavioral assertions below are unchanged; only the entry seam is.
 */
function dispatch(
  db: ReturnType<typeof createMockDb>,
  event: NormalizedEvent,
  sessionId: string,
  opts: Parameters<typeof handleEvent>[3] = {},
) {
  return handleEvent(db as never, adaptNormalizedEvent(event), sessionId, {
    ...deriveFeishuTaskAttachments(event),
    userMessageId: event.messageId,
    ...opts,
  });
}

function makeEvent(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    eventId: 'evt_seam_1',
    messageId: 'om_seam_1',
    chatId: 'oc_seam_chat',
    chatType: 'group',
    senderOpenId: 'ou_seam_sender',
    senderUnionId: 'on_seam_sender',
    senderType: 'user',
    tenantKey: 'tenant_seam',
    content: {
      type: 'text',
      text: 'hello world',
      raw: { schema: '2.0' },
    },
    replyLanguage: 'zh-CN',
    timestamp: 1710000000000,
    ...overrides,
  };
}

// Representative inbound matrix at the NormalizedEvent layer the seam recovers.
const CASES: Array<{ name: string; event: NormalizedEvent }> = [
  {
    name: '@mention dispatching a chat_reply task',
    event: makeEvent({
      content: {
        type: 'text',
        text: '写一个排序函数并解释思路设计取舍',
        mentions: [{ id: 'ou_bot', name: 'Bot', isBot: true, key: '@_user_1' }],
        raw: {},
      },
    }),
  },
  {
    name: 'slash command with args',
    event: makeEvent({
      content: {
        type: 'command',
        text: '/schedule 30分钟后 improve runtime selection',
        command: '/schedule',
        args: '30分钟后 improve runtime selection',
        commandIndex: 0,
        raw: {},
      },
    }),
  },
  {
    name: 'image attachment message',
    event: makeEvent({
      content: {
        type: 'image',
        imageKey: 'img_seam_key',
        imageMessageId: 'om_seam_1',
        raw: {},
      },
    }),
  },
  {
    name: 'file attachment message',
    event: makeEvent({
      content: {
        type: 'file',
        text: 'summarize the file',
        fileAttachment: {
          resourceKey: 'file_seam_key',
          messageId: 'om_seam_1',
          resourceType: 'file',
          fileName: 'report.pdf',
          mimeType: 'application/pdf',
        },
        raw: {},
      },
    }),
  },
  {
    name: 'post message with rich_text content',
    event: makeEvent({
      content: {
        type: 'rich_text',
        text: '请分析这段富文本内容并给出结论',
        raw: { post: { zh_cn: { title: 't' } } },
      },
    }),
  },
  {
    name: 'message referencing a prior chat record',
    event: makeEvent({
      content: {
        type: 'text',
        text: '学习一下引用记录',
        referencedMessages: [
          {
            messageId: 'om_ref_1',
            contentType: 'rich_text',
            entries: [
              { author: '周俊戈', text: '第一条' },
              { author: '乐露薇', text: '第二条' },
            ],
            warnings: ['Skipped 1 unsupported referenced chat record entries'],
          },
        ],
        referencedMessageWarnings: ['Referenced parser skipped unsupported entries'],
        raw: {},
      },
    }),
  },
];

describe('inbound dispatch seam — channel.native recovery contract', () => {
  for (const { name, event } of CASES) {
    it(`${name}: recovers the native event losslessly (reference + deep equal)`, () => {
      const inbound = adaptNormalizedEvent(event);
      expect(inbound.channel.kind).toBe('lark');
      // The seam hands `channel.native` to the dispatch core verbatim. It must be
      // the exact same object the adapter received, so dispatch is byte-identical.
      expect(inbound.channel.native).toBe(event);
      expect(inbound.channel.native).toEqual(event);
    });
  }
});

describe('inbound dispatch seam — dispatch outcome is identical for original vs recovered', () => {
  for (const { name, event } of CASES) {
    it(`${name}: orchestrator task row matches`, async () => {
      const dbOriginal = createMockDb();
      const dbRecovered = createMockDb();

      // Pin a fixed taskId so the only non-deterministic field (handleEvent mints
      // a random uuid otherwise) cannot mask a real difference between the two.
      const opts = { taskId: 'task-seam-fixed' };
      const fromOriginal = await dispatch(dbOriginal, event, 'session-seam', opts);
      const fromRecovered = await dispatch(dbRecovered, recover(event), 'session-seam', opts);

      expect(fromRecovered).toEqual(fromOriginal);
      expect(dbRecovered._getInsertedValues()).toEqual(dbOriginal._getInsertedValues());
    });
  }
});

describe('inbound dispatch seam — pinned dispatch shapes (today\'s behavior)', () => {
  it('@mention task: pins chat_reply task type, auto runtime, and goal', async () => {
    // After the keyword intent classifier was removed, every non-ops inbound
    // message pins `chat_reply` (the runtime decides its own approach).
    const event = CASES[0].event;
    const db = createMockDb();
    const result = await dispatch(db, event, 'session-seam', {
      agentId: 'agent_seam',
      feishuAppId: 'app_seam',
    });

    expect(result.type).toBe('task_created');
    const inserted = db._getInsertedValues();
    expect(inserted).toMatchObject({
      sessionId: 'session-seam',
      agentId: 'agent_seam',
      feishuAppId: 'app_seam',
      taskType: IntentType.CHAT_REPLY,
      goal: '写一个排序函数并解释思路设计取舍',
      runtimeHint: null,
      constraints: {
        tenantKey: 'tenant_seam',
        chatId: 'oc_seam_chat',
        userMessageId: 'om_seam_1',
        requesterOpenId: 'ou_seam_sender',
        replyLanguage: 'zh-CN',
      },
    });
  });

  it('image task: preserves runtime and carries imageAttachment into constraints', async () => {
    const event = CASES[2].event;
    const db = createMockDb();
    const result = await dispatch(db, event, 'session-seam');

    expect(result.type).toBe('task_created');
    expect(result.imageAttachment).toEqual({ imageKey: 'img_seam_key', messageId: 'om_seam_1' });
    expect(db._getInsertedValues().constraints).toMatchObject({
      imageAttachment: { imageKey: 'img_seam_key', messageId: 'om_seam_1' },
    });
  });

  it('file task: carries fileAttachment into constraints', async () => {
    const event = CASES[3].event;
    const db = createMockDb();
    const result = await dispatch(db, event, 'session-seam');

    expect(result.type).toBe('task_created');
    expect(db._getInsertedValues().constraints).toMatchObject({
      fileAttachment: {
        resourceKey: 'file_seam_key',
        messageId: 'om_seam_1',
        resourceType: 'file',
        fileName: 'report.pdf',
        mimeType: 'application/pdf',
      },
    });
  });

  it('referenced task: folds referenced chat records into the goal', async () => {
    const event = CASES[5].event;
    const db = createMockDb();
    const result = await dispatch(db, event, 'session-seam');

    expect(result.type).toBe('task_created');
    expect(result.goal).toContain('学习一下引用记录');
    expect(result.goal).toContain('第一条');
    expect(result.goal).toContain('第二条');
  });
});

describe('inbound dispatch seam — enqueued job is identical for original vs recovered', () => {
  for (const { name, event } of CASES) {
    it(`${name}: buildQueuedTaskInput job matches`, () => {
      const baseInput = {
        sessionId: 'session-seam',
        agentId: 'agent_seam',
        feishuAppId: 'app_seam',
        result: {
          taskId: 'task-seam',
          intent: IntentType.CHAT_REPLY,
          runtime: 'auto' as const,
          goal: 'pinned goal',
          imageAttachment: undefined,
        },
        ackMessageId: 'ack-seam',
        replyToMessageId: 'om_reply_seam',
      };

      const fromOriginal = buildQueuedTaskInput({ ...baseInput, event });
      const fromRecovered = buildQueuedTaskInput({ ...baseInput, event: recover(event) });

      expect(fromRecovered.job).toEqual(fromOriginal.job);
      expect(fromRecovered.isRuntimeSwitch).toBe(fromOriginal.isRuntimeSwitch);
    });
  }

  it('slash command: pins sourceCommand and Feishu constraints on the job', () => {
    const { job } = buildQueuedTaskInput({
      event: CASES[1].event,
      sessionId: 'session-seam',
      result: {
        taskId: 'task-seam',
        intent: IntentType.CHAT_REPLY,
        runtime: 'codex',
        goal: 'improve runtime selection',
        imageAttachment: undefined,
      },
      ackMessageId: 'ack-seam',
    });

    expect(job.runtimeHint).toBe('codex');
    expect(job.constraints).toMatchObject({
      tenantKey: 'tenant_seam',
      chatId: 'oc_seam_chat',
      userMessageId: 'om_seam_1',
      sourceCommand: '/schedule',
      replyLanguage: 'zh-CN',
    });
  });
});

// Source-level guard for the seam WIRING (mirrors the convention in
// channel-observation-tap.test.ts). The behavioral tests above prove the
// recovery contract + dispatch equivalence; this pins that server.ts actually
// routes the addressed path through the neutral seam (and adapts at the
// boundary), so a regression that bypasses the seam or drops the boundary adapt
// is caught.
describe('inbound dispatch seam — server.ts routing guard', () => {
  const serverSrc = readFileSync(fileURLToPath(new URL('../server.ts', import.meta.url)), 'utf8');

  it('routes the addressed path through the neutral seam exactly once', () => {
    const calls = serverSrc.match(/return dispatchInboundMessageViaFeishuNative\(/g) ?? [];
    expect(calls).toHaveLength(1);
  });

  it('adapts NormalizedEvent -> InboundMessage at the boundary, after the null check, before the seam', () => {
    const nullCheckIdx = serverSrc.indexOf('const event = normalizeEvent(adapted as any, config);');
    const adaptIdx = serverSrc.indexOf('const inbound = adaptNormalizedEvent(event);');
    const seamCallIdx = serverSrc.indexOf(
      'return dispatchInboundMessageViaFeishuNative(inbound',
    );
    expect(nullCheckIdx).toBeGreaterThan(-1);
    expect(adaptIdx).toBeGreaterThan(nullCheckIdx);
    expect(seamCallIdx).toBeGreaterThan(adaptIdx);
  });

  it('recovers the native event inside the seam via the documented Feishu bridge', () => {
    expect(serverSrc).toContain('function recoverFeishuNormalizedEvent(');
    expect(serverSrc).toContain('return message.channel.native as NormalizedEvent;');
  });
});
