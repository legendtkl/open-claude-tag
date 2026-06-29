import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../db.js';
import {
  getSlackInstallationByTeamId,
  listEnabledSlackInstallations,
  resolveSlackInstallationToken,
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
