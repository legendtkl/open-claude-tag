import type { FeishuClient } from '@open-tag/feishu-adapter';
import { describe, expect, it, vi } from 'vitest';
import {
  buildDocumentCommentFailureReply,
  deliverDocumentCommentTaskReply,
  extractDocumentCommentDeliveryTarget,
} from '../document-comment-delivery.js';

describe('document comment delivery', () => {
  it('builds a visible failure reply for document comment tasks', () => {
    expect(buildDocumentCommentFailureReply('Machine "ubuntu" is offline')).toBe(
      'Task failed before the bot could produce a reply.\n\nMachine "ubuntu" is offline',
    );
  });

  it('builds a generic failure reply when the error text is blank', () => {
    expect(buildDocumentCommentFailureReply('   ')).toBe(
      'Task failed before the bot could produce a reply.',
    );
  });

  it('extracts the Drive comment target from task constraints', () => {
    expect(
      extractDocumentCommentDeliveryTarget({
        documentComment: {
          fileToken: 'doccnabc123',
          fileType: 'docx',
          commentId: 'comment_001',
        },
      }),
    ).toEqual({
      fileToken: 'doccnabc123',
      fileType: 'docx',
      commentId: 'comment_001',
    });
  });

  it('returns not_document_comment for ordinary chat tasks', async () => {
    const client = {
      createDocumentCommentReply: vi.fn(),
      createDocumentComment: vi.fn(),
    } as unknown as FeishuClient;

    const result = await deliverDocumentCommentTaskReply({
      client,
      constraints: { chatId: 'oc_chat' },
      content: 'done',
    });

    expect(result).toEqual({ status: 'not_document_comment' });
    expect(client.createDocumentCommentReply).not.toHaveBeenCalled();
  });

  it('replies to the original document comment without throwing on success', async () => {
    const client = {
      createDocumentCommentReply: vi.fn().mockResolvedValue({ replyId: 'reply_002' }),
      createDocumentComment: vi.fn(),
    } as unknown as FeishuClient;

    const result = await deliverDocumentCommentTaskReply({
      client,
      constraints: {
        documentComment: {
          fileToken: 'doccnabc123',
          fileType: 'docx',
          commentId: 'comment_001',
        },
      },
      content: 'Trace AI analysis is available.',
    });

    expect(result).toEqual({
      status: 'delivered',
      target: {
        fileToken: 'doccnabc123',
        fileType: 'docx',
        commentId: 'comment_001',
      },
      replyId: 'reply_002',
    });
    expect(client.createDocumentCommentReply).toHaveBeenCalledWith({
      fileToken: 'doccnabc123',
      fileType: 'docx',
      commentId: 'comment_001',
      content: 'Trace AI analysis is available.',
    });
    expect(client.createDocumentComment).not.toHaveBeenCalled();
  });

  it('renders mention placeholders as plain document comment text', async () => {
    const client = {
      createDocumentCommentReply: vi.fn().mockResolvedValue({ replyId: 'reply_002' }),
      createDocumentComment: vi.fn(),
    } as unknown as FeishuClient;

    await deliverDocumentCommentTaskReply({
      client,
      constraints: {
        documentComment: {
          fileToken: 'doccnabc123',
          fileType: 'docx',
          commentId: 'comment_001',
        },
      },
      content: '{{mention:ou_requester:Tao Kelu}} done {{mention:invalid}}',
    });

    expect(client.createDocumentCommentReply).toHaveBeenCalledWith({
      fileToken: 'doccnabc123',
      fileType: 'docx',
      commentId: 'comment_001',
      content: '@Tao Kelu done',
    });
  });

  it('creates a new full comment when the original comment cannot be replied to', async () => {
    const error = new Error('createDocumentCommentReply failed: code 1069302');
    const client = {
      createDocumentCommentReply: vi.fn().mockRejectedValue(error),
      createDocumentComment: vi.fn().mockResolvedValue({
        commentId: 'comment_fallback',
        replyId: 'reply_fallback',
      }),
    } as unknown as FeishuClient;

    const result = await deliverDocumentCommentTaskReply({
      client,
      constraints: {
        documentComment: {
          fileToken: 'doccnabc123',
          fileType: 'docx',
          commentId: 'comment_001',
          senderOpenId: 'ou_requester',
        },
      },
      content: 'Trace AI analysis is available.',
    });

    expect(result).toEqual({
      status: 'delivered_fallback',
      target: {
        fileToken: 'doccnabc123',
        fileType: 'docx',
        commentId: 'comment_001',
      },
      fallbackCommentId: 'comment_fallback',
      fallbackReplyId: 'reply_fallback',
      error,
    });
    expect(client.createDocumentComment).toHaveBeenCalledWith({
      fileToken: 'doccnabc123',
      fileType: 'docx',
      elements: [
        { type: 'mention_user', mentionUser: 'ou_requester' },
        { type: 'text', text: ' Trace AI analysis is available.' },
      ],
    });
  });

  it('renders mention placeholders before full-comment fallback delivery', async () => {
    const error = new Error('createDocumentCommentReply failed: code 1069302');
    const client = {
      createDocumentCommentReply: vi.fn().mockRejectedValue(error),
      createDocumentComment: vi.fn().mockResolvedValue({
        commentId: 'comment_fallback',
        replyId: 'reply_fallback',
      }),
    } as unknown as FeishuClient;

    await deliverDocumentCommentTaskReply({
      client,
      constraints: {
        documentComment: {
          fileToken: 'doccnabc123',
          fileType: 'docx',
          commentId: 'comment_001',
          senderOpenId: 'ou_requester',
        },
      },
      content: '{{mention:ou_requester:Tao Kelu}} done {{mention:invalid}}',
    });

    expect(client.createDocumentComment).toHaveBeenCalledWith({
      fileToken: 'doccnabc123',
      fileType: 'docx',
      elements: [
        { type: 'mention_user', mentionUser: 'ou_requester' },
        { type: 'text', text: ' @Tao Kelu done' },
      ],
    });
  });

  it('falls back to plain text when the requester open id is unavailable', async () => {
    const error = new Error('The comment section does not allow replies');
    const client = {
      createDocumentCommentReply: vi.fn().mockRejectedValue(error),
      createDocumentComment: vi.fn().mockResolvedValue({
        commentId: 'comment_fallback',
        replyId: 'reply_fallback',
      }),
    } as unknown as FeishuClient;

    const result = await deliverDocumentCommentTaskReply({
      client,
      constraints: {
        documentComment: {
          fileToken: 'doccnabc123',
          fileType: 'docx',
          commentId: 'comment_001',
        },
      },
      content: 'Trace AI analysis is available.',
    });

    expect(result).toEqual({
      status: 'delivered_fallback',
      target: {
        fileToken: 'doccnabc123',
        fileType: 'docx',
        commentId: 'comment_001',
      },
      fallbackCommentId: 'comment_fallback',
      fallbackReplyId: 'reply_fallback',
      error,
    });
    expect(client.createDocumentComment).toHaveBeenCalledWith({
      fileToken: 'doccnabc123',
      fileType: 'docx',
      content: 'Trace AI analysis is available.',
    });
  });

  it('reports failed delivery without throwing', async () => {
    const error = new Error('missing scope');
    const client = {
      createDocumentCommentReply: vi.fn().mockRejectedValue(error),
      createDocumentComment: vi.fn(),
    } as unknown as FeishuClient;

    const result = await deliverDocumentCommentTaskReply({
      client,
      constraints: {
        documentComment: {
          fileToken: 'doccnabc123',
          fileType: 'docx',
          commentId: 'comment_001',
        },
      },
      content: 'done',
    });

    expect(result).toEqual({
      status: 'failed',
      target: {
        fileToken: 'doccnabc123',
        fileType: 'docx',
        commentId: 'comment_001',
      },
      error,
    });
  });
});
