import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { basename, join } from 'path';
import { tmpdir } from 'os';
import { exec as execCb } from 'child_process';
import { promisify } from 'util';
import type { PersistWorkspaceFn } from '../worktree-manager.js';
import {
  createWorktree,
  getWorktree,
  removeWorktree,
  removeWorktreeAtPath,
  resolveExternalProjectWorkspace,
  resolveBaseBranch,
} from '../worktree-manager.js';

const execAsync = promisify(execCb);

describe('WorktreeManager', () => {
  let tempRepo: string;

  beforeEach(async () => {
    tempRepo = await mkdtemp(join(tmpdir(), 'wt-test-'));
    await execAsync(
      'git init && git config user.email "test@test.com" && git config user.name "Test" && git commit --allow-empty -m "init"',
      { cwd: tempRepo },
    );
    // This repo's default branch is `master` — exercise that case so a
    // hardcoded `main` base ref is caught (regression for #6).
    await execAsync('git branch -M master', { cwd: tempRepo });
  });

  afterEach(async () => {
    // Remove all worktrees first
    try {
      const { stdout } = await execAsync('git worktree list --porcelain', {
        cwd: tempRepo,
      });
      const paths = stdout
        .split('\n')
        .filter((l) => l.startsWith('worktree '))
        .map((l) => l.replace('worktree ', ''))
        .filter((p) => p !== tempRepo);
      for (const p of paths) {
        await execAsync(`git worktree remove "${p}" --force`, {
          cwd: tempRepo,
        }).catch(() => {});
      }
    } catch {
      // ignore
    }
    await rm(tempRepo, { recursive: true, force: true });
  });

  it('createWorktree creates branch and directory', async () => {
    const wt = await createWorktree('session-abc12345-rest', tempRepo);
    expect(existsSync(wt.worktreePath)).toBe(true);
    // Readable prefix + 12-hex sha256 suffix of the full input (#22).
    expect(wt.branchName).toMatch(/^dev\/abc12345-[0-9a-f]{12}$/);
    expect(wt.worktreePath).toContain('dev-abc12345-');
    // Invariant the cleanup orphan branch-guess relies on: branch === 'dev/' +
    // worktree dir basename with the leading 'dev-' stripped.
    const dir = basename(wt.worktreePath);
    expect(wt.branchName).toBe(`dev/${dir.replace(/^dev-/, '')}`);

    const { stdout } = await execAsync('git worktree list', {
      cwd: tempRepo,
    });
    expect(stdout).toContain('dev-abc12345-');
  });

  it('getWorktree returns info for existing worktree', async () => {
    await createWorktree('session-abc12345-rest', tempRepo);
    const wt = await getWorktree('session-abc12345-rest', tempRepo);
    expect(wt).not.toBeNull();
    expect(wt!.branchName).toMatch(/^dev\/abc12345-[0-9a-f]{12}$/);
  });

  it('getWorktree returns null for non-existent worktree', async () => {
    const wt = await getWorktree('session-nonexist0-rest', tempRepo);
    expect(wt).toBeNull();
  });

  it('removeWorktree cleans up branch and directory', async () => {
    const wt = await createWorktree('session-abc12345-rest', tempRepo);
    expect(existsSync(wt.worktreePath)).toBe(true);

    await removeWorktree('session-abc12345-rest', tempRepo);
    expect(existsSync(wt.worktreePath)).toBe(false);

    const { stdout } = await execAsync('git branch', { cwd: tempRepo });
    expect(stdout).not.toContain('dev/abc12345');
  });

  it('createWorktree is idempotent (reuses existing)', async () => {
    const wt1 = await createWorktree('session-abc12345-rest', tempRepo);
    const wt2 = await createWorktree('session-abc12345-rest', tempRepo);
    expect(wt1.worktreePath).toBe(wt2.worktreePath);
    expect(wt1.branchName).toBe(wt2.branchName);
  });

  it('createWorktree copies .env from repo root to worktree', async () => {
    await writeFile(join(tempRepo, '.env'), 'SECRET=abc123');
    const wt = await createWorktree('session-abc12345-rest', tempRepo);
    const content = await readFile(join(wt.worktreePath, '.env'), 'utf-8');
    expect(content).toBe('SECRET=abc123');
  });

  it('removeWorktree deletes .env from worktree', async () => {
    await writeFile(join(tempRepo, '.env'), 'SECRET=abc123');
    const wt = await createWorktree('session-abc12345-rest', tempRepo);
    expect(existsSync(join(wt.worktreePath, '.env'))).toBe(true);

    await removeWorktree('session-abc12345-rest', tempRepo);
    expect(existsSync(wt.worktreePath)).toBe(false);
  });

  // Regression for #22: two sessions sharing the first 8 chars (the old 32-bit
  // discriminator) must NOT collide on path/branch, and removing one must leave
  // the other intact.
  it('does not collide for ids sharing the first 8 characters', async () => {
    const a = await createWorktree('aabbccdd-1111-1111-1111-111111111111', tempRepo);
    const b = await createWorktree('aabbccdd-2222-2222-2222-222222222222', tempRepo);
    expect(a.worktreePath).not.toBe(b.worktreePath);
    expect(a.branchName).not.toBe(b.branchName);
    expect(existsSync(a.worktreePath)).toBe(true);
    expect(existsSync(b.worktreePath)).toBe(true);

    await removeWorktree('aabbccdd-1111-1111-1111-111111111111', tempRepo);
    expect(existsSync(a.worktreePath)).toBe(false);
    // The sibling worktree and its branch survive the removal.
    expect(existsSync(b.worktreePath)).toBe(true);
    const { stdout } = await execAsync('git branch', { cwd: tempRepo });
    expect(stdout).toContain(b.branchName);
  });

  it('derives a deterministic, idempotent slug from the full id', async () => {
    const id = 'aabbccdd-1111-2222-3333-444455556666';
    const first = await createWorktree(id, tempRepo);
    const again = await createWorktree(id, tempRepo); // idempotent reuse
    expect(again.worktreePath).toBe(first.worktreePath);
    expect(again.branchName).toBe(first.branchName);
    expect(first.branchName).toMatch(/^dev\/aabbccdd-[0-9a-f]{12}$/);
  });
});

