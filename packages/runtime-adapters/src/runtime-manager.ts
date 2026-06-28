import { createLogger } from '@open-tag/observability';
import type {
  RuntimeAdapter,
  RuntimeRegistration,
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

  /**
   * Strict runtime resolution for an EXPLICITLY selected runtime. Returns the
   * requested adapter when it is registered; otherwise throws. NEVER substitutes
   * a different runtime — runtime is an execution-semantics boundary
   * (permissions, sandbox, model, resume, cost), so an explicit choice must fail
   * fast rather than silently change.
   *
   * Registration IS the availability signal: the `isAvailable()/create()`
   * descriptor gates the `register()` call (a codex-less daemon never registers
   * codex), so the adapter map reflects what this process can actually run.
   * Credential problems surface at EXECUTION via the runtime's own clear error,
   * never as a silent runtime switch.
   */
  async requireHealthy(runtime: string): Promise<RuntimeAdapter> {
    const adapter = this.adapters.get(runtime);
    if (!adapter) {
      throw new Error(`Requested runtime "${runtime}" is not registered`);
    }
    return adapter;
  }

  /**
   * Tolerant runtime resolution for the auto/default/resume path: return the
   * preferred runtime when registered, otherwise fall back to the first other
   * registered adapter. Returns `undefined` only when nothing is registered.
   * Use {@link requireHealthy} for explicit user selections — this method may
   * substitute a different runtime and reports it via `usedFallback`/`reason`.
   * The caller owns logging/persisting the substitution.
   */
  async getHealthyFallback(preferred: string): Promise<HealthyFallbackResult | undefined> {
    const preferredAdapter = this.adapters.get(preferred);
    if (preferredAdapter) {
      return {
        adapter: preferredAdapter,
        requested: preferred,
        selected: preferred,
        usedFallback: false,
      };
    }

    // Fallback: first other registered adapter.
    const reason = `requested runtime "${preferred}" is not registered`;
    for (const [name, adapter] of this.adapters) {
      if (name === preferred) continue;
      return { adapter, requested: preferred, selected: name, usedFallback: true, reason };
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
