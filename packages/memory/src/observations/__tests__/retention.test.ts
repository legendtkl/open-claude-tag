import { describe, expect, it } from 'vitest';
import {
  selectObservationsToPrune,
  effectiveKeepFloor,
  OBSERVATION_READ_CAP_FLOOR,
  type PrunableObservation,
} from '../retention.js';
import { MAX_OBSERVATION_LIMIT } from '../read.js';

const BASE = 1_782_864_000_000;

/**
 * Build `n` rows, index 0 = OLDEST, index n-1 = NEWEST (occurredAt strictly
 * increasing). createdAt mirrors occurredAt; id is zero-padded so the SQL `id`
 * tiebreak is deterministic.
 */
function makeRows(n: number, stepMs = 1000): PrunableObservation[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `obs-${String(i).padStart(6, '0')}`,
    occurredAt: new Date(BASE + i * stepMs),
    createdAt: new Date(BASE + i * stepMs),
  }));
}

function ids(from: number, to: number): string[] {
  const out: string[] = [];
  for (let i = from; i <= to; i++) out.push(`obs-${String(i).padStart(6, '0')}`);
  return out;
}

describe('selectObservationsToPrune (pure)', () => {
  const NOW = new Date(BASE + 10_000_000);

  it('pins the read-cap floor to MAX_OBSERVATION_LIMIT (no constant drift)', () => {
    expect(OBSERVATION_READ_CAP_FLOOR).toBe(MAX_OBSERVATION_LIMIT);
    expect(OBSERVATION_READ_CAP_FLOOR).toBe(200);
  });

  it('is a no-op when both knobs are unset (feature off)', () => {
    const rows = makeRows(1000);
    expect(selectObservationsToPrune(rows, { maxPerScope: null, ttlMs: null, now: NOW })).toEqual(
      [],
    );
  });

  it('is a no-op under the cap', () => {
    const rows = makeRows(199);
    expect(selectObservationsToPrune(rows, { maxPerScope: 200, ttlMs: null, now: NOW })).toEqual([]);
  });

  it('is a no-op exactly at the cap', () => {
    const rows = makeRows(200);
    expect(selectObservationsToPrune(rows, { maxPerScope: 200, ttlMs: null, now: NOW })).toEqual([]);
  });

  it('prunes the oldest surplus over the count cap, oldest-first', () => {
    const rows = makeRows(205);
    const out = selectObservationsToPrune(rows, { maxPerScope: 200, ttlMs: null, now: NOW });
    // Oldest 5 rows (indices 0..4), returned oldest-first.
    expect(out).toEqual(ids(0, 4));
  });

  it('clamps a misconfigured sub-floor maxPerScope UP to the read floor', () => {
    expect(effectiveKeepFloor(10)).toBe(200);
    const rows = makeRows(205);
    // maxPerScope=10 would naively prune 195 rows; clamped to 200 it prunes only 5.
    const out = selectObservationsToPrune(rows, { maxPerScope: 10, ttlMs: null, now: NOW });
    expect(out).toEqual(ids(0, 4));
  });

  it('bounds the batch via maxDeletesPerScope (oldest first)', () => {
    const rows = makeRows(250);
    const out = selectObservationsToPrune(rows, {
      maxPerScope: 200,
      ttlMs: null,
      now: NOW,
      maxDeletesPerScope: 10,
    });
    // 50 are surplus but only the oldest 10 are deleted this run.
    expect(out).toEqual(ids(0, 9));
  });

  it('TTL-only mode prunes only expired surplus rows; the boundary age == ttlMs is pruned', () => {
    // 210 rows, floor 200 → surplus = indices 0..9. now = BASE + 210_000.
    const rows = makeRows(210);
    const now = new Date(BASE + 210_000);
    // age(i) = 210_000 - i*1000. ttl 205_000 ⇒ expired for age>=205_000 ⇒ i<=5.
    const out = selectObservationsToPrune(rows, {
      maxPerScope: null,
      ttlMs: 205_000,
      now,
    });
    // indices 0..5 expired (i=5 is the exact boundary), 6..9 not; oldest-first.
    expect(out).toEqual(ids(0, 5));
  });

  it('TTL-only mode is a no-op when nothing beyond the floor is old enough', () => {
    const rows = makeRows(210);
    const now = new Date(BASE + 210_000);
    // ttl huge ⇒ no surplus row is old enough.
    const out = selectObservationsToPrune(rows, { maxPerScope: null, ttlMs: 10_000_000, now });
    expect(out).toEqual([]);
  });

  it('count cap dominates TTL when both are set (all surplus pruned regardless of age)', () => {
    const rows = makeRows(205);
    const out = selectObservationsToPrune(rows, {
      maxPerScope: 200,
      ttlMs: 10_000_000, // would protect everything by age, but the count cap wins
      now: NOW,
    });
    expect(out).toEqual(ids(0, 4));
  });

  it('orders by read order: occurredAt, then createdAt, then id (tiebreaks)', () => {
    // Two rows share occurredAt; the one with the OLDER createdAt is the older row
    // and must be the one pruned first when only one surplus slot exists.
    const floor = OBSERVATION_READ_CAP_FLOOR;
    const base = makeRows(floor); // exactly floor newest rows, all protected
    const t = new Date(BASE - 1000); // strictly older than every base row
    const tieOld: PrunableObservation = { id: 'tie-a', occurredAt: t, createdAt: new Date(1) };
    const tieNew: PrunableObservation = { id: 'tie-b', occurredAt: t, createdAt: new Date(2) };
    // floor+2 rows ⇒ 2 surplus (the two tie rows, both older than base).
    const out = selectObservationsToPrune([...base, tieNew, tieOld], {
      maxPerScope: floor,
      ttlMs: null,
      now: NOW,
      maxDeletesPerScope: 1,
    });
    // Only one deletion allowed → the OLDER (smaller createdAt) tie row goes first.
    expect(out).toEqual(['tie-a']);
  });
});
