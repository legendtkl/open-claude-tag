import { randomUUID } from 'crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Database } from '../db.js';
import * as schema from '../schema.js';
import { platformUsers, slackInstallations } from '../schema.js';
import {
  disableSlackInstallationByTeamId,
  getSlackInstallationByTeamId,
  hasAnySlackInstallation,
  listEnabledSlackInstallations,
  resolveSlackInstallationToken,
  SlackInstallationOwnershipError,
  upsertSlackInstallationFromOAuth,
} from '../slack-installation-repository.js';

/** A select chain whose terminal step (`limit` / `orderBy`) resolves to `rows`. */
function makeDb(rows: unknown[]): { db: Database; where: ReturnType<typeof vi.fn> } {
  const where = vi.fn(() => chain);
  const chain = {
    from: () => chain,
    where,
    limit: async () => rows,
    orderBy: async () => rows,
  };
  return { db: { select: vi.fn(() => chain) } as unknown as Database, where };
}

/** An update chain (`update→set→where→returning`) resolving to `rows`. */
function makeUpdateDb(rows: unknown[]): { db: Database; set: ReturnType<typeof vi.fn> } {
  const set = vi.fn(() => chain);
  const chain = {
    set,
    where: () => chain,
    returning: async () => rows,
  };
  return { db: { update: vi.fn(() => chain) } as unknown as Database, set };
}

describe('resolveSlackInstallationToken', () => {
  it('prefers an env reference (plain or env: prefixed) when the var is set', () => {
    expect(
      resolveSlackInstallationToken(
        { botTokenRef: 'SLACK_TEAM_TOKEN', botToken: 'xoxb-stored' },
        { SLACK_TEAM_TOKEN: 'xoxb-from-env' },
      ),
    ).toBe('xoxb-from-env');
    expect(
      resolveSlackInstallationToken(
        { botTokenRef: 'env:SLACK_TEAM_TOKEN', botToken: null },
        { SLACK_TEAM_TOKEN: 'xoxb-from-env' },
      ),
    ).toBe('xoxb-from-env');
  });

  it('falls back to the stored token when the ref is "stored" or its env var is unset', () => {
    expect(resolveSlackInstallationToken({ botTokenRef: 'stored', botToken: 'xoxb-stored' }, {})).toBe(
      'xoxb-stored',
    );
    expect(
      resolveSlackInstallationToken({ botTokenRef: 'MISSING_VAR', botToken: 'xoxb-stored' }, {}),
    ).toBe('xoxb-stored');
  });

  it('returns null (never throws) when neither an env var nor a stored token resolves', () => {
    expect(resolveSlackInstallationToken({ botTokenRef: 'stored', botToken: null }, {})).toBeNull();
    expect(resolveSlackInstallationToken({ botTokenRef: 'deleted', botToken: null }, {})).toBeNull();
  });
});

describe('getSlackInstallationByTeamId', () => {
  it('returns the enabled row for a team id', async () => {
    const row = { id: 'i1', teamId: 'T1', status: 'enabled', botToken: 'xoxb-1' };
    const { db } = makeDb([row]);
    await expect(getSlackInstallationByTeamId(db, 'T1')).resolves.toMatchObject({
      id: 'i1',
      teamId: 'T1',
    });
  });

  it('returns null when no enabled row exists for the team', async () => {
    const { db } = makeDb([]);
    await expect(getSlackInstallationByTeamId(db, 'T_unknown')).resolves.toBeNull();
  });
});

describe('listEnabledSlackInstallations', () => {
  it('returns the enabled installation rows', async () => {
    const rows = [
      { id: 'i1', teamId: 'T1', status: 'enabled' },
      { id: 'i2', teamId: 'T2', status: 'enabled' },
    ];
    const { db } = makeDb(rows);
    await expect(listEnabledSlackInstallations(db)).resolves.toHaveLength(2);
  });
});

describe('hasAnySlackInstallation', () => {
  it('is true when the existence probe returns a row', async () => {
    const { db } = makeDb([{ exists: 1 }]);
    await expect(hasAnySlackInstallation(db)).resolves.toBe(true);
  });

  it('is false when the existence probe returns no row', async () => {
    const { db } = makeDb([]);
    await expect(hasAnySlackInstallation(db)).resolves.toBe(false);
  });
});

