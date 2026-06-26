import { describe, expect, it } from 'vitest';
import type { NormalizedDocumentCommentEvent } from '@open-tag/feishu-adapter';
import { buildDocumentCommentStorageIds } from '../document-comment-storage-ids.js';

function makeEvent(
  overrides: Partial<NormalizedDocumentCommentEvent> = {},
): NormalizedDocumentCommentEvent {
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
    senderOpenId: 'ou_sender',
    senderType: 'user',
    text: 'Follow up on the previous answer',
    mentions: [],
    timestamp: 1710000000000,
    raw: {},
    ...overrides,
  };
}

describe('buildDocumentCommentStorageIds', () => {
  it('keeps same-bot follow-ups in the same document comment session', () => {
    const first = buildDocumentCommentStorageIds({
      event: makeEvent({ eventId: 'evt_1', replyId: 'reply_001' }),
      feishuAppId: 'feishu_app_1',
      agentId: 'agent_1',
    });
    const second = buildDocumentCommentStorageIds({
      event: makeEvent({ eventId: 'evt_2', replyId: 'reply_002' }),
      feishuAppId: 'feishu_app_1',
      agentId: 'agent_1',
    });

    expect(second.chatId).toBe(first.chatId);
    expect(second.sessionKey).toBe(first.sessionKey);
    expect(second.sourceMessageId).not.toBe(first.sourceMessageId);
    expect(second.taskId).not.toBe(first.taskId);
  });

  it('isolates different routed agents in the same document comment thread', () => {
    const first = buildDocumentCommentStorageIds({
      event: makeEvent({ eventId: 'evt_1', replyId: 'reply_001' }),
      feishuAppId: 'feishu_app_1',
      agentId: 'agent_1',
    });
    const second = buildDocumentCommentStorageIds({
      event: makeEvent({ eventId: 'evt_2', replyId: 'reply_002' }),
      feishuAppId: 'feishu_app_1',
      agentId: 'agent_2',
    });

    expect(second.chatId).toBe(first.chatId);
    expect(second.sessionKey).not.toBe(first.sessionKey);
  });

  it('isolates different receiving apps in the same document comment thread', () => {
    const first = buildDocumentCommentStorageIds({
      event: makeEvent({ eventId: 'evt_1', replyId: 'reply_001', appId: 'cli_app_1' }),
      feishuAppId: 'feishu_app_1',
    });
    const second = buildDocumentCommentStorageIds({
      event: makeEvent({ eventId: 'evt_2', replyId: 'reply_002', appId: 'cli_app_2' }),
      feishuAppId: 'feishu_app_2',
    });

    expect(second.chatId).not.toBe(first.chatId);
    expect(second.sessionKey).not.toBe(first.sessionKey);
  });
});
