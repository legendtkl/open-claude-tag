import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { createDb, type Database } from '../db.js';
import { platformUsers } from '../schema.js';
import {
  upsertPlatformUserBySsoWithBootstrap,
  type PlatformUser,
} from '../platform-users.js';

// R2-5: first-superadmin bootstrap must be atomic. Two concurrent first logins
// must NOT both become superadmin. Gated on DATABASE_URL (advisory-lock semantics
// require real Postgres) — runs under the isolated runner, skips in pure unit runs.
const describePg = process.env.DATABASE_URL ? describe : describe.skip;

describePg('upsertPlatformUserBySsoWithBootstrap (R2-5 atomic bootstrap)', () => {
  const createdSubs: string[] = [];

  function freshDb(): Database {
    return createDb(process.env.DATABASE_URL!);
  }

  afterEach(async () => {
    if (createdSubs.length === 0) return;
    const db = freshDb();
    await db.delete(platformUsers).where(inArray(platformUsers.ssoSub, createdSubs));
    createdSubs.length = 0;
  });

  async function tableWasEmpty(db: Database): Promise<boolean> {
    const rows = await db.select({ id: platformUsers.id }).from(platformUsers).limit(1);
    return rows.length === 0;
  }

  it('never promotes BOTH of two CONCURRENT first logins to superadmin', async () => {
    const db = freshDb();
    const wasEmpty = await tableWasEmpty(db);
    const subA = `boot-a-${randomUUID()}`;
    const subB = `boot-b-${randomUUID()}`;
    createdSubs.push(subA, subB);

    // Fire both bootstraps concurrently. The advisory-locked transaction must
    // serialize them so only the one that observes an empty table promotes — the
    // race bug (count==0 then insert, no lock) would make BOTH superadmin.
    const [a, b] = await Promise.all([
      upsertPlatformUserBySsoWithBootstrap(db, { ssoSub: subA }, { bootstrapEnabled: true }),
      upsertPlatformUserBySsoWithBootstrap(db, { ssoSub: subB }, { bootstrapEnabled: true }),
    ]);

    const superadmins = [a, b].filter((u: PlatformUser) => u.role === 'superadmin');
    // The core invariant: at most one of the two concurrent logins is promoted.
    expect(superadmins.length).toBeLessThanOrEqual(1);
    // When the table started empty, exactly one is promoted (the other is a user).
    if (wasEmpty) {
      expect(superadmins).toHaveLength(1);
      expect([a, b].filter((u) => u.role === 'user')).toHaveLength(1);
    }

    // Re-read from the DB to confirm persistence matches the returned roles.
    const rows = await db
      .select({ ssoSub: platformUsers.ssoSub, role: platformUsers.role })
      .from(platformUsers)
      .where(inArray(platformUsers.ssoSub, [subA, subB]));
    expect(rows.filter((row) => row.role === 'superadmin').length).toBeLessThanOrEqual(1);
  });

  it('keeps a returning user at their role and never re-bootstraps', async () => {
    const db = freshDb();
    const sub = `boot-returning-${randomUUID()}`;
    createdSubs.push(sub);

    const first = await upsertPlatformUserBySsoWithBootstrap(
      db,
      { ssoSub: sub, email: 'one@example.com' },
      { bootstrapEnabled: false },
    );
    expect(first.role).toBe('user');

    // A later login with bootstrap enabled must not promote an existing user, and
    // (because the table is non-empty) must not bootstrap them as superadmin.
    const second = await upsertPlatformUserBySsoWithBootstrap(
      db,
      { ssoSub: sub, email: 'two@example.com' },
      { bootstrapEnabled: true },
    );
    expect(second.role).toBe('user');
    expect(second.email).toBe('two@example.com');

    const [row] = await db
      .select()
      .from(platformUsers)
      .where(eq(platformUsers.ssoSub, sub))
      .limit(1);
    expect(row.role).toBe('user');
  });

  it('does not promote when bootstrap is disabled even on an empty table', async () => {
    const db = freshDb();
    const sub = `boot-disabled-${randomUUID()}`;
    createdSubs.push(sub);
    const user = await upsertPlatformUserBySsoWithBootstrap(
      db,
      { ssoSub: sub },
      { bootstrapEnabled: false },
    );
    expect(user.role).toBe('user');
  });
});
