import { createLogger } from '@open-tag/observability';
import type { Database } from '@open-tag/storage';
import { cleanStaleWorktrees } from './worktree-cleanup.js';

const logger = createLogger('worktree-retention-cleanup');

export const DEFAULT_WORKTREE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_WORKTREE_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

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
    } = {},
  ) {}

  start(): void {
    if (this.timer) return;

    const intervalMs = this.options.intervalMs ?? parseWorktreeCleanupIntervalMs();
    const retentionMs = this.options.retentionMs ?? parseWorktreeRetentionMs();

    logger.info(
      { intervalMs, retentionMs },
      'Worktree retention cleanup service started',
    );

    this.timer = setInterval(() => {
      this.runOnce(retentionMs).catch((err) => {
        logger.error({ err }, 'Worktree retention cleanup tick failed');
      });
    }, intervalMs);
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
