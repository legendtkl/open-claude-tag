import type { Database } from '@open-tag/storage';
import { channelObservations } from '@open-tag/storage';
import { and, asc, desc, eq, inArray, lte, notInArray, sql } from 'drizzle-orm';
import { MAX_OBSERVATION_LIMIT } from './read.js';

/**
 * The hard floor of rows that are NEVER pruned, regardless of configuration. It is
 * pinned to {@link MAX_OBSERVATION_LIMIT} — the absolute ceiling any reader can
 * surface (`getChannelObservations` clamps every caller to it; `hydrateChannelMemory`
 * only ever reads the top-20). Keeping at least this many most-recent rows per
 * scope makes the "never drop memory the agent still reads" invariant structural:
 * even a misconfigured `maxPerScope` below this is clamped UP to it, so retention
 * can only ever delete rows no read could return. Pinned (not a literal) so the two
 * constants can never drift apart — see `retention.test.ts`.
 */
export const OBSERVATION_READ_CAP_FLOOR = MAX_OBSERVATION_LIMIT;

/** Conservative default keep-N per scope — 2.5× the read ceiling, so nothing readable is ever dropped. */
export const DEFAULT_CHANNEL_MEMORY_MAX_PER_SCOPE = 500;
/** Per-tick safety valve: at most this many over-cap scopes are pruned per reconciler tick. */
export const DEFAULT_CHANNEL_MEMORY_MAX_SCOPES_PER_TICK = 50;
/** Per-tick safety valve: at most this many (oldest) surplus rows are deleted per scope per tick. */
export const DEFAULT_CHANNEL_MEMORY_MAX_DELETES_PER_SCOPE = 1000;

/** A single scope's observation row, reduced to the fields retention reasons over. */
export interface PrunableObservation {
  id: string;
  /** Inbound event time — the primary recency key (mirrors the read order). */
  occurredAt: Date;
  /** Write time — the first tiebreak when two rows share an `occurredAt`. */
  createdAt: Date;
}

export interface RetentionPolicy {
  /**
   * Keep at most this many most-recent rows per scope; older surplus is pruned.
   * `null` ⇒ no count cap. Values below {@link OBSERVATION_READ_CAP_FLOOR} are
   * clamped up to it (you can never configure pruning to drop a readable row).
   */
  maxPerScope: number | null;
  /**
   * Prune surplus rows (already beyond the read-cap floor) whose age
   * (`now - occurredAt`) is at least this many ms. `null` ⇒ no TTL prune. Ignored
   * when the count cap is active (the cap already removes all surplus). OFF by
   * default; count-cap retention is the shipped mechanism.
   */
  ttlMs: number | null;
  /** Injected clock for the TTL comparison (never wall-clock here). */
  now: Date;
  /**
   * Max (oldest) surplus rows to delete per scope per run. `null` ⇒ unbounded.
   * Bounds a first-rollout delete; remaining surplus is pruned on later ticks
   * (idempotent, converges from the oldest rows up).
   */
  maxDeletesPerScope?: number | null;
}

/**
 * Read-order comparator: newest first by `occurredAt`, then `createdAt`, then `id`
 * — identical to the order `getChannelObservations` returns, so "the top-N rows"
 * means exactly "the N rows a read would surface".
 */
function byReadOrderDesc(a: PrunableObservation, b: PrunableObservation): number {
  const occ = b.occurredAt.getTime() - a.occurredAt.getTime();
  if (occ !== 0) return occ;
  const created = b.createdAt.getTime() - a.createdAt.getTime();
  if (created !== 0) return created;
  // Descending id, string-compared, to match SQL `ORDER BY id DESC`.
  if (a.id < b.id) return 1;
  if (a.id > b.id) return -1;
  return 0;
}

/**
 * Resolve the effective keep-floor for a policy: the larger of the configured
 * count cap and the structural read-cap floor. A `maxPerScope` of `null` still
 * yields the read-cap floor, so a TTL-only policy never drops a readable row.
 */
export function effectiveKeepFloor(maxPerScope: number | null): number {
  return Math.max(OBSERVATION_READ_CAP_FLOOR, maxPerScope ?? 0);
}

/**
 * Pure retention policy: given ONE scope's rows, return the ids to delete.
 *
 * Rules (deterministic, append-only-safe):
 *  - Both knobs unset ⇒ `[]` (feature off; never deletes).
 *  - The top `effectiveKeepFloor(maxPerScope)` rows by read order are ALWAYS kept.
 *    Since that floor is ≥ {@link OBSERVATION_READ_CAP_FLOOR}, every row a read
 *    could surface is protected — read behavior is provably unchanged.
 *  - Among rows ranked beyond the floor (surplus): a row is eligible when the count
 *    cap is active (`maxPerScope != null`) OR it is at least `ttlMs` old.
 *  - The OLDEST eligible rows are deleted first, capped at `maxDeletesPerScope`, so
 *    a bounded batch converges over successive ticks.
 *
 * Pure + clock-injected, so the policy is unit-testable with a fake `now`. The IO
 * edge ({@link pruneChannelObservations}) issues the equivalent bounded DELETE.
 */
