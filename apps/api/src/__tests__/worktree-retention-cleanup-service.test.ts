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

vi.mock('@open-tag/runtime-adapters', () => ({
  reapIdleConversationWorkspaces: vi.fn(),
}));

import type { Database } from '@open-tag/storage';
import { cleanStaleWorktrees } from '../worktree-cleanup.js';
import { reapIdleConversationWorkspaces } from '@open-tag/runtime-adapters';
import {
  DEFAULT_CONVERSATION_WORKSPACE_IDLE_MS,
  DEFAULT_WORKTREE_CLEANUP_INTERVAL_MS,
  DEFAULT_WORKTREE_RETENTION_MS,
  WorktreeRetentionCleanupService,
  parseConversationWorkspaceIdleMs,
  parseWorktreeCleanupIntervalMs,
  parseWorktreeRetentionMs,
  shouldRunWorktreeRetentionCleanup,
} from '../worktree-retention-cleanup-service.js';

const mockCleanStaleWorktrees = vi.mocked(cleanStaleWorktrees);
const mockReapIdle = vi.mocked(reapIdleConversationWorkspaces);

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
    mockReapIdle.mockResolvedValue({
      reaped: [],
      skippedRecent: [],
      skippedForeign: [],
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

  it('falls back to the default conversation idle window when config is invalid', () => {
    expect(parseConversationWorkspaceIdleMs({ CONVERSATION_WORKSPACE_IDLE_MS: 'nope' })).toBe(
      DEFAULT_CONVERSATION_WORKSPACE_IDLE_MS,
    );
    expect(parseConversationWorkspaceIdleMs({ CONVERSATION_WORKSPACE_IDLE_MS: '0' })).toBe(
      DEFAULT_CONVERSATION_WORKSPACE_IDLE_MS,
    );
    expect(parseConversationWorkspaceIdleMs({ CONVERSATION_WORKSPACE_IDLE_MS: '3600000' })).toBe(
      3600000,
    );
  });

  it('runs both worktree retention and the conversation idle scan on each tick', async () => {
    const service = new WorktreeRetentionCleanupService({} as Database, '/repo', {
      intervalMs: 1000,
      retentionMs: 2000,
      conversationIdleMs: 5000,
    });

    service.start();
    await vi.advanceTimersByTimeAsync(1000);

    expect(mockCleanStaleWorktrees).toHaveBeenCalledTimes(1);
    expect(mockReapIdle).toHaveBeenCalledTimes(1);
    expect(mockReapIdle).toHaveBeenCalledWith({ idleMs: 5000 });
  });

  it('isolates a conversation scan failure: worktree retention still runs and the tick survives', async () => {
    mockReapIdle.mockRejectedValueOnce(new Error('scan boom'));
    const service = new WorktreeRetentionCleanupService({} as Database, '/repo', {
      intervalMs: 1000,
      retentionMs: 2000,
      conversationIdleMs: 5000,
    });

    service.start();
    await vi.advanceTimersByTimeAsync(1000);

    expect(mockCleanStaleWorktrees).toHaveBeenCalledTimes(1);
    expect(loggerMock.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Conversation workspace idle scan tick failed',
    );

    // The service is still alive: the next tick runs both tasks again.
    await vi.advanceTimersByTimeAsync(1000);
    expect(mockReapIdle).toHaveBeenCalledTimes(2);
  });

  it('isolates a worktree retention failure: the conversation scan still runs', async () => {
    mockCleanStaleWorktrees.mockRejectedValueOnce(new Error('worktree boom'));
    const service = new WorktreeRetentionCleanupService({} as Database, '/repo', {
      intervalMs: 1000,
      retentionMs: 2000,
      conversationIdleMs: 5000,
    });

    service.start();
    await vi.advanceTimersByTimeAsync(1000);

    expect(mockReapIdle).toHaveBeenCalledTimes(1);
    expect(loggerMock.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Worktree retention cleanup tick failed',
    );
  });

  it('runs the injected stale-thread scan on each tick alongside the other steps', async () => {
    const staleThreadScan = vi.fn(async () => undefined);
    const service = new WorktreeRetentionCleanupService({} as Database, '/repo', {
      intervalMs: 1000,
      retentionMs: 2000,
      conversationIdleMs: 5000,
      staleThreadScan,
    });

    service.start();
    await vi.advanceTimersByTimeAsync(1000);

    expect(mockCleanStaleWorktrees).toHaveBeenCalledTimes(1);
    expect(mockReapIdle).toHaveBeenCalledTimes(1);
    expect(staleThreadScan).toHaveBeenCalledTimes(1);
  });

  it('skips the stale-thread scan step cleanly when no scan is injected', async () => {
    const service = new WorktreeRetentionCleanupService({} as Database, '/repo', {
      intervalMs: 1000,
      retentionMs: 2000,
      conversationIdleMs: 5000,
    });

    service.start();
    await vi.advanceTimersByTimeAsync(1000);

    // The other steps still ran; no stale-thread error was logged.
    expect(mockReapIdle).toHaveBeenCalledTimes(1);
    expect(loggerMock.error).not.toHaveBeenCalledWith(
      expect.anything(),
      'Stale-thread nudge scan tick failed',
    );
  });

  it('isolates a stale-thread scan failure: the other steps still ran and the tick survives', async () => {
    const staleThreadScan = vi.fn(async () => {
      throw new Error('scan boom');
    });
    const service = new WorktreeRetentionCleanupService({} as Database, '/repo', {
      intervalMs: 1000,
      retentionMs: 2000,
      conversationIdleMs: 5000,
      staleThreadScan,
    });

    service.start();
    await vi.advanceTimersByTimeAsync(1000);

    expect(mockCleanStaleWorktrees).toHaveBeenCalledTimes(1);
    expect(mockReapIdle).toHaveBeenCalledTimes(1);
    expect(loggerMock.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Stale-thread nudge scan tick failed',
    );

    // Still alive: the next tick runs the scan again.
    await vi.advanceTimersByTimeAsync(1000);
    expect(staleThreadScan).toHaveBeenCalledTimes(2);
  });
});
