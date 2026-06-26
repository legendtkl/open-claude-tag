import type { Logger } from 'pino';
import type { FeishuClient, NormalizedDocumentCommentEvent } from '@open-tag/feishu-adapter';

export const DOCUMENT_COMMENT_ACK_REACTION_TYPE = 'OK';

export type DocumentCommentAckReactionResult = 'added' | 'skipped_missing_reply' | 'failed';

export async function addDocumentCommentAckReaction(input: {
  client: Pick<FeishuClient, 'updateDocumentCommentReplyReaction'>;
  event: Pick<NormalizedDocumentCommentEvent, 'fileToken' | 'fileType' | 'eventId'> & {
    replyId?: string;
  };
  logger: Pick<Logger, 'info' | 'warn'>;
  reactionType?: string;
}): Promise<DocumentCommentAckReactionResult> {
  if (!input.event.replyId) {
    return 'skipped_missing_reply';
  }

  try {
    await input.client.updateDocumentCommentReplyReaction({
      fileToken: input.event.fileToken,
      fileType: input.event.fileType,
      replyId: input.event.replyId,
      reactionType: input.reactionType ?? DOCUMENT_COMMENT_ACK_REACTION_TYPE,
      action: 'add',
    });
    input.logger.info(
      {
        eventId: input.event.eventId,
        replyId: input.event.replyId,
        reactionType: input.reactionType ?? DOCUMENT_COMMENT_ACK_REACTION_TYPE,
      },
      'Document comment ack reaction added',
    );
    return 'added';
  } catch (err) {
    input.logger.warn(
      { err, eventId: input.event.eventId, replyId: input.event.replyId },
      'Failed to add document comment ack reaction',
    );
    return 'failed';
  }
}