describe('disableSlackInstallationByTeamId (unit)', () => {
  it('disables + wipes the token and reports a row was affected', async () => {
    const { db, set } = makeUpdateDb([{ id: 'i1' }]);
    await expect(disableSlackInstallationByTeamId(db, 'T1')).resolves.toBe(true);
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'disabled', botToken: null }),
    );
  });

  it('reports no row affected when the team has no live install', async () => {
    const { db } = makeUpdateDb([]);
    await expect(disableSlackInstallationByTeamId(db, 'T_unknown')).resolves.toBe(false);
  });
});

// Real-Postgres proof of the soft-delete SQL predicate: only the SQL backend can
// verify that the `left(team_id, len) = '__deleted__'` filter counts a plain
// disabled row but excludes a soft-deleted (`__deleted__` + disabled) one. The
// global `hasAnySlackInstallation` probe is table-wide so it cannot be asserted
// `false` in a shared DB; instead we drive the SAME non-deleted predicate scoped
// to a unique fixture suffix to make the assertion deterministic. Gated like the
// other storage PG integration tests.
const describePg =
  process.env.OPEN_TAG_STORAGE_PG_INTEGRATION === '1' ? describe : describe.skip;

describePg('hasAnySlackInstallation non-deleted predicate (Postgres)', () => {
  const DELETED_PREFIX = '__deleted__';
  let client: postgres.Sql;
  let db: Database;
  const cleanupIds: string[] = [];
  const run = randomUUID().slice(0, 8);

  async function insertInstall(opts: { teamId: string; status: string }): Promise<string> {
    const id = randomUUID();
    cleanupIds.push(id);
    await db.insert(slackInstallations).values({
      id,
      teamId: opts.teamId,
      botToken: 'xoxb-fixture',
      botTokenRef: 'stored',
      status: opts.status,
    });
    return id;
  }

  // The production non-deleted predicate, scoped to THIS run's fixture rows so the
  // assertion is deterministic regardless of other rows already in the table.
  async function listNonDeletedForRun(): Promise<string[]> {
    const rows = await db
      .select({ id: slackInstallations.id })
      .from(slackInstallations)
      .where(
        and(
          inArray(slackInstallations.id, cleanupIds),
          sql`not (${slackInstallations.status} = 'disabled' and left(${slackInstallations.teamId}, ${DELETED_PREFIX.length}) = ${DELETED_PREFIX})`,
        ),
      );
    return rows.map((r) => r.id);
  }

  beforeAll(() => {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL is required for storage Postgres integration tests');
    }
    client = postgres(process.env.DATABASE_URL, { max: 4, idle_timeout: 5, connect_timeout: 5 });
    db = drizzle(client, { schema }) as unknown as Database;
  });

  afterAll(async () => {
    for (const id of cleanupIds.splice(0)) {
      await db.delete(slackInstallations).where(eq(slackInstallations.id, id));
    }
    await client.end({ timeout: 5 });
  });

  it('counts enabled + plain-disabled rows but excludes a soft-deleted row; global probe is true and never throws', async () => {
    const enabledId = await insertInstall({ teamId: `T_en_${run}`, status: 'enabled' });
    const disabledId = await insertInstall({ teamId: `T_dis_${run}`, status: 'disabled' });
    const deletedId = await insertInstall({
      teamId: `${DELETED_PREFIX}${run}${randomUUID().replaceAll('-', '')}`,
      status: 'disabled',
    });

    const nonDeleted = await listNonDeletedForRun();
    expect(nonDeleted).toContain(enabledId); // enabled counts
    expect(nonDeleted).toContain(disabledId); // a plain disabled row still counts
    expect(nonDeleted).not.toContain(deletedId); // a soft-deleted row is excluded

    // Smoke: with our non-deleted rows present the global probe is true and stable.
    await expect(hasAnySlackInstallation(db)).resolves.toBe(true);
  });
});

