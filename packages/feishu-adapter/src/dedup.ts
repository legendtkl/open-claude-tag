import type { Database } from '@open-tag/storage';
import { inboundEvents } from '@open-tag/storage';
import { and, eq, isNull, lt } from 'drizzle-orm';

export interface DedupResult {
  isDuplicate: boolean;
  eventId: string;
}

/**
 * A `received` claim younger than this is an in-flight delivery (the API-side
 * pipeline finishes in seconds; the worker owns the long-running part) — a
 * redelivery inside the window is a duplicate. An older claim means the
 * processor died mid-flight, and a redelivery may take it over.
 */
const STALE_CLAIM_TAKEOVER_MS = 5 * 60 * 1000;

function eventKeyWhere(eventId: string, feishuAppId?: string) {
  return feishuAppId
    ? and(eq(inboundEvents.feishuAppId, feishuAppId), eq(inboundEvents.eventId, eventId))
    : and(isNull(inboundEvents.feishuAppId), eq(inboundEvents.eventId, eventId));
}

/**
 * Atomic event claim. Insert-first: the `UNIQUE NULLS NOT DISTINCT`
 * constraint on `(feishu_app_id, event_id)` (migration 0029) is the arbiter,
 * so exactly one concurrent delivery wins — including the NULL-app scope,
 * where the old NULLS DISTINCT index never conflicted and the same event was
 * fully processed twice.
 */
export async function checkAndRecordEvent(
  db: Database,
  eventId: string,
  messageId?: string,
  feishuAppId?: string,
): Promise<DedupResult> {
  const inserted = await db
    .insert(inboundEvents)
    .values({
      feishuAppId,
      eventId,
      messageId,
      status: 'received',
    })
    .onConflictDoNothing({ target: [inboundEvents.feishuAppId, inboundEvents.eventId] })
    .returning({ id: inboundEvents.id });

  if (inserted.length > 0) {
    return { isDuplicate: false, eventId };
  }

  const eventKey = eventKeyWhere(eventId, feishuAppId);
  const existing = await db.select().from(inboundEvents).where(eventKey).limit(1);

  if (existing.length === 0) {
    // The conflicting row vanished between insert and select (external
    // cleanup); treat as duplicate — the next redelivery starts fresh.
    return { isDuplicate: true, eventId };
  }

  const row = existing[0];

  if (row.status === 'processed' || row.status === 'duplicate') {
    if (row.status !== 'duplicate') {
      await db.update(inboundEvents).set({ status: 'duplicate' }).where(eventKey);
    }
    return { isDuplicate: true, eventId };
  }

  // status === 'received': another delivery holds the claim.
  const claimAgeMs = Date.now() - row.createdAt.getTime();
  if (claimAgeMs < STALE_CLAIM_TAKEOVER_MS) {
    // In-flight: racing it would double-process the event.
    return { isDuplicate: true, eventId };
  }

  // Stale claim (processor crashed mid-flight). Take over by re-arming the
  // claim timestamp. The predicate is precision-safe (Postgres stores
  // microseconds, JS Dates carry milliseconds, so equality on created_at
  // would never match a naturally-inserted row): the winner moves created_at
  // past the staleness cutoff, so concurrent takeovers elect exactly one.
  const staleCutoff = new Date(Date.now() - STALE_CLAIM_TAKEOVER_MS);
  const claimed = await db
    .update(inboundEvents)
    .set({ createdAt: new Date() })
    .where(
      and(
        eq(inboundEvents.id, row.id),
        eq(inboundEvents.status, 'received'),
        lt(inboundEvents.createdAt, staleCutoff),
      ),
    )
    .returning({ id: inboundEvents.id });

  return { isDuplicate: claimed.length === 0, eventId };
}

export async function markEventProcessed(
  db: Database,
  eventId: string,
  feishuAppId?: string,
): Promise<void> {
  await db
    .update(inboundEvents)
    .set({ status: 'processed', processedAt: new Date() })
    .where(eventKeyWhere(eventId, feishuAppId));
}
