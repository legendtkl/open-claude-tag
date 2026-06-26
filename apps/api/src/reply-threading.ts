import type { NormalizedEvent } from '@open-tag/core-types';
import type { Database } from '@open-tag/storage';
import { aliasThreadKeysForSession } from '@open-tag/session';

function hasThreadContext(event: Pick<NormalizedEvent, 'threadId' | 'rootMessageId' | 'parentMessageId'>): boolean {
  return Boolean(event.threadId || event.rootMessageId || event.parentMessageId);
}

function hasEstablishedThreadContext(
  event: Pick<NormalizedEvent, 'threadId' | 'rootMessageId'>,
): boolean {
  return Boolean(event.threadId || event.rootMessageId);
}

export function getReplyToMessageId(
  event: Pick<
    NormalizedEvent,
    'messageId' | 'chatType' | 'threadId' | 'rootMessageId' | 'parentMessageId'
  >,
): string | undefined {
  // Anchor every bot reply on the user's message so feishu-client routes through
  // /im/v1/messages/{id}/reply with reply_in_thread=true. For P2P this preserves
  // the existing thread; for group root @bot it auto-creates a topic so the
  // ACK / running / done / Task complete sequence collapses into one thread
  // instead of flooding the main group flow.
  if (hasThreadContext(event)) return event.messageId;
  if (event.chatType === 'p2p') return event.messageId;
  if (event.chatType === 'group') return event.messageId;
  return undefined;
}

// Returns true when this event will create a new topic via the reply endpoint —
// i.e. the user's message has no pre-existing thread context. After the bot's
// first reply lands, the resolved session must be aliased under the upcoming
// `thread:<userMessageId>` and `thread:<sentMessageId>` keys so that follow-up
// messages inside the new topic resolve back to the same session. Applies to
// P2P and group root alike — including group manual sessions (`/new`) and
// active sessions (chatActiveSessions pointer).
export function shouldUpgradeRootProvisionalSession(
  event: Pick<NormalizedEvent, 'chatType' | 'threadId' | 'rootMessageId' | 'parentMessageId'>,
): boolean {
  return !hasEstablishedThreadContext(event);
}

export function getRootAliasMessageIds(
  event: Pick<NormalizedEvent, 'messageId'>,
  sentMessageId?: string,
): string[] {
  return [...new Set([event.messageId, sentMessageId].filter((value): value is string => Boolean(value)))];
}

export async function upgradeRootProvisionalSession({
  db,
  event,
  logger,
  sessionId,
  sentMessageId,
  alias = aliasThreadKeysForSession,
}: {
  db: Database;
  event: Pick<
    NormalizedEvent,
    'chatType' | 'threadId' | 'rootMessageId' | 'parentMessageId' | 'messageId' | 'tenantKey' | 'chatId'
  >;
  logger: {
    warn: (obj: Record<string, unknown>, msg: string) => void;
  };
  sessionId: string;
  sentMessageId?: string;
  alias?: typeof aliasThreadKeysForSession;
}): Promise<void> {
  if (!shouldUpgradeRootProvisionalSession(event)) return;

  try {
    await alias(
      db,
      sessionId,
      getRootAliasMessageIds(event, sentMessageId),
      event.tenantKey,
      event.chatId,
    );
  } catch (err) {
    logger.warn(
      {
        err,
        chatId: event.chatId,
        sessionId,
        messageId: event.messageId,
        sentMessageId,
      },
      'Failed to upgrade root provisional session',
    );
  }
}
