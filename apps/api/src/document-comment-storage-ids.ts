import { stableUuidFromKey } from '@open-tag/core-types';
import type { NormalizedDocumentCommentEvent } from '@open-tag/feishu-adapter';

export interface DocumentCommentStorageIds {
  chatId: string;
  sessionKey: string;
  sourceMessageId: string;
  taskId: string;
}

export function buildDocumentCommentStorageIds(input: {
  event: NormalizedDocumentCommentEvent;
  feishuAppId?: string;
  agentId?: string;
}): DocumentCommentStorageIds {
  const { event } = input;
  const tenantKey = event.tenantKey || 'default';
  const appKey = input.feishuAppId?.trim() || event.appId?.trim() || 'default-app';
  const ownerKey = input.agentId?.trim() || appKey;
  const threadKey = [tenantKey, appKey, event.fileToken, event.commentId].join(':');
  const eventKey = [threadKey, event.replyId ?? '', event.eventId].join(':');
  return {
    chatId: `doc:${stableUuidFromKey(`document-comment-chat:${threadKey}`)}`,
    sessionKey: `feishu:${tenantKey}:document-comment:${stableUuidFromKey(
      `${threadKey}:owner:${ownerKey}`,
    )}`,
    sourceMessageId: `doc:${stableUuidFromKey(`document-comment-message:${eventKey}`)}`,
    taskId: stableUuidFromKey(`document-comment-task:${eventKey}`),
  };
}
