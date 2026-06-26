export interface RuntimeStreamOutcome {
  error: string | null;
  cancelled?: boolean;
}

export type RuntimeCancellationSource = 'user' | 'system' | 'watchdog';

export function shouldFallbackToFreshExecutionAfterResume(outcome: RuntimeStreamOutcome): boolean {
  return Boolean(outcome.error && !outcome.cancelled);
}

export function resolveRuntimeCancellationSource(value: unknown): RuntimeCancellationSource {
  if (value === 'user' || value === 'watchdog') return value;
  return 'system';
}

export function cancellationSourceToTaskRunStatus(
  source: RuntimeCancellationSource,
): 'failed' | 'cancelled' {
  return source === 'user' ? 'cancelled' : 'failed';
}

export function runtimeOutcomeToTaskRunStatus(
  outcome: RuntimeStreamOutcome,
  cancellationSource: RuntimeCancellationSource = 'system',
): 'completed' | 'failed' | 'cancelled' {
  if (outcome.cancelled) return cancellationSourceToTaskRunStatus(cancellationSource);
  if (outcome.error) return 'failed';
  return 'completed';
}