export function selectObservationsToPrune(
  rows: readonly PrunableObservation[],
  policy: RetentionPolicy,
): string[] {
  if (policy.maxPerScope == null && policy.ttlMs == null) return [];

  const keepFloor = effectiveKeepFloor(policy.maxPerScope);
  if (rows.length <= keepFloor) return [];

  const sorted = [...rows].sort(byReadOrderDesc);
  const countCapActive = policy.maxPerScope != null;
  const nowMs = policy.now.getTime();

  // Surplus = rows ranked beyond the protected floor, walked OLDEST-first (the tail
  // of the desc-sorted array). Collect eligible ids until the per-scope cap is hit.
  const cap =
    policy.maxDeletesPerScope == null ? Number.POSITIVE_INFINITY : policy.maxDeletesPerScope;
  const toDelete: string[] = [];
  for (let rank = sorted.length - 1; rank >= keepFloor && toDelete.length < cap; rank--) {
    const row = sorted[rank];
    const expired = policy.ttlMs != null && nowMs - row.occurredAt.getTime() >= policy.ttlMs;
    if (countCapActive || expired) {
      toDelete.push(row.id);
    }
  }
  return toDelete;
}

export interface PruneChannelObservationsOptions extends RetentionPolicy {
  /** Max over-cap scopes to prune per run. `null` ⇒ unbounded. */
  maxScopesPerTick?: number | null;
}

export interface PruneChannelObservationsResult {
  /** Scopes that exceeded the keep-floor and were scanned for surplus. */
  scopesScanned: number;
  /** Total rows deleted across all scopes this run. */
  deleted: number;
}

/**
 * Bounded, per-scope retention prune — the IO edge mirroring
 * {@link selectObservationsToPrune}. A no-op when the policy is off or nothing
 * exceeds the keep-floor (the candidate query returns zero scopes).
 *
 * Safe under concurrent {@link ingestObservation}: a new row carries the newest
 * `occurredAt` (rank 1), so it is always inside the protected floor and excluded
 * from the victim set; the delete targets a stable read-order ranking and is
 * idempotent (re-running deletes the next batch of oldest surplus). Per-(channelKind,
 * scopeId) only — never crosses scope isolation — and never touches the dedupe
 * UNIQUE (it deletes whole rows; a later identical message simply re-inserts).
 */
export async function pruneChannelObservations(
  db: Database,
  options: PruneChannelObservationsOptions,
): Promise<PruneChannelObservationsResult> {
  if (options.maxPerScope == null && options.ttlMs == null) {
    return { scopesScanned: 0, deleted: 0 };
  }

  const keepFloor = effectiveKeepFloor(options.maxPerScope);
  const countCapActive = options.maxPerScope != null;
  const perScopeCap = options.maxDeletesPerScope ?? DEFAULT_CHANNEL_MEMORY_MAX_DELETES_PER_SCOPE;

  // Candidate scopes: only those whose row count exceeds the keep-floor can have
  // surplus. Uses idx_channel_observations_scope; returns nothing when no scope is
  // over the floor, so the common case is a single cheap aggregate query. Bounded
  // by maxScopesPerTick so a first rollout touches at most N scopes per tick.
  const scopeCap = options.maxScopesPerTick ?? DEFAULT_CHANNEL_MEMORY_MAX_SCOPES_PER_TICK;
  const candidateQuery = db
    .select({
      channelKind: channelObservations.channelKind,
      scopeId: channelObservations.scopeId,
    })
    .from(channelObservations)
    .groupBy(channelObservations.channelKind, channelObservations.scopeId)
    .having(sql`count(*) > ${keepFloor}`)
    .limit(scopeCap == null ? Number.MAX_SAFE_INTEGER : scopeCap);
  const candidates = await candidateQuery;

  let deleted = 0;
  for (const scope of candidates) {
    const scopeMatch = and(
      eq(channelObservations.channelKind, scope.channelKind),
      eq(channelObservations.scopeId, scope.scopeId),
    );

    // The protected set: the newest keepFloor rows in read order — exactly what a
    // read would surface. A SUBQUERY (not a materialized list) so it shares the
    // delete's single MVCC snapshot: a row concurrently appended during the prune is
    // either fully visible to this statement (and, being newest, lands inside this
    // protected set) or not visible at all — so the newest rows are never deleted.
    const protectedIds = db
      .select({ id: channelObservations.id })
      .from(channelObservations)
      .where(scopeMatch)
      .orderBy(
        desc(channelObservations.occurredAt),
        desc(channelObservations.createdAt),
        desc(channelObservations.id),
      )
      .limit(keepFloor);

    // Victims: surplus rows (not protected), OLDEST-first, capped at the per-scope
    // batch. TTL-only mode additionally requires the row to be at/over the age
    // threshold; the count cap already removes all surplus so TTL is not applied then.
    const victimConditions = [scopeMatch, notInArray(channelObservations.id, protectedIds)];
    if (!countCapActive && options.ttlMs != null) {
      const threshold = new Date(options.now.getTime() - options.ttlMs);
      victimConditions.push(lte(channelObservations.occurredAt, threshold));
    }
    const victimIds = db
      .select({ id: channelObservations.id })
      .from(channelObservations)
      .where(and(...victimConditions))
      .orderBy(
        asc(channelObservations.occurredAt),
        asc(channelObservations.createdAt),
        asc(channelObservations.id),
      )
      .limit(perScopeCap);

    // One statement: the protected/victim subqueries and the delete all evaluate
    // against the same snapshot, so the batch is bounded (perScopeCap) AND the
    // newest-row protection holds under concurrent ingestion.
    const removed = await db
      .delete(channelObservations)
      .where(inArray(channelObservations.id, victimIds))
      .returning({ id: channelObservations.id });
    deleted += removed.length;
  }

  return { scopesScanned: candidates.length, deleted };
}
