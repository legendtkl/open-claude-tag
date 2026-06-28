import type { NormalizedEvent, ReplyLanguage } from '@open-tag/core-types';
import { normalizeRuntimeHint } from '@open-tag/core-types';
import type { NormalizedDocumentCommentEvent } from '@open-tag/feishu-adapter';
import type { TaskJobData } from '@open-tag/queue';
import { shouldSkipTaskExecutionForDebugEvent } from './debug-task-control.js';

export interface SessionRuntimeState {
  sdkSessionId: string | null;
  runtimeBackend: string | null;
  sdkSessionMachineId?: string | null;
}

export interface BuildQueuedTaskInput {
  event: NormalizedEvent;
  sessionId: string;
  agentId?: string;
  feishuAppId?: string;
  result: {
    taskId: string;
    intent: string;
    runtime?: string;
    goal?: string;
    imageAttachment?: { imageKey: string; messageId: string };
    fileAttachment?: NonNullable<NormalizedEvent['content']['fileAttachment']>;
  };
  replyToMessageId?: string;
  ackMessageId?: string | null;
  userMessageReactionId?: string;
  replyLanguage?: ReplyLanguage;
  sessionRow?: SessionRuntimeState;
  extraConstraints?: Record<string, unknown>;
}

export interface BuildQueuedTaskOutput {
  isRuntimeSwitch: boolean;
  job: TaskJobData;
}

export interface BuildDocumentCommentTaskInput {
  event: NormalizedDocumentCommentEvent;
  sessionId: string;
  taskId: string;
  sourceMessageId: string;
  taskType: TaskJobData['taskType'];
  runtime: string;
  agentId?: string;
  feishuAppId?: string;
  sessionRow?: SessionRuntimeState;
}

type DocumentCommentThreadReply = NonNullable<
  NormalizedDocumentCommentEvent['threadReplies']
>[number];

function buildFeishuContext(event: NormalizedEvent, replyToMessageId?: string) {
  return {
    tenantKey: event.tenantKey,
    chatId: event.chatId,
    replyToMessageId,
    senderOpenId: event.senderOpenId,
    text: event.content.text,
    referencedMessages: event.content.referencedMessages,
    referencedMessageWarnings: event.content.referencedMessageWarnings,
    mentions: (event.content.mentions ?? []).map((mention) => ({
      openId: mention.id,
      name: mention.name,
      isBot: mention.isBot,
      key: mention.key,
      index: mention.index,
    })),
  };
}

function renderDocumentCommentThreadReply(
  reply: DocumentCommentThreadReply,
  index: number,
): string {
  const author = reply.userId ? ` by ${reply.userId}` : '';
  return `${index + 1}. ${reply.replyId}${author}: ${reply.text}`;
}

function renderDocumentCommentThreadHistory(event: NormalizedDocumentCommentEvent): string {
  const replies = event.threadReplies ?? [];
  if (replies.length === 0) return '';

  return [
    'Document comment thread history:',
    ...replies.map((reply, index) => renderDocumentCommentThreadReply(reply, index)),
  ].join('\n');
}

export function buildDocumentCommentTaskGoal(event: NormalizedDocumentCommentEvent): string {
  const userText = event.text.trim() || 'Please respond to this Feishu document comment.';
  const threadHistory = renderDocumentCommentThreadHistory(event);
  const selectedText = event.quote?.trim();
  const selectedTextContext = selectedText
    ? [
        `- Selected/commented text: ${selectedText}`,
        [
          '- Treat the selected/commented text as the target when the user says',
          '"this word", "this term", or similar.',
        ].join(' '),
        '- Answer using the selected text even if direct document reading is unavailable.',
      ]
    : [];
  return [
    threadHistory,
    threadHistory ? 'Current request:' : '',
    userText,
    [
      'Context:',
      '- Source: Feishu document comment',
      `- Feishu document URL: ${event.documentUrl}`,
      ...selectedTextContext,
      [
        '- The source is a Feishu document comment.',
        'Use the actual request and available comment context to decide whether reading the original Feishu document is necessary before answering.',
        'If reading the document would improve accuracy, use Lark-related skills such as the lark-doc skill to read it from the URL.',
        'Prefer lark-cli docs +fetch --api-version v2 --doc <URL> when the installed CLI supports it.',
        'If that CLI rejects the v2 flags, fall back to lark-cli docs +fetch --doc <URL> --format json.',
        'If document access still fails, state the exact bot/user permission issue and continue from the selected text.',
        'If the comment context is sufficient, answer directly without reading the document.',
      ].join(' '),
    ].join('\n'),
  ]
    .filter(Boolean)
    .join('\n\n');
}

