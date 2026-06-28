import { describe, it, expect, vi } from 'vitest';
import { TaskStatus } from '@open-tag/core-types';
import type { Database } from '@open-tag/storage';
import { transitionTask } from '../orchestrator.js';

interface DbMockHandles {
  db: Database;
  selectMock: ReturnType<typeof vi.fn>;
  updateMock: ReturnType<typeof vi.fn>;
  setCalls: Array<Record<string, unknown>>;
}

function createDbMock(
  selectResults: Array<Array<{ status: string }>>,
  updateResults: Array<Array<{ id: string }>>,
): DbMockHandles {
  let selectCall = 0;
  let updateCall = 0;
  const setCalls: Array<Record<string, unknown>> = [];

  const selectMock = vi.fn(() => ({
    from: () => ({
      where: () => ({
        limit: async () => selectResults[Math.min(selectCall++, selectResults.length - 1)],
      }),
    }),
  }));
  const updateMock = vi.fn(() => ({
    set: (data: Record<string, unknown>) => {
      setCalls.push(data);
      return {
        where: () => ({
          returning: async () => updateResults[Math.min(updateCall++, updateResults.length - 1)],
        }),
      };
    },
  }));

  return {
    db: { select: selectMock, update: updateMock } as unknown as Database,
    selectMock,
    updateMock,
    setCalls,
  };
}

describe('transitionTask compare-and-swap', () => {
  it('transitions when the observed status is still current', async () => {
    const { db, selectMock, updateMock, setCalls } = createDbMock(
      [[{ status: TaskStatus.RUNNING }]],
      [[{ id: 'task_1' }]],
    );

    await transitionTask(db, 'task_1', TaskStatus.COMPLETED, { result: { ok: true } });

    expect(selectMock).toHaveBeenCalledTimes(1);
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(setCalls[0]).toMatchObject({ status: TaskStatus.COMPLETED, result: { ok: true } });
  });

  it('retries once when a concurrent transition invalidates the CAS, then succeeds', async () => {
    const { db, selectMock, updateMock } = createDbMock(
      [[{ status: TaskStatus.RUNNING }], [{ status: TaskStatus.RUNNING }]],
      [[], [{ id: 'task_1' }]],
    );

    await transitionTask(db, 'task_1', TaskStatus.FAILED, { errorMessage: 'boom' });

    expect(selectMock).toHaveBeenCalledTimes(2);
    expect(updateMock).toHaveBeenCalledTimes(2);
  });

  it('rejects when a concurrent transition moved the task to a terminal state', async () => {
    // Worker tries to complete while the user cancelled in between: the CAS
    // no-ops, the re-read sees CANCELLED, and the transition must fail instead
    // of overwriting the terminal state.
    const { db, updateMock } = createDbMock(
      [[{ status: TaskStatus.RUNNING }], [{ status: TaskStatus.CANCELLED }]],
      [[]],
    );

    await expect(transitionTask(db, 'task_1', TaskStatus.COMPLETED)).rejects.toThrow(
      /Invalid task state transition: cancelled → completed/,
    );
    expect(updateMock).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid transitions without issuing an update', async () => {
    const { db, updateMock } = createDbMock([[{ status: TaskStatus.COMPLETED }]], [[]]);

    await expect(transitionTask(db, 'task_1', TaskStatus.RUNNING)).rejects.toThrow(
      /Invalid task state transition/,
    );
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('rejects when the task does not exist', async () => {
    const { db } = createDbMock([[]], [[]]);

    await expect(transitionTask(db, 'task_missing', TaskStatus.RUNNING)).rejects.toThrow(
      /Task not found/,
    );
  });

  it('gives up after persistent CAS contention', async () => {
    const { db, updateMock } = createDbMock([[{ status: TaskStatus.RUNNING }]], [[]]);

    await expect(transitionTask(db, 'task_1', TaskStatus.COMPLETED)).rejects.toThrow(
      /transition contention/,
    );
    expect(updateMock).toHaveBeenCalledTimes(3);
  });
});

describe('transitionTask falsy result/errorMessage (issue #11)', () => {
  it('persists an empty-string errorMessage', async () => {
    const { db, setCalls } = createDbMock([[{ status: TaskStatus.RUNNING }]], [[{ id: 't' }]]);
    await transitionTask(db, 't', TaskStatus.FAILED, { errorMessage: '' });
    expect('errorMessage' in setCalls[0]).toBe(true);
    expect(setCalls[0].errorMessage).toBe('');
  });

  it('persists a null result (clearing a prior value)', async () => {
    const { db, setCalls } = createDbMock([[{ status: TaskStatus.RUNNING }]], [[{ id: 't' }]]);
    await transitionTask(db, 't', TaskStatus.CANCELLED, { result: null });
    expect('result' in setCalls[0]).toBe(true);
    expect(setCalls[0].result).toBeNull();
  });

  it('persists falsy result values (false and 0)', async () => {
    const m1 = createDbMock([[{ status: TaskStatus.RUNNING }]], [[{ id: 't' }]]);
    await transitionTask(m1.db, 't', TaskStatus.COMPLETED, { result: false });
    expect(m1.setCalls[0].result).toBe(false);

    const m2 = createDbMock([[{ status: TaskStatus.RUNNING }]], [[{ id: 't' }]]);
    await transitionTask(m2.db, 't', TaskStatus.COMPLETED, { result: 0 });
    expect(m2.setCalls[0].result).toBe(0);
  });

  it('clears a prior errorMessage when explicitly passed null', async () => {
    const { db, setCalls } = createDbMock([[{ status: TaskStatus.FAILED }]], [[{ id: 't' }]]);
    await transitionTask(db, 't', TaskStatus.PENDING, { errorMessage: null });
    expect('errorMessage' in setCalls[0]).toBe(true);
    expect(setCalls[0].errorMessage).toBeNull();
  });

  it('does not write result/errorMessage when the caller omits them', async () => {
    const { db, setCalls } = createDbMock([[{ status: TaskStatus.FAILED }]], [[{ id: 't' }]]);
    await transitionTask(db, 't', TaskStatus.PENDING, {});
    expect('result' in setCalls[0]).toBe(false);
    expect('errorMessage' in setCalls[0]).toBe(false);
  });
});
