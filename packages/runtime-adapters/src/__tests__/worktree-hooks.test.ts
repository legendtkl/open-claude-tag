import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readFile, chmod } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { exec as execCb } from 'child_process';
import { promisify } from 'util';
import {
  createWorktree,
  removeWorktree,
  removeWorktreeAtPath,
  resolveExternalProjectWorkspace,
} from '../worktree-manager.js';
import { runWorktreeHook } from '../worktree-hooks.js';

const execAsync = promisify(execCb);

async function setupRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'wt-hook-test-'));
  await execAsync(
    'git init && git config user.email "t@t.com" && git config user.name "T" && git commit --allow-empty -m "init" && git branch -M main',
    { cwd: repo },
  );
  return repo;
}

async function cleanupRepo(repo: string): Promise<void> {
  try {
    const { stdout } = await execAsync('git worktree list --porcelain', { cwd: repo });
    const paths = stdout
      .split('\n')
      .filter((l) => l.startsWith('worktree '))
      .map((l) => l.replace('worktree ', ''))
      .filter((p) => p !== repo);
    for (const p of paths) {
      await execAsync(`git worktree remove "${p}" --force`, { cwd: repo }).catch(() => {});
    }
  } catch {
    /* ignore */
  }
  await rm(repo, { recursive: true, force: true });
}

async function writeHook(
  repoRoot: string,
  phase: 'pre' | 'post',
  body: string,
): Promise<string> {
  const dir = join(repoRoot, '.open-claude-tag', 'worktree-hooks');
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${phase}.sh`);
  await writeFile(file, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`);
  await chmod(file, 0o755);
  return file;
}

describe('runWorktreeHook (unit)', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await setupRepo();
  });
  afterEach(async () => {
    await cleanupRepo(repo);
  });

  it('is a no-op when the hook script is absent', async () => {
    await expect(
      runWorktreeHook('pre', {
        sourceRoot: repo,
        worktreePath: repo,
        sessionId: 'session-abc12345',
        branchName: 'dev/abc12345',
      }),
    ).resolves.toBeUndefined();
  });

  it('runs the hook with cwd=worktreePath and standard env vars', async () => {
    // Hook writes the env vars and cwd to a marker file inside the worktree
    await writeHook(
      repo,
      'pre',
      `pwd > marker.cwd
printf '%s' "$WORKTREE_PATH" > marker.wt
printf '%s' "$REPO_ROOT" > marker.repo
printf '%s' "$SESSION_ID" > marker.session
printf '%s' "$BRANCH_NAME" > marker.branch
printf '%s' "$WORKTREE_HOOK_PHASE" > marker.phase`,
    );

    await runWorktreeHook('pre', {
      sourceRoot: repo,
      worktreePath: repo,
      sessionId: 'session-abc12345',
      branchName: 'dev/abc12345',
    });

    expect((await readFile(join(repo, 'marker.wt'), 'utf-8'))).toBe(repo);
    expect((await readFile(join(repo, 'marker.repo'), 'utf-8'))).toBe(repo);
    expect((await readFile(join(repo, 'marker.session'), 'utf-8'))).toBe('session-abc12345');
    expect((await readFile(join(repo, 'marker.branch'), 'utf-8'))).toBe('dev/abc12345');
    expect((await readFile(join(repo, 'marker.phase'), 'utf-8'))).toBe('pre');
  });

  it('throws on pre hook non-zero exit', async () => {
    await writeHook(repo, 'pre', 'exit 7');
    await expect(
      runWorktreeHook('pre', {
        sourceRoot: repo,
        worktreePath: repo,
        sessionId: 'session-abc12345',
        branchName: 'dev/abc12345',
      }),
    ).rejects.toThrow(/pre worktree hook failed/);
  });

  it('swallows post hook non-zero exit and resolves', async () => {
    await writeHook(repo, 'post', 'exit 7');
    await expect(
      runWorktreeHook('post', {
        sourceRoot: repo,
        worktreePath: repo,
        sessionId: 'session-abc12345',
        branchName: 'dev/abc12345',
      }),
    ).resolves.toBeUndefined();
  });
});

describe('createWorktree with hooks', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await setupRepo();
  });
  afterEach(async () => {
    await cleanupRepo(repo);
  });

  it('runs pre hook in the worktree directory', async () => {
    await writeHook(repo, 'pre', 'echo "AKCFG=copied" > .ak-config');
    const wt = await createWorktree('session-abc12345-x', repo);
    expect(existsSync(join(wt.worktreePath, '.ak-config'))).toBe(true);
  });

  it('rolls back the worktree when pre hook fails', async () => {
    await writeHook(repo, 'pre', 'exit 3');
    await expect(createWorktree('session-failhook-x', repo)).rejects.toThrow();

    // Worktree dir and branch must be gone
    const wtPath = join(repo, '.worktrees', 'dev-failhoo');
    expect(existsSync(wtPath)).toBe(false);
    const { stdout } = await execAsync('git branch', { cwd: repo });
    expect(stdout).not.toContain('dev/failhoo');
  });

  it('runs post hook on remove and continues even if it fails', async () => {
    await writeHook(repo, 'post', 'echo gone > /tmp/open-claude-tag-test-post-marker || true; exit 5');
    const wt = await createWorktree('session-postfail-x', repo);
    expect(existsSync(wt.worktreePath)).toBe(true);

    // post hook will exit non-zero, but removal must still complete
    await removeWorktree('session-postfail-x', repo);
    expect(existsSync(wt.worktreePath)).toBe(false);
  });
});

describe('resolveExternalProjectWorkspace with hooks', () => {
  let extRepo: string;

  beforeEach(async () => {
    extRepo = await setupRepo();
  });
  afterEach(async () => {
    await cleanupRepo(extRepo);
  });

  it('runs pre hook for external git project', async () => {
    await writeHook(extRepo, 'pre', 'echo extak > .ak-ext');
    const persist = async () => {};
    const wt = await resolveExternalProjectWorkspace(
      'session-extok123-x',
      extRepo,
      null,
      persist,
    );
    expect(existsSync(join(wt.worktreePath, '.ak-ext'))).toBe(true);
  });

  it('rolls back and bubbles up when pre hook fails for external project', async () => {
    await writeHook(extRepo, 'pre', 'exit 9');
    const persist = async () => {};
    await expect(
      resolveExternalProjectWorkspace('session-extbad12-x', extRepo, null, persist),
    ).rejects.toThrow(/pre worktree hook failed/);

    // Must not silently fall back to projectPath, and worktree must be gone
    const wtPath = join(extRepo, '.worktrees', 'dev-extbad1');
    expect(existsSync(wtPath)).toBe(false);
  });
});

describe('removeWorktreeAtPath with hooks', () => {
  let extRepo: string;

  beforeEach(async () => {
    extRepo = await setupRepo();
  });
  afterEach(async () => {
    await cleanupRepo(extRepo);
  });

  it('runs post hook before deleting the worktree', async () => {
    const wtPath = join(extRepo, '.worktrees', 'dev-rmpath01');
    await mkdir(join(extRepo, '.worktrees'), { recursive: true });
    await execAsync(`git worktree add "${wtPath}" -b "dev/rmpath01" main`, { cwd: extRepo });

    const markerOutside = join(extRepo, 'post-marker.txt');
    await writeHook(
      extRepo,
      'post',
      `printf '%s' "$WORKTREE_PATH" > "${markerOutside}"`,
    );

    await removeWorktreeAtPath(wtPath, 'dev/rmpath01');

    expect(existsSync(wtPath)).toBe(false);
    expect(await readFile(markerOutside, 'utf-8')).toBe(wtPath);
  });
});
