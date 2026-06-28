import { describe, expect, it } from 'vitest';
import { IntentType } from '@open-tag/core-types';
import {
  buildDocumentCommentTaskGoal,
  buildDocumentCommentTaskInput,
  buildQueuedTaskInput,
} from '../task-dispatch.js';

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    tenantKey: 'tenant_test',
    chatId: 'oc_test_chat',
    messageId: 'msg_123',
    content: {
      text: '--runtime codex 原始命令文本',
    },
    ...overrides,
  } as any;
}

function makeDocumentCommentEvent(overrides: Record<string, unknown> = {}) {
  return {
    eventId: 'evt_doc_comment_001',
    tenantKey: 'tenant_test',
    appId: 'cli_test',
    noticeType: 'add_comment',
    fileToken: 'doccnabc123',
    fileType: 'docx',
    documentUrl: 'https://example.feishu.cn/docx/doccnabc123',
    commentId: 'comment_001',
    replyId: 'reply_001',
    quote: 'Meta Harness',
    isWhole: false,
    senderOpenId: 'ou_sender',
    senderUnionId: 'on_sender',
    senderType: 'user',
    text: '调研一下社区 Trace 目前有没有类似的 AI 分析能力',
    mentions: [
      {
        id: 'ou_bot',
        name: 'ClaudeCode',
        isBot: true,
        key: '@ClaudeCode',
        index: 0,
      },
    ],
    replyLanguage: 'zh-CN',
    timestamp: 1710000000000,
    raw: {},
    ...overrides,
  } as any;
}

