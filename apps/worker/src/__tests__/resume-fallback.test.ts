import { describe, expect, it } from 'vitest';
import {
  cancellationSourceToTaskRunStatus,
  resolveRuntimeCancellationSource,
  runtimeOutcomeToTaskRunStatus,
  shouldFallbackToFreshExecutionAfterResume,
} from '../resume-fallback.js';

describe('shouldFallbackToFreshExecutionAfterResume', () => {
  it('falls back for ordinary resume failures', () => {
    expect(
      shouldFallbackToFreshExecutionAfterResume({
        error: 'session expired',
        cancelled: false,
      }),
    ).toBe(true);
  });

  it('does not fallback to fresh execute after an intentional resume cancellation', () => {
    expect(
      shouldFallbackToFreshExecutionAfterResume({
        error: 'Aborted',
        cancelled: true,
      }),
    ).toBe(false);
  });
});

describe('runtimeOutcomeToTaskRunStatus', () => {
  it('settles system-cancelled runtime outcomes as failed by default so watchdogs can retry', () => {
    expect(runtimeOutcomeToTaskRunStatus({ error: 'Aborted', cancelled: true })).toBe('failed');
  });

  it('settles user-cancelled runtime outcomes as cancelled', () => {
    expect(runtimeOutcomeToTaskRunStatus({ error: 'Aborted', cancelled: true }, 'user')).toBe(
      'cancelled',
    );
  });

  it('settles watchdog-cancelled runtime outcomes as failed', () => {
    expect(runtimeOutcomeToTaskRunStatus({ error: 'Aborted', cancelled: true }, 'watchdog')).toBe(
      'failed',
    );
  });

  it('settles ordinary runtime errors as failed', () => {
    expect(runtimeOutcomeToTaskRunStatus({ error: 'session expired' })).toBe('failed');
  });
});

describe('resolveRuntimeCancellationSource', () => {
  it('defaults unknown sources to system', () => {
    expect(resolveRuntimeCancellationSource(undefined)).toBe('system');
    expect(resolveRuntimeCancellationSource('cancelled')).toBe('system');
  });

  it('allows explicit user and watchdog sources', () => {
    expect(resolveRuntimeCancellationSource('user')).toBe('user');
    expect(resolveRuntimeCancellationSource('watchdog')).toBe('watchdog');
  });
});

describe('cancellationSourceToTaskRunStatus', () => {
  it('keeps user cancellation terminal but system/watchdog cancellation recoverable', () => {
    expect(cancellationSourceToTaskRunStatus('user')).toBe('cancelled');
    expect(cancellationSourceToTaskRunStatus('system')).toBe('failed');
    expect(cancellationSourceToTaskRunStatus('watchdog')).toBe('failed');
  });
});
