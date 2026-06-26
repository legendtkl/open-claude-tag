import type {
  FeishuClient,
  FeishuDocumentComment,
  FeishuDocumentCommentContentElement,
  FeishuDocumentCommentReply,
} from '@open-tag/feishu-adapter';

const MAX_DOCUMENT_COMMENT_THREAD_REPLIES = 12;
const MAX_DOCUMENT_COMMENT_THREAD_REPLY_TEXT_LENGTH = 1_000;

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringRecordValue(
  record: Record<string, unknown> | undefined,
  keys: string[],
): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function booleanRecordValue(
  record: Record<string, unknown> | undefined,
  keys: string[],
): boolean | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (['true', '1', 'yes'].includes(normalized)) return true;
      if (['false', '0', 'no'].includes(normalized)) return false;
    }
  }
  return undefined;
}

export function documentCommentEventRecord(raw: unknown): Record<string, unknown> | null {
  if (!isObjectRecord(raw)) return null;
  const event = isObjectRecord(raw.event) ? raw.event : raw;
  const eventType =
    stringRecordValue(isObjectRecord(raw.header) ? raw.header : undefined, ['event_type']) ??
    stringRecordValue(event, ['event_type', 'type']);
  return eventType === 'drive.notice.comment_add_v1' ? event : null;
}

function documentCommentNoticeMeta(
  event: Record<string, unknown>,
): Record<string, unknown> | undefined {
  return isObjectRecord(event.notice_meta)
    ? event.notice_meta
    : isObjectRecord(event.noticeMeta)
      ? event.noticeMeta
      : undefined;
}

function documentCommentFileMetadata(event: Record<string, unknown>): {
  fileToken?: string;
  fileType: string;
  documentUrl?: string;
  isWhole?: boolean;
  quote?: string;
} {
  const meta = documentCommentNoticeMeta(event);
  const fileToken =
    stringRecordValue(event, ['file_token', 'fileToken']) ??
    stringRecordValue(meta, ['file_token', 'fileToken', 'obj_token', 'objToken', 'token']);
  const fileType =
    stringRecordValue(event, ['file_type', 'fileType']) ??
    stringRecordValue(meta, ['file_type', 'fileType', 'obj_type', 'objType']) ??
    'docx';
  const documentUrl =
    stringRecordValue(event, [
      'document_url',
      'documentUrl',
      'file_url',
      'fileUrl',
      'docs_url',
      'docsUrl',
      'doc_url',
      'docUrl',
      'url',
    ]) ??
    stringRecordValue(meta, [
      'document_url',
      'documentUrl',
      'file_url',
      'fileUrl',
      'docs_url',
      'docsUrl',
      'doc_url',
      'docUrl',
      'url',
    ]) ??
    (fileToken ? `https://example.com/docx/${fileToken}` : undefined);
  return {
    fileToken,
    fileType,
    documentUrl,
    isWhole:
      booleanRecordValue(event, ['is_whole', 'isWhole']) ??
      booleanRecordValue(meta, ['is_whole', 'isWhole']),
    quote:
      stringRecordValue(event, ['quote', 'quote_text', 'quoteText', 'selected_text', 'selectedText']) ??
      stringRecordValue(meta, ['quote', 'quote_text', 'quoteText', 'selected_text', 'selectedText']),
  };
}

function documentCommentReplyText(elements: FeishuDocumentCommentContentElement[]): string {
  return elements
    .map((element) => element.textRun?.text ?? '')
    .join('')
    .trim();
}

function truncateDocumentCommentThreadText(text: string): string {
  return text.length > MAX_DOCUMENT_COMMENT_THREAD_REPLY_TEXT_LENGTH
    ? `${text.slice(0, MAX_DOCUMENT_COMMENT_THREAD_REPLY_TEXT_LENGTH)}...`
    : text;
}

function documentCommentReplyMentions(elements: FeishuDocumentCommentContentElement[]): Array<{
  id: { open_id?: string };
  name: string;
}> {
  return elements.flatMap((element) => {
    const openId = element.person?.userId?.trim();
    return openId ? [{ id: { open_id: openId }, name: '' }] : [];
  });
}

function selectDocumentCommentReply(
  comment: FeishuDocumentComment,
  replyId?: string,
): NonNullable<NonNullable<FeishuDocumentComment['replyList']>['replies']>[number] | null {
  const replies = comment.replyList?.replies ?? [];
  if (replyId) {
    const matched = replies.find((reply) => reply.replyId === replyId);
    if (matched) return matched;
  }
  return replies[0] ?? null;
}

