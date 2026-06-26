import { count, eq, sql } from 'drizzle-orm';
import type { Database } from './db.js';
import { platformUsers } from './schema.js';

/** A `platform_users` row. */
export type PlatformUser = typeof platformUsers.$inferSelect;

/** Console roles. `superadmin` (ops) sees everything; `user` is self-service. */
export type PlatformUserRole = 'user' | 'superadmin';

/**
 * Identity claims for a console platform user. `ssoSub` is the stable
 * person-level subject used for ownership. `legacySsoSub` is an optional
 * previous subject (for example the old login `uuid`) that can be lazily rekeyed
 * to preserve ownership after claim-precedence fixes.
 */
export interface PlatformUserClaims {
  ssoSub: string;
  legacySsoSub?: string | null;
  email?: string | null;
  displayName?: string | null;
  department?: string | null;
}

/**
 * Column widths used for defensive truncation. The schema columns are unbounded
 * `text`, but we still cap values so a hostile/oversized JWT claim can never bloat
 * the row (the upsert-by-SSO pattern truncates every claim before persisting).
 */
const FIELD_LIMITS = {
  ssoSub: 256,
  email: 320,
  displayName: 256,
  department: 256,
} as const;

function truncate(value: string | null | undefined, max: number): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max);
}

/**
 * Whether the platform is eligible to bootstrap its first superadmin: true only
 * when `platform_users` is empty. The first verified SSO user is then promoted to
 * superadmin (design D-A2), unless `ADMIN_BOOTSTRAP=false` disables it at the guard.
 *
 * NOTE: this is a non-atomic check (count==0) and MUST NOT be used to gate a
 * subsequent insert — two concurrent first logins would both see 0 and both
 * become superadmin (R2-5). For the bootstrap decision use
 * {@link upsertPlatformUserBySsoWithBootstrap}, which re-checks emptiness inside
 * an advisory-locked transaction so exactly one row is promoted. This helper is
 * retained only for read-only/informational callers.
 */
export async function isBootstrapEligible(db: Database): Promise<boolean> {
  const [row] = await db.select({ value: count() }).from(platformUsers);
  return (row?.value ?? 0) === 0;
}

/**
 * A transaction-capable database handle: either a {@link Database} or a Drizzle
 * transaction object. The upsert helpers accept this so they can run standalone
 * or inside the bootstrap transaction without duplicating the upsert SQL.
 */
type DatabaseOrTx = Pick<Database, 'insert' | 'select' | 'update'>;

/**
 * Advisory-lock key for the first-superadmin bootstrap (R2-5). A single arbitrary
 * 64-bit constant; any session taking `pg_advisory_xact_lock(BOOTSTRAP_LOCK_KEY)`
 * serializes with every other bootstrap attempt, so the emptiness re-check and the
 * promote-to-superadmin insert happen under mutual exclusion. The lock is held for
 * the duration of the enclosing transaction and released automatically on commit
 * or rollback (the `_xact_` variant).
 */
const BOOTSTRAP_LOCK_KEY = 0x636f_6469_6e67_61n; // "codinga" — stable, repo-unique.

/**
 * Insert-or-update a platform user keyed by `ssoSub` (upsert-by-SSO pattern).
 *
 * On insert, `role` defaults to the provided `bootstrapRole` (used to promote the
 * very first user to superadmin); on conflict the existing role is preserved — an
 * upsert from a later request never demotes or escalates an established user.
 * Mutable identity fields (email/displayName/department) are refreshed from the
 * latest verified claims. All claim values are defensively truncated.
 *
 * If a verified JWT also carries `legacySsoSub`, the helper first attempts a
 * bounded compatibility repair: when no row exists for the stable `ssoSub` but a
 * row exists for the legacy subject, that row is rekeyed to the stable subject.
 * This keeps existing `platform_owner_id` references intact without merging two
 * already-distinct users.
 */
export async function upsertPlatformUserBySso(
  db: DatabaseOrTx,
  claims: PlatformUserClaims,
  options: { bootstrapRole?: PlatformUserRole } = {},
): Promise<PlatformUser> {
  const ssoSub = truncate(claims.ssoSub, FIELD_LIMITS.ssoSub);
  if (!ssoSub) {
    throw new Error('upsertPlatformUserBySso requires a non-empty ssoSub claim');
  }
  const email = truncate(claims.email, FIELD_LIMITS.email);
  const displayName = truncate(claims.displayName, FIELD_LIMITS.displayName);
  const department = truncate(claims.department, FIELD_LIMITS.department);
  const role: PlatformUserRole = options.bootstrapRole ?? 'user';
  const set = { email, displayName, department, updatedAt: new Date() };
  const legacySsoSub = truncate(claims.legacySsoSub, FIELD_LIMITS.ssoSub);

  if (legacySsoSub && legacySsoSub !== ssoSub) {
    const repaired = await rekeyLegacyPlatformUserBySso(db, {
      ssoSub,
      legacySsoSub,
      set,
    });
    if (repaired) return repaired;
  }

  const [row] = await db
    .insert(platformUsers)
    .values({ ssoSub, email, displayName, department, role })
    .onConflictDoUpdate({
      target: platformUsers.ssoSub,
      // Refresh mutable identity fields only; role is intentionally NOT updated so
      // a returning user keeps the role they were first assigned.
      set,
    })
    .returning();
  return row;
}

