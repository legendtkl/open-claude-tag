import { createLogger } from '@open-tag/observability';
import type { Database } from '@open-tag/storage';
import { reapIdleConversationWorkspaces } from '@open-tag/runtime-adapters';
import { cleanStaleWorktrees } from './worktree-cleanup.js';

const logger = createLogger('worktree-retention-cleanup');

export const DEFAULT_WORKTREE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_WORKTREE_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
/**
 * Idle window before a conversation workspace is reaped. Kept above the pg-boss
 * job lifetime (`expireInHours: 23`) so an in-flight turn's dir — its mtime set
 * at turn start — is never reaped mid-run.
 */
export const DEFAULT_CONVERSATION_WORKSPACE_IDLE_MS = 24 * 60 * 60 * 1000;

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

export function parseWorktreeRetentionMs(
  env: Record<string, string | undefined> = process.env,
): number {
  return parsePositiveInteger(env.WORKTREE_RETENTION_MS, DEFAULT_WORKTREE_RETENTION_MS);
}

export function parseWorktreeCleanupIntervalMs(
  env: Record<string, string | undefined> = process.env,
): number {
  return parsePositiveInteger(
    env.WORKTREE_CLEANUP_INTERVAL_MS,
    DEFAULT_WORKTREE_CLEANUP_INTERVAL_MS,
  );
}

export function parseConversationWorkspaceIdleMs(
  env: Record<string, string | undefined> = process.env,
): number {
  return parsePositiveInteger(
    env.CONVERSATION_WORKSPACE_IDLE_MS,
    DEFAULT_CONVERSATION_WORKSPACE_IDLE_MS,
  );
}

export function shouldRunWorktreeRetentionCleanup(options: {
  instanceRole: 'primary' | 'isolated';
  processType: 'api' | 'worker';
}): boolean {
  return options.processType === 'api' && options.instanceRole === 'primary';
}

export class WorktreeRetentionCleanupService {
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Guards against overlapping ticks: a slow scan must not be re-entered before it finishes. */
  private ticking = false;

  constructor(
    private readonly db: Database,
    private readonly repoRoot: string,
    private readonly options: {
      intervalMs?: number;
      retentionMs?: number;
      conversationIdleMs?: number;
      /**
       * Optional, error-isolated stale-thread nudge scan (Stage 5). Injected by
       * the composition root with all heavy deps closed over; the scan's own
       * Gate-0 flag check makes it a complete no-op when disabled (default). Absent
       * ⇒ the tick simply skips this step (e.g. isolated instances / tests).
       */
      staleThreadScan?: () => Promise<void>;
      /**
       * Optional, error-isolated channel-memory retention prune (Stage 3). Bounds
       * the append-only `channel_observations` growth per channel scope. Injected by
       * the composition root with its env-derived policy closed over; a conservative
       * count-cap default keeps the scan a no-op until a scope exceeds the keep
       * floor. Absent ⇒ the tick skips this step (isolated instances / tests).
       */
      channelMemoryRetentionScan?: () => Promise<void>;
    } = {},
  ) {}

  start(): void {
    if (this.timer) return;

    const intervalMs = this.options.intervalMs ?? parseWorktreeCleanupIntervalMs();
    const retentionMs = this.options.retentionMs ?? parseWorktreeRetentionMs();
    const conversationIdleMs =
      this.options.conversationIdleMs ?? parseConversationWorkspaceIdleMs();

    logger.info(
      { intervalMs, retentionMs, conversationIdleMs },
      'Worktree retention cleanup service started',
    );

    this.timer = setInterval(() => {
      void this.tick(retentionMs, conversationIdleMs);
    }, intervalMs);
  }

  /**
   * One scheduled tick: worktree retention, THEN the conversation-workspace idle
   * scan, THEN the stale-thread nudge scan, THEN the channel-memory retention prune
   * — each in its own try/catch. Every step is additive and independent: a failure
   * in one is logged but must not crash the service or block the others.
   *
   * Re-entrancy guarded: if a previous tick is still running (a slow scan), this
   * tick is skipped. Combined with the primary-API-only invariant, that keeps the
   * stale-thread scan's check-then-send idempotency free of overlapping-tick races.
   */
  private async tick(retentionMs: number, conversationIdleMs: number): Promise<void> {
    if (this.ticking) {
      logger.warn('Reconciler tick skipped (previous tick still running)');
      return;
    }
    this.ticking = true;
    try {
      try {
        await this.runOnce(retentionMs);
      } catch (err) {
        logger.error({ err }, 'Worktree retention cleanup tick failed');
      }
      try {
        await this.runConversationWorkspaceScan(conversationIdleMs);
      } catch (err) {
        logger.error({ err }, 'Conversation workspace idle scan tick failed');
      }
      try {
        if (this.options.staleThreadScan) {
          await this.options.staleThreadScan();
        }
      } catch (err) {
        logger.error({ err }, 'Stale-thread nudge scan tick failed');
      }
      try {
        if (this.options.channelMemoryRetentionScan) {
          await this.options.channelMemoryRetentionScan();
        }
      } catch (err) {
        logger.error({ err }, 'Channel memory retention scan tick failed');
      }
    } finally {
      this.ticking = false;
    }
  }

  private async runConversationWorkspaceScan(idleMs: number): Promise<void> {
    const result = await reapIdleConversationWorkspaces({ idleMs });
    logger.info(
      {
        idleMs,
        reaped: result.reaped.length,
        skippedRecent: result.skippedRecent.length,
        skippedForeign: result.skippedForeign.length,
        errors: result.errors,
      },
      'Conversation workspace idle scan tick completed',
    );
  }

  stop(): void {
    if (!this.timer) return;

    clearInterval(this.timer);
    this.timer = null;
    logger.info('Worktree retention cleanup service stopped');
  }

  async runOnce(retentionMs: number = this.options.retentionMs ?? parseWorktreeRetentionMs()): Promise<void> {
    const result = await cleanStaleWorktrees(this.db, this.repoRoot, retentionMs, new Date());
    logger.info(
      {
        retentionMs,
        cleaned: result.targetCleaned,
        skipped: result.staleSkipped,
        orphanDbCleaned: result.orphanDbCleaned,
        errors: result.errors,
      },
      'Worktree retention cleanup tick completed',
    );
  }
}
