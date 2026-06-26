import { getTableConfig, type AnyPgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../db.js';
import { agents, feishuApps, platformUsers } from '../schema.js';
import {
  getPlatformUserBySso,
  isBootstrapEligible,
  type PlatformUser,
  upsertPlatformUserByDevAuth,
  upsertPlatformUserBySso,
} from '../platform-users.js';

type InsertCapture = {
  values: Record<string, unknown>;
  conflictSet?: Record<string, unknown>;
};

// Minimal drizzle-shaped fake that captures the insert/onConflict payloads and
// returns a synthetic row. Keeps the test pure (no Postgres) while still
// exercising the truncation/role logic exactly as production calls it.
function fakeInsertDb(returnedRow: Record<string, unknown>): {
  db: Database;
  capture: InsertCapture;
} {
  const capture: InsertCapture = { values: {} };
  const db = {
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        capture.values = values;
        return {
          onConflictDoUpdate: ({ set }: { set: Record<string, unknown> }) => {
            capture.conflictSet = set;
            return { returning: async () => [returnedRow] };
          },
        };
      },
    }),
  } as unknown as Database;
  return { db, capture };
}

function collectStrings(
  value: unknown,
  out = new Set<string>(),
  seen = new WeakSet<object>(),
): Set<string> {
  if (typeof value === 'string') {
    out.add(value);
    return out;
  }
  if (!value || typeof value !== 'object') return out;
  if (seen.has(value)) return out;
  seen.add(value);
  for (const item of Object.values(value as Record<string, unknown>)) {
    collectStrings(item, out, seen);
  }
  return out;
}

function fakePlatformUsersDb(initialRows: PlatformUser[]): {
  db: Database;
  rows: Map<string, PlatformUser>;
} {
  const rows = new Map(initialRows.map((row) => [row.ssoSub, row]));
  const rowFromCondition = (condition: unknown): PlatformUser | undefined => {
    const values = collectStrings(condition);
    for (const [ssoSub, row] of rows) {
      if (values.has(ssoSub)) return row;
    }
    return undefined;
  };
  const db = {
    select: (selection?: Record<string, unknown>) => ({
      from: () => {
        if (selection && 'value' in selection) return Promise.resolve([{ value: rows.size }]);
        return {
          where: (condition: unknown) => ({
            limit: async () => {
              const row = rowFromCondition(condition);
              return row ? [row] : [];
            },
          }),
        };
      },
    }),
    update: () => ({
      set: (set: Partial<PlatformUser>) => ({
        where: (condition: unknown) => ({
          returning: async () => {
            const row = rowFromCondition(condition);
            if (!row) return [];
            const updated = { ...row, ...set } as PlatformUser;
            rows.delete(row.ssoSub);
            rows.set(updated.ssoSub, updated);
            return [updated];
          },
        }),
      }),
    }),
    insert: () => ({
      values: (values: PlatformUser) => ({
        onConflictDoUpdate: ({ set }: { set: Partial<PlatformUser> }) => ({
          returning: async () => {
            const existing = rows.get(values.ssoSub);
            if (existing) {
              const updated = { ...existing, ...set } as PlatformUser;
              rows.set(updated.ssoSub, updated);
              return [updated];
            }
            rows.set(values.ssoSub, values);
            return [values];
          },
        }),
      }),
    }),
  } as unknown as Database;
  return { db, rows };
}

function summarizeIndexes(table: AnyPgTable) {
  return getTableConfig(table).indexes.map((index) => ({
    name: index.config.name,
    unique: index.config.unique,
    columns: index.config.columns.map((column) => {
      const namedColumn = column as { name?: string };
      return namedColumn.name ?? '<expression>';
    }),
  }));
}

