import { exec as execCb, execFile as execFileCb } from 'child_process';
import { copyFile, stat, unlink } from 'fs/promises';
import { createHash } from 'crypto';
import { promisify } from 'util';
import { existsSync } from 'fs';
import { join } from 'path';
import { createLogger } from '@open-tag/observability';
import { runWorktreeHook } from './worktree-hooks.js';

// `execAsync` is reserved for static, shell-only commands (`git worktree list
// --porcelain`, `pnpm install`). Anything that interpolates user-controllable
// paths (worktreePath / branch / repoRoot) — or that should stay portable, like
// branch detection — MUST go through `execFileAsync` so no path can break out of
// its quoting and no POSIX-only shell syntax is required.
const execAsync = promisify(execCb);
const execFileAsync = promisify(execFileCb);
const logger = createLogger('worktree-manager');

export interface WorktreeInfo {
  worktreePath: string;
  branchName: string;
}

/**
 * Derive a stable, collision-resistant slug for a session's worktree dir/branch.
 *
 * The input — a UUID (`sessions.id`), or a composite multi-agent workspace key —
 * is hashed in FULL, so two ids that merely share a prefix are now
 * overwhelmingly unlikely to collide on path, branch, cleanup target, or
 * persisted state. (The old `slice(0, 8)` kept just 32 bits of a UUID, and only
 * 16 bits for multi-agent keys whose first 8 chars are agent4+session4 — a
 * birthday collision around ~256 concurrent sessions per agent.) A readable
 * prefix is retained for log/branch correlation, followed by 12 hex of sha256
 * (48 bits, ~50% birthday near 16.7M concurrent) of the full cleaned input.
 *
 * Both `worktreeDir` (`dev-<slug>`) and `branchName` (`dev/<slug>`) derive from
 * this, preserving the dir-vs-branch correspondence the cleanup module's orphan
 * branch-guess relies on (`dev-<slug>` ⇒ `dev/<slug>`).
 *
 * Deliberate one-time migration cost: a session created under the old
 * `dev-<8char>` scheme resolves to a new slug after deploy, so `getWorktree`
 * misses and a fresh worktree is created once (the old one is GC'd by the
 * cleanup module's orphan-disk scan). We accept this bounded cost rather than
 * carry a permanent old-slug fallback; persisted-path reuse
 * (`resolveExternalProjectWorkspace`'s `existingPath` check) is unaffected.
 */
function worktreeSlug(sessionId: string): string {
  const cleaned = sessionId.replace(/^session-/, '');
  const prefix = cleaned.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'sess';
  const hash = createHash('sha256').update(cleaned).digest('hex').slice(0, 12);
  return `${prefix}-${hash}`;
}

function worktreeDir(repoRoot: string, sessionId: string): string {
  return join(repoRoot, '.worktrees', `dev-${worktreeSlug(sessionId)}`);
}

function branchName(sessionId: string): string {
  return `dev/${worktreeSlug(sessionId)}`;
}

/**
 * Resolve the base ref to create a worktree from.
 *
 * Prefers the repo's default branch (`origin/HEAD`), falls back to the current
 * branch, then to `HEAD`. Centralizes the detection used by both
 * `createWorktree` (self-dev) and `resolveExternalProjectWorkspace` (external
 * projects) so neither hardcodes a branch name — this repo defaults to `master`,
 * and others may use `develop` / `trunk`.
 *
 * Each git command runs via `execFileAsync` (no shell), so detection works
 * cross-platform — it avoids the POSIX-only `2>/dev/null` redirection a shell
 * pipeline would need (daemons run on user machines, including Windows).
 */
export async function resolveBaseBranch(repoRoot: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['symbolic-ref', 'refs/remotes/origin/HEAD', '--short'],
      { cwd: repoRoot },
    );
    const branch = stdout.trim().replace(/^origin\//, '');
    if (branch) return branch;
  } catch {
    // origin/HEAD unset (no remote or no default) — fall through to current branch
  }
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: repoRoot,
    });
    return stdout.trim() || 'HEAD';
  } catch {
    return 'HEAD';
  }
}

