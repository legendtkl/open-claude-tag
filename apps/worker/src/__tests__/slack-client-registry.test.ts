import { describe, expect, it, vi } from 'vitest';
import type { Database } from '@open-tag/storage';
import { SlackChannel } from '@open-tag/channel-slack';
import { createWorkerSlackClientRegistry } from '../slack-client-registry.js';

interface SlackInstallationRow {
  id: string;
  teamId: string;
  botTokenRef: string;
  botToken: string | null;
  status: string;
}

/** A row is soft-deleted iff it is disabled AND its team id carries the sentinel. */
function hasNonDeletedRow(rows: SlackInstallationRow[]): boolean {
  return rows.some((r) => !(r.status === 'disabled' && r.teamId.startsWith('__deleted__')));
}

/**
 * A `db` distinguishing the two queries by the `select` projection:
 *  - `db.select()` (no projection) → `listEnabledSlackInstallations`: resolves
 *    through `.orderBy(...)` to the ENABLED rows only (mirroring real Postgres).
 *  - `db.select({...})` (a projection) → `hasAnySlackInstallation`: resolves
 *    through `.limit(1)` to `{exists:1}` when ANY non-deleted row exists.
 */
function makeDb(rowsRef: { rows: SlackInstallationRow[] }): Database {
  const listChain = {
    from: () => listChain,
    where: () => listChain,
    orderBy: async () => rowsRef.rows.filter((r) => r.status === 'enabled'),
  };
  const probeChain = {
    from: () => probeChain,
    where: () => probeChain,
    limit: async () => (hasNonDeletedRow(rowsRef.rows) ? [{ exists: 1 }] : []),
  };
  return {
    select: vi.fn((...args: unknown[]) => (args.length === 0 ? listChain : probeChain)),
  } as unknown as Database;
}

function makeChannel(token: string): SlackChannel {
  return { token } as unknown as SlackChannel;
}

