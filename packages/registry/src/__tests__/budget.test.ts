import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentProfiles, agents, createDb, identityUsage, type Database } from '@open-tag/storage';
import { checkBudget, recordUsage, windowKeyFor } from '../budget.js';
import { resolveIdentity, type Identity, type IdentityAgentSource } from '../identity.js';

function makeAgent(overrides: Partial<IdentityAgentSource> = {}): IdentityAgentSource {
  return {
    id: 'agent-uuid-1',
    handle: 'open-claude-tag',
    profileId: 'profile-uuid-1',
    defaultRuntime: 'claude_code',
    scopeType: 'system',
    scopeId: 'default',
    status: 'active',
    ...overrides,
  };
}

describe('windowKeyFor', () => {
  it('derives a deterministic UTC day bucket', () => {
    expect(windowKeyFor('day', '2026-06-27T13:45:00.000Z')).toBe('2026-06-27');
    // Boundary: just before midnight UTC stays in the same day.
    expect(windowKeyFor('day', '2026-06-27T23:59:59.999Z')).toBe('2026-06-27');
    // Boundary: midnight UTC rolls to the next day.
    expect(windowKeyFor('day', '2026-06-28T00:00:00.000Z')).toBe('2026-06-28');
  });

  it('derives a deterministic UTC month bucket', () => {
    expect(windowKeyFor('month', '2026-06-27T13:45:00.000Z')).toBe('2026-06');
    expect(windowKeyFor('month', '2026-12-01T00:00:00.000Z')).toBe('2026-12');
  });

  it('is pure: same input always yields the same key', () => {
    const iso = '2026-01-09T08:00:00.000Z';
    expect(windowKeyFor('day', iso)).toBe(windowKeyFor('day', iso));
    expect(windowKeyFor('day', iso)).toBe('2026-01-09');
  });

  it('throws on an unparseable timestamp (fail fast)', () => {
    expect(() => windowKeyFor('day', 'not-a-date')).toThrow(/invalid ISO timestamp/);
  });
});

const describePg = process.env.OPEN_TAG_STORAGE_PG_INTEGRATION === '1' ? describe : describe.skip;

