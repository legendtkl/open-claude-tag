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

  constructor(
    private readonly db: Database,
    private readonly repoRoot: string,
    private readonly options: {
      intervalMs?: number;
      retentionMs?: number;
      conversationIdleMs?: number;
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
   * One scheduled tick: worktree retention THEN the conversation-workspace idle
   * scan, each in its own try/catch. The scan is additive and independent — a
   * failure in either task is logged but must not crash the service or block the
   * other task.
   */
  private async tick(retentionMs: number, conversationIdleMs: number): Promise<void> {
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
