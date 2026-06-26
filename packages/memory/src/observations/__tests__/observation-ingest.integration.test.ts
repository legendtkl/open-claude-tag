import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, channelObservations } from '@open-tag/storage';
import type { Database } from '@open-tag/storage';
import { ingestObservation, type ObservationInbound } from '../ingest.js';

// Real-Postgres proof of channel-scoped accumulation + dedup + isolation +
// sensitive-gate. Gated STRICTLY on the package integration flag so a developer
// shell that merely exports DATABASE_URL never hits a real DB on a unit run.
const describePg = process.env.OPEN_TAG_MEMORY_PG_INTEGRATION === '1' ? describe : describe.skip;

const CHANNEL_KIND = 'lark';

function obs(
  scopeId: string,
  text: string,
  opts: { isBot?: boolean; eventType?: string; messageId?: string } = {},
): ObservationInbound {
  return {
    messageId: opts.messageId ?? `msg_${randomUUID()}`,
    eventType: opts.eventType ?? 'created',
    occurredAt: 1782864000000,
    scope: { kind: CHANNEL_KIND, scopeId },
    sender: { isBot: opts.isBot ?? false },
    content: { type: 'text', text },
  };
}

describePg('channel observation ingestion integration', () => {
  let db: Database;
  const createdScopeIds: string[] = [];

  function scope(): string {
    const id = `obs-scope-${randomUUID()}`;
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

  beforeAll(() => {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL is required for memory Postgres integration tests');
    }
    db = createDb(process.env.DATABASE_URL);
  });

  afterAll(async () => {
    if (createdScopeIds.length) {
      await db
        .delete(channelObservations)
        .where(inArray(channelObservations.scopeId, createdScopeIds));
    }
    await db.$client.end({ timeout: 5 });
  });

  it('accumulates two distinct messages in the same scope and queries them by scopeId', async () => {
    const scopeId = scope();

    const a = await ingestObservation(db, obs(scopeId, 'the staging deploy goes out on Fridays'));
    const b = await ingestObservation(db, obs(scopeId, 'the on-call rotation handoff is at 10am'));
    expect(a.written).toBe(true);
    expect(b.written).toBe(true);

    const rows = await rowsInScope(scopeId);
    expect(rows).toHaveLength(2);
    const gists = rows.map((r) => r.gist).sort();
    expect(gists).toEqual(
      ['the on-call rotation handoff is at 10am', 'the staging deploy goes out on Fridays'].sort(),
    );
  });

  it('dedups identical content within a scope (no-op on conflict)', async () => {
    const scopeId = scope();
    const text = 'the prod database lives in region us-east-1';

    const first = await ingestObservation(db, obs(scopeId, text));
    // Same content, different source message id — still a no-op.
    const second = await ingestObservation(db, obs(scopeId, text));
    // Whitespace differences normalize to the same dedupe key.
    const third = await ingestObservation(
      db,
      obs(scopeId, `  the prod  database lives   in region us-east-1 `),
    );

    expect(first).toEqual({ written: true });
    expect(second).toEqual({ written: false, reason: 'duplicate' });
    expect(third).toEqual({ written: false, reason: 'duplicate' });

    const rows = await rowsInScope(scopeId);
    expect(rows).toHaveLength(1);
  });

  it('isolates the same content across different scopes', async () => {
    const scopeA = scope();
    const scopeB = scope();
    const text = 'the wiki is the source of truth';

    const a = await ingestObservation(db, obs(scopeA, text));
    const b = await ingestObservation(db, obs(scopeB, text));
    expect(a.written).toBe(true);
    expect(b.written).toBe(true);

    const rowsA = await rowsInScope(scopeA);
    const rowsB = await rowsInScope(scopeB);
    expect(rowsA).toHaveLength(1);
    expect(rowsB).toHaveLength(1);
    expect(rowsA[0].scopeId).toBe(scopeA);
    expect(rowsB[0].scopeId).toBe(scopeB);
  });

  it('skips a sensitive message (nothing persisted)', async () => {
    const scopeId = scope();

    const result = await ingestObservation(
      db,
      obs(scopeId, 'rotate this: sk-abcdefghijklmnopqrstuvwxyz0123456789'),
    );
    expect(result).toEqual({ written: false, reason: 'sensitive' });

    const rows = await rowsInScope(scopeId);
    expect(rows).toHaveLength(0);
  });
});