describePg('budget tracking integration', () => {
  let db: Database;
  const identityIds: string[] = [];
  const createdAgentIds: string[] = [];
  const createdProfileIds: string[] = [];

  function identityWithBudget(
    id: string,
    budget: Identity['budget'],
  ): Identity {
    return resolveIdentity(makeAgent({ id }), { budget });
  }

  beforeAll(() => {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL is required for registry Postgres integration tests');
    }
    db = createDb(process.env.DATABASE_URL);
  });

  afterAll(async () => {
    if (identityIds.length) {
      await db.delete(identityUsage).where(inArray(identityUsage.identityId, identityIds));
    }
    if (createdAgentIds.length) {
      await db.delete(agents).where(inArray(agents.id, createdAgentIds));
    }
    if (createdProfileIds.length) {
      await db.delete(agentProfiles).where(inArray(agentProfiles.id, createdProfileIds));
    }
    await db.$client.end({ timeout: 5 });
  });

  it('recordUsage inserts then accumulates across repeated calls in the same window', async () => {
    const identityId = `id_${randomUUID()}`;
    identityIds.push(identityId);
    const windowKey = '2026-06-27';

    await recordUsage(db, { identityId, period: 'day', windowKey, tokens: 100, spend: 0.5 });
    await recordUsage(db, { identityId, period: 'day', windowKey, tokens: 250, spend: 1.25 });

    const identity = identityWithBudget(identityId, {
      tokenCap: 10_000,
      spendCap: 100,
      window: 'day',
    });
    const result = await checkBudget(db, { identity, windowKey });

    // 100 + 250 tokens, 0.5 + 1.25 spend.
    expect(result.withinBudget).toBe(true);
    expect(result.remaining.tokens).toBe(10_000 - 350);
    expect(result.remaining.spend).toBeCloseTo(100 - 1.75, 6);
  });

  it('no declared cap → withinBudget true without touching usage', async () => {
    const identityId = `id_${randomUUID()}`;
    identityIds.push(identityId);
    const identity = identityWithBudget(identityId, { window: 'day' });

    const result = await checkBudget(db, { identity, windowKey: '2026-06-27' });
    expect(result).toEqual({ withinBudget: true, remaining: {} });
  });

  it('under cap → true; at/over tokenCap → false', async () => {
    const identityId = `id_${randomUUID()}`;
    identityIds.push(identityId);
    const windowKey = '2026-06-27';
    const identity = identityWithBudget(identityId, { tokenCap: 500, window: 'day' });

    await recordUsage(db, { identityId, period: 'day', windowKey, tokens: 499 });
    expect((await checkBudget(db, { identity, windowKey })).withinBudget).toBe(true);

    // One more token lands exactly AT the cap → exhausted (>=).
    await recordUsage(db, { identityId, period: 'day', windowKey, tokens: 1 });
    const atCap = await checkBudget(db, { identity, windowKey });
    expect(atCap.withinBudget).toBe(false);
    expect(atCap.remaining.tokens).toBe(0);

    // Over the cap stays exhausted with negative headroom.
    await recordUsage(db, { identityId, period: 'day', windowKey, tokens: 50 });
    const overCap = await checkBudget(db, { identity, windowKey });
    expect(overCap.withinBudget).toBe(false);
    expect(overCap.remaining.tokens).toBe(-50);
  });

  it('over spendCap → false (even when tokens are unbounded)', async () => {
    const identityId = `id_${randomUUID()}`;
    identityIds.push(identityId);
    const windowKey = '2026-06-27';
    const identity = identityWithBudget(identityId, { spendCap: 10, window: 'day' });

    await recordUsage(db, { identityId, period: 'day', windowKey, tokens: 999_999, spend: 12.5 });
    const result = await checkBudget(db, { identity, windowKey });
    expect(result.withinBudget).toBe(false);
    expect(result.remaining.spend).toBeCloseTo(-2.5, 6);
    // tokenCap not declared ⇒ no token headroom reported.
    expect(result.remaining.tokens).toBeUndefined();
  });

  it('window isolation: usage in a different windowKey does not count', async () => {
    const identityId = `id_${randomUUID()}`;
    identityIds.push(identityId);
    const identity = identityWithBudget(identityId, { tokenCap: 100, window: 'day' });

    // Yesterday's bucket is over cap, but today's bucket is empty.
    await recordUsage(db, { identityId, period: 'day', windowKey: '2026-06-26', tokens: 500 });

    const today = await checkBudget(db, { identity, windowKey: '2026-06-27' });
    expect(today.withinBudget).toBe(true);
    expect(today.remaining.tokens).toBe(100);

    const yesterday = await checkBudget(db, { identity, windowKey: '2026-06-26' });
    expect(yesterday.withinBudget).toBe(false);
  });

  it('full loop: a persisted agents.budget cap composes into an enforcing Identity', async () => {
    // Persist a real agent row carrying a `budget` jsonb cap, then prove the whole
    // loop: load the row → resolveIdentity composes the cap → record usage over the
    // cap → checkBudget (same composed identity) returns withinBudget=false. This is
    // exactly the path the ambient gate + worker exercise.
    const suffix = randomUUID().slice(0, 8);
    const [profile] = await db
      .insert(agentProfiles)
      .values({ name: `budget-loop-${suffix}`, displayName: 'Budget Loop' })
      .returning({ id: agentProfiles.id });
    createdProfileIds.push(profile.id);

    const [agentRow] = await db
      .insert(agents)
      .values({
        handle: `budget-loop-${suffix}`,
        displayName: 'Budget Loop',
        profileId: profile.id,
        budget: { tokenCap: 1_000, window: 'day' },
      })
      .returning();
    createdAgentIds.push(agentRow.id);
    identityIds.push(agentRow.id);

    // Read the row back from the DB and compose it — the budget jsonb round-trips.
    const [loaded] = await db.select().from(agents).where(eq(agents.id, agentRow.id)).limit(1);
    const identity = resolveIdentity(loaded);
    expect(identity.budget).toEqual({ tokenCap: 1_000, window: 'day' });

    const windowKey = windowKeyFor(identity.budget!.window, '2026-06-27T10:00:00.000Z');

    // Under the cap → allowed.
    await recordUsage(db, { identityId: identity.id, period: 'day', windowKey, tokens: 600 });
    expect((await checkBudget(db, { identity, windowKey })).withinBudget).toBe(true);

    // Crossing the cap → the gate now blocks (the loop is closed).
    await recordUsage(db, { identityId: identity.id, period: 'day', windowKey, tokens: 500 });
    const overCap = await checkBudget(db, { identity, windowKey });
    expect(overCap.withinBudget).toBe(false);
    expect(overCap.remaining.tokens).toBe(1_000 - 1_100);
  });
});
