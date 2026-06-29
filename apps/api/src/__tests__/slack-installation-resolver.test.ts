import { describe, expect, it, vi } from 'vitest';
import type { Database } from '@open-tag/storage';
import { SlackChannel } from '@open-tag/channel-slack';
import { createSlackInstallationResolver } from '../slack-installation-resolver.js';

interface SlackInstallationRow {
  id: string;
  teamId: string;
  botTokenRef: string;
  botToken: string | null;
  botUserId: string | null;
  status: string;
}

/**
 * A `db` whose `getSlackInstallationByTeamId` (select…where…limit) returns the
 * row matching the queried team id, and whose `listEnabledSlackInstallations`
 * (select…where…orderBy) returns all rows. The where predicate is not inspected;
 * instead the limit/orderBy terminals consult `rowsByTeam` / `allRows`.
 */
function makeDb(rows: SlackInstallationRow[], teamIdRef: { teamId?: string }): Database {
  const chain = {
    from: () => chain,
    where: (..._args: unknown[]) => chain,
    // getSlackInstallationByTeamId resolves through `.limit(1)`.
    limit: async () => {
      const row = rows.find((r) => r.teamId === teamIdRef.teamId && r.status === 'enabled');
      return row ? [row] : [];
    },
    // listEnabledSlackInstallations resolves through `.orderBy(...)`.
    orderBy: async () => rows.filter((r) => r.status === 'enabled'),
  };
  return { select: vi.fn(() => chain) } as unknown as Database;
}

function makeChannel(token: string): SlackChannel {
  return { token } as unknown as SlackChannel;
}

describe('createSlackInstallationResolver', () => {
  function setup(rows: SlackInstallationRow[], defaults?: { token?: string; userId?: string }) {
    const teamIdRef: { teamId?: string } = {};
    const db = makeDb(rows, teamIdRef);
    const resolver = createSlackInstallationResolver({
      getDb: () => db,
      defaultBotToken: defaults?.token,
      defaultBotUserId: defaults?.userId,
      createChannel: makeChannel,
      // Tag the queried team via a getSlackInstallationByTeamId shim is awkward;
      // instead expose teamIdRef so the test sets it before each lookup.
    });
    return { resolver, teamIdRef };
  }

  it('resolves a per-team token by installation id (stored)', async () => {
    const rows: SlackInstallationRow[] = [
      { id: 'i1', teamId: 'T1', botTokenRef: 'stored', botToken: 'xoxb-t1', botUserId: 'U1', status: 'enabled' },
    ];
    const { resolver, teamIdRef } = setup(rows, { token: 'xoxb-env', userId: 'U_env' });
    teamIdRef.teamId = 'T1';
    await expect(resolver.resolveSender('T1')).resolves.toMatchObject({ token: 'xoxb-t1' });
    await expect(resolver.resolveBotUserId('T1')).resolves.toBe('U1');
  });

  it('resolves a per-team token from an env reference', async () => {
    const rows: SlackInstallationRow[] = [
      { id: 'i1', teamId: 'T1', botTokenRef: 'env:SLACK_T1', botToken: null, botUserId: 'U1', status: 'enabled' },
    ];
    const teamIdRef: { teamId?: string } = { teamId: 'T1' };
    const db = makeDb(rows, teamIdRef);
    const resolver = createSlackInstallationResolver({
      getDb: () => db,
      env: { SLACK_T1: 'xoxb-from-env' } as NodeJS.ProcessEnv,
      createChannel: makeChannel,
    });
    await expect(resolver.resolveSender('T1')).resolves.toMatchObject({ token: 'xoxb-from-env' });
  });

  it('falls back to the env default ONLY when no enabled rows exist (single-workspace)', async () => {
    const { resolver, teamIdRef } = setup([], { token: 'xoxb-env', userId: 'U_env' });
    teamIdRef.teamId = 'T_unknown';
    await expect(resolver.resolveSender('T_unknown')).resolves.toMatchObject({ token: 'xoxb-env' });
    await expect(resolver.resolveBotUserId('T_unknown')).resolves.toBe('U_env');
  });

  it('does NOT borrow the env default for an unknown team once rows exist (multi-workspace)', async () => {
    const rows: SlackInstallationRow[] = [
      { id: 'i1', teamId: 'T1', botTokenRef: 'stored', botToken: 'xoxb-t1', botUserId: 'U1', status: 'enabled' },
    ];
    const { resolver, teamIdRef } = setup(rows, { token: 'xoxb-env', userId: 'U_env' });
    teamIdRef.teamId = 'T_unknown';
    await expect(resolver.resolveSender('T_unknown')).resolves.toBeUndefined();
    await expect(resolver.resolveBotUserId('T_unknown')).resolves.toBeUndefined();
  });

  it('fails closed (no env fallback) when the enabled-row probe errors for an unknown team', async () => {
    // getSlackInstallationByTeamId returns no row, then the "any enabled?" probe
    // throws (DB blip). The cross-workspace gate must NOT borrow the env token
    // (Codex impl-gate finding 2).
    const throwingChain = {
      from: () => throwingChain,
      where: () => throwingChain,
      limit: async () => [] as unknown[],
      orderBy: async () => {
        throw new Error('db down');
      },
    };
    const db = { select: vi.fn(() => throwingChain) } as unknown as Database;
    const resolver = createSlackInstallationResolver({
      getDb: () => db,
      defaultBotToken: 'xoxb-env',
      defaultBotUserId: 'U_env',
      createChannel: makeChannel,
    });
    await expect(resolver.resolveSender('T_unknown')).resolves.toBeUndefined();
    await expect(resolver.resolveBotUserId('T_unknown')).resolves.toBeUndefined();
  });

  it('uses the per-team bot user id for the @-mention gate, not the env default', async () => {
    const rows: SlackInstallationRow[] = [
      { id: 'i1', teamId: 'T1', botTokenRef: 'stored', botToken: 'xoxb-t1', botUserId: 'U_team', status: 'enabled' },
    ];
    const { resolver, teamIdRef } = setup(rows, { token: 'xoxb-env', userId: 'U_env' });
    teamIdRef.teamId = 'T1';
    await expect(resolver.resolveBotUserId('T1')).resolves.toBe('U_team');
  });
});