async function rekeyLegacyPlatformUserBySso(
  db: DatabaseOrTx,
  input: {
    ssoSub: string;
    legacySsoSub: string;
    set: {
      email: string | null;
      displayName: string | null;
      department: string | null;
      updatedAt: Date;
    };
  },
): Promise<PlatformUser | null> {
  const [stableRow] = await db
    .select()
    .from(platformUsers)
    .where(eq(platformUsers.ssoSub, input.ssoSub))
    .limit(1);
  if (stableRow) return null;

  const [row] = await db
    .update(platformUsers)
    .set({ ssoSub: input.ssoSub, ...input.set })
    .where(eq(platformUsers.ssoSub, input.legacySsoSub))
    .returning();
  return row ?? null;
}

/**
 * Upsert a verified SSO user and atomically decide whether they bootstrap as the
 * first superadmin (R2-5). Fixes the race where `count==0` was checked outside any
 * lock and a subsequent insert ran separately — two concurrent first logins both
 * saw 0 and both became superadmin.
 *
 * When `bootstrapEnabled` is false, this is a plain `user` upsert (no promotion).
 * When true, the whole operation runs in a transaction that first takes
 * `pg_advisory_xact_lock(BOOTSTRAP_LOCK_KEY)`, then re-checks emptiness UNDER the
 * lock: only the attempt that observes zero existing rows promotes its insert to
 * `superadmin`; any concurrent attempt blocks on the lock, then sees ≥1 row and
 * inserts as a plain `user`. The lock releases on commit/rollback. Returns the
 * resolved {@link PlatformUser} (role reflects the bootstrap decision).
 */
export async function upsertPlatformUserBySsoWithBootstrap(
  db: Database,
  claims: PlatformUserClaims,
  options: { bootstrapEnabled: boolean },
): Promise<PlatformUser> {
  if (!options.bootstrapEnabled) {
    return upsertPlatformUserBySso(db, claims);
  }
  return db.transaction(async (tx) => {
    // Serialize all bootstrap attempts. Held until this transaction ends.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${BOOTSTRAP_LOCK_KEY})`);
    // Re-check emptiness INSIDE the lock so exactly one attempt sees zero rows.
    const [{ value: existing } = { value: 0 }] = await tx
      .select({ value: count() })
      .from(platformUsers);
    const bootstrapRole: PlatformUserRole | undefined = existing === 0 ? 'superadmin' : undefined;
    return upsertPlatformUserBySso(tx, claims, { bootstrapRole });
  });
}

/** Look up a platform user by its SSO subject, or null if unknown. */
export async function getPlatformUserBySso(
  db: Database,
  ssoSub: string,
): Promise<PlatformUser | null> {
  const trimmed = ssoSub.trim();
  if (!trimmed) return null;
  const [row] = await db
    .select()
    .from(platformUsers)
    .where(eq(platformUsers.ssoSub, trimmed))
    .limit(1);
  return row ?? null;
}

/**
 * Namespace prefix for dev-auth identities (design D-A6). Dev-auth subjects are
 * stored as `dev:<sub>` so a dev identity can never collide with another platform
 * user subject, keeping the two trust domains apart even though both share the
 * `platform_users.sso_sub` column.
 */
export const DEV_AUTH_SUB_PREFIX = 'dev:';

/** Build the namespaced `sso_sub` for a dev-auth identity. */
export function devAuthSsoSub(sub: string): string {
  return `${DEV_AUTH_SUB_PREFIX}${sub.trim()}`;
}

/**
 * Insert-or-update a dev-auth platform user (design D-A6, test-only login mode).
 *
 * The subject is namespaced with `dev:` and the role is ALWAYS `user` — never
 * superadmin, even on the very first row. Superadmin stays break-glass-token
 * only, so A/B owner isolation is testable without a real SSO provider. Existing
 * identity fields are preserved when callers only pass `sub`; dev-auth cookie
 * resolution must not erase the display name captured by `/admin/auth/dev-login`.
 * Callers MUST gate this behind the `OPEN_TAG_DEV_AUTH=enabled` flag (the guard
 * never honors a dev identity when the flag is off).
 */
export async function upsertPlatformUserByDevAuth(
  db: Database,
  input: { sub: string; displayName?: string | null; email?: string | null },
): Promise<PlatformUser> {
  const sub = input.sub.trim();
  if (!sub) {
    throw new Error('upsertPlatformUserByDevAuth requires a non-empty sub');
  }
  const ssoSub = truncate(devAuthSsoSub(sub), FIELD_LIMITS.ssoSub);
  if (!ssoSub) {
    throw new Error('upsertPlatformUserByDevAuth requires a non-empty dev-auth subject');
  }
  const email = input.email === undefined ? null : truncate(input.email, FIELD_LIMITS.email);
  const displayName =
    input.displayName === undefined
      ? null
      : truncate(input.displayName, FIELD_LIMITS.displayName);
  const set: {
    email?: string | null;
    displayName?: string | null;
    updatedAt: Date;
  } = { updatedAt: new Date() };

  if (input.email !== undefined) set.email = email;
  if (input.displayName !== undefined) set.displayName = displayName;

  const [row] = await db
    .insert(platformUsers)
    .values({ ssoSub, email, displayName, department: null, role: 'user' })
    .onConflictDoUpdate({
      target: platformUsers.ssoSub,
      set,
    })
    .returning();
  return row;
}
