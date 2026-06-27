import { createHash, randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createDb, channelObservations } from '@open-tag/storage';
import type { Database } from '@open-tag/storage';
import { ingestObservation, type ObservationInbound } from '../ingest.js';
import { pruneChannelObservations, OBSERVATION_READ_CAP_FLOOR } from '../retention.js';

// Real-Postgres proof of bounded retention: over-cap scopes are pruned down to the
// newest keep-floor, a scope under the cap is untouched, the dedupe UNIQUE survives,
// and a disabled policy is a no-op. Gated STRICTLY on the package integration flag.
const describePg = process.env.OPEN_TAG_MEMORY_PG_INTEGRATION === '1' ? describe : describe.skip;

const CHANNEL_KIND = 'lark';
const BASE = 1_782_864_000_000;
const FLOOR = OBSERVATION_READ_CAP_FLOOR; // 200

function obs(scopeId: string, text: string, occurredAt: number): ObservationInbound {
  return {
    messageId: `msg_${randomUUID()}`,
    eventType: 'created',
    occurredAt,
    scope: { kind: CHANNEL_KIND, scopeId },
    sender: { isBot: false },
    content: { type: 'text', text },
  };
}

describePg('channel observation retention prune (integration)', () => {
  let db: Database;
  const createdScopeIds: string[] = [];

  function scope(label: string): string {
    const id = `prune-${label}-${randomUUID()}`;
    createdScopeIds.push(id);
    return id;
  }

  function rowsInScope(scopeId: string) {
    return db
      .select()
      .from(channelObservations)
      .where(
        and(
          eq(channelObservations.channelKind, CHANNEL_KIND),
          eq(channelObservations.scopeId, scopeId),
        ),
      );
  }

  /** Bulk-insert `count` synthetic rows for a scope, index 0 = oldest. */
  async function seed(scopeId: string, count: number): Promise<void> {
    const values = Array.from({ length: count }, (_, i) => ({
      channelKind: CHANNEL_KIND,
      scopeId,
      sourceMessageId: `seed-${i}`,
      gist: `seed message ${i} for ${scopeId}`,
      occurredAt: new Date(BASE + i * 1000),
      dedupeHash: createHash('sha256').update(`${scopeId}:${i}`).digest('hex'),
    }));
    await db.insert(channelObservations).values(values);
  }

  beforeAll(() => {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL is required for memory Postgres integration tests');
    }
    db = createDb(process.env.DATABASE_URL);
  });

  // The prune is intentionally GLOBAL (every over-cap scope each tick), so a
  // scope another test left over the cap would inflate this test's `result.deleted`.
  // Clean all test scopes between tests so each one sees only its own data.
  afterEach(async () => {
    if (createdScopeIds.length) {
      await db
        .delete(channelObservations)
        .where(inArray(channelObservations.scopeId, createdScopeIds));
    }
  });

  afterAll(async () => {
    if (createdScopeIds.length) {
      await db
        .delete(channelObservations)
        .where(inArray(channelObservations.scopeId, createdScopeIds));
    }
    await db.$client.end({ timeout: 5 });
  });

  it('prunes an over-cap scope to the newest keep-floor and leaves another scope untouched', async () => {
    const scopeA = scope('over');
    const scopeB = scope('under');

    // scopeA: a known OLDEST and NEWEST marker via real ingest (so the dedupe hash
    // matches a later re-ingest), plus synthetic filler in between → FLOOR+5 total.
    const pruned = await ingestObservation(db, obs(scopeA, 'OLDEST marker fact', BASE));
    const kept = await ingestObservation(
      db,
      obs(scopeA, 'NEWEST marker fact', BASE + (FLOOR + 4) * 1000),
    );
    expect(pruned.written).toBe(true);
    expect(kept.written).toBe(true);
    // Fill indices 1..FLOOR+3 (FLOOR+3 synthetic rows) so the scope holds FLOOR+5.
    const fillerValues = Array.from({ length: FLOOR + 3 }, (_, k) => {
      const i = k + 1;
      return {
        channelKind: CHANNEL_KIND,
        scopeId: scopeA,
        sourceMessageId: `seed-${i}`,
        gist: `filler ${i}`,
        occurredAt: new Date(BASE + i * 1000),
        dedupeHash: createHash('sha256').update(`${scopeA}:${i}`).digest('hex'),
      };
    });
    await db.insert(channelObservations).values(fillerValues);
    expect(await rowsInScope(scopeA)).toHaveLength(FLOOR + 5);

    // scopeB stays under the cap (must be untouched).
    await seed(scopeB, 3);

    const result = await pruneChannelObservations(db, {
      maxPerScope: FLOOR,
      ttlMs: null,
      now: new Date(),
    });
    expect(result.deleted).toBe(5);
    expect(result.scopesScanned).toBe(1); // only scopeA exceeds the floor

    const remainA = await rowsInScope(scopeA);
    expect(remainA).toHaveLength(FLOOR);
    // The newest marker survived; the oldest marker was pruned.
    const gists = remainA.map((r) => r.gist);
    expect(gists).toContain('NEWEST marker fact');
    expect(gists).not.toContain('OLDEST marker fact');
    // Exactly the oldest 5 (occurredAt < BASE + 5000) were removed.
    const minOccurred = Math.min(...remainA.map((r) => r.occurredAt.getTime()));
    expect(minOccurred).toBe(BASE + 5 * 1000);

    // Per-scope isolation: the under-cap scope is fully intact.
    expect(await rowsInScope(scopeB)).toHaveLength(3);

    // Dedupe UNIQUE intact: re-ingesting a KEPT message is still a duplicate no-op,
    // while a PRUNED message's text inserts fresh (its row is gone).
    const reKept = await ingestObservation(
      db,
      obs(scopeA, 'NEWEST marker fact', BASE + (FLOOR + 9) * 1000),
    );
    expect(reKept).toEqual({ written: false, reason: 'duplicate' });
    const rePruned = await ingestObservation(
      db,
      obs(scopeA, 'OLDEST marker fact', BASE + (FLOOR + 10) * 1000),
    );
    expect(rePruned.written).toBe(true);
  });

  it('is a default-safe no-op when the policy is disabled (no deletes)', async () => {
    const scopeId = scope('disabled');
    await seed(scopeId, FLOOR + 25);

    const result = await pruneChannelObservations(db, {
      maxPerScope: null,
      ttlMs: null,
      now: new Date(),
    });
    expect(result).toEqual({ scopesScanned: 0, deleted: 0 });
    expect(await rowsInScope(scopeId)).toHaveLength(FLOOR + 25);
  });

  it('respects the per-scope delete batch cap, converging over repeated runs', async () => {
    const scopeId = scope('batch');
    await seed(scopeId, FLOOR + 30); // 30 surplus

    const first = await pruneChannelObservations(db, {
      maxPerScope: FLOOR,
      ttlMs: null,
      now: new Date(),
      maxDeletesPerScope: 10,
    });
    expect(first.deleted).toBe(10);
    expect(await rowsInScope(scopeId)).toHaveLength(FLOOR + 20);

    // A second run deletes the next batch (idempotent, oldest-first).
    const second = await pruneChannelObservations(db, {
      maxPerScope: FLOOR,
      ttlMs: null,
      now: new Date(),
      maxDeletesPerScope: 100,
    });
    expect(second.deleted).toBe(20);
    const remain = await rowsInScope(scopeId);
    expect(remain).toHaveLength(FLOOR);
    // Newest FLOOR kept: oldest remaining is index 30.
    const minOccurred = Math.min(...remain.map((r) => r.occurredAt.getTime()));
    expect(minOccurred).toBe(BASE + 30 * 1000);
  });
});
