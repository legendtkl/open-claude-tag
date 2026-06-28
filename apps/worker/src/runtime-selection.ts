import type { RuntimeAdapter } from '@open-tag/runtime-adapters';

/**
 * Minimal slice of `RuntimeManager` that local adapter selection needs. Keeping
 * it structural lets the selection logic be unit-tested with a fake manager.
 */
export interface LocalRuntimeSelector {
  requireHealthy(runtime: string): Promise<RuntimeAdapter>;
  getHealthyFallback(preferred: string): Promise<
    | {
        adapter: RuntimeAdapter;
        requested: string;
        selected: string;
        usedFallback: boolean;
        reason?: string;
      }
    | undefined
  >;
}

export interface RuntimeFallbackRecord {
  preferredRuntime: string;
  fallbackRuntime: string;
  reason: string;
}

export interface LocalAdapterSelection {
  adapter: RuntimeAdapter;
  /** Non-null only when an auto/default selection fell back to another runtime. */
  fallback: RuntimeFallbackRecord | null;
}

/**
 * Select a LOCAL runtime adapter honoring the fail-fast vs logged-fallback
 * contract (issue #8):
 *
 * - `explicit` selections (user-confirmed or an explicit hint) run EXACTLY the
 *   requested runtime — `requireHealthy` throws if it is unregistered or
 *   unhealthy, and we let that propagate so the task fails fast with a clear
 *   error rather than silently switching runtimes.
 * - auto/default/resume selections may fall back to another healthy runtime;
 *   the substitution is reported via {@link LocalAdapterSelection.fallback} so
 *   the caller can log and persist it.
 */
export async function selectLocalRuntimeAdapter(
  manager: LocalRuntimeSelector,
  preferredRuntime: string,
  explicit: boolean,
): Promise<LocalAdapterSelection> {
  if (explicit) {
    const adapter = await manager.requireHealthy(preferredRuntime);
    return { adapter, fallback: null };
  }

  const result = await manager.getHealthyFallback(preferredRuntime);
  if (!result) {
    throw new Error('No healthy runtime adapter available');
  }

  return {
    adapter: result.adapter,
    fallback: result.usedFallback
      ? {
          preferredRuntime: result.requested,
          fallbackRuntime: result.selected,
          reason: result.reason ?? 'preferred runtime unavailable',
        }
      : null,
  };
}