describe('buildQueuedTaskInput', () => {
  it('uses the normalized orchestrator goal instead of raw command text', () => {
    const { job } = buildQueuedTaskInput({
      event: makeEvent(),
      sessionId: 'session-1',
      result: {
        taskId: 'task-1',
        intent: IntentType.SELF_DEV,
        runtime: 'codex',
        goal: '实现 codex self-dev runtime',
        imageAttachment: undefined,
      },
      ackMessageId: 'ack-1',
      userMessageReactionId: 'reaction-1',
      sessionRow: {
        sdkSessionId: 'sdk-1',
        sdkSessionMachineId: 'machine-1',
        runtimeBackend: 'codex',
      },
    });

    expect(job.goal).toBe('实现 codex self-dev runtime');
    expect(job.runtimeHint).toBe('codex');
    expect(job.sdkSessionId).toBe('sdk-1');
    expect(job.sdkSessionMachineId).toBe('machine-1');
    expect(job.runtimeBackend).toBe('codex');
    expect(job.constraints).toMatchObject({
      tenantKey: 'tenant_test',
      chatId: 'oc_test_chat',
      ackMessageId: 'ack-1',
      userMessageId: 'msg_123',
      userMessageReactionId: 'reaction-1',
    });
  });

  it('drops SDK resume metadata when runtime switches', () => {
    const { isRuntimeSwitch, job } = buildQueuedTaskInput({
      event: makeEvent(),
      sessionId: 'session-1',
      result: {
        taskId: 'task-1',
        intent: IntentType.SELF_DEV,
        runtime: 'codex',
        goal: '继续 self-dev',
        imageAttachment: undefined,
      },
      sessionRow: {
        sdkSessionId: 'sdk-1',
        sdkSessionMachineId: 'machine-1',
        runtimeBackend: 'claude_code',
      },
    });

    expect(isRuntimeSwitch).toBe(true);
    expect(job.sdkSessionId).toBeUndefined();
    expect(job.sdkSessionMachineId).toBeUndefined();
    expect(job.runtimeBackend).toBeUndefined();
  });

  it('follow-up with auto runtime does NOT trigger switch — session runtime is preserved', () => {
    // Scenario: session started with codex; user sends a plain follow-up message.
    // Orchestrator returns runtime:'auto' (no explicit --runtime flag).
    // isRuntimeSwitch must be false so runtimeBackend:'codex' is passed to the job.
    const { isRuntimeSwitch, job } = buildQueuedTaskInput({
      event: makeEvent(),
      sessionId: 'session-1',
      result: {
        taskId: 'task-2',
        intent: IntentType.CHAT_REPLY,
        runtime: 'auto',
        goal: '继续前面的任务',
        imageAttachment: undefined,
      },
      sessionRow: { sdkSessionId: 'sdk-codex-thread', runtimeBackend: 'codex' },
    });

    expect(isRuntimeSwitch).toBe(false);
    expect(job.runtimeBackend).toBe('codex');
    expect(job.sdkSessionId).toBe('sdk-codex-thread');
    expect(job.runtimeHint).toBe('auto');
  });

  it('explicit switch from codex to claude_code triggers isRuntimeSwitch', () => {
    const { isRuntimeSwitch, job } = buildQueuedTaskInput({
      event: makeEvent(),
      sessionId: 'session-1',
      result: {
        taskId: 'task-3',
        intent: IntentType.SELF_DEV,
        runtime: 'claude_code',
        goal: '用 claude 重写',
        imageAttachment: undefined,
      },
      sessionRow: { sdkSessionId: 'sdk-codex-thread', runtimeBackend: 'codex' },
    });

    expect(isRuntimeSwitch).toBe(true);
    expect(job.runtimeBackend).toBeUndefined();
    expect(job.sdkSessionId).toBeUndefined();
  });

  it('normalizes null ackMessageId to undefined', () => {
    const { job } = buildQueuedTaskInput({
      event: makeEvent(),
      sessionId: 'session-1',
      result: {
        taskId: 'task-1',
        intent: IntentType.SELF_DEV,
        runtime: 'claude_code',
        goal: '继续 self-dev',
        imageAttachment: undefined,
      },
      ackMessageId: null,
    });

    expect(job.constraints).toHaveProperty('ackMessageId', undefined);
  });

  it('propagates file attachments into queued task constraints', () => {
    const fileAttachment = {
      resourceKey: 'file_v2_abc',
      messageId: 'msg_file_1',
      resourceType: 'file' as const,
      fileName: 'report.pdf',
      mimeType: 'application/pdf',
    };
    const { job } = buildQueuedTaskInput({
      event: makeEvent(),
      sessionId: 'session-1',
      result: {
        taskId: 'task-file-1',
        intent: IntentType.CHAT_REPLY,
        runtime: 'auto',
        goal: 'summarize the file',
        imageAttachment: undefined,
        fileAttachment,
      },
    });

    expect(job.constraints.fileAttachment).toEqual(fileAttachment);
  });

  it('propagates replyLanguage into queued task constraints', () => {
    const { job } = buildQueuedTaskInput({
      event: makeEvent({ replyLanguage: 'zh-CN' }),
      sessionId: 'session-1',
      result: {
        taskId: 'task-4',
        intent: IntentType.CHAT_REPLY,
        runtime: 'claude_code',
        goal: '继续处理这个任务',
        imageAttachment: undefined,
      },
    });

    expect(job.constraints).toMatchObject({
      chatId: 'oc_test_chat',
      userMessageId: 'msg_123',
      replyLanguage: 'zh-CN',
    });
  });

  it('propagates agent and Feishu app identity into the queued job', () => {
    const { job } = buildQueuedTaskInput({
      event: makeEvent(),
      sessionId: 'session-1',
      agentId: 'agent_123',
      feishuAppId: 'app_123',
      result: {
        taskId: 'task-8',
        intent: IntentType.CHAT_REPLY,
        runtime: 'claude_code',
        goal: 'handle this as the routed agent',
        imageAttachment: undefined,
      },
    });

    expect(job).toMatchObject({
      agentId: 'agent_123',
      feishuAppId: 'app_123',
      constraints: {
        agentId: 'agent_123',
        feishuAppId: 'app_123',
      },
    });
  });

  it('propagates the originating slash command into queued task constraints', () => {
    const { job } = buildQueuedTaskInput({
      event: makeEvent({
        content: {
          text: '30分钟后 improve runtime selection',
          command: '/schedule',
        },
      }),
      sessionId: 'session-1',
      result: {
        taskId: 'task-6',
        intent: IntentType.CHAT_REPLY,
        runtime: 'codex',
        goal: 'improve runtime selection',
        imageAttachment: undefined,
      },
    });

    expect(job.constraints).toMatchObject({
      sourceCommand: '/schedule',
    });
  });

  it('propagates debug execution skip into queued task constraints', () => {
    const { job } = buildQueuedTaskInput({
      event: makeEvent({
        content: {
          text: 'write a safe test task',
          raw: {
            event: {
              message: {
                __openClaudeTagDebug: {
                  skipTaskExecution: true,
                },
              },
            },
          },
        },
      }),
      sessionId: 'session-1',
      result: {
        taskId: 'task-5',
        intent: IntentType.SELF_DEV,
        runtime: 'claude_code',
        goal: 'write a safe test task',
        imageAttachment: undefined,
      },
    });

    expect(job.constraints).toMatchObject({
      debugSkipExecution: true,
    });
  });

  it('propagates debug loopback isolation into queued task constraints', () => {
    const { job } = buildQueuedTaskInput({
      event: makeEvent(),
      sessionId: 'session-1',
      result: {
        taskId: 'task-debug-loopback',
        intent: IntentType.CHAT_REPLY,
        runtime: 'codex',
        goal: 'reply locally',
        imageAttachment: undefined,
      },
      extraConstraints: {
        debugLoopback: true,
      },
    });

    expect(job.constraints).toMatchObject({
      debugLoopback: true,
      feishuAppId: undefined,
    });
  });

  it('propagates Feishu context into queued task constraints', () => {
    const { job } = buildQueuedTaskInput({
      event: makeEvent({
        senderOpenId: 'ou_sender',
        replyLanguage: 'zh-CN',
        content: {
          text: '创建 1.txt，完成后请 陈环 和 李四 看一下',
          mentions: [
            {
              id: 'ou_bot',
              name: 'OpenClaudeTag',
              isBot: true,
              key: '@_user_1',
              index: 0,
            },
            {
              id: 'ou_chen',
              name: '陈环',
              isBot: false,
              key: '@_user_2',
              index: 20,
            },
            {
              id: 'ou_li',
              name: '李四',
              isBot: false,
              key: '@_user_3',
              index: 28,
            },
          ],
        },
      }),
      sessionId: 'session-1',
      result: {
        taskId: 'task-7',
        intent: IntentType.CHAT_REPLY,
        runtime: 'claude_code',
        goal: '创建 1.txt，完成后请 陈环 和 李四 看一下',
        imageAttachment: undefined,
      },
      replyToMessageId: 'om_root_001',
      ackMessageId: 'ack-1',
    });

    expect(job.constraints).toMatchObject({
      feishuContext: {
        tenantKey: 'tenant_test',
        chatId: 'oc_test_chat',
        replyToMessageId: 'om_root_001',
        senderOpenId: 'ou_sender',
        text: '创建 1.txt，完成后请 陈环 和 李四 看一下',
        mentions: [
          {
            openId: 'ou_bot',
            name: 'OpenClaudeTag',
            isBot: true,
            key: '@_user_1',
            index: 0,
          },
          {
            openId: 'ou_chen',
            name: '陈环',
            isBot: false,
            key: '@_user_2',
            index: 20,
          },
          {
            openId: 'ou_li',
            name: '李四',
            isBot: false,
            key: '@_user_3',
            index: 28,
          },
        ],
      },
    });
  });

  it('propagates referenced Feishu context into queued task constraints', () => {
    const referencedMessages = [
      {
        messageId: 'om_record_1',
        contentType: 'rich_text' as const,
        entries: [
          { author: '周俊戈', text: '第一条' },
          { author: '乐露薇', text: '第二条' },
        ],
        warnings: ['Skipped 1 unsupported referenced chat record entries'],
      },
    ];

    const { job } = buildQueuedTaskInput({
      event: makeEvent({
        senderOpenId: 'ou_sender',
        content: {
          text: '学习一下引用记录',
          referencedMessages,
          referencedMessageWarnings: ['Referenced parser skipped unsupported entries'],
        },
      }),
      sessionId: 'session-1',
      result: {
        taskId: 'task-9',
        intent: IntentType.CHAT_REPLY,
        runtime: 'auto',
        goal: '学习一下引用记录',
        imageAttachment: undefined,
      },
    });

    expect(job.constraints).toMatchObject({
      feishuContext: {
        referencedMessages,
        referencedMessageWarnings: ['Referenced parser skipped unsupported entries'],
      },
    });
  });
});

