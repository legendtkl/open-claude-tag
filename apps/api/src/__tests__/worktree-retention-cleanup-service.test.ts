import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../worktree-cleanup.js', () => ({
  cleanStaleWorktrees: vi.fn(),
}));

vi.mock('@open-tag/observability', () => ({
  createLogger: () => loggerMock,
}));

import type { Database } from '@open-tag/storage';
import { cleanStaleWorktrees } from '../worktree-cleanup.js';
import {
  DEFAULT_WORKTREE_CLEANUP_INTERVAL_MS,
  DEFAULT_WORKTREE_RETENTION_MS,
  WorktreeRetentionCleanupService,
  parseWorktreeCleanupIntervalMs,
  parseWorktreeRetentionMs,
  shouldRunWorktreeRetentionCleanup,
} from '../worktree-retention-cleanup-service.js';

const mockCleanStaleWorktrees = vi.mocked(cleanStaleWorktrees);

describe('worktree-retention-cleanup-service', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockCleanStaleWorktrees.mockResolvedValue({
      mergedCleaned: [],
      closedCleaned: [],
      orphanDbCleaned: [],
      orphanDiskCleaned: [],
      targetCleaned: [],
      staleSkipped: [],
      errors: [],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('falls back to default retention when config is invalid', () => {
    expect(parseWorktreeRetentionMs({ WORKTREE_RETENTION_MS: 'abc' })).toBe(
      DEFAULT_WORKTREE_RETENTION_MS,
    );
    expect(parseWorktreeRetentionMs({ WORKTREE_RETENTION_MS: '-1' })).toBe(
      DEFAULT_WORKTREE_RETENTION_MS,
    );
  });

  it('falls back to default cleanup interval when config is invalid', () => {
    expect(parseWorktreeCleanupIntervalMs({ WORKTREE_CLEANUP_INTERVAL_MS: '0' })).toBe(
      DEFAULT_WORKTREE_CLEANUP_INTERVAL_MS,
    );
    expect(parseWorktreeCleanupIntervalMs({ WORKTREE_CLEANUP_INTERVAL_MS: 'bad' })).toBe(
      DEFAULT_WORKTREE_CLEANUP_INTERVAL_MS,
    );
  });

  it('runs only in the primary API process', () => {
    expect(shouldRunWorktreeRetentionCleanup({ instanceRole: 'primary', processType: 'api' })).toBe(
      true,
    );
    expect(shouldRunWorktreeRetentionCleanup({ instanceRole: 'isolated', processType: 'api' })).toBe(
      false,
    );
    expect(shouldRunWorktreeRetentionCleanup({ instanceRole: 'primary', processType: 'worker' })).toBe(
      false,
    );
  });

  it('start() and stop() manage the timer lifecycle', () => {
    const service = new WorktreeRetentionCleanupService({} as Database, '/repo', {
      intervalMs: 1000,
      retentionMs: 2000,
    });

    service.start();
    expect((service as any).timer).not.toBeNull();

    service.stop();
    expect((service as any).timer).toBeNull();
  });

  it('does not log stop when the service never started', () => {
    const service = new WorktreeRetentionCleanupService({} as Database, '/repo');

    service.stop();

    expect(loggerMock.info).not.toHaveBeenCalledWith('Worktree retention cleanup service stopped');
  });

  it('invokes stale cleanup on each timer tick with the configured retention', async () => {
    const service = new WorktreeRetentionCleanupService({} as Database, '/repo', {
      intervalMs: 1000,
      retentionMs: 2000,
    });

    service.start();
    vi.advanceTimersByTime(1000);
    await Promise.resolve();

    expect(mockCleanStaleWorktrees).toHaveBeenCalledWith(
      expect.anything(),
      '/repo',
      2000,
      expect.any(Date),
    );
  });
});
