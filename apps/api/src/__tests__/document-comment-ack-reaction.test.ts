import { describe, expect, it, vi } from 'vitest';
import { addDocumentCommentAckReaction } from '../document-comment-ack-reaction.js';

describe('addDocumentCommentAckReaction', () => {
  it('adds an OK reaction to the source document comment reply', async () => {
    const client = {
      updateDocumentCommentReplyReaction: vi.fn().mockResolvedValue(undefined),
    };
    const logger = { info: vi.fn(), warn: vi.fn() };

    await expect(
      addDocumentCommentAckReaction({
        client,
        logger,
        event: {
          eventId: 'evt_001',
          fileToken: 'doccnabc123',
          fileType: 'docx',
          replyId: 'reply_001',
        },
      }),
    ).resolves.toBe('added');

    expect(client.updateDocumentCommentReplyReaction).toHaveBeenCalledWith({
      fileToken: 'doccnabc123',
      fileType: 'docx',
      replyId: 'reply_001',
      reactionType: 'OK',
      action: 'add',
    });
    expect(logger.info).toHaveBeenCalledWith(
      { eventId: 'evt_001', replyId: 'reply_001', reactionType: 'OK' },
      'Document comment ack reaction added',
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('skips events without a reply id', async () => {
    const client = {
      updateDocumentCommentReplyReaction: vi.fn().mockResolvedValue(undefined),
    };

    await expect(
      addDocumentCommentAckReaction({
        client,
        logger: { info: vi.fn(), warn: vi.fn() },
        event: {
          eventId: 'evt_001',
          fileToken: 'doccnabc123',
          fileType: 'docx',
        },
      }),
    ).resolves.toBe('skipped_missing_reply');

    expect(client.updateDocumentCommentReplyReaction).not.toHaveBeenCalled();
  });

  it('logs and continues when Feishu rejects the reaction', async () => {
    const err = new Error('missing scope');
    const logger = { info: vi.fn(), warn: vi.fn() };

    await expect(
      addDocumentCommentAckReaction({
        client: {
          updateDocumentCommentReplyReaction: vi.fn().mockRejectedValue(err),
        },
        logger,
        event: {
          eventId: 'evt_001',
          fileToken: 'doccnabc123',
          fileType: 'docx',
          replyId: 'reply_001',
        },
      }),
    ).resolves.toBe('failed');

    expect(logger.warn).toHaveBeenCalledWith(
      { err, eventId: 'evt_001', replyId: 'reply_001' },
      'Failed to add document comment ack reaction',
    );
    expect(logger.info).not.toHaveBeenCalled();
  });
});
