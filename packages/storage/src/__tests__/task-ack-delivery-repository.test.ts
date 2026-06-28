import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../db.js';
import {
  getTaskAckDelivery,
  setTaskAckDelivery,
  type TaskAckDelivery,
} from '../task-ack-delivery-repository.js';

const ack: TaskAckDelivery = { kind: 'slack', scopeId: 'C_chat', messageId: 'ack_ts' };

/** Stub the drizzle `update().set().where()` chain, capturing the `set` payload. */
function makeUpdateStub() {
  const captured = { set: undefined as unknown };
  const chain = {
    set: (values: unknown) => {
      captured.set = values;
      return chain;
    },
    where: async () => undefined,
  };
  const update = vi.fn(() => chain);
  return { db: { update } as unknown as Database, update, captured };
}

/** Stub the drizzle `select().from().where().limit()` chain. */
function makeSelectStub(limitResult: unknown[]) {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: async () => limitResult,
  };
  return { db: { select: vi.fn(() => chain) } as unknown as Database };
}

describe('setTaskAckDelivery', () => {
  it('issues a jsonb shallow-merge update of the ack handle on the task row', async () => {
    const { db, update, captured } = makeUpdateStub();
    await setTaskAckDelivery(db, 'task-1', ack);
    expect(update).toHaveBeenCalledTimes(1);
    // The merge writes the constraints column via a sql fragment (not a literal),
    // so we assert it set `constraints` rather than re-deriving the SQL text.
    expect(captured.set).toHaveProperty('constraints');
  });
});

describe('getTaskAckDelivery', () => {
  it('returns the persisted ack handle from constraints.ackDelivery', async () => {
    const { db } = makeSelectStub([{ constraints: { timeoutSec: 1800, ackDelivery: ack } }]);
    await expect(getTaskAckDelivery(db, 'task-1')).resolves.toEqual(ack);
  });

  it('returns null when the task row has no ackDelivery key', async () => {
    const { db } = makeSelectStub([{ constraints: { timeoutSec: 1800 } }]);
    await expect(getTaskAckDelivery(db, 'task-1')).resolves.toBeNull();
  });

  it('returns null when constraints is null', async () => {
    const { db } = makeSelectStub([{ constraints: null }]);
    await expect(getTaskAckDelivery(db, 'task-1')).resolves.toBeNull();
  });

  it('returns null when no task row exists', async () => {
    const { db } = makeSelectStub([]);
    await expect(getTaskAckDelivery(db, 'task-1')).resolves.toBeNull();
  });
});