export async function createWorktree(
  sessionId: string,
  repoRoot: string,
): Promise<WorktreeInfo> {
  const wtPath = worktreeDir(repoRoot, sessionId);
  const branch = branchName(sessionId);

  // Idempotent: if already exists, return existing info
  const existing = await getWorktree(sessionId, repoRoot);
  if (existing) return existing;

  const base = await resolveBaseBranch(repoRoot);
  await execFileAsync('git', ['worktree', 'add', wtPath, '-b', branch, base], {
    cwd: repoRoot,
  });

  // Copy .env from repo root so services in the worktree can load env vars
  const srcEnv = join(repoRoot, '.env');
  if (existsSync(srcEnv)) {
    await copyFile(srcEnv, join(wtPath, '.env'));
  }

  try {
    await runWorktreeHook('pre', {
      sourceRoot: repoRoot,
      worktreePath: wtPath,
      sessionId,
      branchName: branch,
    });
  } catch (err) {
    // Roll back the partially-created worktree so it does not enter a ready
    // state without the resources the hook was meant to provide.
    await execFileAsync('git', ['worktree', 'remove', wtPath, '--force'], { cwd: repoRoot }).catch(() => {});
    await execFileAsync('git', ['branch', '-D', branch], { cwd: repoRoot }).catch(() => {});
    throw err;
  }

  return { worktreePath: wtPath, branchName: branch };
}

export async function getWorktree(
  sessionId: string,
  repoRoot: string,
): Promise<WorktreeInfo | null> {
  const wtPath = worktreeDir(repoRoot, sessionId);

  if (!existsSync(wtPath)) return null;

  // Verify it's still registered with git
  try {
    const { stdout } = await execAsync('git worktree list --porcelain', {
      cwd: repoRoot,
    });
    if (stdout.includes(wtPath)) {
      return { worktreePath: wtPath, branchName: branchName(sessionId) };
    }
  } catch {
    // git command failed
  }

  return null;
}

export async function removeWorktree(
  sessionId: string,
  repoRoot: string,
): Promise<void> {
  const wtPath = worktreeDir(repoRoot, sessionId);
  const branch = branchName(sessionId);

  if (existsSync(wtPath)) {
    await runWorktreeHook('post', {
      sourceRoot: repoRoot,
      worktreePath: wtPath,
      sessionId,
      branchName: branch,
    });
  }

  // Remove .env before deleting the worktree to avoid leaking secrets on disk
  try {
    await unlink(join(wtPath, '.env'));
  } catch {
    // .env may not exist
  }

  try {
    await execFileAsync('git', ['worktree', 'remove', wtPath, '--force'], {
      cwd: repoRoot,
    });
  } catch {
    // Worktree may already be removed
  }

  try {
    await execFileAsync('git', ['branch', '-D', branch], { cwd: repoRoot });
  } catch {
    // Branch may already be deleted
  }
}

/**
 * Remove a worktree by its absolute path and optional branch name.
 *
 * Derives the project root as the grandparent of worktreePath, relying on the
 * convention `<projectRoot>/.worktrees/dev-<slug>` that is enforced by both
 * `createWorktree` (self-dev) and `resolveExternalProjectWorkspace` (external
 * projects).  Only call this with paths that follow that convention.
 *
 * Use this instead of `removeWorktree` when you have the explicit path
 * (e.g. from sessions.worktreePath) and the path may be outside repoRoot.
 */
export async function removeWorktreeAtPath(
  worktreePath: string,
  branchName: string | null,
): Promise<void> {
  const projectRoot = join(worktreePath, '..', '..');

  if (existsSync(worktreePath)) {
    // Derive a session hint from the worktree dir name (`dev-<slug>`) so
    // hook scripts get a stable SESSION_ID env var without changing the API.
    const baseName = worktreePath.split('/').pop() ?? '';
    const sessionHint = baseName.replace(/^dev-/, '');
    await runWorktreeHook('post', {
      sourceRoot: projectRoot,
      worktreePath,
      sessionId: sessionHint,
      branchName,
    });
  }

  // Remove .env before deleting the worktree to avoid leaking secrets on disk
  try {
    await unlink(join(worktreePath, '.env'));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      logger.warn({ err, worktreePath }, 'Unexpected error deleting .env from worktree');
    }
  }

  try {
    await execFileAsync('git', ['worktree', 'remove', worktreePath, '--force'], {
      cwd: projectRoot,
    });
  } catch {
    // Worktree may already be removed
  }

  if (branchName) {
    try {
      await execFileAsync('git', ['branch', '-D', branchName], { cwd: projectRoot });
    } catch {
      // Branch may already be deleted
    }
  }
}

