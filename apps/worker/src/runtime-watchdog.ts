import type { RuntimeCancelOptions, RuntimeCancelOutcome } from '@open-tag/runtime-adapters';

export interface RuntimeWatchdogLogger {
  warn(meta: Record<string, unknown>, message: string): void;
  error(meta: Record<string, unknown>, message: string): void;
}

export interface RuntimeWatchdogOptions {
  startupTimeoutMs: number;
  stalledTimeoutMs: number;
  stalledRecoverySigtermTimeoutMs: number;
  errorBackoffMs: number;
  now?: () => number;
  cancelExecution(
    executionId: string,
    source: 'watchdog',
    options?: RuntimeCancelOptions,
  ): Promise<RuntimeCancelOutcome>;
  failExecution(
    executionId: string,
    source: 'watchdog',
    reason: 'startup_timeout' | 'progress_stalled',
  ): Promise<void>;
  logger: RuntimeWatchdogLogger;
}

export interface RuntimeWatchdogRegistration {
  taskId: string;
  sessionId: string;
  startedAt?: number;
}

interface ActiveRuntimeExecution {
  taskId: string;
  sessionId: string;
  startedAt: number;
  lastProgressAt: number;
  runtimeStarted: boolean;
  cancelRequested: boolean;
  cancelRequestedAt?: number;
  forceCancelRequested: boolean;
  cancelReason?: 'startup_timeout' | 'progress_stalled';
  nextCancelAttemptAt?: number;
}

export interface RuntimeWatchdogSnapshot {
  taskId: string;
  sessionId: string;
  startedAt: number;
  lastProgressAt: number;
  runtimeStarted: boolean;
  cancelRequested: boolean;
  cancelRequestedAt?: number;
  forceCancelRequested: boolean;
  cancelReason?: 'startup_timeout' | 'progress_stalled';
  nextCancelAttemptAt?: number;
}

export class RuntimeWatchdog {
  private readonly active = new Map<string, ActiveRuntimeExecution>();
  private readonly now: () => number;

  constructor(private readonly options: RuntimeWatchdogOptions) {
    this.now = options.now ?? Date.now;
  }

  register(input: RuntimeWatchdogRegistration): void {
    const startedAt = input.startedAt ?? this.now();
    this.active.set(input.taskId, {
      taskId: input.taskId,
      sessionId: input.sessionId,
      startedAt,
      lastProgressAt: startedAt,
      runtimeStarted: false,
      cancelRequested: false,
      forceCancelRequested: false,
    });
  }

  markRuntimeStarted(taskId: string): void {
    const execution = this.active.get(taskId);
    if (!execution) return;
    execution.runtimeStarted = true;
    execution.lastProgressAt = this.now();
  }

  markProgress(taskId: string): void {
    const execution = this.active.get(taskId);
    if (!execution) return;
    execution.lastProgressAt = this.now();
  }

  unregister(taskId: string): void {
    this.active.delete(taskId);
  }

  snapshot(): RuntimeWatchdogSnapshot[] {
    return Array.from(this.active.values()).map((execution) => ({ ...execution }));
  }

  async scan(): Promise<{ inspected: number; cancelled: number; failed: number }> {
    const now = this.now();
    let cancelled = 0;
    let failed = 0;

    for (const execution of this.active.values()) {
      if (execution.cancelRequested) {
        if (
          !execution.forceCancelRequested &&
          execution.cancelRequestedAt !== undefined &&
          now - execution.cancelRequestedAt >= this.options.stalledRecoverySigtermTimeoutMs
        ) {
          const outcome = await this.tryCancel(execution, now, execution.cancelReason, true);
          if (outcome === 'terminated') {
            execution.forceCancelRequested = true;
          }
        }
        continue;
      }
      if (execution.nextCancelAttemptAt && now < execution.nextCancelAttemptAt) continue;

      const reason = this.resolveCancelReason(execution, now);
      if (!reason) continue;

      execution.cancelReason = reason;
      const outcome = await this.tryCancel(execution, now, reason, false);
      if (outcome === 'termination_started' || outcome === 'terminated') {
        cancelled += 1;
        execution.cancelRequested = true;
        execution.cancelRequestedAt = now;
        execution.nextCancelAttemptAt = undefined;
        this.options.logger.warn(
          {
            taskId: execution.taskId,
            sessionId: execution.sessionId,
            reason,
            runtimeStarted: execution.runtimeStarted,
            lastProgressAgeMs: now - execution.lastProgressAt,
          },
          'Runtime watchdog cancelled stalled execution',
        );
      } else if (outcome === 'no_active_execution') {
        // scan() runs fire-and-forget under fatal process handlers: a rejected
        // terminal write must not crash the worker. Keep the execution
        // registered so the next scan retries the write.
        try {
          await this.options.failExecution(execution.taskId, 'watchdog', reason);
          this.unregister(execution.taskId);
          failed += 1;
        } catch (err) {
          this.options.logger.error(
            { taskId: execution.taskId, sessionId: execution.sessionId, reason, err },
            'Watchdog failed to record execution failure; will retry next scan',
          );
        }
      }
    }

    return { inspected: this.active.size, cancelled, failed };
  }

  private async tryCancel(
    execution: ActiveRuntimeExecution,
    now: number,
    reason: 'startup_timeout' | 'progress_stalled' | undefined,
    force: boolean,
  ): Promise<RuntimeCancelOutcome> {
    try {
      const outcome = await this.options.cancelExecution(execution.taskId, 'watchdog', { force });
      if (outcome === 'no_active_execution') {
        execution.nextCancelAttemptAt = undefined;
      }
      return outcome;
    } catch (err) {
      execution.nextCancelAttemptAt = now + this.options.errorBackoffMs;
      this.options.logger.error(
        {
          err,
          taskId: execution.taskId,
          sessionId: execution.sessionId,
          reason,
          force,
          nextCancelAttemptAt: execution.nextCancelAttemptAt,
        },
        'Runtime watchdog failed to cancel stalled execution',
      );
      return 'already_done';
    }
  }

  private resolveCancelReason(
    execution: ActiveRuntimeExecution,
    now: number,
  ): 'startup_timeout' | 'progress_stalled' | null {
    if (!execution.runtimeStarted && now - execution.startedAt >= this.options.startupTimeoutMs) {
      return 'startup_timeout';
    }
    if (
      execution.runtimeStarted &&
      now - execution.lastProgressAt >= this.options.stalledTimeoutMs
    ) {
      return 'progress_stalled';
    }
    return null;
  }
}
