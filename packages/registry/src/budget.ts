import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '@open-tag/storage';
import { identityUsage } from '@open-tag/storage';
import type { Identity, IdentityBudgetWindow } from './identity.js';

/**
 * Per-identity budget tracking and enforcement over the `identity_usage`
 * aggregate table. The mechanism is split into three pure-ish pieces:
 *  - {@link windowKeyFor} — derive a bucket label from a timestamp (deterministic).
 *  - {@link recordUsage}  — atomically increment a window bucket's counters.
 *  - {@link checkBudget}  — compare a window bucket against the declared cap.
 *
 * Determinism contract: NONE of these read wall-clock. The bucket window is
 * always supplied by the caller (a `windowKey` derived from a passed timestamp),
 * never `Date.now()`. This keeps the budget math reproducible and testable.
 */

/** Input to {@link recordUsage}. `windowKey` is caller-derived (see {@link windowKeyFor}). */
export interface RecordUsageInput {
  /** The Identity id whose window bucket is incremented (`Identity.id`). */
  identityId: string;
  /** Which window family this bucket belongs to — mirrors the budget window. */
  period: IdentityBudgetWindow;
  /** The bucket label, e.g. '2026-06-27' (day) or '2026-06' (month). */
  windowKey: string;
  /** Tokens consumed by this usage event (default 0). */
  tokens?: number;
  /** Spend consumed by this usage event (default 0). */
  spend?: number;
}

/** Result of {@link checkBudget}: the gate verdict plus remaining headroom. */
export interface BudgetCheckResult {
  /** False ⇒ either declared cap is at/over its limit for this window. */
  withinBudget: boolean;
  /**
   * Headroom against each declared cap (`cap - used`); a key is present only when
   * the corresponding cap is declared. May be negative once a cap is exceeded.
   */
  remaining: { tokens?: number; spend?: number };
}

/** Input to {@link checkBudget}. `windowKey` is caller-derived (see {@link windowKeyFor}). */
export interface CheckBudgetInput {
  /** The identity whose declared `budget` cap is enforced. */
  identity: Identity;
  /** The window bucket to evaluate (must match `identity.budget.window`'s family). */
  windowKey: string;
}

/**
 * Derive the bucket label for a window family from an ISO timestamp. Pure and
 * deterministic — the timestamp is the only clock input, computed in UTC so the
 * bucket boundary is stable regardless of server locale:
 *  - `day`   → 'YYYY-MM-DD' (e.g. '2026-06-27')
 *  - `month` → 'YYYY-MM'    (e.g. '2026-06')
 *
 * Throws on an unparseable timestamp (fail fast — a bad bucket key would silently
 * scatter usage across phantom windows).
 */
export function windowKeyFor(period: IdentityBudgetWindow, isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`windowKeyFor: invalid ISO timestamp "${isoTimestamp}"`);
  }
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  if (period === 'month') {
    return `${year}-${month}`;
  }
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Atomically increment an identity's window bucket. The first usage in a window
 * inserts the row; every later usage in the SAME window adds to the existing
 * counters via `onConflictDoUpdate` — the add happens inside the conflicting
 * INSERT (a single statement holding the row lock), so concurrent recorders never
 * read-modify-write past each other.
 *
 * Clock-pure: the caller derives `windowKey` from a timestamp (see
 * {@link windowKeyFor}); this function reads no wall-clock for the bucket. The
 * `updated_at` bookkeeping column is touched with `now()` and is metadata only —
 * it never participates in the budget math.
 */
export async function recordUsage(db: Database, input: RecordUsageInput): Promise<void> {
  const tokens = input.tokens ?? 0;
  const spend = input.spend ?? 0;

  await db
    .insert(identityUsage)
    .values({
      identityId: input.identityId,
      period: input.period,
      windowKey: input.windowKey,
      tokensUsed: tokens,
      // numeric columns round-trip as strings in drizzle.
      spendUsed: String(spend),
    })
    .onConflictDoUpdate({
      target: [identityUsage.identityId, identityUsage.period, identityUsage.windowKey],
      set: {
        tokensUsed: sql`${identityUsage.tokensUsed} + ${tokens}`,
        spendUsed: sql`${identityUsage.spendUsed} + ${spend}::numeric`,
        updatedAt: sql`now()`,
      },
    });
}

/**
 * Evaluate an identity's declared budget against its current window usage.
 *
 * Unlimited fast-path: when the identity declares no budget, or a budget with no
 * `tokenCap` and no `spendCap`, this returns `{ withinBudget: true, remaining: {} }`
 * WITHOUT touching the DB — an uncapped identity is never gated.
 *
 * Otherwise it sums the matching `(identityId, period, windowKey)` bucket and
 * compares against each declared cap. A cap is treated as exhausted at OR over the
 * limit (`used >= cap`), so `withinBudget` is false if EITHER cap is reached. The
 * `period` is taken from `identity.budget.window`, so the caller's `windowKey`
 * must have been derived for that same window family.
 */
export async function checkBudget(
  db: Database,
  input: CheckBudgetInput,
): Promise<BudgetCheckResult> {
  const { identity, windowKey } = input;
  const budget = identity.budget;

  // Unlimited: no budget, or a budget with neither cap declared.
  if (!budget || (budget.tokenCap === undefined && budget.spendCap === undefined)) {
    return { withinBudget: true, remaining: {} };
  }

  const rows = await db
    .select({
      tokens: sql<string>`coalesce(sum(${identityUsage.tokensUsed}), 0)`,
      spend: sql<string>`coalesce(sum(${identityUsage.spendUsed}), 0)`,
    })
    .from(identityUsage)
    .where(
      and(
        eq(identityUsage.identityId, identity.id),
        eq(identityUsage.period, budget.window),
        eq(identityUsage.windowKey, windowKey),
      ),
    );

  const tokensUsed = Number(rows[0]?.tokens ?? 0);
  const spendUsed = Number(rows[0]?.spend ?? 0);

  let withinBudget = true;
  const remaining: BudgetCheckResult['remaining'] = {};

  if (budget.tokenCap !== undefined) {
    remaining.tokens = budget.tokenCap - tokensUsed;
    if (tokensUsed >= budget.tokenCap) {
      withinBudget = false;
    }
  }
  if (budget.spendCap !== undefined) {
    remaining.spend = budget.spendCap - spendUsed;
    if (spendUsed >= budget.spendCap) {
      withinBudget = false;
    }
  }

  return { withinBudget, remaining };
}