// ── resolveBaseBranch (regression for #6) ──

describe('resolveBaseBranch', () => {
  let repo: string;
  let nonGit: string;

  afterEach(async () => {
    if (repo) await rm(repo, { recursive: true, force: true });
    if (nonGit) await rm(nonGit, { recursive: true, force: true });
  });

  it('returns the current branch when origin/HEAD is unset', async () => {
    repo = await mkdtemp(join(tmpdir(), 'rbb-cur-'));
    await execAsync(
      'git init && git config user.email "t@t.com" && git config user.name "T" && git commit --allow-empty -m init && git branch -M trunk',
      { cwd: repo },
    );
    expect(await resolveBaseBranch(repo)).toBe('trunk');
  });

  it('prefers origin/HEAD and strips the origin/ prefix', async () => {
    const originRepo = await mkdtemp(join(tmpdir(), 'rbb-origin-'));
    repo = await mkdtemp(join(tmpdir(), 'rbb-clone-'));
    try {
      await execAsync(
        'git init && git config user.email "t@t.com" && git config user.name "T" && git commit --allow-empty -m init && git branch -M develop',
        { cwd: originRepo },
      );
      // Clone so origin/HEAD is populated, then verify detection.
      await execAsync(`git clone "${originRepo}" "${repo}"`, { cwd: tmpdir() });
      await execAsync('git remote set-head origin develop', { cwd: repo });
      expect(await resolveBaseBranch(repo)).toBe('develop');
    } finally {
      await rm(originRepo, { recursive: true, force: true });
    }
  });

  it('falls back to HEAD for a non-git directory', async () => {
    nonGit = await mkdtemp(join(tmpdir(), 'rbb-nongit-'));
    expect(await resolveBaseBranch(nonGit)).toBe('HEAD');
  });
});

