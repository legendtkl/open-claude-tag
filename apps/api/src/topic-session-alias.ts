import type { NormalizedEvent } from '@open-tag/core-types';

export const QUOTED_IMAGE_TOPIC_ALIAS_RETRY_DELAYS_MS = [0, 5_000, 15_000, 30_000];

export interface TopicAliasLookupClient {
  getMessage(messageId: string): Promise<{ threadId?: string | null } | null>;
}

export interface TopicAliasLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

export type AliasThreadKeysFn = (
  sessionId: string,
  threadIds: string | string[],
  tenant: string,
  chatId: string,
) => Promise<void>;

export async function aliasQuotedImageTopicStart(input: {
  event: NormalizedEvent;
  sessionId: string;
  client: TopicAliasLookupClient;
  aliasThreadKeys: AliasThreadKeysFn;
  logger: TopicAliasLogger;
  retryDelaysMs?: number[];
}): Promise<void> {
  if (!input.event.content.referencedMessages?.some((message) => message.imageAttachment)) return;

  await input.aliasThreadKeys(
    input.sessionId,
    input.event.messageId,
    input.event.tenantKey,
    input.event.chatId,
  );
  void aliasGeneratedTopicWhenAvailable(input).catch((err) => {
    input.logger.warn(
      { err, eventId: input.event.eventId, messageId: input.event.messageId, sessionId: input.sessionId },
      'Failed to alias delayed Feishu topic id',
    );
  });
}

export async function aliasGeneratedTopicWhenAvailable(input: {
  event: NormalizedEvent;
  sessionId: string;
  client: TopicAliasLookupClient;
  aliasThreadKeys: AliasThreadKeysFn;
  logger: TopicAliasLogger;
  retryDelaysMs?: number[];
}): Promise<void> {
  for (const delayMs of input.retryDelaysMs ?? QUOTED_IMAGE_TOPIC_ALIAS_RETRY_DELAYS_MS) {
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    const currentMessage = await input.client.getMessage(input.event.messageId);
    const threadId = currentMessage?.threadId?.trim();
    if (
      !isGeneratedFeishuTopicId(threadId) ||
      threadId === input.event.threadId ||
      threadId === input.event.rootMessageId
    ) {
      continue;
    }

    await input.aliasThreadKeys(
      input.sessionId,
      threadId,
      input.event.tenantKey,
      input.event.chatId,
    );
    input.logger.info(
      { eventId: input.event.eventId, messageId: input.event.messageId, sessionId: input.sessionId, threadId },
      'Aliased delayed Feishu topic id to session',
    );
    return;
  }
}

export function isGeneratedFeishuTopicId(threadId: string | null | undefined): threadId is string {
  return typeof threadId === 'string' && threadId.trim().startsWith('omt_');
}
