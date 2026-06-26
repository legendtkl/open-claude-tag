import type { ReadyDelegationBarrier } from '@open-tag/storage';
import type { DelegationBarrierWakeDeliveryResult } from './delegation-barrier-wake.js';

export interface DelegationBarrierReconcilerLogger {
  info(meta: Record<string, unknown>, message: string): void;
  warn(meta: Record<string, unknown>, message: string): void;
}

export interface DelegationBarrierReconcilerDeps {
  reconcileTerminalChildEdges(input: { limit: number }): Promise<{
    inspected: number;
    reconciled: number;
  }>;
  listReadyBarriers(input: { limit: number }): Promise<ReadyDelegationBarrier[]>;
  deliverWake(childTaskId: string): Promise<DelegationBarrierWakeDeliveryResult>;
  logger: DelegationBarrierReconcilerLogger;
  batchSize: number;
}

export async function runDelegationBarrierReconcilerOnce(
  deps: DelegationBarrierReconcilerDeps,
): Promise<{ inspected: number; delivered: number; failed: number }> {
  const edgeResult = await deps.reconcileTerminalChildEdges({ limit: deps.batchSize });
  if (edgeResult.inspected > 0) {
    deps.logger.info(edgeResult, 'Reconciled terminal delegated child task edges');
  }

  const barriers = await deps.listReadyBarriers({ limit: deps.batchSize });
  let delivered = 0;
  let failed = 0;

  for (const barrier of barriers) {
    try {
      const result = await deps.deliverWake(barrier.childTaskId);
      delivered += 1;
      deps.logger.info(
        {
          treeId: barrier.treeId,
          parentTaskId: barrier.parentTaskId,
          childTaskId: barrier.childTaskId,
          result,
        },
        'Reconciled delegation barrier',
      );
    } catch (err) {
      failed += 1;
      deps.logger.warn(
        {
          err,
          treeId: barrier.treeId,
          parentTaskId: barrier.parentTaskId,
          childTaskId: barrier.childTaskId,
        },
        'Delegation barrier reconciliation failed; will retry on next sweep',
      );
    }
  }

  return { inspected: barriers.length, delivered, failed };
}