// ── createWorktree base branch matrix (regression for #6) ──

describe('createWorktree base branch detection', () => {
  for (const base of ['master', 'main', 'develop', 'trunk']) {
    it(`creates a worktree when the default branch is ${base}`, async () => {
      const repo = await mkdtemp(join(tmpdir(), `cw-${base}-`));
      try {
        await execAsync(
          `git init && git config user.email "t@t.com" && git config user.name "T" && git commit --allow-empty -m init && git branch -M ${base}`,
          { cwd: repo },
        );
        const wt = await createWorktree('session-base1234-x', repo);
        expect(existsSync(wt.worktreePath)).toBe(true);
        expect(wt.branchName).toMatch(/^dev\/base1234-[0-9a-f]{12}$/);
      } finally {
        await execAsync('git worktree prune', { cwd: repo }).catch(() => {});
        await rm(repo, { recursive: true, force: true });
      }
    });
  }
});

// ── removeWorktreeAtPath ──

describe('removeWorktreeAtPath', () => {
  let projectRepo: string;

  beforeEach(async () => {
    projectRepo = await mkdtemp(join(tmpdir(), 'rm-wt-test-'));
    await execAsync(
      'git init && git config user.email "test@test.com" && git config user.name "Test" && git commit --allow-empty -m "init" && git branch -M main',
      { cwd: projectRepo },
    );
  });

  afterEach(async () => {
    try {
      const { stdout } = await execAsync('git worktree list --porcelain', { cwd: projectRepo });
      const paths = stdout
        .split('\n')
        .filter((l) => l.startsWith('worktree '))
        .map((l) => l.replace('worktree ', ''))
        .filter((p) => p !== projectRepo);
      for (const p of paths) {
        await execAsync(`git worktree remove "${p}" --force`, { cwd: projectRepo }).catch(() => {});
      }
    } catch { /* ignore */ }
    await rm(projectRepo, { recursive: true, force: true });
  });

  it('removes a self-dev style worktree using derived projectRoot', async () => {
    // Create worktree inside projectRepo (same structure as OpenClaudeTag self-dev)
    const wtPath = join(projectRepo, '.worktrees', 'dev-abc12345');
    await mkdir(wtPath, { recursive: true });
    await execAsync(`git worktree add "${wtPath}" -b "dev/abc12345" main`, { cwd: projectRepo });

    await removeWorktreeAtPath(wtPath, 'dev/abc12345');

    expect(existsSync(wtPath)).toBe(false);
    const { stdout } = await execAsync('git branch', { cwd: projectRepo });
    expect(stdout).not.toContain('dev/abc12345');
  });

  it('removes an external-project worktree by deriving correct projectRoot', async () => {
    // Simulate external project with worktree at <extProject>/.worktrees/dev-extabc1
    const wtPath = join(projectRepo, '.worktrees', 'dev-extabc1');
    await mkdir(wtPath, { recursive: true });
    await execAsync(`git worktree add "${wtPath}" -b "dev/extabc1" main`, { cwd: projectRepo });

    // removeWorktreeAtPath must figure out cwd=projectRepo from the path alone
    await removeWorktreeAtPath(wtPath, 'dev/extabc1');

    expect(existsSync(wtPath)).toBe(false);
    const { stdout } = await execAsync('git branch', { cwd: projectRepo });
    expect(stdout).not.toContain('dev/extabc1');
  });

  it('skips branch deletion when branchName is null', async () => {
    const wtPath = join(projectRepo, '.worktrees', 'dev-nob12345');
    await mkdir(wtPath, { recursive: true });
    await execAsync(`git worktree add "${wtPath}" -b "dev/nob12345" main`, { cwd: projectRepo });

    // Should not throw even though branchName is null
    await removeWorktreeAtPath(wtPath, null);

    expect(existsSync(wtPath)).toBe(false);
    // Branch should still exist since we passed null
    const { stdout } = await execAsync('git branch', { cwd: projectRepo });
    expect(stdout).toContain('dev/nob12345');
  });

  it('deletes .env from worktree before removal', async () => {
    const wtPath = join(projectRepo, '.worktrees', 'dev-env12345');
    await mkdir(wtPath, { recursive: true });
    await execAsync(`git worktree add "${wtPath}" -b "dev/env12345" main`, { cwd: projectRepo });
    await writeFile(join(wtPath, '.env'), 'SECRET=test');

    await removeWorktreeAtPath(wtPath, 'dev/env12345');

    // Worktree directory gone — .env is gone with it
    expect(existsSync(wtPath)).toBe(false);
  });

  it('does not throw when worktree is already removed', async () => {
    const nonExistentPath = join(projectRepo, '.worktrees', 'dev-gone1234');
    await expect(removeWorktreeAtPath(nonExistentPath, 'dev/gone1234')).resolves.not.toThrow();
  });
});