function orderedDocumentCommentReplies(
  comment: FeishuDocumentComment,
): FeishuDocumentCommentReply[] {
  return (comment.replyList?.replies ?? [])
    .map((reply, index) => ({ reply, index }))
    .sort((a, b) => {
      const aTime = a.reply.createTime;
      const bTime = b.reply.createTime;
      if (typeof aTime === 'number' && typeof bTime === 'number' && aTime !== bTime) {
        return aTime - bTime;
      }
      return a.index - b.index;
    })
    .map(({ reply }) => reply);
}

function documentCommentThreadReplies(
  comment: FeishuDocumentComment,
  currentReplyId?: string,
): Array<{ reply_id: string; user_id?: string; create_time?: number; text: string }> {
  const replies = orderedDocumentCommentReplies(comment);
  const currentIndex = currentReplyId
    ? replies.findIndex((reply) => reply.replyId === currentReplyId)
    : 0;
  const priorReplies = currentIndex >= 0 ? replies.slice(0, currentIndex) : replies;

  return priorReplies
    .map((reply) => ({
      reply,
      text: truncateDocumentCommentThreadText(
        documentCommentReplyText(reply.content?.elements ?? []),
      ),
    }))
    .filter(({ text }) => text)
    .slice(-MAX_DOCUMENT_COMMENT_THREAD_REPLIES)
    .map(({ reply, text }) => ({
      reply_id: reply.replyId,
      ...(reply.userId ? { user_id: reply.userId } : {}),
      ...(typeof reply.createTime === 'number' ? { create_time: reply.createTime } : {}),
      text,
    }));
}

function replaceDocumentCommentEvent(
  raw: unknown,
  event: Record<string, unknown>,
  enrichedEvent: Record<string, unknown>,
): unknown {
  if (isObjectRecord(raw) && raw.event === event) {
    return { ...raw, event: enrichedEvent };
  }
  return enrichedEvent;
}

export async function enrichDocumentCommentEventIfNeeded(
  raw: unknown,
  client: FeishuClient,
): Promise<unknown> {
  const event = documentCommentEventRecord(raw);
  if (!event) return raw;

  const metadata = documentCommentFileMetadata(event);
  const commentId = stringRecordValue(event, ['comment_id', 'commentId']);
  const hasInlineContent = Boolean(
    stringRecordValue(event, ['content', 'comment_content', 'reply_content', 'text']),
  );
  const hasInlineSender = Boolean(
    isObjectRecord(event.operator_id) ||
    isObjectRecord(event.operator) ||
    isObjectRecord(event.sender_id),
  );
  if (!commentId || !metadata.fileToken) return raw;

  const comment = await client.getDocumentComment({
    fileToken: metadata.fileToken,
    fileType: metadata.fileType,
    commentId,
    isWhole: metadata.isWhole,
  });
  if (!comment) return raw;

  const replyId = stringRecordValue(event, ['reply_id', 'replyId']);
  const reply = selectDocumentCommentReply(comment, replyId);
  const threadReplies = documentCommentThreadReplies(comment, reply?.replyId ?? replyId);
  if (hasInlineContent && hasInlineSender) {
    return replaceDocumentCommentEvent(raw, event, {
      ...event,
      file_token: metadata.fileToken,
      file_type: metadata.fileType,
      document_url: metadata.documentUrl,
      comment_id: commentId,
      ...(threadReplies.length > 0 ? { thread_replies: threadReplies } : {}),
    });
  }

  if (!reply) return raw;

  const elements = reply.content?.elements ?? [];
  return replaceDocumentCommentEvent(raw, event, {
    ...event,
    file_token: metadata.fileToken,
    file_type: metadata.fileType,
    document_url: metadata.documentUrl,
    comment_id: commentId,
    reply_id: reply.replyId,
    operator_id: { open_id: reply.userId ?? comment.userId },
    content: documentCommentReplyText(elements),
    mention_list: documentCommentReplyMentions(elements),
    ...(threadReplies.length > 0 ? { thread_replies: threadReplies } : {}),
    is_mentioned: event.is_mentioned ?? event.isMentioned,
    is_whole: comment.isWhole ?? metadata.isWhole,
    quote: comment.quote ?? metadata.quote,
  });
}

export function shouldRetryDocumentCommentAfterEnrichmentFailure(input: {
  raw: unknown;
  normalizedDocumentComment: unknown;
  enrichmentError: unknown;
}): boolean {
  return Boolean(
    input.enrichmentError &&
    documentCommentEventRecord(input.raw) &&
    !input.normalizedDocumentComment,
  );
}
