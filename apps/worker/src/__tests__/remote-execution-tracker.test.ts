import { describe, expect, it, vi } from 'vitest';
import { RemoteExecutionTracker } from '../remote-execution-tracker.js';

function makeCancelable(outcome = 'termination_started' as const) {
  return { cancel: vi.fn().mockResolvedValue(outcome) };
}

describe('RemoteExecutionTracker', () => {
  it('routes cancel to the registered adapter and returns its outcome', async () => {
    const tracker = new RemoteExecutionTracker();
    const adapter = makeCancelable();
    tracker.register('task-1', adapter);

    await expect(tracker.cancel('task-1', { force: true })).resolves.toBe('termination_started');
    expect(adapter.cancel).toHaveBeenCalledWith('task-1', { force: true });
  });

  it('returns null for untracked executions so callers fall back to the local manager', async () => {
    const tracker = new RemoteExecutionTracker();
    await expect(tracker.cancel('task-unknown')).resolves.toBeNull();
  });

  it('unregister removes the execution', async () => {
    const tracker = new RemoteExecutionTracker();
    const adapter = makeCancelable();
    tracker.register('task-1', adapter);
    tracker.unregister('task-1');

    expect(tracker.has('task-1')).toBe(false);
    await expect(tracker.cancel('task-1')).resolves.toBeNull();
    expect(adapter.cancel).not.toHaveBeenCalled();
  });

  it('cancelAll force-cancels every tracked execution and swallows errors', async () => {
    const tracker = new RemoteExecutionTracker();
    const ok = makeCancelable();
    const failing = { cancel: vi.fn().mockRejectedValue(new Error('socket gone')) };
    tracker.register('task-ok', ok);
    tracker.register('task-bad', failing);

    tracker.cancelAll();
    await new Promise((resolve) => setImmediate(resolve));

    expect(ok.cancel).toHaveBeenCalledWith('task-ok', { force: true });
    expect(failing.cancel).toHaveBeenCalledWith('task-bad', { force: true });
  });
});
