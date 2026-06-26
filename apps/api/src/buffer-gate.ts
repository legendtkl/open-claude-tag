import { eq, desc, and, gt } from 'drizzle-orm';
import { messages, tasks } from '@open-tag/storage';
import type { Database } from '@open-tag/storage';
import type { NormalizedEvent } from '@open-tag/core-types';
import { createLogger } from '@open-tag/observability';

const logger = createLogger('buffer-gate');

const BUFFER_MAX_MESSAGES = 25;

export interface AggregatedResult {
  text: string;
  messageCount: number;
}

/**
 * Gather all user messages in a session since the last task was created,
 * capped at BUFFER_MAX_MESSAGES. Returns null when there are no non-empty
 * messages to aggregate.
 *
 * IMPORTANT: The caller must ensure that the current message has already been
 * INSERT-ed into the messages table before calling this function, because the
 * query reads from the same table. In the current single-connection sequential
 * flow inside processEvent this is guaranteed, but wrapping the INSERT in a
 * separate transaction would break the read-your-own-writes assumption.
 */
export async function gatherPendingMessages(
  db: Database,
  sessionId: string,
): Promise<AggregatedResult | null> {
  const [lastTask] = await db
    .select({ createdAt: tasks.createdAt })
    .from(tasks)
    .where(eq(tasks.sessionId, sessionId))
    .orderBy(desc(tasks.createdAt))
    .limit(1);

  const since = lastTask?.createdAt ?? null;
  const whereClause = since
    ? and(eq(messages.sessionId, sessionId), eq(messages.role, 'user'), gt(messages.createdAt, since))
    : and(eq(messages.sessionId, sessionId), eq(messages.role, 'user'));

  const rows = await db
    .select({ content: messages.content })
    .from(messages)
    .where(whereClause)
    .orderBy(messages.createdAt)
    .limit(BUFFER_MAX_MESSAGES);

  const nonEmpty = rows.filter((r) => r.content.trim());
  if (nonEmpty.length === 0) return null;
  if (nonEmpty.length === 1) return { text: nonEmpty[0].content, messageCount: 1 };
  return {
    text: nonEmpty.map((r, i) => `[${i + 1}] ${r.content}`).join('\n'),
    messageCount: nonEmpty.length,
  };
}

/**
 * Determine whether the current event should be buffered (true = skip task
 * creation) or should trigger task creation with aggregated context.
 *
 * Returns the (possibly rewritten) event to pass downstream, or null when
 * the message should be silently buffered.
 */
export async function applyBufferGate(
  db: Database,
  event: NormalizedEvent,
  sessionId: string,
): Promise<NormalizedEvent | null> {
  // Slash commands always bypass buffering
  if (event.content.type === 'command') return event;

  const hasBotMention = event.content.mentions?.some((m) => m.isBot) ?? false;

  if (!hasBotMention) {
    logger.info({ eventId: event.eventId, sessionId }, 'BUFFER_UNTIL_AT: message buffered');
    return null;
  }

  // @bot mentioned: aggregate buffered messages (includes current, already stored)
  const result = await gatherPendingMessages(db, sessionId);
  if (result) {
    logger.info(
      { eventId: event.eventId, sessionId, messageCount: result.messageCount },
      'BUFFER_UNTIL_AT: aggregated buffered messages for task',
    );
    return { ...event, content: { ...event.content, text: result.text } };
  }

  return event;
}
