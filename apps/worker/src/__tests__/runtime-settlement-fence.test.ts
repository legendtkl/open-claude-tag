import type { RuntimeEvent } from '@open-tag/core-types';
import { describe, expect, it, vi } from 'vitest';
import { createAdmissionSlotReleaser } from '../admission-slot-release.js';
import { RuntimeSettlementFence, RuntimeWatchdogSettledError } from '../runtime-settlement-fence.js';

describe('RuntimeSettlementFence', () => {
  it('interrupts a pending runtime stream before a late completed event can win', async () => {
    const fence = new RuntimeSettlementFence();
    const taskId = 'task_1';
    let releaseLateCompleted!: () => void;
    const lateCompletedGate = new Promise<void>((resolve) => {
      releaseLateCompleted = resolve;
    });
    let waitingForLateCompleted!: () => void;
    const pendingAfterSyntheticProgress = new Promise<void>((resolve) => {
      waitingForLateCompleted = resolve;
    });
    let completed = false;

    async function* stream(): AsyncGenerator<RuntimeEvent> {
      yield { type: 'status', message: 'adapter initialized' };
      yield { type: 'progress', percent: 5, message: 'preparing adapter' };
      waitingForLateCompleted();
      await lateCompletedGate;
      yield {
        type: 'completed',
        result: {
          status: 'completed',
          taskId,
          output: { text: 'late success' },
          metrics: {
            durationMs: 1,
            tokenIn: 1,
            tokenOut: 1,
            estimatedCostUsd: 0,
          },
        },
      };
    }

    async function consume(): Promise<'settled' | 'completed'> {
      const iterator = stream()[Symbol.asyncIterator]();
      try {
        while (true) {
          const next = await fence.race(taskId, iterator.next());
          fence.throwIfSettled(taskId);
          if (next.done) break;
          if (next.value.type === 'completed') completed = true;
          fence.throwIfSettled(taskId);
        }
        fence.throwIfSettled(taskId);
        return completed ? 'completed' : 'settled';
      } catch (err) {
        if (err instanceof RuntimeWatchdogSettledError) {
          const returnPromise = iterator.return?.(undefined);
          if (returnPromise) void returnPromise.catch(() => {});
          return 'settled';
        }
        throw err;
      }
    }

    const consumed = consume();
    await pendingAfterSyntheticProgress;

    fence.settle(taskId, 'watchdog failed before runtime child attached');
    await expect(consumed).resolves.toBe('settled');

    releaseLateCompleted();
    await Promise.resolve();
    expect(completed).toBe(false);
  });

  it('wakes a hung runtime stream when watchdog settlement fires', async () => {
    const fence = new RuntimeSettlementFence();
    const taskId = 'task_1';
    const never = new Promise<IteratorResult<RuntimeEvent>>(() => {});

    const interrupted = fence.race(taskId, never);
    fence.settle(taskId, 'watchdog failed');

    await expect(interrupted).rejects.toThrow(RuntimeWatchdogSettledError);
  });
});

describe('createAdmissionSlotReleaser', () => {
  it('releases start and running slots exactly once across watchdog and finally paths', () => {
    const handle = {
      taskId: 'task_1',
      agentId: 'agent_1',
      releaseStartSlot: vi.fn(),
      releaseRunningSlot: vi.fn(),
    };
    const releaser = createAdmissionSlotReleaser(() => handle);

    releaser.releaseAll();
    releaser.releaseStartSlot();
    releaser.releaseRunningSlot();
    releaser.releaseAll();

    expect(handle.releaseStartSlot).toHaveBeenCalledTimes(1);
    expect(handle.releaseRunningSlot).toHaveBeenCalledTimes(1);
  });
});
