import { createLogger } from '@open-tag/observability';
import type {
  RuntimeAdapter,
  RuntimeRegistration,
  HealthStatus,
  RuntimeCancelOptions,
  RuntimeCancelOutcome,
} from './types.js';

const logger = createLogger('runtime-manager');

/**
 * Result of {@link RuntimeManager.getHealthyFallback}. `requested` is the
 * runtime the caller asked for; `selected` is the runtime actually returned.
 * They differ only when `usedFallback` is true, in which case `reason` explains
 * why the requested runtime was skipped. Callers persist `requested`/`selected`
 * verbatim rather than inferring the substitution from the adapter name.
 */
export interface HealthyFallbackResult {
  adapter: RuntimeAdapter;
  requested: string;
  selected: string;
  usedFallback: boolean;
  reason?: string;
}

export class RuntimeManager {
  private readonly adapters = new Map<string, RuntimeAdapter>();

  register(adapter: RuntimeAdapter): void {
    this.adapters.set(adapter.name(), adapter);
    logger.info({ runtime: adapter.name() }, 'Runtime adapter registered');
  }

  get(name: string): RuntimeAdapter | undefined {
    return this.adapters.get(name);
  }

  /** Run an adapter healthcheck, converting a thrown error into an unhealthy status. */
  private async safeHealthcheck(adapter: RuntimeAdapter): Promise<HealthStatus> {
    try {
      return await adapter.healthcheck();
    } catch (err) {
      return {
        healthy: false,
        name: adapter.name(),
        message: err instanceof Error ? err.message : 'Unknown error',
        lastCheckedAt: new Date(),
      };
    }
  }

  /**
   * Strict runtime resolution for an EXPLICITLY selected runtime. Returns the
   * requested adapter only when it is registered AND its live healthcheck
   * passes; otherwise throws. NEVER substitutes a different runtime — runtime is
   * an execution-semantics boundary (permissions, sandbox, model, resume,
   * cost), so an explicit choice must fail fast rather than silently change.
   */
  async requireHealthy(runtime: string): Promise<RuntimeAdapter> {
    const adapter = this.adapters.get(runtime);
    if (!adapter) {
      throw new Error(`Requested runtime "${runtime}" is not registered`);
    }
    const health = await this.safeHealthcheck(adapter);
    if (!health.healthy) {
      throw new Error(
        `Requested runtime "${runtime}" is unavailable: ${health.message ?? 'failed healthcheck'}`,
      );
    }
    return adapter;
  }

  /**
   * Tolerant runtime resolution for the auto/default/resume path: live-check the
   * preferred runtime, and if it is missing or unhealthy fall back to the first
   * other healthy adapter. Returns `undefined` only when nothing is healthy.
   * Use {@link requireHealthy} for explicit user selections — this method may
   * substitute a different runtime and reports it via `usedFallback`/`reason`.
   */
  async getHealthyFallback(preferred: string): Promise<HealthyFallbackResult | undefined> {
    // Try the preferred runtime first with a LIVE healthcheck.
    const preferredAdapter = this.adapters.get(preferred);
    let reason: string;
    if (preferredAdapter) {
      const health = await this.safeHealthcheck(preferredAdapter);
      if (health.healthy) {
        return {
          adapter: preferredAdapter,
          requested: preferred,
          selected: preferred,
          usedFallback: false,
        };
      }
      reason = `requested runtime "${preferred}" is unhealthy: ${health.message ?? 'failed healthcheck'}`;
    } else {
      reason = `requested runtime "${preferred}" is not registered`;
    }

    // Fallback: find any other healthy adapter (live-checked).
    for (const [name, adapter] of this.adapters) {
      if (name === preferred) continue;
      const health = await this.safeHealthcheck(adapter);
      if (health.healthy) {
        logger.warn({ preferred, fallback: name, reason }, 'Using fallback runtime');
        return { adapter, requested: preferred, selected: name, usedFallback: true, reason };
      }
    }

    return undefined;
  }

  /** Cancel a specific execution id across adapters. */
  async cancel(
    executionId: string,
    options: RuntimeCancelOptions = {},
  ): Promise<RuntimeCancelOutcome> {
    const errors: unknown[] = [];
    const outcomes = await Promise.all(
      Array.from(this.adapters.values()).map(async (adapter) => {
        try {
          return await adapter.cancel(executionId, options);
        } catch (err) {
          errors.push(err);
          logger.warn({ err, runtime: adapter.name(), executionId }, 'Runtime cancel failed');
          return 'no_active_execution' satisfies RuntimeCancelOutcome;
        }
      }),
    );

    if (errors.length > 0) {
      throw new AggregateError(errors, `Runtime cancel failed for execution ${executionId}`);
    }

    if (outcomes.includes('terminated')) return 'terminated';
    if (outcomes.includes('termination_started')) return 'termination_started';
    if (outcomes.includes('already_done')) return 'already_done';
    return 'no_active_execution';
  }

  /** Cancel all active executions across all adapters (called during shutdown). */
  cancelAll(): void {
    for (const adapter of this.adapters.values()) {
      if ('cancelAll' in adapter && typeof (adapter as any).cancelAll === 'function') {
        (adapter as any).cancelAll();
      }
    }
  }

  listAdapters(): string[] {
    return Array.from(this.adapters.keys());
  }
}

/**
 * Single, data-driven place that builds a {@link RuntimeManager}: every app
 * (worker, daemon) describes its runtimes as a {@link RuntimeRegistration} list
 * and hands it here. Only available runtimes are constructed and registered.
 * Adding a runtime is a new list entry — no per-app registration block to keep
 * in sync.
 */
export function buildRuntimeManager(registrations: RuntimeRegistration[]): RuntimeManager {
  const manager = new RuntimeManager();
  for (const registration of registrations) {
    if (registration.isAvailable()) {
      manager.register(registration.create());
    }
  }
  return manager;
}