describe('buildDocumentCommentTaskInput', () => {
  it('passes document comment context, selected text, and thread history to the agent', () => {
    const event = makeDocumentCommentEvent({
      threadReplies: [
        {
          replyId: 'reply_prev_user',
          userId: 'ou_sender',
          createTime: 1710000000001,
          text: '请先解释一下 Meta Harness 是什么',
        },
        {
          replyId: 'reply_prev_bot',
          userId: 'ou_bot',
          createTime: 1710000000002,
          text: 'Meta Harness 是业务语义和底层 harness 的抽象层。',
        },
      ],
    });
    const goal = buildDocumentCommentTaskGoal(event);

    expect(goal).toContain('调研一下社区 Trace');
    expect(goal).toContain('Document comment thread history');
    expect(goal).toContain('请先解释一下 Meta Harness 是什么');
    expect(goal).toContain('Meta Harness 是业务语义和底层 harness 的抽象层。');
    expect(goal).toContain('Feishu document URL: https://example.feishu.cn/docx/doccnabc123');
    expect(goal).toContain('Selected/commented text: Meta Harness');
    expect(goal).toContain('Treat the selected/commented text as the target');
    expect(goal).toContain('even if direct document reading is unavailable');
    expect(goal).toContain('The source is a Feishu document');
    expect(goal).toContain('decide whether reading the original Feishu document is necessary');
    expect(goal).toContain('Lark-related skills such as the lark-doc skill');
    expect(goal).toContain('lark-cli docs +fetch --api-version v2 --doc <URL>');
    expect(goal).toContain('lark-cli docs +fetch --doc <URL> --format json');
    expect(goal).toContain('state the exact bot/user permission issue');
    expect(goal).toContain('If the comment context is sufficient, answer directly');
  });

  it('builds a queued task without chat-card feedback constraints', () => {
    const event = makeDocumentCommentEvent({
      threadReplies: [
        {
          replyId: 'reply_prev',
          userId: 'ou_previous',
          createTime: 1710000000001,
          text: 'Previous context',
        },
      ],
    });
    const { job } = buildDocumentCommentTaskInput({
      event,
      sessionId: 'session-1',
      taskId: 'task-doc-comment-1',
      sourceMessageId: 'doc:message-1',
      taskType: IntentType.RESEARCH,
      runtime: 'auto',
      agentId: 'agent_123',
      feishuAppId: 'app_123',
      sessionRow: {
        sdkSessionId: 'sdk-1',
        sdkSessionMachineId: 'machine-1',
        runtimeBackend: 'codex',
      },
    });

    expect(job).toMatchObject({
      taskId: 'task-doc-comment-1',
      sessionId: 'session-1',
      agentId: 'agent_123',
      feishuAppId: 'app_123',
      taskType: IntentType.RESEARCH,
      runtimeHint: 'auto',
      sdkSessionId: 'sdk-1',
      sdkSessionMachineId: 'machine-1',
      runtimeBackend: 'codex',
      constraints: {
        tenantKey: 'tenant_test',
        agentId: 'agent_123',
        feishuAppId: 'app_123',
        userMessageId: 'doc:message-1',
        requesterOpenId: 'ou_sender',
        replyLanguage: 'zh-CN',
        feedbackChannel: 'document_comment',
        documentComment: {
          source: 'document_comment',
          documentUrl: 'https://example.feishu.cn/docx/doccnabc123',
          fileToken: 'doccnabc123',
          fileType: 'docx',
          commentId: 'comment_001',
          replyId: 'reply_001',
          quote: 'Meta Harness',
          isWhole: false,
          eventId: 'evt_doc_comment_001',
          senderOpenId: 'ou_sender',
          text: '调研一下社区 Trace 目前有没有类似的 AI 分析能力',
          threadReplies: [
            {
              replyId: 'reply_prev',
              userId: 'ou_previous',
              createTime: 1710000000001,
              text: 'Previous context',
            },
          ],
        },
      },
    });
    expect(job.constraints).not.toHaveProperty('chatId');
    expect(job.constraints).not.toHaveProperty('ackMessageId');
    expect(job.constraints).not.toHaveProperty('replyToMessageId');
  });
});
