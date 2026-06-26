import { randomUUID } from 'crypto';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, feishuApps, inboundEvents } from '@open-tag/storage';
import type { Database } from '@open-tag/storage';
import { checkAndRecordEvent, markEventProcessed } from '../dedup.js';

// Real-Postgres dedup suite: the claims here are about atomicity and the
// NULLS NOT DISTINCT constraint — neither is observable with a mocked db.
// Gated STRICTLY on the package integration flag (set by the test:integration
// script): a developer shell that merely exports DATABASE_URL must not have
// plain unit runs hit a real database.
const describePg = process.env.OPEN_TAG_FEISHU_PG_INTEGRATION === '1' ? describe : describe.skip;

describePg('inbound event dedup integration', () => {
  let db: Database;
  const trackedEventIds: string[] = [];
  const trackedAppIds: string[] = [];

  function newEventId(): string {
    const id = `evt-${randomUUID()}`;
    trackedEventIds.push(id);
    return id;
  }

  beforeAll(() => {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL is required for feishu-adapter Postgres integration tests');
    }
    db = createDb(process.env.DATABASE_URL);
  });

  afterAll(async () => {
    if (trackedEventIds.length > 0) {
      await db.delete(inboundEvents).where(inArray(inboundEvents.eventId, trackedEventIds));
    }
    if (trackedAppIds.length > 0) {
      await db.delete(feishuApps).where(inArray(feishuApps.id, trackedAppIds));
    }
    await db.$client.end({ timeout: 5 });
  });

  it('claims a new event and reports an in-flight retry as duplicate', async () => {
    const eventId = newEventId();

    const first = await checkAndRecordEvent(db, eventId);
    expect(first.isDuplicate).toBe(false);

    // The first delivery is still processing (claim is fresh): a webhook
    // retry must NOT race it into a second full pipeline run.
    const retry = await checkAndRecordEvent(db, eventId);
    expect(retry.isDuplicate).toBe(true);
  });

  it('concurrent deliveries with a NULL app id elect exactly one winner and one row', async () => {
    const eventId = newEventId();

    const results = await Promise.all(
      Array.from({ length: 4 }, () => checkAndRecordEvent(db, eventId)),
    );

    expect(results.filter((r) => !r.isDuplicate)).toHaveLength(1);
    const rows = await db
      .select()
      .from(inboundEvents)
      .where(and(isNull(inboundEvents.feishuAppId), eq(inboundEvents.eventId, eventId)));
    expect(rows).toHaveLength(1);
  });

  it('processed events stay duplicates', async () => {
    const eventId = newEventId();
    await checkAndRecordEvent(db, eventId);
    await markEventProcessed(db, eventId);

    const retry = await checkAndRecordEvent(db, eventId);
    expect(retry.isDuplicate).toBe(true);
  });

  it('a stale received claim is taken over by exactly one redelivery', async () => {
    const eventId = newEventId();
    await checkAndRecordEvent(db, eventId);

    // Age the claim past the takeover window (simulates a crashed processor).
    // Aged via SQL interval arithmetic so created_at keeps Postgres microsecond
    // precision — a JS Date here would mask the production case where an
    // equality CAS could never match the stored value.
    await db
      .update(inboundEvents)
      .set({ createdAt: sql`now() - interval '10 minutes'` })
      .where(eq(inboundEvents.eventId, eventId));

    const takeovers = await Promise.all([
      checkAndRecordEvent(db, eventId),
      checkAndRecordEvent(db, eventId),
    ]);
    expect(takeovers.filter((r) => !r.isDuplicate)).toHaveLength(1);
  });

  it('the same event id under different apps stays independently processable', async () => {
    const appA = randomUUID();
    const appB = randomUUID();
    trackedAppIds.push(appA, appB);
    await db.insert(feishuApps).values([
      { id: appA, tenantKey: `t-${appA.slice(0, 8)}`, appId: `cli_${appA}`, appSecretRef: 'env:A' },
      { id: appB, tenantKey: `t-${appB.slice(0, 8)}`, appId: `cli_${appB}`, appSecretRef: 'env:B' },
    ]);
    const eventId = newEventId();

    const a = await checkAndRecordEvent(db, eventId, undefined, appA);
    const b = await checkAndRecordEvent(db, eventId, undefined, appB);

    expect(a.isDuplicate).toBe(false);
    expect(b.isDuplicate).toBe(false);
  });
});
