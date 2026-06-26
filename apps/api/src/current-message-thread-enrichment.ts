import type { NormalizedEvent } from '@open-tag/core-types';
import { isObjectRecord } from '@open-tag/core-types';
import type { FeishuMessageDetail } from '@open-tag/feishu-adapter';

type ThreadAwareFeishuMessageDetail = FeishuMessageDetail & {
  threadId?: string;
  rootMessageId?: string;
};

const CURRENT_MESSAGE_THREAD_RETRY_DELAYS_MS = [0, 250, 750, 1500];

export interface CurrentMessageThreadLookupClient {
  getMessage(messageId: string): Promise<ThreadAwareFeishuMessageDetail | null>;
  getMessageAppLink?(messageId: string): Promise<string | null>;
}

export interface CurrentMessageThreadLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
  info?(obj: Record<string, unknown>, msg: string): void;
}

export async function enrichEventWithCurrentMessageThread(
  event: NormalizedEvent,
  client: CurrentMessageThreadLookupClient,
  logger?: CurrentMessageThreadLogger,
): Promise<NormalizedEvent> {
  if (!shouldInspectCurrentMessage(event)) return event;

  try {
    const resolved = await lookupCurrentMessageThread(client, event);
    const threadId = resolved?.threadId;
    logger?.info?.(
      {
        eventId: event.eventId,
        messageId: event.messageId,
        inputThreadId: event.threadId,
        inputRootMessageId: event.rootMessageId,
        inputParentMessageId: event.parentMessageId,
        referencedImageCount:
          event.content.referencedMessages?.filter((message) => message.imageAttachment).length ?? 0,
        resolvedThreadId: threadId,
        detailThreadId: resolved?.currentMessage?.threadId,
        detailRootMessageId: resolved?.currentMessage?.rootMessageId,
        detailParentMessageId: resolved?.currentMessage?.parentMessageId,
      },
      'Current Feishu message thread inspection complete',
    );
    if (!threadId || threadId === event.threadId) return event;
    const currentMessage = resolved?.currentMessage;

    return {
      ...event,
      threadId,
      ...(event.rootMessageId || !currentMessage?.rootMessageId
        ? {}
        : { rootMessageId: currentMessage.rootMessageId }),
      ...(event.parentMessageId || !currentMessage?.parentMessageId
        ? {}
        : { parentMessageId: currentMessage.parentMessageId }),
    };
  } catch (err) {
    logger?.warn(
      { err, eventId: event.eventId, messageId: event.messageId },
      'Failed to inspect current Feishu message for thread context',
    );
    return event;
  }
}

function shouldInspectCurrentMessage(event: NormalizedEvent): boolean {
  if (event.chatType !== 'group') return false;

  const rawMessage = getRawMessage(event);
  if (event.content.referencedMessages?.some((message) => message.imageAttachment)) {
    return true;
  }

  if (event.threadId) {
    return isEventThreadIdQuotedSource(event, rawMessage) || isMessageIdThreadId(event.threadId);
  }

  if (
    event.rootMessageId ||
    event.parentMessageId ||
    stringValue(rawMessage?.root_id) ||
    stringValue(rawMessage?.parent_id) ||
    getRawReferenceMessageId(rawMessage)
  ) {
    return true;
  }

  return looksLikeImageReferenceRequest(event);
}

function looksLikeImageReferenceRequest(event: NormalizedEvent): boolean {
  const text = [event.content.args, event.content.text]
    .filter((value): value is string => typeof value === 'string')
    .join('\n');
  return /(?:图片|图像|这张图|这个图|这个图片|截图|照片|image|picture|photo|screenshot)/i.test(
    text,
  );
}

function getRawReferenceMessageId(
  rawMessage: Record<string, unknown> | undefined,
): string | undefined {
  const rawReference = isObjectRecord(rawMessage?.reference) ? rawMessage.reference : undefined;
  return (
    stringValue(rawMessage?.reference_message_id) ??
    stringValue(rawMessage?.quote_message_id) ??
    stringValue(rawReference?.message_id)
  );
}

function getRawMessage(event: NormalizedEvent): Record<string, unknown> | undefined {
  const raw = event.content.raw;
  if (!isObjectRecord(raw)) return undefined;
  const rawEvent = raw.event;
  if (!isObjectRecord(rawEvent)) return undefined;
  return isObjectRecord(rawEvent.message) ? rawEvent.message : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

async function lookupCurrentMessageThread(
  client: CurrentMessageThreadLookupClient,
  event: NormalizedEvent,
): Promise<{ threadId: string; currentMessage: ThreadAwareFeishuMessageDetail | null } | undefined> {
  for (const delayMs of CURRENT_MESSAGE_THREAD_RETRY_DELAYS_MS) {
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    const currentMessage = await client.getMessage(event.messageId);
    const detailThreadId = currentMessage?.threadId?.trim();
    const needsAppLinkThread =
      !detailThreadId ||
      isQuotedSourceThreadId(event, currentMessage, detailThreadId) ||
      isMessageIdThreadId(detailThreadId);
    const appLinkThreadId =
      needsAppLinkThread && client.getMessageAppLink
        ? parseThreadIdFromMessageAppLink(await client.getMessageAppLink(event.messageId))
        : undefined;
    const threadId = appLinkThreadId ?? (needsAppLinkThread ? undefined : detailThreadId);
    if (threadId) return { threadId, currentMessage };
  }

  return undefined;
}

function isQuotedSourceThreadId(
  event: NormalizedEvent,
  currentMessage: ThreadAwareFeishuMessageDetail | null,
  threadId: string,
): boolean {
  return [
    event.rootMessageId,
    event.parentMessageId,
    currentMessage?.rootMessageId,
    currentMessage?.parentMessageId,
  ].some(
    (messageId) => messageId && messageId === threadId && messageId !== event.messageId,
  );
}

function isEventThreadIdQuotedSource(
  event: NormalizedEvent,
  rawMessage: Record<string, unknown> | undefined,
): boolean {
  const threadId = event.threadId?.trim();
  if (!threadId) return false;

  return [
    event.rootMessageId,
    event.parentMessageId,
    stringValue(rawMessage?.root_id),
    stringValue(rawMessage?.parent_id),
    getRawReferenceMessageId(rawMessage),
  ].some((messageId) => messageId && messageId === threadId && messageId !== event.messageId);
}

function isMessageIdThreadId(threadId: string): boolean {
  return threadId.startsWith('om_');
}

function isGeneratedTopicThreadId(threadId: string): boolean {
  return threadId.startsWith('omt_');
}

function parseThreadIdFromMessageAppLink(appLink: string | null | undefined): string | undefined {
  if (!appLink) return undefined;
  try {
    const url = new URL(appLink);
    for (const [key, value] of url.searchParams.entries()) {
      if (key.replace(/_/g, '').toLowerCase() === 'openthreadid') {
        const threadId = stringValue(value);
        return threadId && isGeneratedTopicThreadId(threadId) ? threadId : undefined;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}
