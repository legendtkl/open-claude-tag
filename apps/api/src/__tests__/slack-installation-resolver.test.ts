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

/** A row is soft-deleted iff it is disabled AND its team id carries the sentinel. */
function hasNonDeletedRow(rows: SlackInstallationRow[]): boolean {
  return rows.some((r) => !(r.status === 'disabled' && r.teamId.startsWith('__deleted__')));
}

/**
 * A `db` that distinguishes the two queries by the `select` projection:
 *  - `db.select()` (no projection) → `getSlackInstallationByTeamId`: resolves
 *    through `.limit(1)` to the ENABLED row matching the queried team id.
 *  - `db.select({...})` (a projection) → `hasAnySlackInstallation`: resolves
 *    through `.limit(1)` to a single `{exists:1}` when ANY non-deleted row exists.
 * The where predicate is not inspected; the terminals consult `rows` / `teamIdRef`.
 */
function makeDb(rows: SlackInstallationRow[], teamIdRef: { teamId?: string }): Database {
  const teamChain = {
    from: () => teamChain,
    where: (..._args: unknown[]) => teamChain,
    limit: async () => {
      const row = rows.find((r) => r.teamId === teamIdRef.teamId && r.status === 'enabled');
      return row ? [row] : [];
    },
  };
  const probeChain = {
    from: () => probeChain,
    where: (..._args: unknown[]) => probeChain,
    limit: async () => (hasNonDeletedRow(rows) ? [{ exists: 1 }] : []),
  };
  return {
    select: vi.fn((...args: unknown[]) => (args.length === 0 ? teamChain : probeChain)),
  } as unknown as Database;
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

  it('does NOT borrow the env default for an empty-string installation id once rows exist', async () => {
    const rows: SlackInstallationRow[] = [
      { id: 'i1', teamId: 'T1', botTokenRef: 'stored', botToken: 'xoxb-t1', botUserId: 'U1', status: 'enabled' },
    ];
    const { resolver } = setup(rows, { token: 'xoxb-env', userId: 'U_env' });
    // No team lookup can match '' ; the multi-workspace gate must still suppress env.
    await expect(resolver.resolveSender('')).resolves.toBeUndefined();
    await expect(resolver.resolveBotUserId('')).resolves.toBeUndefined();
  });

  it('does NOT borrow the env default for a known-but-DISABLED only team', async () => {
    // The sole row is disabled (non-deleted): no ENABLED row resolves, but the gate
    // sees a non-deleted row ⇒ multi-workspace ⇒ no env borrow (Copilot finding #1).
    const rows: SlackInstallationRow[] = [
      { id: 'i1', teamId: 'T1', botTokenRef: 'stored', botToken: 'xoxb-t1', botUserId: 'U1', status: 'disabled' },
    ];
    const { resolver, teamIdRef } = setup(rows, { token: 'xoxb-env', userId: 'U_env' });
    teamIdRef.teamId = 'T1';
    await expect(resolver.resolveSender('T1')).resolves.toBeUndefined();
    await expect(resolver.resolveBotUserId('T1')).resolves.toBeUndefined();
  });

  it('fails closed (no env fallback) when the existence probe errors for an unknown team', async () => {
    // getSlackInstallationByTeamId returns no row, then the "any installation?" probe
    // throws (DB blip). The cross-workspace gate must NOT borrow the env token
    // (Codex impl-gate finding 2 / Copilot M1a review).
    const teamChain = {
      from: () => teamChain,
      where: () => teamChain,
      limit: async () => [] as unknown[],
    };
    const probeChain = {
      from: () => probeChain,
      where: () => probeChain,
      limit: async () => {
        throw new Error('db down');
      },
    };
    const db = {
      select: vi.fn((...args: unknown[]) => (args.length === 0 ? teamChain : probeChain)),
    } as unknown as Database;
    const resolver = createSlackInstallationResolver({
      getDb: () => db,
      defaultBotToken: 'xoxb-env',
      defaultBotUserId: 'U_env',
      createChannel: makeChannel,
    });
    await expect(resolver.resolveSender('T_unknown')).resolves.toBeUndefined();
    await expect(resolver.resolveBotUserId('T_unknown')).resolves.toBeUndefined();
  });

  it('fails closed AFTER a cached single-workspace result once a later probe errors', async () => {
    // First probe returns no rows (single-workspace ⇒ env sender, caches `false`).
    // The TTL is 0 so the next call re-probes; that probe errors. The gate must NOT
    // reuse the stale `false` to borrow the env token (Copilot M1a review): a DB
    // blip right after the first install lands cannot resurrect a cross-workspace
    // borrow.
    let probeCalls = 0;
    const teamChain = {
      from: () => teamChain,
      where: () => teamChain,
      limit: async () => [] as unknown[],
    };
    const probeChain = {
      from: () => probeChain,
      where: () => probeChain,
      limit: async () => {
        probeCalls += 1;
        if (probeCalls === 1) return [] as unknown[];
        throw new Error('db down');
      },
    };
    const db = {
      select: vi.fn((...args: unknown[]) => (args.length === 0 ? teamChain : probeChain)),
    } as unknown as Database;
    const resolver = createSlackInstallationResolver({
      getDb: () => db,
      defaultBotToken: 'xoxb-env',
      defaultBotUserId: 'U_env',
      createChannel: makeChannel,
      enabledProbeTtlMs: 0,
    });
    // Cache the single-workspace `false`.
    await expect(resolver.resolveSender('T_x')).resolves.toMatchObject({ token: 'xoxb-env' });
    // Re-probe errors ⇒ fail closed, no env borrow despite the cached `false`.
    await expect(resolver.resolveSender('T_y')).resolves.toBeUndefined();
    await expect(resolver.resolveBotUserId('T_y')).resolves.toBeUndefined();
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
