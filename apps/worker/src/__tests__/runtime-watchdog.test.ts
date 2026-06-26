import { describe, expect, it, vi } from 'vitest';
import { RuntimeWatchdog } from '../runtime-watchdog.js';

function createWatchdog(nowRef: { now: number }) {
  const cancelExecution = vi.fn().mockResolvedValue('terminated');
  const failExecution = vi.fn().mockResolvedValue(undefined);
  const watchdog = new RuntimeWatchdog({
    startupTimeoutMs: 100,
    stalledTimeoutMs: 200,
    stalledRecoverySigtermTimeoutMs: 50,
    errorBackoffMs: 50,
    now: () => nowRef.now,
    cancelExecution,
    failExecution,
    logger: {
      warn: vi.fn(),
      error: vi.fn(),
    },
  });

  return { watchdog, cancelExecution, failExecution };
}

describe('RuntimeWatchdog', () => {
  it('cancels an execution that produces no startup event before timeout', async () => {
    const nowRef = { now: 0 };
    const { watchdog, cancelExecution } = createWatchdog(nowRef);
    watchdog.register({ taskId: 'task_1', sessionId: 'session_1' });

    nowRef.now = 100;
    const result = await watchdog.scan();

    expect(result).toEqual({ inspected: 1, cancelled: 1, failed: 0 });
    expect(cancelExecution).toHaveBeenCalledWith('task_1', 'watchdog', { force: false });
    expect(watchdog.snapshot()[0]?.cancelReason).toBe('startup_timeout');
  });

  it('cancels a runtime that stalls after progress starts', async () => {
    const nowRef = { now: 0 };
    const { watchdog, cancelExecution } = createWatchdog(nowRef);
    watchdog.register({ taskId: 'task_1', sessionId: 'session_1' });
    watchdog.markRuntimeStarted('task_1');

    nowRef.now = 199;
    expect(await watchdog.scan()).toEqual({ inspected: 1, cancelled: 0, failed: 0 });

    nowRef.now = 200;
    expect(await watchdog.scan()).toEqual({ inspected: 1, cancelled: 1, failed: 0 });
    expect(cancelExecution).toHaveBeenCalledWith('task_1', 'watchdog', { force: false });
    expect(watchdog.snapshot()[0]?.cancelReason).toBe('progress_stalled');
  });

  it('latches cancellation when a child-backed termination path starts', async () => {
    const nowRef = { now: 0 };
    const { watchdog, cancelExecution } = createWatchdog(nowRef);
    cancelExecution.mockResolvedValue('termination_started');
    watchdog.register({ taskId: 'task_1', sessionId: 'session_1' });
    watchdog.markRuntimeStarted('task_1');

    nowRef.now = 200;
    await watchdog.scan();

    expect(watchdog.snapshot()[0]?.cancelRequested).toBe(true);
    expect(watchdog.snapshot()[0]?.forceCancelRequested).toBe(false);
  });

  it('does not cancel the same task repeatedly before it unregisters', async () => {
    const nowRef = { now: 0 };
    const { watchdog, cancelExecution } = createWatchdog(nowRef);
    watchdog.register({ taskId: 'task_1', sessionId: 'session_1' });

    nowRef.now = 100;
    await watchdog.scan();
    await watchdog.scan();

    expect(cancelExecution).toHaveBeenCalledTimes(1);
  });

  it('settles no-process active runtime stalls as failed without latching cancel', async () => {
    const nowRef = { now: 0 };
    const { watchdog, cancelExecution, failExecution } = createWatchdog(nowRef);
    cancelExecution.mockResolvedValue('no_active_execution');
    watchdog.register({ taskId: 'task_1', sessionId: 'session_1' });
    watchdog.markRuntimeStarted('task_1');

    nowRef.now = 200;
    const result = await watchdog.scan();

    expect(result).toEqual({ inspected: 0, cancelled: 0, failed: 1 });
    expect(cancelExecution).toHaveBeenCalledTimes(1);
    expect(failExecution).toHaveBeenCalledWith('task_1', 'watchdog', 'progress_stalled');
    expect(watchdog.snapshot()).toEqual([]);
  });

  it('does not treat synthetic progress as runtime start before startup timeout', async () => {
    const nowRef = { now: 0 };
    const { watchdog, cancelExecution, failExecution } = createWatchdog(nowRef);
    cancelExecution.mockResolvedValue('no_active_execution');
    watchdog.register({ taskId: 'task_1', sessionId: 'session_1' });
    watchdog.markProgress('task_1');

    nowRef.now = 100;
    const result = await watchdog.scan();

    expect(result).toEqual({ inspected: 0, cancelled: 0, failed: 1 });
    expect(failExecution).toHaveBeenCalledWith('task_1', 'watchdog', 'startup_timeout');
    expect(watchdog.snapshot()).toEqual([]);
  });

  it('directly fails startup timeout when no runtime execution is active', async () => {
    const nowRef = { now: 0 };
    const { watchdog, cancelExecution, failExecution } = createWatchdog(nowRef);
    cancelExecution.mockResolvedValue('no_active_execution');
    watchdog.register({ taskId: 'task_1', sessionId: 'session_1' });

    nowRef.now = 100;
    const result = await watchdog.scan();

    expect(result).toEqual({ inspected: 0, cancelled: 0, failed: 1 });
    expect(failExecution).toHaveBeenCalledWith('task_1', 'watchdog', 'startup_timeout');
    expect(watchdog.snapshot()).toEqual([]);
  });

  it('force cancels when recovery timeout elapses after initial cancel', async () => {
    const nowRef = { now: 0 };
    const { watchdog, cancelExecution } = createWatchdog(nowRef);
    watchdog.register({ taskId: 'task_1', sessionId: 'session_1' });
    watchdog.markRuntimeStarted('task_1');

    nowRef.now = 200;
    await watchdog.scan();

    nowRef.now = 249;
    await watchdog.scan();
    expect(cancelExecution).toHaveBeenCalledTimes(1);

    nowRef.now = 250;
    await watchdog.scan();
    expect(cancelExecution).toHaveBeenLastCalledWith('task_1', 'watchdog', { force: true });
    expect(watchdog.snapshot()[0]?.forceCancelRequested).toBe(true);
  });

  it('backs off and retries when cancel fails', async () => {
    const nowRef = { now: 0 };
    const cancelExecution = vi
      .fn()
      .mockRejectedValueOnce(new Error('cancel failed'))
      .mockResolvedValueOnce('terminated');
    const watchdog = new RuntimeWatchdog({
      startupTimeoutMs: 100,
      stalledTimeoutMs: 200,
      stalledRecoverySigtermTimeoutMs: 50,
      errorBackoffMs: 50,
      now: () => nowRef.now,
      cancelExecution,
      failExecution: vi.fn(),
      logger: {
        warn: vi.fn(),
        error: vi.fn(),
      },
    });
    watchdog.register({ taskId: 'task_1', sessionId: 'session_1' });

    nowRef.now = 100;
    await watchdog.scan();
    expect(cancelExecution).toHaveBeenCalledTimes(1);
    expect(watchdog.snapshot()[0]?.nextCancelAttemptAt).toBe(150);

    nowRef.now = 149;
    await watchdog.scan();
    expect(cancelExecution).toHaveBeenCalledTimes(1);

    nowRef.now = 150;
    await watchdog.scan();
    expect(cancelExecution).toHaveBeenCalledTimes(2);
    expect(watchdog.snapshot()[0]?.cancelRequested).toBe(true);
  });

  it('clears active execution state on unregister', () => {
    const nowRef = { now: 0 };
    const { watchdog } = createWatchdog(nowRef);
    watchdog.register({ taskId: 'task_1', sessionId: 'session_1' });

    watchdog.unregister('task_1');

    expect(watchdog.snapshot()).toEqual([]);
  });

  it('scan resolves and keeps the execution registered when failExecution rejects', async () => {
    // The worker invokes scan() fire-and-forget under fatal process handlers:
    // a rejected scan would kill the whole worker. A failed terminal write must
    // be retried on the next scan, not crash or orphan the execution.
    const nowRef = { now: 0 };
    const { watchdog, cancelExecution, failExecution } = createWatchdog(nowRef);
    cancelExecution.mockResolvedValue('no_active_execution');
    failExecution.mockRejectedValueOnce(new Error('db down'));
    watchdog.register({ taskId: 'task_1', sessionId: 'session_1' });
    watchdog.markRuntimeStarted('task_1');

    nowRef.now = 200;
    await expect(watchdog.scan()).resolves.toBeDefined();
    expect(watchdog.snapshot()).toHaveLength(1);
    expect(failExecution).toHaveBeenCalledTimes(1);

    failExecution.mockResolvedValue(undefined);
    nowRef.now = 400;
    await watchdog.scan();
    expect(failExecution).toHaveBeenCalledTimes(2);
    expect(watchdog.snapshot()).toHaveLength(0);
  });
});
