import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import { existsSync, readdirSync, type Dirent } from 'fs';
import { basename, dirname, join, normalize } from 'path';
import { TaskStatus } from '@open-tag/core-types';
import { sessions, projects, tasks } from '@open-tag/storage';
import { and, isNotNull, eq, sql } from 'drizzle-orm';
import { removeWorktree, removeWorktreeAtPath } from '@open-tag/runtime-adapters';
import type { Database } from '@open-tag/storage';
import { getReviewRequestState } from './review-request.js';

const execFileAsync = promisify(execFileCb);

/**
 * Fetch the GitHub PR state via the `gh` CLI.
 * Returns `'OPEN' | 'MERGED' | 'CLOSED'`, or `null` when prUrl is
 * null/invalid or the `gh` command fails.
 */
export async function getPrState(prUrl: string | null): Promise<'OPEN' | 'MERGED' | 'CLOSED' | null> {
  return getReviewRequestState(prUrl);
}

/**
 * Check if a PR/MR is merged.
 * Returns false if prUrl is null, invalid, or the provider command fails.
 */
export async function isPrMerged(prUrl: string | null): Promise<boolean> {
  return (await getPrState(prUrl)) === 'MERGED';
}

/**
 * Check if a PR/MR is closed without merging.
 * Returns false if prUrl is null, invalid, or the provider command fails.
 */
export async function isPrClosed(prUrl: string | null): Promise<boolean> {
  return (await getPrState(prUrl)) === 'CLOSED';
}

export interface CleanupResult {
  mergedCleaned: string[];
  closedCleaned: string[];
  orphanDbCleaned: string[];
  orphanDiskCleaned: string[];
  targetCleaned: string[];
  staleSkipped: string[];
  errors: string[];
}

function emptyResult(): CleanupResult {
  return {
    mergedCleaned: [],
    closedCleaned: [],
    orphanDbCleaned: [],
    orphanDiskCleaned: [],
    targetCleaned: [],
    staleSkipped: [],
    errors: [],
  };
}

async function removeGitWorktree(repoRoot: string, worktreePath: string): Promise<void> {
  await execFileAsync('git', ['worktree', 'remove', worktreePath, '--force'], { cwd: repoRoot });
}

async function deleteGitBranch(repoRoot: string, branchName: string): Promise<void> {
  await execFileAsync('git', ['branch', '-D', branchName], { cwd: repoRoot });
}

function isManagedWorktreePath(repoRoot: string, worktreePath: string): boolean {
  const normalizedRoot = normalize(join(repoRoot, '.worktrees'));
  const normalizedPath = normalize(worktreePath);
  return dirname(normalizedPath) === normalizedRoot && basename(normalizedPath).startsWith('dev-');
}

function cleanupLabel(session: { id: string; worktreeBranch: string | null; worktreePath: string | null }): string {
  return session.worktreeBranch ?? session.worktreePath ?? session.id.slice(0, 8);
}

function worktreeSessionCleanupFilter() {
  return and(
    isNotNull(sessions.worktreePath),
    sql`not exists (
      select 1
      from ${tasks}
      where ${tasks.sessionId} = ${sessions.id}
        and ${tasks.status} = ${TaskStatus.WAITING_DELEGATION}
    )`,
  );
}

async function clearSessionWorktreeBinding(db: Database, sessionId: string): Promise<void> {
  await db
    .update(sessions)
    .set({
      worktreePath: null,
      worktreeBranch: null,
      updatedAt: new Date(),
    })
    .where(eq(sessions.id, sessionId));
}

type CleanupTargetKind =
  | 'self_dev_managed_worktree'
  | 'external_project_managed_worktree'
  | 'external_project_direct_path'
  | 'unknown_unmanaged_path';

function classifyCleanupTarget(
  repoRoot: string,
  worktreePath: string,
  projectPath: string | null,
  isExternalProject: boolean,
): CleanupTargetKind {
  if (isExternalProject) {
    if (projectPath && normalize(worktreePath) === normalize(projectPath)) {
      return 'external_project_direct_path';
    }
    if (projectPath && isManagedWorktreePath(projectPath, worktreePath)) {
      return 'external_project_managed_worktree';
    }
    return 'unknown_unmanaged_path';
  }

  if (isManagedWorktreePath(repoRoot, worktreePath)) {
    return 'self_dev_managed_worktree';
  }

  return 'unknown_unmanaged_path';
}

/**
 * Time-based cleanup: removes stale managed worktrees regardless of PR state.
 * Self-dev worktrees reuse the current OpenClaudeTag removal flow.
 * External-project worktrees are removed via `git worktree remove` and keep their branches.
 */
