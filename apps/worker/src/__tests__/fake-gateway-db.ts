import { vi } from 'vitest';
import type { Database } from '@open-tag/storage';
import { machines, machinePairingTokens } from '@open-tag/storage';

/**
 * A table-routing fake of the Drizzle {@link Database} sufficient for the gateway
 * and remote-adapter tests. It is intentionally small: it understands only the
 * `select/from/where/limit`, `insert/values/returning`, and `update/set/where`
 * chains the gateway uses, and routes results by the table object passed to
 * `from`/`insert`/`update`.
 */
export interface FakeGatewayDbState {
  /** Pairing token rows, returned by the first matching select on the token table. */
  tokens: Array<Record<string, unknown>>;
  /** Machine rows, returned by selects on the machines table. */
  machines: Array<Record<string, unknown>>;
  /** Id assigned to a newly inserted machine. */
  insertedMachineId: string;
  /**
   * Captured token update payloads (e.g. `{ usedAt }`). Each entry is the `.set()`
   * payload from a single-use claim; a successful claim records exactly one entry.
   */
  tokenUpdates: Array<Record<string, unknown>>;
  /** Captured machine update payloads (status flips, capabilities, etc.). */
  machineUpdates: Array<Record<string, unknown>>;
  /** Captured machine insert payloads. */
  machineInserts: Array<Record<string, unknown>>;
  /** When set, the next machine insert throws (simulates a unique-index race). */
  failNextMachineInsert?: boolean;
  /** When set, the next machine update returns no rows (simulates an optimistic-lock race). */
  failNextMachineUpdate?: boolean;
  /** While set, every select rejects (simulates the database being unavailable). */
  failSelects?: boolean;
  /** While set, every update on the machines table rejects (simulates DB failure mid-write). */
  failMachineUpdates?: boolean;
}