describe('platform-users schema', () => {
  it('exports the platform_users SSO identity table with the expected columns', () => {
    expect(platformUsers.id).toBeDefined();
    expect(platformUsers.ssoSub.notNull).toBe(true);
    expect(platformUsers.ssoSub.isUnique).toBe(true);
    expect(platformUsers.email.notNull).toBe(false);
    expect(platformUsers.displayName.notNull).toBe(false);
    expect(platformUsers.department.notNull).toBe(false);
    expect(platformUsers.role.notNull).toBe(true);
    expect(platformUsers.computerAccessEnabled.notNull).toBe(true);
  });

  it('indexes platform_users by email', () => {
    expect(summarizeIndexes(platformUsers)).toEqual(
      expect.arrayContaining([
        { name: 'idx_platform_users_email', unique: false, columns: ['email'] },
      ]),
    );
  });

  it('adds nullable platform ownership columns to feishu_apps and agents', () => {
    expect(feishuApps.platformOwnerId.notNull).toBe(false);
    expect(agents.platformOwnerId.notNull).toBe(false);
    // The Feishu-domain agent owner column is left intact alongside the new one.
    expect(agents.ownerUserId.notNull).toBe(false);
  });
});

describe('upsertPlatformUserBySso', () => {
  it('persists trimmed claims and defaults the role to user', async () => {
    const { db, capture } = fakeInsertDb({ id: 'u1', ssoSub: 'sub-1', role: 'user' });
    await upsertPlatformUserBySso(db, {
      ssoSub: '  sub-1  ',
      email: '  alice@example.com ',
      displayName: ' Alice ',
      department: ' Platform ',
    });
    expect(capture.values).toMatchObject({
      ssoSub: 'sub-1',
      email: 'alice@example.com',
      displayName: 'Alice',
      department: 'Platform',
      role: 'user',
    });
  });

  it('honors the bootstrap role on insert', async () => {
    const { db, capture } = fakeInsertDb({ id: 'u1', ssoSub: 'sub-1', role: 'superadmin' });
    await upsertPlatformUserBySso(db, { ssoSub: 'sub-1' }, { bootstrapRole: 'superadmin' });
    expect(capture.values.role).toBe('superadmin');
  });

  it('refreshes identity fields on conflict but never the role', async () => {
    const { db, capture } = fakeInsertDb({ id: 'u1', ssoSub: 'sub-1', role: 'user' });
    await upsertPlatformUserBySso(db, {
      ssoSub: 'sub-1',
      email: 'new@example.com',
      displayName: 'New Name',
    });
    expect(capture.conflictSet).toMatchObject({
      email: 'new@example.com',
      displayName: 'New Name',
    });
    expect(capture.conflictSet).not.toHaveProperty('role');
  });

  it('truncates oversized claim values defensively', async () => {
    const { db, capture } = fakeInsertDb({ id: 'u1', ssoSub: 'sub-1', role: 'user' });
    const longSub = 'x'.repeat(500);
    await upsertPlatformUserBySso(db, { ssoSub: longSub });
    expect((capture.values.ssoSub as string).length).toBe(256);
  });

  it('coerces blank optional claims to null', async () => {
    const { db, capture } = fakeInsertDb({ id: 'u1', ssoSub: 'sub-1', role: 'user' });
    await upsertPlatformUserBySso(db, { ssoSub: 'sub-1', email: '   ', displayName: '' });
    expect(capture.values.email).toBeNull();
    expect(capture.values.displayName).toBeNull();
  });

  it('rejects an empty ssoSub', async () => {
    const { db } = fakeInsertDb({ id: 'u1', ssoSub: '', role: 'user' });
    await expect(upsertPlatformUserBySso(db, { ssoSub: '   ' })).rejects.toThrow(/ssoSub/);
  });

  it('rekeys a legacy uuid row to the stable SSO subject without changing its id', async () => {
    const legacy = {
      id: 'u-legacy',
      ssoSub: 'login-uuid-1',
      email: 'old@example.com',
      displayName: 'Old Name',
      department: null,
      role: 'user',
      computerAccessEnabled: true,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    } satisfies PlatformUser;
    const { db, rows } = fakePlatformUsersDb([legacy]);

    const user = await upsertPlatformUserBySso(db, {
      ssoSub: 'employee-123',
      legacySsoSub: 'login-uuid-1',
      email: 'new@example.com',
      displayName: 'New Name',
    });

    expect(user.id).toBe('u-legacy');
    expect(user.ssoSub).toBe('employee-123');
    expect(user.email).toBe('new@example.com');
    expect(user.displayName).toBe('New Name');
    expect(rows.has('login-uuid-1')).toBe(false);
    expect(rows.get('employee-123')?.id).toBe('u-legacy');
    expect(rows.get('employee-123')?.computerAccessEnabled).toBe(true);
  });

  it('does not merge a legacy uuid row when the stable subject already exists', async () => {
    const stable = {
      id: 'u-stable',
      ssoSub: 'employee-123',
      email: 'stable@example.com',
      displayName: 'Stable',
      department: null,
      role: 'user',
      computerAccessEnabled: false,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    } satisfies PlatformUser;
    const legacy = {
      ...stable,
      id: 'u-legacy',
      ssoSub: 'login-uuid-1',
      email: 'legacy@example.com',
      computerAccessEnabled: true,
    } satisfies PlatformUser;
    const { db, rows } = fakePlatformUsersDb([stable, legacy]);

    const user = await upsertPlatformUserBySso(db, {
      ssoSub: 'employee-123',
      legacySsoSub: 'login-uuid-1',
      email: 'new@example.com',
    });

    expect(user.id).toBe('u-stable');
    expect(rows.get('login-uuid-1')?.id).toBe('u-legacy');
    expect(rows.get('employee-123')?.id).toBe('u-stable');
  });
});

