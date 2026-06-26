import { randomUUID } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, identityAccessGrants, type Database } from '@open-tag/storage';
import { loadIdentityAccessGrants } from '../access-grants-store.js';
import { resolveIdentityAccess } from '../access-bundles.js';

const describePg = process.env.OPEN_TAG_STORAGE_PG_INTEGRATION === '1' ? describe : describe.skip;

describePg('access grants store integration', () => {
  let db: Database;
  const identityIds: string[] = [];

  beforeAll(() => {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL is required for registry Postgres integration tests');
    }
    db = createDb(process.env.DATABASE_URL);
  });

  afterAll(async () => {
    if (identityIds.length) {
      await db
        .delete(identityAccessGrants)
        .where(inArray(identityAccessGrants.identityId, identityIds));
    }
    await db.$client.end({ timeout: 5 });
  });

  it('loads no grants for an identity with none (zero-access default)', async () => {
    const identityId = `id_${randomUUID()}`;
    identityIds.push(identityId);

    const grants = await loadIdentityAccessGrants(db, identityId);
    expect(grants).toEqual([]);
    expect(resolveIdentityAccess({ id: identityId }, grants)).toEqual([]);
  });

  it('install → load → resolve yields the granted bundle', async () => {
    const identityId = `id_${randomUUID()}`;
    identityIds.push(identityId);

    await db.insert(identityAccessGrants).values({ identityId, bundleId: 'jira' });

    const grants = await loadIdentityAccessGrants(db, identityId);
    expect(grants).toEqual([{ identityId, bundleId: 'jira' }]);

    const bundles = resolveIdentityAccess({ id: identityId }, grants);
    expect(bundles.map((b) => b.id)).toEqual(['jira']);
    expect(bundles[0].credentialEnv).toContain('JIRA_API_TOKEN');
  });

  it('loads multiple grants in install order, scoped to the identity', async () => {
    const identityId = `id_${randomUUID()}`;
    const otherId = `id_${randomUUID()}`;
    identityIds.push(identityId, otherId);

    // Insert jira first, datadog second, so install order is observable.
    await db.insert(identityAccessGrants).values({ identityId, bundleId: 'jira' });
    await db.insert(identityAccessGrants).values({ identityId, bundleId: 'datadog' });
    // A grant for a DIFFERENT identity must never leak into this identity's load.
    await db.insert(identityAccessGrants).values({ identityId: otherId, bundleId: 'datadog' });

    const grants = await loadIdentityAccessGrants(db, identityId);
    expect(grants).toEqual([
      { identityId, bundleId: 'jira' },
      { identityId, bundleId: 'datadog' },
    ]);
    expect(resolveIdentityAccess({ id: identityId }, grants).map((b) => b.id)).toEqual([
      'jira',
      'datadog',
    ]);
  });

  it('re-installing the same bundle is idempotent (unique index)', async () => {
    const identityId = `id_${randomUUID()}`;
    identityIds.push(identityId);

    await db.insert(identityAccessGrants).values({ identityId, bundleId: 'jira' });
    // A duplicate install conflicts on the (identity_id, bundle_id) unique index
    // and must not create a second grant row.
    await db
      .insert(identityAccessGrants)
      .values({ identityId, bundleId: 'jira' })
      .onConflictDoNothing();

    const grants = await loadIdentityAccessGrants(db, identityId);
    expect(grants).toEqual([{ identityId, bundleId: 'jira' }]);
  });
});
