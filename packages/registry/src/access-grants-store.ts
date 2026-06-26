import { asc, eq } from 'drizzle-orm';
import type { Database } from '@open-tag/storage';
import { identityAccessGrants } from '@open-tag/storage';
import type { IdentityAccessGrant } from './access-bundles.js';

/**
 * Load an identity's installed access-bundle grants from the `identity_access_grants`
 * table as the {@link IdentityAccessGrant} source {@link resolveIdentityAccess}
 * consumes. The DB-backed counterpart of the previously injected grant parameter.
 *
 * Mirrors the `budget.ts` store pattern: registry depends on `@open-tag/storage`
 * (so a DB read lives here, not in storage which must not depend back on registry),
 * and the query is keyed by the SAME `Identity.id` the worker composes via
 * `resolveIdentity` — so a grant installed under an identity is the grant the
 * runtime resolves for it.
 *
 * Returns `[]` for an identity with no installed bundles (the zero-access default).
 * Rows are ordered by `installed_at` so resolution is deterministic and matches
 * install order; the `(identity_id, bundle_id)` unique index keeps a re-install
 * from producing duplicate grants. This is a thin row→`IdentityAccessGrant` map and
 * does NOT resolve or validate bundle ids — `resolveIdentityAccess` owns the
 * fail-fast on an unknown granted bundle.
 */
export async function loadIdentityAccessGrants(
  db: Database,
  identityId: string,
): Promise<IdentityAccessGrant[]> {
  const rows = await db
    .select({
      identityId: identityAccessGrants.identityId,
      bundleId: identityAccessGrants.bundleId,
    })
    .from(identityAccessGrants)
    .where(eq(identityAccessGrants.identityId, identityId))
    .orderBy(asc(identityAccessGrants.installedAt));

  return rows.map((row) => ({ identityId: row.identityId, bundleId: row.bundleId }));
}