describe('upsertPlatformUserByDevAuth', () => {
  it('stores the typed display name when dev-login provides one', async () => {
    const { db, capture } = fakeInsertDb({ id: 'u1', ssoSub: 'dev:alice', role: 'user' });
    await upsertPlatformUserByDevAuth(db, {
      sub: 'alice',
      displayName: ' Alice Dev ',
    });
    expect(capture.values).toMatchObject({
      ssoSub: 'dev:alice',
      displayName: 'Alice Dev',
      role: 'user',
    });
    expect(capture.conflictSet).toMatchObject({ displayName: 'Alice Dev' });
  });

  it('preserves existing identity fields when cookie resolution only supplies sub', async () => {
    const { db, capture } = fakeInsertDb({ id: 'u1', ssoSub: 'dev:alice', role: 'user' });
    await upsertPlatformUserByDevAuth(db, { sub: 'alice' });
    expect(capture.values).toMatchObject({
      ssoSub: 'dev:alice',
      displayName: null,
      role: 'user',
    });
    expect(capture.conflictSet).toMatchObject({ updatedAt: expect.any(Date) });
    expect(capture.conflictSet).not.toHaveProperty('displayName');
    expect(capture.conflictSet).not.toHaveProperty('email');
  });
});

describe('isBootstrapEligible', () => {
  it('is eligible when platform_users is empty', async () => {
    const db = {
      select: () => ({ from: async () => [{ value: 0 }] }),
    } as unknown as Database;
    await expect(isBootstrapEligible(db)).resolves.toBe(true);
  });

  it('is not eligible once a user exists', async () => {
    const db = {
      select: () => ({ from: async () => [{ value: 3 }] }),
    } as unknown as Database;
    await expect(isBootstrapEligible(db)).resolves.toBe(false);
  });
});

describe('getPlatformUserBySso', () => {
  it('returns null for a blank subject without querying', async () => {
    const select = vi.fn();
    const db = { select } as unknown as Database;
    await expect(getPlatformUserBySso(db, '  ')).resolves.toBeNull();
    expect(select).not.toHaveBeenCalled();
  });

  it('returns the matched row', async () => {
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({ limit: async () => [{ id: 'u1', ssoSub: 'sub-1' }] }),
        }),
      }),
    } as unknown as Database;
    await expect(getPlatformUserBySso(db, 'sub-1')).resolves.toMatchObject({ id: 'u1' });
  });
});