export function createFakeGatewayDb(initial: Partial<FakeGatewayDbState> = {}): {
  db: Database;
  state: FakeGatewayDbState;
} {
  const state: FakeGatewayDbState = {
    tokens: initial.tokens ?? [],
    machines: initial.machines ?? [],
    insertedMachineId: initial.insertedMachineId ?? 'machine-new',
    tokenUpdates: [],
    machineUpdates: [],
    machineInserts: [],
    failNextMachineInsert: initial.failNextMachineInsert,
    failNextMachineUpdate: initial.failNextMachineUpdate,
    failSelects: initial.failSelects,
    failMachineUpdates: initial.failMachineUpdates,
  };

  function selectChain(_columns?: unknown) {
    let table: unknown;
    const chain = {
      from(t: unknown) {
        table = t;
        return chain;
      },
      where() {
        return chain;
      },
      orderBy() {
        return chain;
      },
      async limit() {
        if (state.failSelects) throw new Error('fake db: select failed (failSelects)');
        return rowsForTable(table, state);
      },
      then(resolve: (rows: unknown[]) => unknown, reject?: (err: unknown) => unknown) {
        if (state.failSelects) {
          return Promise.reject(new Error('fake db: select failed (failSelects)')).then(
            resolve,
            reject,
          );
        }
        return Promise.resolve(rowsForTable(table, state)).then(resolve, reject);
      },
    };
    return chain;
  }

  /**
   * Atomic single-use token claim: model `UPDATE machine_pairing_tokens SET
   * used_at=... WHERE token_hash=? AND used_at IS NULL AND expires_at > now()
   * RETURNING ...`. The first usable token (unused, unexpired) is marked used and
   * returned; a second concurrent claim finds none usable and returns []. The
   * `set()` payload is captured so single-use assertions still work.
   */
  function claimToken(payload: Record<string, unknown>): Array<Record<string, unknown>> {
    const now = Date.now();
    const usable = state.tokens.find(
      (t) =>
        t.usedAt == null &&
        t.expiresAt instanceof Date &&
        (t.expiresAt as Date).getTime() > now,
    );
    if (!usable) return [];
    usable.usedAt = payload.usedAt ?? new Date();
    state.tokenUpdates.push(payload);
    return [usable];
  }

  function makeDb(): Database {
    return {
      select: vi.fn((columns?: unknown) => selectChain(columns)),
      insert: vi.fn((table: unknown) => ({
        values(payload: Record<string, unknown>) {
          return {
            async returning() {
              if (table === machines) {
                if (state.failNextMachineInsert) {
                  throw new Error('duplicate key value violates unique constraint');
                }
                state.machineInserts.push({ ...payload });
                state.machines.push({ id: state.insertedMachineId, ...payload });
                return [{ id: state.insertedMachineId }];
              }
              return [{ id: 'inserted' }];
            },
          };
        },
      })),
      update: vi.fn((table: unknown) => ({
        set(payload: Record<string, unknown>) {
          if (table === machines) state.machineUpdates.push(payload);
          const failMachines = () => table === machines && state.failMachineUpdates;
          const whereResult = {
            async returning() {
              if (failMachines()) {
                throw new Error('fake db: machines update failed (failMachineUpdates)');
              }
              if (table === machinePairingTokens) return claimToken(payload);
              if (table === machines) return updateMachine(state, payload);
              return [];
            },
            // The gateway awaits some updates without .returning(); make the
            // chain thenable so those awaits resolve (or reject under the
            // failMachineUpdates switch).
            then(resolve: (value: unknown) => unknown, reject?: (err: unknown) => unknown) {
              if (failMachines()) {
                return Promise.reject(
                  new Error('fake db: machines update failed (failMachineUpdates)'),
                ).then(resolve, reject);
              }
              if (table === machines) {
                return Promise.resolve(updateMachine(state, payload)).then(resolve, reject);
              }
              return Promise.resolve(undefined).then(resolve, reject);
            },
          };
          return {
            where() {
              return whereResult;
            },
          };
        },
      })),
      // Run the callback against a tx that shares this same fake state. On a thrown
      // error, roll back the in-memory mutations the transaction made (token claim
      // + machine insert) so "409 leaves the token redeemable" holds.
      async transaction(cb: (tx: Database) => Promise<unknown>) {
        const tokenSnapshot = state.tokens.map((t) => ({ ...t }));
        const machinesLen = state.machines.length;
        const insertsLen = state.machineInserts.length;
        const tokenUpdatesLen = state.tokenUpdates.length;
        try {
          return await cb(makeDb());
        } catch (err) {
          // Restore token rows (un-consume), drop inserted machines, and discard
          // captured token updates — modelling a real ROLLBACK.
          state.tokens.length = 0;
          state.tokens.push(...tokenSnapshot);
          state.machines.length = machinesLen;
          state.machineInserts.length = insertsLen;
          state.tokenUpdates.length = tokenUpdatesLen;
          throw err;
        }
      },
    } as unknown as Database;
  }

  return { db: makeDb(), state };
}

function updateMachine(
  state: FakeGatewayDbState,
  payload: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const hasIdentity =
    typeof payload.tenantKey === 'string' && typeof payload.name === 'string';
  if (!hasIdentity) return [];
  if (state.failNextMachineUpdate) {
    state.failNextMachineUpdate = false;
    return [];
  }
  const row = state.machines.find(
    (machine) =>
      machine.tenantKey === payload.tenantKey &&
      machine.name === payload.name &&
      machine.platformOwnerId === payload.platformOwnerId &&
      machine.ownerOpenId === payload.ownerOpenId &&
      machine.status !== 'revoked',
  );
  if (!row) return [];
  Object.assign(row, payload);
  return [{ id: row.id, ...row }];
}

function rowsForTable(table: unknown, state: FakeGatewayDbState): unknown[] {
  if (table === machinePairingTokens) return state.tokens;
  if (table === machines) return state.machines;
  return [];
}
