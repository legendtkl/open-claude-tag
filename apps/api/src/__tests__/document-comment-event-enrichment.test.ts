import { describe, expect, it, vi } from 'vitest';
import type { FeishuClient } from '@open-tag/feishu-adapter';
import {
  enrichDocumentCommentEventIfNeeded,
  shouldRetryDocumentCommentAfterEnrichmentFailure,
} from '../document-comment-event-enrichment.js';

describe('document comment event enrichment', () => {
  it('enriches compact document comment events from the Feishu comment API', async () => {
    const getDocumentComment = vi.fn(async () => ({
      commentId: 'comment_001',
      userId: 'ou_comment_author',
      isWhole: true,
      quote: 'Meta Harness',
      replyList: {
        replies: [
          {
            replyId: 'reply_001',
            userId: 'ou_sender',
            content: {
              elements: [
                { type: 'person', person: { userId: 'ou_bot' } },
                { type: 'text_run', textRun: { text: ' investigate Trace AI' } },
              ],
            },
          },
        ],
      },
    }));
    const client = { getDocumentComment } as unknown as FeishuClient;

    const enriched = await enrichDocumentCommentEventIfNeeded(
      {
        header: {
          event_id: 'evt_doc_comment_001',
          tenant_key: 'tenant_test',
          event_type: 'drive.notice.comment_add_v1',
        },
        event: {
          comment_id: 'comment_001',
          notice_meta: {
            file_token: 'doccnabc123',
            obj_type: 'docx',
          },
          is_mentioned: true,
        },
      },
      client,
    );

    expect(getDocumentComment).toHaveBeenCalledWith({
      fileToken: 'doccnabc123',
      fileType: 'docx',
      commentId: 'comment_001',
      isWhole: undefined,
    });
    expect(enriched).toMatchObject({
      header: {
        event_id: 'evt_doc_comment_001',
        tenant_key: 'tenant_test',
        event_type: 'drive.notice.comment_add_v1',
      },
      event: {
        file_token: 'doccnabc123',
        file_type: 'docx',
        document_url: 'https://example.com/docx/doccnabc123',
        comment_id: 'comment_001',
        reply_id: 'reply_001',
        operator_id: { open_id: 'ou_sender' },
        content: 'investigate Trace AI',
        mention_list: [{ id: { open_id: 'ou_bot' }, name: '' }],
        is_mentioned: true,
        is_whole: true,
        quote: 'Meta Harness',
      },
    });
  });

  it('adds bounded prior document comment thread replies during enrichment', async () => {
    const priorReplies = Array.from({ length: 14 }, (_, index) => {
      const n = index + 1;
      return {
        replyId: `reply_${String(n).padStart(3, '0')}`,
        userId: `ou_user_${n}`,
        createTime: 1710000000000 + n,
        content: {
          elements: [{ type: 'text_run', textRun: { text: `Prior reply ${n}` } }],
        },
      };
    });
    const getDocumentComment = vi.fn(async () => ({
      commentId: 'comment_001',
      userId: 'ou_comment_author',
      isWhole: true,
      replyList: {
        replies: [
          ...priorReplies,
          {
            replyId: 'reply_current',
            userId: 'ou_sender',
            createTime: 1710000001000,
            content: {
              elements: [
                { type: 'person', person: { userId: 'ou_bot' } },
                { type: 'text_run', textRun: { text: ' continue the task' } },
              ],
            },
          },
        ],
      },
    }));
    const client = { getDocumentComment } as unknown as FeishuClient;

    const enriched = await enrichDocumentCommentEventIfNeeded(
      {
        header: { event_type: 'drive.notice.comment_add_v1' },
        event: {
          comment_id: 'comment_001',
          reply_id: 'reply_current',
          notice_meta: {
            file_token: 'doccnabc123',
            obj_type: 'docx',
          },
          is_mentioned: true,
        },
      },
      client,
    );

    expect(enriched).toMatchObject({
      event: {
        reply_id: 'reply_current',
        content: 'continue the task',
        thread_replies: [
          { reply_id: 'reply_003', user_id: 'ou_user_3', text: 'Prior reply 3' },
          { reply_id: 'reply_004', user_id: 'ou_user_4', text: 'Prior reply 4' },
          { reply_id: 'reply_005', user_id: 'ou_user_5', text: 'Prior reply 5' },
          { reply_id: 'reply_006', user_id: 'ou_user_6', text: 'Prior reply 6' },
          { reply_id: 'reply_007', user_id: 'ou_user_7', text: 'Prior reply 7' },
          { reply_id: 'reply_008', user_id: 'ou_user_8', text: 'Prior reply 8' },
          { reply_id: 'reply_009', user_id: 'ou_user_9', text: 'Prior reply 9' },
          { reply_id: 'reply_010', user_id: 'ou_user_10', text: 'Prior reply 10' },
          { reply_id: 'reply_011', user_id: 'ou_user_11', text: 'Prior reply 11' },
          { reply_id: 'reply_012', user_id: 'ou_user_12', text: 'Prior reply 12' },
          { reply_id: 'reply_013', user_id: 'ou_user_13', text: 'Prior reply 13' },
          { reply_id: 'reply_014', user_id: 'ou_user_14', text: 'Prior reply 14' },
        ],
      },
    });
  });

  it('preserves inline sender and content while adding thread history', async () => {
    const getDocumentComment = vi.fn(async () => ({
      commentId: 'comment_001',
      userId: 'ou_comment_author',
      isWhole: true,
      replyList: {
        replies: [
          {
            replyId: 'reply_000',
            userId: 'ou_previous',
            createTime: 1710000000000,
            content: {
              elements: [{ type: 'text_run', textRun: { text: 'Previous inline context' } }],
            },
          },
          {
            replyId: 'reply_001',
            userId: 'ou_sender',
            createTime: 1710000000001,
            content: {
              elements: [{ type: 'text_run', textRun: { text: '@bot investigate Trace AI' } }],
            },
          },
        ],
      },
    }));
    const client = { getDocumentComment } as unknown as FeishuClient;
    const raw = {
      header: {
        event_id: 'evt_inline_001',
        tenant_key: 'tenant_test',
        event_type: 'drive.notice.comment_add_v1',
      },
      event: {
        file_token: 'doccnabc123',
        file_type: 'docx',
        comment_id: 'comment_001',
        reply_id: 'reply_001',
        operator_id: { open_id: 'ou_sender' },
        content: '@bot investigate Trace AI',
      },
    };

    await expect(enrichDocumentCommentEventIfNeeded(raw, client)).resolves.toMatchObject({
      header: {
        event_id: 'evt_inline_001',
        tenant_key: 'tenant_test',
        event_type: 'drive.notice.comment_add_v1',
      },
      event: {
        file_token: 'doccnabc123',
        file_type: 'docx',
        comment_id: 'comment_001',
        reply_id: 'reply_001',
        operator_id: { open_id: 'ou_sender' },
        content: '@bot investigate Trace AI',
        thread_replies: [
          { reply_id: 'reply_000', user_id: 'ou_previous', text: 'Previous inline context' },
        ],
      },
    });
    expect(getDocumentComment).toHaveBeenCalledWith({
      fileToken: 'doccnabc123',
      fileType: 'docx',
      commentId: 'comment_001',
      isWhole: undefined,
    });
  });

  it('marks compact document comment events retryable after enrichment failure', () => {
    expect(
      shouldRetryDocumentCommentAfterEnrichmentFailure({
        raw: {
          header: { event_type: 'drive.notice.comment_add_v1' },
          event: {
            comment_id: 'comment_001',
            notice_meta: { file_token: 'doccnabc123' },
          },
        },
        normalizedDocumentComment: null,
        enrichmentError: new Error('temporarily unavailable'),
      }),
    ).toBe(true);
  });

  it('does not retry non-document, normalized, or successful enrichment cases', () => {
    expect(
      shouldRetryDocumentCommentAfterEnrichmentFailure({
        raw: { header: { event_type: 'im.message.receive_v1' } },
        normalizedDocumentComment: null,
        enrichmentError: new Error('temporarily unavailable'),
      }),
    ).toBe(false);
    expect(
      shouldRetryDocumentCommentAfterEnrichmentFailure({
        raw: { header: { event_type: 'drive.notice.comment_add_v1' } },
        normalizedDocumentComment: { eventId: 'evt_1' },
        enrichmentError: new Error('temporarily unavailable'),
      }),
    ).toBe(false);
    expect(
      shouldRetryDocumentCommentAfterEnrichmentFailure({
        raw: { header: { event_type: 'drive.notice.comment_add_v1' } },
        normalizedDocumentComment: null,
        enrichmentError: undefined,
      }),
    ).toBe(false);
  });
});
