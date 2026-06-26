import { createLogger } from '@open-tag/observability';
import type {
  RuntimeAdapter,
  RuntimeRegistration,
  HealthStatus,
  RuntimeCancelOptions,
  RuntimeCancelOutcome,
} from './types.js';

const logger = createLogger('runtime-manager');

export class RuntimeManager {
  private readonly adapters = new Map<string, RuntimeAdapter>();
  private readonly healthCache = new Map<string, HealthStatus>();
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null;

  register(adapter: RuntimeAdapter): void {
    this.adapters.set(adapter.name(), adapter);
    logger.info({ runtime: adapter.name() }, 'Runtime adapter registered');
  }

  get(name: string): RuntimeAdapter | undefined {
    return this.adapters.get(name);
  }

  getHealthy(preferred: string): RuntimeAdapter | undefined {
    // Try preferred first
    const preferredAdapter = this.adapters.get(preferred);
    if (preferredAdapter) {
      const health = this.healthCache.get(preferred);
      if (!health || health.healthy) {
        return preferredAdapter;
      }
    }

    // Fallback: find any healthy adapter
    for (const [name, adapter] of this.adapters) {
      if (name === preferred) continue;
      const health = this.healthCache.get(name);
      if (!health || health.healthy) {
        logger.warn({ preferred, fallback: name }, 'Using fallback runtime');
        return adapter;
      }
    }

    return undefined;
  }

  async checkHealth(): Promise<Map<string, HealthStatus>> {
    const results = new Map<string, HealthStatus>();
    for (const [name, adapter] of this.adapters) {
      try {
        const status = await adapter.healthcheck();
        this.healthCache.set(name, status);
        results.set(name, status);
      } catch (err) {
        const status: HealthStatus = {
          healthy: false,
          name,
          message: err instanceof Error ? err.message : 'Unknown error',
          lastCheckedAt: new Date(),
        };
        this.healthCache.set(name, status);
        results.set(name, status);
      }
    }
    return results;
  }

  startHealthChecks(intervalMs: number = 30000): void {
    this.healthCheckInterval = setInterval(() => {
      this.checkHealth().catch((err) => {
        logger.error({ err }, 'Health check failed');
      });
    }, intervalMs);
  }

  stopHealthChecks(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
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
