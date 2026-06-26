import type { ChildProcess } from 'child_process';
import type { RuntimeCancelOptions, RuntimeCancelOutcome } from './types.js';

export interface RuntimeExecutionRegistryLogger {
  info(meta: Record<string, unknown>, message: string): void;
  warn(meta: Record<string, unknown>, message: string): void;
}

export interface RuntimeExecutionRegistryOptions {
  runtimeName: string;
  sigtermGraceMs?: number;
  sigkillGraceMs?: number;
  logger: RuntimeExecutionRegistryLogger;
}

interface ActiveRuntimeExecution {
  executionId: string;
  abortController: AbortController;
  child?: ChildProcess;
  cancelling: boolean;
  done: boolean;
  sigtermTimer?: ReturnType<typeof setTimeout>;
  sigkillTimer?: ReturnType<typeof setTimeout>;
}

const DEFAULT_SIGTERM_GRACE_MS = 10_000;
const DEFAULT_SIGKILL_GRACE_MS = 10_000;

export class RuntimeExecutionRegistry {
  private readonly active = new Map<string, ActiveRuntimeExecution>();
  private readonly recentlyDone = new Set<string>();
  private readonly sigtermGraceMs: number;
  private readonly sigkillGraceMs: number;

  constructor(private readonly options: RuntimeExecutionRegistryOptions) {
    this.sigtermGraceMs = options.sigtermGraceMs ?? DEFAULT_SIGTERM_GRACE_MS;
    this.sigkillGraceMs = options.sigkillGraceMs ?? DEFAULT_SIGKILL_GRACE_MS;
  }

  start(executionId: string, abortController: AbortController): void {
    this.clear(executionId);
    this.recentlyDone.delete(executionId);
    this.active.set(executionId, {
      executionId,
      abortController,
      cancelling: false,
      done: false,
    });
  }

  attachChild(executionId: string, child: ChildProcess): void {
    const execution = this.active.get(executionId);
    if (!execution) return;
    execution.child = child;
    const markDone = () => {
      this.markDone(executionId);
    };
    child.once('exit', markDone);
    child.once('close', markDone);
  }

  async cancel(
    executionId: string,
    options: RuntimeCancelOptions = {},
  ): Promise<RuntimeCancelOutcome> {
    const execution = this.active.get(executionId);
    if (!execution) {
      return this.recentlyDone.has(executionId) ? 'already_done' : 'no_active_execution';
    }
    if (execution.done) {
      return 'already_done';
    }
    if (execution.cancelling && !options.force) {
      return 'already_done';
    }

    execution.cancelling = true;
    if (!execution.abortController.signal.aborted) {
      execution.abortController.abort();
    }

    if (!execution.child || execution.done) {
      return 'no_active_execution';
    }

    if (options.force) {
      this.sendSignal(execution, 'SIGTERM');
      this.scheduleSigkill(execution, 0);
      return 'terminated';
    } else {
      this.scheduleSigterm(execution);
      return 'termination_started';
    }
  }

  cancelAll(): void {
    for (const executionId of Array.from(this.active.keys())) {
      void this.cancel(executionId, { force: true }).catch(() => {});
    }
  }

  complete(executionId: string): void {
    const execution = this.active.get(executionId);
    if (execution?.cancelling && execution.child && !this.isChildExited(execution.child)) {
      return;
    }
    this.markDone(executionId);
  }

  hasActive(executionId: string): boolean {
    return this.active.has(executionId);
  }

  private scheduleSigterm(execution: ActiveRuntimeExecution): void {
    if (execution.sigtermTimer) return;
    execution.sigtermTimer = setTimeout(() => {
      this.sendSignal(execution, 'SIGTERM');
      this.scheduleSigkill(execution, this.sigkillGraceMs);
    }, this.sigtermGraceMs);
    execution.sigtermTimer.unref?.();
  }

  private scheduleSigkill(execution: ActiveRuntimeExecution, delayMs: number): void {
    if (execution.sigkillTimer) return;
    execution.sigkillTimer = setTimeout(() => {
      this.sendSignal(execution, 'SIGKILL');
    }, delayMs);
    execution.sigkillTimer.unref?.();
  }

  private sendSignal(execution: ActiveRuntimeExecution, signal: NodeJS.Signals): void {
    const child = execution.child;
    if (!child || execution.done || this.isChildExited(child)) return;
    try {
      if (process.platform !== 'win32' && child.pid) {
        process.kill(-child.pid, signal);
      } else {
        child.kill(signal);
      }
      this.options.logger.warn(
        {
          runtime: this.options.runtimeName,
          executionId: execution.executionId,
          pid: child.pid,
          signal,
        },
        'Runtime execution sent OS termination signal',
      );
    } catch (err) {
      this.options.logger.warn(
        {
          err,
          runtime: this.options.runtimeName,
          executionId: execution.executionId,
          pid: child.pid,
          signal,
        },
        'Runtime execution signal failed',
      );
    }
  }

  private markDone(executionId: string): void {
    const execution = this.active.get(executionId);
    if (!execution) return;
    execution.done = true;
    this.clearTimers(execution);
    this.active.delete(executionId);
    this.recentlyDone.add(executionId);
    setTimeout(() => {
      this.recentlyDone.delete(executionId);
    }, 60_000).unref?.();
  }

  private clear(executionId: string): void {
    const existing = this.active.get(executionId);
    if (!existing) return;
    this.clearTimers(existing);
    this.active.delete(executionId);
  }

  private clearTimers(execution: ActiveRuntimeExecution): void {
    if (execution.sigtermTimer) clearTimeout(execution.sigtermTimer);
    if (execution.sigkillTimer) clearTimeout(execution.sigkillTimer);
    execution.sigtermTimer = undefined;
    execution.sigkillTimer = undefined;
  }

  private isChildExited(child: ChildProcess): boolean {
    // `child.killed` only means a signal was SENT — the process may ignore
    // SIGTERM and keep running. Treating it as exited let complete() clear
    // the SIGKILL escalation timers while the process was still alive.
    return child.exitCode !== null || (child.signalCode ?? null) !== null;
  }
}
