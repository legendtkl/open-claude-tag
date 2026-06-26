import { randomUUID } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, channelObservations } from '@open-tag/storage';
import type { Database } from '@open-tag/storage';
import { ingestObservation, type ObservationInbound } from '../ingest.js';
import { getChannelObservations, hydrateChannelMemory } from '../read.js';

// Real-Postgres proof of the Stage-3 multiplayer invariant: the channel-scoped
// read is keyed by (channelKind, scopeId) ONLY — never by thread/session/sender —
// so a member sees another member's channel activity, while a different scope is
// hard-isolated. Gated STRICTLY on the package integration flag.
const describePg = process.env.OPEN_TAG_MEMORY_PG_INTEGRATION === '1' ? describe : describe.skip;

const CHANNEL_KIND = 'lark';

/**
 * Build an observation. `occurredAt` orders the read; `messageId` stands in for a
 * distinct source message — in production two members posting from two different
 * threads/senders into the same channel produce two such writes with the SAME
 * `scopeId`. The write path stores neither thread nor sender, so the only thing
 * that ties (or isolates) observations is `scopeId` + `channelKind`.
 */
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

const T1 = 1782864000000;
const T2 = 1782864100000;
const T3 = 1782864200000;

describePg('channel-scoped observation read — multiplayer invariant', () => {
  let db: Database;
  const createdScopeIds: string[] = [];

  function scope(): string {
    const id = `read-scope-${randomUUID()}`;
    createdScopeIds.push(id);
    return id;
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

  it('returns observations from two different members in the same scope (multiplayer)', async () => {
    const scopeId = scope();
    // Two writes with the same scopeId but distinct source messages — modelling
    // two members posting from two different threads/senders into one channel.
    const memberA = await ingestObservation(
      db,
      obs(scopeId, 'member A: the staging deploy goes out on Fridays', T1),
    );
    const memberB = await ingestObservation(
      db,
      obs(scopeId, 'member B: the on-call handoff is at 10am', T2),
    );
    expect(memberA.written).toBe(true);
    expect(memberB.written).toBe(true);

    const rows = await getChannelObservations(db, { channelKind: CHANNEL_KIND, scopeId });
    expect(rows).toHaveLength(2);
    // Newest-first by occurredAt: member B (T2) before member A (T1).
    expect(rows.map((r) => r.gist)).toEqual([
      'member B: the on-call handoff is at 10am',
      'member A: the staging deploy goes out on Fridays',
    ]);
    // Every returned row really is this channel scope — no foreign rows leaked in.
    expect(rows.every((r) => r.scopeId === scopeId && r.channelKind === CHANNEL_KIND)).toBe(true);
  });

  it('hard-isolates a different scope — its rows are never returned', async () => {
    const scopeId = scope();
    const otherScopeId = scope();
    await ingestObservation(db, obs(scopeId, 'in-scope fact about the wiki', T1));
    await ingestObservation(db, obs(otherScopeId, 'OTHER scope secret about prod', T1));

    const rows = await getChannelObservations(db, { channelKind: CHANNEL_KIND, scopeId });
    expect(rows).toHaveLength(1);
    expect(rows[0].gist).toBe('in-scope fact about the wiki');
    expect(rows.some((r) => r.gist.includes('OTHER scope secret'))).toBe(false);

    // The other scope sees only its own row — symmetric isolation.
    const otherRows = await getChannelObservations(db, {
      channelKind: CHANNEL_KIND,
      scopeId: otherScopeId,
    });
    expect(otherRows).toHaveLength(1);
    expect(otherRows[0].gist).toBe('OTHER scope secret about prod');
  });

  it('respects newest-first ordering and the limit cap', async () => {
    const scopeId = scope();
    await ingestObservation(db, obs(scopeId, 'oldest', T1));
    await ingestObservation(db, obs(scopeId, 'middle', T2));
    await ingestObservation(db, obs(scopeId, 'newest', T3));

    const top2 = await getChannelObservations(db, { channelKind: CHANNEL_KIND, scopeId, limit: 2 });
    expect(top2.map((r) => r.gist)).toEqual(['newest', 'middle']);
  });

  it('filters by `since` (strictly newer occurredAt)', async () => {
    const scopeId = scope();
    await ingestObservation(db, obs(scopeId, 'before the cutoff', T1));
    await ingestObservation(db, obs(scopeId, 'after the cutoff', T2));

    const rows = await getChannelObservations(db, {
      channelKind: CHANNEL_KIND,
      scopeId,
      since: T1,
    });
    expect(rows.map((r) => r.gist)).toEqual(['after the cutoff']);
  });

  it('hydrates a populated scope into a block with both members, and empty for unknown', async () => {
    const scopeId = scope();
    await ingestObservation(db, obs(scopeId, 'member A: design review is on Tuesdays', T1));
    await ingestObservation(db, obs(scopeId, 'member B: the repo lives on the internal host', T2));

    const block = await hydrateChannelMemory(db, { kind: CHANNEL_KIND, scopeId });
    expect(block).not.toBe('');
    expect(block).toContain('## Channel Memory');
    expect(block).toContain('member A: design review is on Tuesdays');
    expect(block).toContain('member B: the repo lives on the internal host');

    const empty = await hydrateChannelMemory(db, {
      kind: CHANNEL_KIND,
      scopeId: `read-scope-unknown-${randomUUID()}`,
    });
    expect(empty.trim()).toBe('');
  });
});