// ── resolveExternalProjectWorkspace ──

describe('resolveExternalProjectWorkspace', () => {
  let externalGitRepo: string;
  let nonGitDir: string;
  let persist: PersistWorkspaceFn;

  beforeEach(async () => {
    persist = vi.fn().mockResolvedValue(undefined);

    // Set up a git repo to use as external project
    externalGitRepo = await mkdtemp(join(tmpdir(), 'ext-git-'));
    await execAsync(
      'git init && git config user.email "test@test.com" && git config user.name "Test" && git commit --allow-empty -m "init" && git branch -M main',
      { cwd: externalGitRepo },
    );

    // Set up a plain directory (non-git)
    nonGitDir = await mkdtemp(join(tmpdir(), 'ext-plain-'));
  });

  afterEach(async () => {
    // Clean up worktrees in external git repo
    try {
      const { stdout } = await execAsync('git worktree list --porcelain', { cwd: externalGitRepo });
      const paths = stdout
        .split('\n')
        .filter((l) => l.startsWith('worktree '))
        .map((l) => l.replace('worktree ', ''))
        .filter((p) => p !== externalGitRepo);
      for (const p of paths) {
        await execAsync(`git worktree remove "${p}" --force`, { cwd: externalGitRepo }).catch(() => {});
      }
    } catch { /* ignore */ }
    await rm(externalGitRepo, { recursive: true, force: true });
    await rm(nonGitDir, { recursive: true, force: true });
  });

  it('creates worktree inside external git repo', async () => {
    const result = await resolveExternalProjectWorkspace('session-ext12345-x', externalGitRepo, null, persist);

    expect(existsSync(result.worktreePath)).toBe(true);
    expect(result.worktreePath).toContain(externalGitRepo);
    expect(result.worktreePath).toContain('dev-');
    expect(result.branchName).toMatch(/^dev\//);
    expect(persist).toHaveBeenCalledWith(result.worktreePath, result.branchName);
  });

  it('returns project path directly for non-git directory', async () => {
    const result = await resolveExternalProjectWorkspace('session-ext12345-x', nonGitDir, null, persist);

    expect(result.worktreePath).toBe(nonGitDir);
    expect(result.branchName).toBe('');
    expect(persist).toHaveBeenCalledWith(nonGitDir, null);
  });

  it('reuses existing worktree path from session if still on disk', async () => {
    const existingWt = join(externalGitRepo, '.worktrees', 'dev-preexist');
    await mkdir(existingWt, { recursive: true });

    const result = await resolveExternalProjectWorkspace('session-ext12345-x', externalGitRepo, existingWt, persist);

    expect(result.worktreePath).toBe(existingWt);
    // persist should NOT be called when reusing an existing path
    expect(persist).not.toHaveBeenCalled();
  });

  it('throws for a non-existent project path', async () => {
    await expect(
      resolveExternalProjectWorkspace('session-ext12345-x', '/does/not/exist', null, persist),
    ).rejects.toThrow('does not exist or is not a directory');
  });
});
