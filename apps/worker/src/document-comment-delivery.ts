import type { FeishuClient } from '@open-tag/feishu-adapter';

export interface DocumentCommentDeliveryTarget {
  fileToken: string;
  fileType: string;
  commentId: string;
}

export interface DocumentCommentDeliveryResult {
  status: 'delivered' | 'delivered_fallback' | 'not_document_comment' | 'missing_client' | 'failed';
  target?: DocumentCommentDeliveryTarget;
  replyId?: string;
  fallbackCommentId?: string;
  fallbackReplyId?: string;
  error?: unknown;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

const MAX_DOCUMENT_COMMENT_MENTION_COUNT = 20;
const MAX_DOCUMENT_COMMENT_MENTION_DISPLAY_NAME_LENGTH = 128;
const DOCUMENT_COMMENT_MENTION_OPEN_ID_PATTERN = /^[A-Za-z0-9_.@-]{1,128}$/;
const DOCUMENT_COMMENT_MENTION_PLACEHOLDER_PATTERN = /\{\{mention:([^}]*)\}\}/g;

function renderDocumentCommentMentionPlaceholders(value: string): string {
  let renderedCount = 0;
  const rendered = value.replace(
    DOCUMENT_COMMENT_MENTION_PLACEHOLDER_PATTERN,
    (_placeholder, rawPlaceholderBody: string) => {
      const separatorIndex = rawPlaceholderBody.indexOf(':');
      if (separatorIndex <= 0) return '';

      const openId = rawPlaceholderBody.slice(0, separatorIndex).trim();
      const displayName = rawPlaceholderBody.slice(separatorIndex + 1).trim();
      if (
        !DOCUMENT_COMMENT_MENTION_OPEN_ID_PATTERN.test(openId) ||
        !displayName ||
        displayName.length > MAX_DOCUMENT_COMMENT_MENTION_DISPLAY_NAME_LENGTH
      ) {
        return '';
      }
      if (renderedCount >= MAX_DOCUMENT_COMMENT_MENTION_COUNT) return '';
      renderedCount += 1;
      return `@${displayName}`;
    },
  );
  return rendered.replace(/[ \t]{2,}/g, ' ').trim();
}

function documentCommentReplyText(content: string): string {
  return renderDocumentCommentMentionPlaceholders(content.trim()) || 'Done.';
}

export function buildDocumentCommentFailureReply(errorMessage: string): string {
  const message = errorMessage.trim();
  if (!message) return 'Task failed before the bot could produce a reply.';
  return `Task failed before the bot could produce a reply.\n\n${message}`;
}

export function extractDocumentCommentDeliveryTarget(
  constraints: Record<string, unknown>,
): DocumentCommentDeliveryTarget | null {
  const documentComment = recordValue(constraints.documentComment);
  if (!documentComment) return null;

  const fileToken = stringValue(documentComment.fileToken);
  const fileType = stringValue(documentComment.fileType);
  const commentId = stringValue(documentComment.commentId);
  if (!fileToken || !fileType || !commentId) return null;

  return { fileToken, fileType, commentId };
}

function extractDocumentCommentRequesterOpenId(
  constraints: Record<string, unknown>,
): string | undefined {
  const documentComment = recordValue(constraints.documentComment);
  return stringValue(constraints.requesterOpenId) ?? stringValue(documentComment?.senderOpenId);
}

function isDocumentCommentReplyDisabledError(error: unknown): boolean {
  if (!error) return false;
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('1069302') || message.includes('does not allow replies');
}

export async function deliverDocumentCommentTaskReply(input: {
  client: FeishuClient | null;
  constraints: Record<string, unknown>;
  content: string;
}): Promise<DocumentCommentDeliveryResult> {
  const target = extractDocumentCommentDeliveryTarget(input.constraints);
  if (!target) return { status: 'not_document_comment' };
  if (!input.client) return { status: 'missing_client' };

  try {
    const content = documentCommentReplyText(input.content);
    const reply = await input.client.createDocumentCommentReply({
      ...target,
      content,
    });
    return { status: 'delivered', target, replyId: reply.replyId };
  } catch (error) {
    if (isDocumentCommentReplyDisabledError(error)) {
      try {
        const replyText = documentCommentReplyText(input.content);
        const requesterOpenId = extractDocumentCommentRequesterOpenId(input.constraints);
        const fallback = await input.client.createDocumentComment({
          fileToken: target.fileToken,
          fileType: target.fileType,
          ...(requesterOpenId
            ? {
                elements: [
                  { type: 'mention_user', mentionUser: requesterOpenId },
                  { type: 'text', text: ` ${replyText}` },
                ],
              }
            : { content: replyText }),
        });
        return {
          status: 'delivered_fallback',
          target,
          fallbackCommentId: fallback.commentId,
          fallbackReplyId: fallback.replyId,
          error,
        };
      } catch (fallbackError) {
        return { status: 'failed', target, error: fallbackError };
      }
    }
    return { status: 'failed', target, error };
  }
}