function buildDocumentCommentContext(event: NormalizedDocumentCommentEvent) {
  return {
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
    mentions: event.mentions.map((mention) => ({
      openId: mention.id,
      name: mention.name,
      isBot: mention.isBot,
      key: mention.key,
      index: mention.index,
    })),
  };
}

export function buildDocumentCommentTaskInput(
  input: BuildDocumentCommentTaskInput,
): BuildQueuedTaskOutput {
  const { event, sessionId, sessionRow } = input;
  const goal = buildDocumentCommentTaskGoal(event);
  const isRuntimeSwitch = Boolean(
    input.runtime &&
      input.runtime !== 'auto' &&
      sessionRow?.runtimeBackend &&
      input.runtime !== sessionRow.runtimeBackend,
  );

  return {
    isRuntimeSwitch,
    job: {
      taskId: input.taskId,
      sessionId,
      agentId: input.agentId,
      feishuAppId: input.feishuAppId,
      taskType: input.taskType,
      goal,
      runtimeHint: normalizeRuntimeHint(input.runtime),
      constraints: {
        timeoutSec: 1800,
        approvalRequired: input.taskType === 'self_improvement',
        tenantKey: event.tenantKey,
        agentId: input.agentId,
        feishuAppId: input.feishuAppId,
        userMessageId: input.sourceMessageId,
        requesterOpenId: event.senderOpenId,
        replyLanguage: event.replyLanguage,
        feedbackChannel: 'document_comment',
        documentComment: buildDocumentCommentContext(event),
        feishuContext: buildDocumentCommentContext(event),
      },
      sdkSessionId: isRuntimeSwitch ? undefined : (sessionRow?.sdkSessionId ?? undefined),
      sdkSessionMachineId: isRuntimeSwitch
        ? undefined
        : (sessionRow?.sdkSessionMachineId ?? undefined),
      runtimeBackend: isRuntimeSwitch ? undefined : (sessionRow?.runtimeBackend ?? undefined),
    },
  };
}

export function buildQueuedTaskInput(input: BuildQueuedTaskInput): BuildQueuedTaskOutput {
  const {
    event,
    sessionId,
    result,
    replyToMessageId,
    ackMessageId,
    userMessageReactionId,
    replyLanguage,
    sessionRow,
  } = input;

  // Only treat it as a runtime switch when the caller explicitly chose a
  // different runtime (the "run with codex" card retry action). When
  // result.runtime is 'auto' (no explicit choice), preserve the session's
  // persisted runtimeBackend.
  const isRuntimeSwitch = Boolean(
    result.runtime &&
    result.runtime !== 'auto' &&
    sessionRow?.runtimeBackend &&
    result.runtime !== sessionRow.runtimeBackend,
  );

  return {
    isRuntimeSwitch,
    job: {
      taskId: result.taskId,
      sessionId,
      agentId: input.agentId,
      feishuAppId: input.feishuAppId,
      taskType: result.intent,
      goal: result.goal ?? event.content.text ?? '',
      runtimeHint: normalizeRuntimeHint(result.runtime),
      constraints: {
        tenantKey: event.tenantKey,
        chatId: event.chatId,
        agentId: input.agentId,
        feishuAppId: input.feishuAppId,
        ackMessageId: ackMessageId ?? undefined,
        replyToMessageId,
        userMessageId: event.messageId,
        userMessageReactionId,
        sourceCommand: event.content.command ?? undefined,
        replyLanguage: replyLanguage ?? event.replyLanguage,
        imageAttachment: result.imageAttachment,
        fileAttachment: result.fileAttachment,
        feishuContext: buildFeishuContext(event, replyToMessageId),
        debugSkipExecution: shouldSkipTaskExecutionForDebugEvent(event) || undefined,
        ...(input.extraConstraints ?? {}),
      },
      sdkSessionId: isRuntimeSwitch ? undefined : (sessionRow?.sdkSessionId ?? undefined),
      sdkSessionMachineId: isRuntimeSwitch
        ? undefined
        : (sessionRow?.sdkSessionMachineId ?? undefined),
      runtimeBackend: isRuntimeSwitch ? undefined : (sessionRow?.runtimeBackend ?? undefined),
    },
  };
}