export async function bootstrapWorktree(worktreePath: string): Promise<void> {
  await execAsync('pnpm install --frozen-lockfile', {
    cwd: worktreePath,
    timeout: 120_000,
  });
}

/**
 * Callback to persist workspace info after it's resolved.
 * Decouples worktree-manager from the DB layer.
 */
export type PersistWorkspaceFn = (worktreePath: string, branchName: string | null) => Promise<void>;

/**
 * Resolve (or create) a workspace for an external project session.
 *
 * - If the external project is a git repo: creates a worktree inside it at
 *   `<projectPath>/.worktrees/dev-<slug>` and returns that path.
 * - If the project is NOT a git repo: returns `projectPath` directly.
 *
 * @param sessionId     - Used to derive a stable branch/dir name
 * @param projectPath   - Absolute path to the external project
 * @param existingPath  - Previously persisted worktree path (if any); reused when still on disk
 * @param persist       - Callback to save the resolved path back to the session
 */
export async function resolveExternalProjectWorkspace(
  sessionId: string,
  projectPath: string,
  existingPath: string | null,
  persist: PersistWorkspaceFn,
): Promise<WorktreeInfo> {
  // Return existing worktree if already persisted and still present on disk
  if (existingPath && existsSync(existingPath)) {
    return {
      worktreePath: existingPath,
      branchName: branchName(sessionId),
    };
  }

  // Verify the project path exists and is a directory
  try {
    const s = await stat(projectPath);
    if (!s.isDirectory()) throw new Error('not a directory');
  } catch {
    throw new Error(`External project path does not exist or is not a directory: ${projectPath}`);
  }

  // Try to create a git worktree inside the external repo
  const wtPath = join(projectPath, '.worktrees', `dev-${worktreeSlug(sessionId)}`);
  const branch = branchName(sessionId);

  try {
    const base = await resolveBaseBranch(projectPath);
    await execFileAsync('git', ['worktree', 'add', wtPath, '-b', branch, base], {
      cwd: projectPath,
    });

    try {
      await runWorktreeHook('pre', {
        sourceRoot: projectPath,
        worktreePath: wtPath,
        sessionId,
        branchName: branch,
      });
    } catch (hookErr) {
      // Roll back the partially-created worktree and bubble up — do NOT
      // fall through to the projectPath fallback below, which would let
      // the session proceed without the resources the hook was supposed
      // to set up.
      await execFileAsync('git', ['worktree', 'remove', wtPath, '--force'], { cwd: projectPath }).catch(() => {});
      await execFileAsync('git', ['branch', '-D', branch], { cwd: projectPath }).catch(() => {});
      (hookErr as { __worktreeHookFailure?: boolean }).__worktreeHookFailure = true;
      throw hookErr;
    }

    await persist(wtPath, branch);
    logger.info({ sessionId, wtPath, branch }, 'Created external project worktree');
    return { worktreePath: wtPath, branchName: branch };
  } catch (err) {
    if ((err as { __worktreeHookFailure?: boolean }).__worktreeHookFailure) {
      throw err;
    }
    // If the worktree directory already exists on disk (e.g. branch already existed from a
    // previous session that had its worktreePath cleared), reuse it instead of falling back.
    if (existsSync(wtPath)) {
      logger.info({ sessionId, wtPath }, 'Worktree directory already exists, reusing');
      await persist(wtPath, branch);
      return { worktreePath: wtPath, branchName: branch };
    }
    // Not a git repo or worktree creation failed — use the project path directly
    logger.warn({ sessionId, projectPath, err: String(err) }, 'git worktree failed, using project path directly');
    await persist(projectPath, null);
    return { worktreePath: projectPath, branchName: '' };
  }
}