export async function cleanStaleWorktrees(
  db: Database,
  repoRoot: string,
  retentionMs: number,
  now: Date = new Date(),
): Promise<CleanupResult> {
  const result = emptyResult();
  const threshold = now.getTime() - retentionMs;

  const devSessions = await db
    .select({
      id: sessions.id,
      worktreePath: sessions.worktreePath,
      worktreeBranch: sessions.worktreeBranch,
      projectId: sessions.projectId,
      updatedAt: sessions.updatedAt,
    })
    .from(sessions)
    .where(worktreeSessionCleanupFilter());

  const staleSessions = devSessions.filter(
    (session) => session.updatedAt instanceof Date && session.updatedAt.getTime() < threshold,
  );

  for (const session of staleSessions) {
    const label = cleanupLabel(session);
    const worktreePath = session.worktreePath!;

    if (!existsSync(worktreePath)) {
      await clearSessionWorktreeBinding(db, session.id);
      result.orphanDbCleaned.push(label);
      continue;
    }

    let projectPath: string | null = null;
    if (session.projectId) {
      const projectRows = await db
        .select({ path: projects.path })
        .from(projects)
        .where(eq(projects.id, session.projectId));
      projectPath = projectRows[0]?.path ?? null;
    }

    const targetKind = classifyCleanupTarget(
      repoRoot,
      worktreePath,
      projectPath,
      Boolean(session.projectId),
    );

    if (
      targetKind === 'external_project_direct_path' ||
      targetKind === 'unknown_unmanaged_path'
    ) {
      result.staleSkipped.push(label);
      continue;
    }

    try {
      if (targetKind === 'self_dev_managed_worktree') {
        await removeWorktree(session.id, repoRoot);
      } else {
        await removeGitWorktree(projectPath!, worktreePath);
      }
      await clearSessionWorktreeBinding(db, session.id);
      result.targetCleaned.push(label);
    } catch (err) {
      result.errors.push(`Failed to remove stale worktree ${label}: ${err}`);
    }
  }

  return result;
}

/**
 * Safe cleanup: removes merged worktrees, orphan DB records, and orphan disk directories.
 * Does NOT remove unmerged worktrees.
 */
export async function cleanWorktrees(db: Database, repoRoot: string): Promise<CleanupResult> {
  const result = emptyResult();

  // 1. Query all sessions with worktreePath set
  const devSessions = await db
    .select({
      id: sessions.id,
      worktreePath: sessions.worktreePath,
      worktreeBranch: sessions.worktreeBranch,
      prUrl: sessions.prUrl,
    })
    .from(sessions)
    .where(worktreeSessionCleanupFilter());

  const dbWorktreePaths = new Set<string>();

  // Separate orphan DB records from sessions that need PR merge check
  const needsMergeCheck: typeof devSessions = [];
  for (const s of devSessions) {
    dbWorktreePaths.add(s.worktreePath!);
    if (!existsSync(s.worktreePath!)) {
      await db
        .update(sessions)
        .set({
          worktreePath: null,
          worktreeBranch: null,
          updatedAt: new Date(),
        })
        .where(eq(sessions.id, s.id));
      result.orphanDbCleaned.push(s.worktreeBranch ?? s.id.slice(0, 8));
    } else {
      needsMergeCheck.push(s);
    }
  }

  // Check PR state in parallel — one gh call per session
  const stateResults = await Promise.all(needsMergeCheck.map((s) => getPrState(s.prUrl)));

  for (let i = 0; i < needsMergeCheck.length; i++) {
    const state = stateResults[i];
    const isMerged = state === 'MERGED';
    const isClosed = state === 'CLOSED';
    if (isMerged || isClosed) {
      const s = needsMergeCheck[i];
      try {
        // Use stored worktreePath so external-project worktrees are removed from the
        // correct project root, not from repoRoot (which only works for self-dev).
        if (s.worktreePath && s.worktreeBranch) {
          await removeWorktreeAtPath(s.worktreePath, s.worktreeBranch);
        }
        await db
          .update(sessions)
          .set({
            worktreePath: null,
            worktreeBranch: null,
            updatedAt: new Date(),
          })
          .where(eq(sessions.id, s.id));
        if (isMerged) {
          result.mergedCleaned.push(s.worktreeBranch ?? s.id.slice(0, 8));
        } else {
          result.closedCleaned.push(s.worktreeBranch ?? s.id.slice(0, 8));
        }
      } catch (err) {
        const label = isMerged ? 'merged' : 'closed';
        result.errors.push(`Failed to remove ${label} worktree ${s.worktreeBranch ?? s.id.slice(0, 8)}: ${err}`);
      }
    }
  }

  // 2. Scan disk for orphan directories (exist on disk but not in DB)
  const worktreesDir = join(repoRoot, '.worktrees');
  if (existsSync(worktreesDir)) {
    let entries: Dirent[];
    try {
      entries = readdirSync(worktreesDir, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('dev-')) continue;
      const fullPath = join(worktreesDir, entry.name);
      if (!dbWorktreePaths.has(fullPath)) {
        try {
          await removeGitWorktree(repoRoot, fullPath);
        } catch {
          /* already removed */
        }
        const branchGuess = `dev/${entry.name.replace('dev-', '')}`;
        try {
          await deleteGitBranch(repoRoot, branchGuess);
        } catch {
          /* branch may not exist */
        }
        result.orphanDiskCleaned.push(entry.name);
      }
    }
  }

  return result;
}