describe('createWorkerSlackClientRegistry', () => {
  it('returns a per-team SlackChannel built from the stored token', async () => {
    const rowsRef = {
      rows: [
        { id: 'i1', teamId: 'T1', botTokenRef: 'stored', botToken: 'xoxb-t1', status: 'enabled' },
        { id: 'i2', teamId: 'T2', botTokenRef: 'stored', botToken: 'xoxb-t2', status: 'enabled' },
      ],
    };
    const registry = await createWorkerSlackClientRegistry({
      db: makeDb(rowsRef),
      primaryToken: '',
      createChannel: makeChannel,
    });
    await expect(registry.getClient('T1')).resolves.toMatchObject({ token: 'xoxb-t1' });
    await expect(registry.getClient('T2')).resolves.toMatchObject({ token: 'xoxb-t2' });
    expect(registry.registeredTeamIds()).toEqual(['T1', 'T2']);
  });

  it('resolves a token from an env reference when set', async () => {
    const rowsRef = {
      rows: [{ id: 'i1', teamId: 'T1', botTokenRef: 'env:SLACK_T1', botToken: null, status: 'enabled' }],
    };
    const registry = await createWorkerSlackClientRegistry({
      db: makeDb(rowsRef),
      primaryToken: '',
      env: { SLACK_T1: 'xoxb-from-env' } as NodeJS.ProcessEnv,
      createChannel: makeChannel,
    });
    await expect(registry.getClient('T1')).resolves.toMatchObject({ token: 'xoxb-from-env' });
  });

  it('reloads when a task references a team installed after startup', async () => {
    const rowsRef = {
      rows: [{ id: 'i1', teamId: 'T1', botTokenRef: 'stored', botToken: 'xoxb-t1', status: 'enabled' }],
    };
    const registry = await createWorkerSlackClientRegistry({
      db: makeDb(rowsRef),
      primaryToken: '',
      createChannel: makeChannel,
      refreshIntervalMs: 60_000,
    });
    rowsRef.rows = [
      ...rowsRef.rows,
      { id: 'i2', teamId: 'T2', botTokenRef: 'stored', botToken: 'xoxb-t2', status: 'enabled' },
    ];
    await expect(registry.getClient('T2')).resolves.toMatchObject({ token: 'xoxb-t2' });
  });

  it('falls back to the env primary sender ONLY when no enabled rows exist (single-workspace)', async () => {
    const rowsRef = { rows: [] as SlackInstallationRow[] };
    const registry = await createWorkerSlackClientRegistry({
      db: makeDb(rowsRef),
      primaryToken: 'xoxb-env',
      createChannel: makeChannel,
    });
    expect(registry.primarySender).toMatchObject({ token: 'xoxb-env' });
    // No rows: an unknown team borrows the env sender (synthetic single-workspace).
    await expect(registry.getClient('T_unknown')).resolves.toMatchObject({ token: 'xoxb-env' });
    // No team id: also the env sender.
    await expect(registry.getClient(undefined)).resolves.toMatchObject({ token: 'xoxb-env' });
  });

  it('does NOT borrow the env token for an unknown team once per-team rows exist (multi-workspace)', async () => {
    const rowsRef = {
      rows: [{ id: 'i1', teamId: 'T1', botTokenRef: 'stored', botToken: 'xoxb-t1', status: 'enabled' }],
    };
    const registry = await createWorkerSlackClientRegistry({
      db: makeDb(rowsRef),
      primaryToken: 'xoxb-env',
      createChannel: makeChannel,
      refreshIntervalMs: 60_000,
    });
    // Rows exist ⇒ a genuine unknown team gets null (skip), never the env token.
    await expect(registry.getClient('T_unknown')).resolves.toBeNull();
  });

  it('does NOT borrow the env token when an enabled row exists but its token is unresolvable', async () => {
    // The enabled row points at a missing env var and has no stored token, so it
    // resolves to no client (empty map) — but it IS an enabled row, so the env
    // fallback must stay suppressed (Codex impl-gate finding 1).
    const rowsRef = {
      rows: [
        { id: 'i1', teamId: 'T1', botTokenRef: 'env:MISSING', botToken: null, status: 'enabled' },
      ],
    };
    const registry = await createWorkerSlackClientRegistry({
      db: makeDb(rowsRef),
      primaryToken: 'xoxb-env',
      env: {} as NodeJS.ProcessEnv,
      createChannel: makeChannel,
      refreshIntervalMs: 60_000,
    });
    expect(registry.registeredTeamIds()).toEqual([]);
    await expect(registry.getClient('T1')).resolves.toBeNull();
    await expect(registry.getClient('T_unknown')).resolves.toBeNull();
  });

  it('does NOT borrow the env token for a known-but-DISABLED only team (multi-workspace)', async () => {
    // The sole row is disabled (non-deleted): listEnabled is empty so no per-team
    // channel resolves, but the gate sees a non-deleted row ⇒ env fallback stays
    // suppressed for any team (Copilot finding #1).
    const rowsRef = {
      rows: [{ id: 'i1', teamId: 'T1', botTokenRef: 'stored', botToken: 'xoxb-t1', status: 'disabled' }],
    };
    const registry = await createWorkerSlackClientRegistry({
      db: makeDb(rowsRef),
      primaryToken: 'xoxb-env',
      createChannel: makeChannel,
      refreshIntervalMs: 60_000,
    });
    expect(registry.registeredTeamIds()).toEqual([]);
    await expect(registry.getClient('T1')).resolves.toBeNull();
    await expect(registry.getClient('T_unknown')).resolves.toBeNull();
  });

  it('treats a soft-deleted-only row as single-workspace: env fallback still serves', async () => {
    // A soft-deleted row (status disabled + __deleted__ team id) is excluded from
    // the non-deleted gate, so a deploy whose only row is soft-deleted is back to
    // single-workspace mode and the env token serves an unknown team.
    const rowsRef = {
      rows: [
        {
          id: 'i1',
          teamId: '__deleted__abc123',
          botTokenRef: 'deleted',
          botToken: null,
          status: 'disabled',
        },
      ],
    };
    const registry = await createWorkerSlackClientRegistry({
      db: makeDb(rowsRef),
      primaryToken: 'xoxb-env',
      createChannel: makeChannel,
      refreshIntervalMs: 60_000,
    });
    await expect(registry.getClient('T_unknown')).resolves.toMatchObject({ token: 'xoxb-env' });
    await expect(registry.getClient(undefined)).resolves.toMatchObject({ token: 'xoxb-env' });
  });

  it('fails closed (null, no env borrow) for an unknown team once a refresh errors', async () => {
    // Starts single-workspace (zero rows ⇒ env sender). Then the DB errors on the
    // staleness refresh: a reload error may hide a freshly-added install, so the
    // gate must assume multi-workspace and skip rather than borrow the env token
    // (Copilot M1a review). refreshIntervalMs 0 ⇒ every getClient forces a reload.
    const rowsRef = { rows: [] as SlackInstallationRow[] };
    const failRef = { fail: false };
    const listChain = {
      from: () => listChain,
      where: () => listChain,
      orderBy: async () => {
        if (failRef.fail) throw new Error('db down');
        return rowsRef.rows.filter((r) => r.status === 'enabled');
      },
    };
    const probeChain = {
      from: () => probeChain,
      where: () => probeChain,
      limit: async () => {
        if (failRef.fail) throw new Error('db down');
        return hasNonDeletedRow(rowsRef.rows) ? [{ exists: 1 }] : [];
      },
    };
    const db = {
      select: vi.fn((...args: unknown[]) => (args.length === 0 ? listChain : probeChain)),
    } as unknown as Database;
    const registry = await createWorkerSlackClientRegistry({
      db,
      primaryToken: 'xoxb-env',
      createChannel: makeChannel,
      refreshIntervalMs: 0,
    });
    // Healthy single-workspace: env sender serves an unknown team.
    await expect(registry.getClient('T_unknown')).resolves.toMatchObject({ token: 'xoxb-env' });
    // DB now errors on refresh ⇒ fail closed: null, never the env token.
    failRef.fail = true;
    await expect(registry.getClient('T_unknown')).resolves.toBeNull();
    await expect(registry.getClient(undefined)).resolves.toBeNull();
  });

  it('never throws on a missing install: an empty DB keeps serving (null skip)', async () => {
    const emptyDb = {
      select: vi.fn((...args: unknown[]) =>
        args.length === 0
          ? { from: () => ({ where: () => ({ orderBy: async () => [] }) }) }
          : { from: () => ({ where: () => ({ limit: async () => [] }) }) },
      ),
    } as unknown as Database;
    const registry = await createWorkerSlackClientRegistry({
      db: emptyDb,
      primaryToken: '',
      createChannel: makeChannel,
    });
    await expect(registry.getClient('T_missing')).resolves.toBeNull();
  });
});
