import { describe, expect, it, vi } from 'vitest';
import { runDelegationBarrierReconcilerOnce } from '../delegation-barrier-reconciler.js';

function makeDeps(overrides: {
  deliverWake?: (childTaskId: string) => Promise<'enqueued'>;
} = {}) {
  return {
    reconcileTerminalChildEdges: vi.fn().mockResolvedValue({ inspected: 0, reconciled: 0 }),
    listReadyBarriers: vi.fn().mockResolvedValue([
      {
        treeId: 'tree_1',
        parentTaskId: 'parent_task',
        childTaskId: 'child_task',
      },
    ]),
    deliverWake: vi.fn(overrides.deliverWake ?? (async () => 'enqueued' as const)),
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
    },
    batchSize: 25,
  };
}

describe('runDelegationBarrierReconcilerOnce', () => {
  it('replays a ready delegation barrier through the normal wake path', async () => {
    const deps = makeDeps();

    const result = await runDelegationBarrierReconcilerOnce(deps);

    expect(result).toEqual({ inspected: 1, delivered: 1, failed: 0 });
    expect(deps.reconcileTerminalChildEdges).toHaveBeenCalledWith({ limit: 25 });
    expect(deps.listReadyBarriers).toHaveBeenCalledWith({ limit: 25 });
    expect(deps.deliverWake).toHaveBeenCalledTimes(1);
    expect(deps.deliverWake).toHaveBeenCalledWith('child_task');
  });

  it('leaves failed barrier delivery for the next sweep', async () => {
    const deps = makeDeps({
      deliverWake: async () => {
        throw new Error('transient barrier failure');
      },
    });

    const first = await runDelegationBarrierReconcilerOnce(deps);
    deps.deliverWake.mockImplementationOnce(async () => 'enqueued');
    const second = await runDelegationBarrierReconcilerOnce(deps);

    expect(first).toEqual({ inspected: 1, delivered: 0, failed: 1 });
    expect(second).toEqual({ inspected: 1, delivered: 1, failed: 0 });
    expect(deps.deliverWake).toHaveBeenCalledTimes(2);
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        parentTaskId: 'parent_task',
        childTaskId: 'child_task',
      }),
      'Delegation barrier reconciliation failed; will retry on next sweep',
    );
  });

  it('repairs terminal child delegation edges before scanning ready barriers', async () => {
    const deps = makeDeps();
    deps.reconcileTerminalChildEdges.mockResolvedValueOnce({ inspected: 1, reconciled: 1 });

    await runDelegationBarrierReconcilerOnce(deps);

    expect(deps.reconcileTerminalChildEdges.mock.invocationCallOrder[0]).toBeLessThan(
      deps.listReadyBarriers.mock.invocationCallOrder[0],
    );
    expect(deps.logger.info).toHaveBeenCalledWith(
      { inspected: 1, reconciled: 1 },
      'Reconciled terminal delegated child task edges',
    );
  });
});