// Real-Postgres proof of the M1b OAuth upsert + uninstall-disable lifecycle: the
// onConflict-on-team_id update-not-duplicate, owner-preservation, cross-owner
// rejection, and disable-keeps-team_id semantics can only be verified on the SQL
// backend (the unique team_id index, the FK to platform_users, and the row lock).
describePg('upsertSlackInstallationFromOAuth + disable lifecycle (Postgres)', () => {
  let client: postgres.Sql;
  let db: Database;
  const run = randomUUID().slice(0, 8);
  const teamId = `T_oauth_${run}`;
  let ownerA = '';
  let ownerB = '';

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL is required for storage Postgres integration tests');
    }
    client = postgres(process.env.DATABASE_URL, { max: 4, idle_timeout: 5, connect_timeout: 5 });
    db = drizzle(client, { schema }) as unknown as Database;
    const [a] = await db
      .insert(platformUsers)
      .values({ ssoSub: `sso_a_${run}` })
      .returning({ id: platformUsers.id });
    const [b] = await db
      .insert(platformUsers)
      .values({ ssoSub: `sso_b_${run}` })
      .returning({ id: platformUsers.id });
    ownerA = a.id;
    ownerB = b.id;
  });

  afterAll(async () => {
    await db.delete(slackInstallations).where(eq(slackInstallations.teamId, teamId));
    await db.delete(platformUsers).where(inArray(platformUsers.id, [ownerA, ownerB]));
    await client.end({ timeout: 5 });
  });

  async function loadRow() {
    const [row] = await db
      .select()
      .from(slackInstallations)
      .where(eq(slackInstallations.teamId, teamId))
      .limit(1);
    return row;
  }

  async function countRows() {
    const rows = await db
      .select({ id: slackInstallations.id })
      .from(slackInstallations)
      .where(eq(slackInstallations.teamId, teamId));
    return rows.length;
  }

  it('runs the full install → re-install → cross-owner → uninstall → reinstall lifecycle', async () => {
    // 1. Fresh install owned by A.
    const created = await upsertSlackInstallationFromOAuth(db, {
      teamId,
      teamName: 'Acme',
      botToken: 'xoxb-first',
      botUserId: 'U_BOT1',
      slackAppId: 'A_APP',
      installation: { team: { id: teamId, name: 'Acme' }, bot_user_id: 'U_BOT1' },
      ownerPlatformUserId: ownerA,
    });
    expect(created).toMatchObject({ teamId, created: true });
    expect(await countRows()).toBe(1);
    let row = await loadRow();
    expect(row.platformOwnerId).toBe(ownerA);
    expect(row.botToken).toBe('xoxb-first');
    expect(row.status).toBe('enabled');

    // 2. Same owner re-installs (token rotates) → UPDATE, not a duplicate.
    const updated = await upsertSlackInstallationFromOAuth(db, {
      teamId,
      teamName: 'Acme Corp',
      botToken: 'xoxb-second',
      botUserId: 'U_BOT2',
      ownerPlatformUserId: ownerA,
    });
    expect(updated.created).toBe(false);
    expect(await countRows()).toBe(1);
    row = await loadRow();
    expect(row.botToken).toBe('xoxb-second');
    expect(row.botUserId).toBe('U_BOT2');
    expect(row.platformOwnerId).toBe(ownerA);

    // 3. A DIFFERENT user re-install is rejected; nothing mutates.
    await expect(
      upsertSlackInstallationFromOAuth(db, {
        teamId,
        botToken: 'xoxb-hijack',
        ownerPlatformUserId: ownerB,
      }),
    ).rejects.toBeInstanceOf(SlackInstallationOwnershipError);
    row = await loadRow();
    expect(row.botToken).toBe('xoxb-second'); // unchanged
    expect(row.platformOwnerId).toBe(ownerA);

    // 4. A superadmin-initiated re-install (null owner) updates but PRESERVES owner A.
    const superUpdate = await upsertSlackInstallationFromOAuth(db, {
      teamId,
      botToken: 'xoxb-superadmin',
      ownerPlatformUserId: null,
    });
    expect(superUpdate.created).toBe(false);
    row = await loadRow();
    expect(row.botToken).toBe('xoxb-superadmin');
    expect(row.platformOwnerId).toBe(ownerA); // owner preserved

    // 5. Uninstall: disable + wipe token, keep team_id + owner.
    await expect(disableSlackInstallationByTeamId(db, teamId)).resolves.toBe(true);
    expect(await countRows()).toBe(1); // row kept (NOT soft-deleted)
    row = await loadRow();
    expect(row.status).toBe('disabled');
    expect(row.botToken).toBeNull();
    expect(row.platformOwnerId).toBe(ownerA);
    // Enabled-only lookup now fails closed.
    await expect(getSlackInstallationByTeamId(db, teamId)).resolves.toBeNull();

    // 6. Re-install re-enables the SAME row, owner still A.
    const reinstalled = await upsertSlackInstallationFromOAuth(db, {
      teamId,
      botToken: 'xoxb-reinstall',
      ownerPlatformUserId: ownerA,
    });
    expect(reinstalled.created).toBe(false);
    expect(await countRows()).toBe(1);
    row = await loadRow();
    expect(row.status).toBe('enabled');
    expect(row.botToken).toBe('xoxb-reinstall');
    expect(row.platformOwnerId).toBe(ownerA);
  });
});
