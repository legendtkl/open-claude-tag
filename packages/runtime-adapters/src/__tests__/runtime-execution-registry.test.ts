import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';
import { RuntimeExecutionRegistry } from '../runtime-execution-registry.js';

class FakeChildProcess extends EventEmitter {
  pid = 12345;
  killed = false;
  exitCode: number | null = null;
  signals: NodeJS.Signals[] = [];

  kill(signal?: NodeJS.Signals): boolean {
    this.signals.push(signal ?? 'SIGTERM');
    if (signal === 'SIGKILL') {
      this.killed = true;
      this.exitCode = 1;
      this.emit('exit', null, signal);
      this.emit('close', null, signal);
    }
    return true;
  }
}

function createRegistry() {
  return new RuntimeExecutionRegistry({
    runtimeName: 'test',
    sigtermGraceMs: 10,
    sigkillGraceMs: 10,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
    },
  });
}

describe('RuntimeExecutionRegistry', () => {
  it('keeps SIGKILL escalation alive when complete() races a signalled-but-running child', async () => {
    // child.killed only means a signal was SENT. A child that ignores SIGTERM
    // must still get the scheduled SIGKILL even if the adapter calls
    // complete() (e.g. its generator settled) before the process exits.
    vi.useFakeTimers();
    const processKill = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
      child.signals.push(signal as NodeJS.Signals);
      if (signal === 'SIGKILL') {
        child.exitCode = 1;
        child.emit('exit', null, signal);
        child.emit('close', null, signal);
      } else {
        // SIGTERM was sent (and ignored) — Node marks killed=true regardless.
        child.killed = true;
      }
      return true;
    });
    const registry = createRegistry();
    const controller = new AbortController();
    const child = new FakeChildProcess();

    registry.start('task_kill_race', controller);
    registry.attachChild('task_kill_race', child as never);

    await registry.cancel('task_kill_race', { force: true }); // SIGTERM now, SIGKILL scheduled
    expect(child.signals).toContain('SIGTERM');
    expect(child.killed).toBe(true);
    expect(child.exitCode).toBeNull();

    // Adapter settles its generator and completes — must NOT clear escalation.
    registry.complete('task_kill_race');

    await vi.advanceTimersByTimeAsync(20);
    expect(child.signals).toContain('SIGKILL');
    expect(child.exitCode).toBe(1);

    processKill.mockRestore();
    vi.useRealTimers();
  });

  it('returns no_active_execution for unknown executions', async () => {
    await expect(createRegistry().cancel('missing')).resolves.toBe('no_active_execution');
  });

  it('returns no_active_execution for controller-only executions without a child', async () => {
    const registry = createRegistry();
    const controller = new AbortController();
    registry.start('task_1', controller);

    await expect(registry.cancel('task_1')).resolves.toBe('no_active_execution');
    expect(controller.signal.aborted).toBe(true);
  });

  it('aborts active execution and escalates to OS signals when the child ignores abort', async () => {
    vi.useFakeTimers();
    const processKill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      expect(pid).toBe(-12345);
      child.kill(signal as NodeJS.Signals);
      return true;
    });
    const registry = createRegistry();
    const controller = new AbortController();
    const child = new FakeChildProcess();

    registry.start('task_1', controller);
    registry.attachChild('task_1', child as any);

    await expect(registry.cancel('task_1')).resolves.toBe('termination_started');
    expect(controller.signal.aborted).toBe(true);
    expect(child.signals).toEqual([]);

    await vi.advanceTimersByTimeAsync(10);
    expect(child.signals).toEqual(['SIGTERM']);
    expect(registry.hasActive('task_1')).toBe(true);

    await vi.advanceTimersByTimeAsync(10);
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(registry.hasActive('task_1')).toBe(false);

    processKill.mockRestore();
    vi.useRealTimers();
  });

  it('force cancel sends SIGTERM without waiting for cooperative grace', async () => {
    vi.useFakeTimers();
    const processKill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      expect(pid).toBe(-12345);
      child.kill(signal as NodeJS.Signals);
      return true;
    });
    const registry = createRegistry();
    const controller = new AbortController();
    const child = new FakeChildProcess();

    registry.start('task_1', controller);
    registry.attachChild('task_1', child as any);

    await expect(registry.cancel('task_1', { force: true })).resolves.toBe('terminated');
    await vi.advanceTimersByTimeAsync(0);

    expect(controller.signal.aborted).toBe(true);
    expect(child.signals).toContain('SIGTERM');

    processKill.mockRestore();
    vi.useRealTimers();
  });
});
