import { createLogger } from '@open-tag/observability';
import type { RuntimeCancelOptions, RuntimeCancelOutcome } from '@open-tag/runtime-adapters';

const logger = createLogger('remote-execution-tracker');

export interface RemoteCancelable {
  cancel(executionId: string, options?: RuntimeCancelOptions): Promise<RuntimeCancelOutcome>;
}

/**
 * In-flight machine-bound executions, keyed by execution id (the taskId).
 *
 * `RemoteRuntimeAdapter` instances are constructed per dispatch and must never
 * be registered with `RuntimeManager` (they would become runtime-selection and
 * health-check candidates), which left them unreachable from the cancellation
 * channel: the watchdog and shutdown called `runtimeManager.cancel` and always
 * got `no_active_execution` — the server failed the task while the user's
 * machine kept executing it. This tracker is the missing channel.
 */
export class RemoteExecutionTracker {
  private readonly active = new Map<string, RemoteCancelable>();

  register(executionId: string, adapter: RemoteCancelable): void {
    this.active.set(executionId, adapter);
  }

  unregister(executionId: string): void {
    this.active.delete(executionId);
  }

  has(executionId: string): boolean {
    return this.active.has(executionId);
  }

  /**
   * Cancel a tracked remote execution. Returns `null` when the id is not a
   * tracked remote execution (caller falls back to the local manager).
   */
  async cancel(
    executionId: string,
    options?: RuntimeCancelOptions,
  ): Promise<RuntimeCancelOutcome | null> {
    const adapter = this.active.get(executionId);
    if (!adapter) return null;
    return adapter.cancel(executionId, options);
  }

  /** Force-cancel everything (shutdown). Errors are logged, never thrown. */
  cancelAll(): void {
    for (const [executionId, adapter] of this.active) {
      void adapter
        .cancel(executionId, { force: true })
        .catch((err) =>
          logger.warn({ executionId, err }, 'Remote cancel failed during shutdown'),
        );
    }
  }
}
