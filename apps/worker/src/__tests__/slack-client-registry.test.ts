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

/** A `select().from().where().orderBy()` chain resolving to the current rows ref. */
function makeDb(rowsRef: { rows: SlackInstallationRow[] }): Database {
  const chain = {
    from: () => chain,
    where: () => chain,
    orderBy: async () => rowsRef.rows,
  };
  return { select: vi.fn(() => chain) } as unknown as Database;
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

  it('never throws on a missing install: a reload failure keeps serving (null skip)', async () => {
    const failingDb = {
      select: vi.fn(() => ({
        from: () => ({ where: () => ({ orderBy: async () => [] }) }),
      })),
    } as unknown as Database;
    const registry = await createWorkerSlackClientRegistry({
      db: failingDb,
      primaryToken: '',
      createChannel: makeChannel,
    });
    await expect(registry.getClient('T_missing')).resolves.toBeNull();
  });
});