/**
 * Force cleanup: removes ALL worktrees regardless of merge status, plus orphan directories.
 */
export async function cleanAllWorktrees(db: Database, repoRoot: string): Promise<CleanupResult> {
  const result = emptyResult();

  const devSessions = await db
    .select({
      id: sessions.id,
      worktreePath: sessions.worktreePath,
      worktreeBranch: sessions.worktreeBranch,
    })
    .from(sessions)
    .where(worktreeSessionCleanupFilter());

  const dbWorktreePaths = new Set<string>();

  for (const s of devSessions) {
    dbWorktreePaths.add(s.worktreePath!);
    // Passthrough sessions (worktreeBranch IS NULL) have no git worktree to remove.
    if (s.worktreePath && s.worktreeBranch) {
      try {
        await removeWorktreeAtPath(s.worktreePath, s.worktreeBranch);
      } catch {
        /* may already be removed */
      }
    }
    await db
      .update(sessions)
      .set({
        worktreePath: null,
        worktreeBranch: null,
        updatedAt: new Date(),
      })
      .where(eq(sessions.id, s.id));
    result.targetCleaned.push(s.worktreeBranch ?? s.id.slice(0, 8));
  }

  // Scan disk for orphan directories
  const worktreesDir = join(repoRoot, '.worktrees');
  if (existsSync(worktreesDir)) {
    let entries: Dirent[];
    try {
      entries = readdirSync(worktreesDir, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('dev-')) continue;
      const fullPath = join(worktreesDir, entry.name);
      if (!dbWorktreePaths.has(fullPath)) {
        try {
          await removeGitWorktree(repoRoot, fullPath);
        } catch {
          /* already removed */
        }
        const branchGuess = `dev/${entry.name.replace('dev-', '')}`;
        try {
          await deleteGitBranch(repoRoot, branchGuess);
        } catch {
          /* branch may not exist */
        }
        result.orphanDiskCleaned.push(entry.name);
      }
    }
  }

  return result;
}

/**
 * Remove a specific worktree by session ID prefix or directory name.
 */
export async function removeWorktreeById(
  db: Database,
  repoRoot: string,
  idPrefix: string,
): Promise<CleanupResult> {
  const result = emptyResult();
  const prefix = idPrefix.trim();

  if (!prefix) {
    result.errors.push('No ID prefix provided');
    return result;
  }

  // 1. Try to match a DB session by ID prefix
  const devSessions = await db
    .select({
      id: sessions.id,
      worktreePath: sessions.worktreePath,
      worktreeBranch: sessions.worktreeBranch,
    })
    .from(sessions)
    .where(worktreeSessionCleanupFilter());

  const matched = devSessions.find(
    (s) => s.id.startsWith(prefix) || s.worktreeBranch?.includes(prefix),
  );

  if (matched) {
    // Use stored worktreePath so external-project worktrees are removed from
    // the correct repo root, not from repoRoot (self-dev only).
    if (matched.worktreePath && matched.worktreeBranch) {
      try {
        await removeWorktreeAtPath(matched.worktreePath, matched.worktreeBranch);
      } catch {
        /* may already be removed from disk */
      }
    }
    await db
      .update(sessions)
      .set({
        worktreePath: null,
        worktreeBranch: null,
        updatedAt: new Date(),
      })
      .where(eq(sessions.id, matched.id));
    result.targetCleaned.push(matched.worktreeBranch ?? matched.id.slice(0, 8));
    return result;
  }

  // 2. Try to match an orphan directory on disk
  const worktreesDir = join(repoRoot, '.worktrees');
  const dirName = prefix.startsWith('dev-') ? prefix : `dev-${prefix}`;
  const fullPath = join(worktreesDir, dirName);

  if (existsSync(fullPath)) {
    try {
      await removeGitWorktree(repoRoot, fullPath);
    } catch {
      /* already removed */
    }
    const branchGuess = `dev/${dirName.replace('dev-', '')}`;
    try {
      await deleteGitBranch(repoRoot, branchGuess);
    } catch {
      /* branch may not exist */
    }
    result.targetCleaned.push(dirName);
    return result;
  }

  result.errors.push(`No worktree found matching "${prefix}"`);
  return result;
}
