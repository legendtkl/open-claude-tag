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
