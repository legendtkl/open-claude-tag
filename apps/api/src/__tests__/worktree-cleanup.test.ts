import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks (must be before vi.mock calls) ──────────────────────────────

const { execFileMock, existsSyncMock, readdirSyncMock, removeWorktreeMock, removeWorktreeAtPathMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  existsSyncMock: vi.fn().mockReturnValue(true),
  readdirSyncMock: vi.fn().mockReturnValue([]),
  removeWorktreeMock: vi.fn().mockResolvedValue(undefined),
  removeWorktreeAtPathMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('child_process', () => ({
  exec: vi.fn(),
  execFile: execFileMock,
}));

vi.mock('fs', () => ({
  existsSync: existsSyncMock,
  readdirSync: readdirSyncMock,
}));

vi.mock('@open-tag/runtime-adapters', () => ({
  removeWorktree: removeWorktreeMock,
  removeWorktreeAtPath: removeWorktreeAtPathMock,
}));

import { getPrState, isPrClosed, cleanWorktrees, cleanAllWorktrees, removeWorktreeById } from '../worktree-cleanup.js';
import type { Database } from '@open-tag/storage';
import { cleanStaleWorktrees } from '../worktree-cleanup.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

const VALID_PR_URL = 'https://github.com/owner/repo/pull/42';

/** Make execFile call the last-argument callback with (null, { stdout, stderr }) */
function mockExecFileResult(stdout: string) {
  execFileMock.mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, cb: (err: null, res: { stdout: string; stderr: string }) => void) => {
      cb(null, { stdout, stderr: '' });
    },
  );
}

/** Make execFile call the last-argument callback with an error */
function mockExecFileError(err: Error) {
  execFileMock.mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error) => void) => {
      cb(err);
    },
  );
}

function makeDb(
  sessionRows: { id: string; worktreePath: string; worktreeBranch: string | null; prUrl: string | null }[],
): Database {
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(sessionRows),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    }),
  } as unknown as Database;
}

function makeQueuedDb(selectResults: unknown[]): Database {
  const selectMock = vi.fn();
  for (const rows of selectResults) {
    selectMock.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(rows),
        limit: vi.fn().mockResolvedValue(rows),
      }),
    });
  }
  selectMock.mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue([]),
      limit: vi.fn().mockResolvedValue([]),
    }),
  });

  return {
    select: selectMock,
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    }),
  } as unknown as Database;
}

beforeEach(() => {
  vi.clearAllMocks();
  existsSyncMock.mockReturnValue(true);
  readdirSyncMock.mockReturnValue([]);
  removeWorktreeMock.mockResolvedValue(undefined);
  removeWorktreeAtPathMock.mockResolvedValue(undefined);
});

// ── getPrState ────────────────────────────────────────────────────────────────

describe('getPrState', () => {
  it('returns MERGED when gh reports MERGED', async () => {
    mockExecFileResult('MERGED\n');
    expect(await getPrState(VALID_PR_URL)).toBe('MERGED');
  });

  it('returns CLOSED when gh reports CLOSED', async () => {
    mockExecFileResult('CLOSED\n');
    expect(await getPrState(VALID_PR_URL)).toBe('CLOSED');
  });

  it('returns OPEN when gh reports OPEN', async () => {
    mockExecFileResult('OPEN\n');
    expect(await getPrState(VALID_PR_URL)).toBe('OPEN');
  });

  it('returns null for null prUrl', async () => {
    expect(await getPrState(null)).toBeNull();
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('returns null when gh CLI errors', async () => {
    mockExecFileError(new Error('gh not found'));
    expect(await getPrState(VALID_PR_URL)).toBeNull();
  });

  it('returns null for an unknown state string', async () => {
    mockExecFileResult('UNKNOWN\n');
    expect(await getPrState(VALID_PR_URL)).toBeNull();
  });
});

// ── isPrClosed ────────────────────────────────────────────────────────────────

describe('isPrClosed', () => {
  it('returns true when gh reports CLOSED', async () => {
    mockExecFileResult('CLOSED\n');
    expect(await isPrClosed(VALID_PR_URL)).toBe(true);
  });

  it('returns false when gh reports MERGED', async () => {
    mockExecFileResult('MERGED\n');
    expect(await isPrClosed(VALID_PR_URL)).toBe(false);
  });

  it('returns false when gh reports OPEN', async () => {
    mockExecFileResult('OPEN\n');
    expect(await isPrClosed(VALID_PR_URL)).toBe(false);
  });

  it('returns false for null prUrl', async () => {
    expect(await isPrClosed(null)).toBe(false);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('returns false for an invalid (non-GitHub) URL', async () => {
    expect(await isPrClosed('https://example.com/pr/1')).toBe(false);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('returns false when gh CLI errors', async () => {
    mockExecFileError(new Error('gh not found'));
    expect(await isPrClosed(VALID_PR_URL)).toBe(false);
  });
});

// ── cleanWorktrees: closed PR ─────────────────────────────────────────────────

describe('cleanWorktrees — closed PR', () => {
  it('removes worktree and populates closedCleaned when PR is closed', async () => {
    const session = {
      id: 'session-id-1',
      worktreePath: '/repo/.worktrees/dev-session-id-1',
      worktreeBranch: 'dev/session-id-1',
      prUrl: VALID_PR_URL,
    };
    const db = makeDb([session]);

    // getPrState is called once per session and returns CLOSED
    mockExecFileResult('CLOSED\n');

    const result = await cleanWorktrees(db, '/repo');

    expect(removeWorktreeAtPathMock).toHaveBeenCalledWith(session.worktreePath, session.worktreeBranch);
    expect(result.closedCleaned).toEqual([session.worktreeBranch]);
    expect(result.mergedCleaned).toEqual([]);
  });

  it('removes external-project worktree using stored path (merged PR)', async () => {
    const session = {
      id: 'session-ext00001',
      worktreePath: '/ext/proj/.worktrees/dev-ext00001',
      worktreeBranch: 'dev/ext00001',
      prUrl: VALID_PR_URL,
    };
    const db = makeDb([session]);
    mockExecFileResult('MERGED\n');

    const result = await cleanWorktrees(db, '/repo');

    expect(removeWorktreeAtPathMock).toHaveBeenCalledWith(
      '/ext/proj/.worktrees/dev-ext00001',
      'dev/ext00001',
    );
    expect(result.mergedCleaned).toEqual(['dev/ext00001']);
  });

  it('skips git removal but clears DB for passthrough session (null branch)', async () => {
    const session = {
      id: 'session-pt00001',
      worktreePath: '/ext/proj',
      worktreeBranch: null,
      prUrl: VALID_PR_URL,
    };
    const db = makeDb([session]);
    mockExecFileResult('MERGED\n');

    const result = await cleanWorktrees(db, '/repo');

    expect(removeWorktreeAtPathMock).not.toHaveBeenCalled();
    expect(result.mergedCleaned).toEqual([session.id.slice(0, 8)]);
  });
});

// ── cleanAllWorktrees ─────────────────────────────────────────────────────────

describe('cleanAllWorktrees', () => {
  it('removes external-project worktree using stored path', async () => {
    const session = {
      id: 'session-extall01',
      worktreePath: '/ext/proj/.worktrees/dev-extall01',
      worktreeBranch: 'dev/extall01',
      prUrl: null,
    };
    const db = makeDb([session]);

    const result = await cleanAllWorktrees(db, '/repo');

    expect(removeWorktreeAtPathMock).toHaveBeenCalledWith(
      '/ext/proj/.worktrees/dev-extall01',
      'dev/extall01',
    );
    expect(result.targetCleaned).toEqual(['dev/extall01']);
  });

  it('skips git removal for passthrough session (null branch) in cleanAllWorktrees', async () => {
    const session = {
      id: 'session-ptall001',
      worktreePath: '/ext/proj',
      worktreeBranch: null,
      prUrl: null,
    };
    const db = makeDb([session]);

    await cleanAllWorktrees(db, '/repo');

    expect(removeWorktreeAtPathMock).not.toHaveBeenCalled();
  });
});

// ── removeWorktreeById ────────────────────────────────────────────────────────

describe('removeWorktreeById', () => {
  it('removes external-project worktree by session ID prefix', async () => {
    const session = {
      id: 'session-extbyid1',
      worktreePath: '/ext/proj/.worktrees/dev-extbyid1',
      worktreeBranch: 'dev/extbyid1',
      prUrl: null,
    };
    const db = makeDb([session]);

    const result = await removeWorktreeById(db, '/repo', 'session-extbyid1');

    expect(removeWorktreeAtPathMock).toHaveBeenCalledWith(
      '/ext/proj/.worktrees/dev-extbyid1',
      'dev/extbyid1',
    );
    expect(result.targetCleaned).toEqual(['dev/extbyid1']);
  });

  it('skips git removal for passthrough session (null branch) in removeWorktreeById', async () => {
    const session = {
      id: 'session-ptbyid01',
      worktreePath: '/ext/proj',
      worktreeBranch: null,
      prUrl: null,
    };
    const db = makeDb([session]);

    const result = await removeWorktreeById(db, '/repo', 'session-ptbyid01');

    expect(removeWorktreeAtPathMock).not.toHaveBeenCalled();
    expect(result.targetCleaned).toEqual([session.id.slice(0, 8)]);
  });
});

describe('cleanStaleWorktrees', () => {
  it('preserves fresh worktrees that are within the retention window', async () => {
    const freshSession = {
      id: 'session-fresh-1',
      worktreePath: '/repo/.worktrees/dev-fresh-1',
      worktreeBranch: 'dev/fresh-1',
      projectId: null,
      updatedAt: new Date('2026-04-07T23:59:00Z'), // 1 minute before now, within retention
    };
    const db = makeQueuedDb([[freshSession]]);

    const result = await cleanStaleWorktrees(db, '/repo', 60_000, new Date('2026-04-08T00:00:00Z'));

    expect(removeWorktreeMock).not.toHaveBeenCalled();
    expect(result.targetCleaned).toEqual([]);
    expect(result.orphanDbCleaned).toEqual([]);
    expect(result.staleSkipped).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('removes stale self-dev worktrees', async () => {
    const staleSession = {
      id: 'session-self-1',
      worktreePath: '/repo/.worktrees/dev-self-1',
      worktreeBranch: 'dev/self-1',
      projectId: null,
      updatedAt: new Date('2026-04-01T00:00:00Z'),
    };
    const db = makeQueuedDb([[staleSession]]);

    const result = await cleanStaleWorktrees(db, '/repo', 60_000, new Date('2026-04-08T00:00:00Z'));

    expect(removeWorktreeMock).toHaveBeenCalledWith(staleSession.id, '/repo');
    expect(result.targetCleaned).toEqual([staleSession.worktreeBranch]);
  });

  it('removes stale external-project git worktrees via git and preserves branches', async () => {
    const staleSession = {
      id: 'session-ext-1',
      worktreePath: '/project/.worktrees/dev-ext-1',
      worktreeBranch: 'dev/ext-1',
      projectId: 'project-1',
      updatedAt: new Date('2026-04-01T00:00:00Z'),
    };
    const db = makeQueuedDb([[staleSession], [{ path: '/project' }]]);

    execFileMock.mockImplementation(
      (cmd: string, args: string[], _opts: unknown, cb: (err: null, res: { stdout: string; stderr: string }) => void) => {
        if (cmd === 'git') {
          cb(null, { stdout: '', stderr: '' });
          return;
        }
        cb(null, { stdout: 'OPEN\n', stderr: '' });
      },
    );

    const result = await cleanStaleWorktrees(db, '/repo', 60_000, new Date('2026-04-08T00:00:00Z'));

    expect(execFileMock).toHaveBeenCalledWith(
      'git',
      ['worktree', 'remove', staleSession.worktreePath, '--force'],
      { cwd: '/project' },
      expect.any(Function),
    );
    expect(execFileMock).not.toHaveBeenCalledWith(
      'git',
      ['branch', '-D', staleSession.worktreeBranch],
      expect.anything(),
      expect.any(Function),
    );
    expect(result.targetCleaned).toEqual([staleSession.worktreeBranch]);
  });

  it('skips stale external-project direct-path workspaces', async () => {
    const staleSession = {
      id: 'session-ext-2',
      worktreePath: '/project',
      worktreeBranch: null,
      projectId: 'project-1',
      updatedAt: new Date('2026-04-01T00:00:00Z'),
    };
    const db = makeQueuedDb([[staleSession], [{ path: '/project' }]]);

    const result = await cleanStaleWorktrees(db, '/repo', 60_000, new Date('2026-04-08T00:00:00Z'));

    expect(execFileMock).not.toHaveBeenCalled();
    expect(removeWorktreeMock).not.toHaveBeenCalled();
    expect(result.targetCleaned).toEqual([]);
  });

  it('clears stale bindings when managed worktree path is already missing', async () => {
    const staleSession = {
      id: 'session-self-missing',
      worktreePath: '/repo/.worktrees/dev-missing',
      worktreeBranch: 'dev/missing',
      projectId: null,
      updatedAt: new Date('2026-04-01T00:00:00Z'),
    };
    const db = makeQueuedDb([[staleSession]]);

    existsSyncMock.mockImplementation((path: string) => path !== staleSession.worktreePath);

    const result = await cleanStaleWorktrees(db, '/repo', 60_000, new Date('2026-04-08T00:00:00Z'));

    expect(removeWorktreeMock).not.toHaveBeenCalled();
    expect(result.orphanDbCleaned).toEqual([staleSession.worktreeBranch]);
  });

  it('preserves fresh managed worktrees within the retention window', async () => {
    const freshSession = {
      id: 'session-self-fresh',
      worktreePath: '/repo/.worktrees/dev-fresh',
      worktreeBranch: 'dev/fresh',
      projectId: null,
      updatedAt: new Date('2026-04-07T23:59:30Z'),
    };
    const db = makeQueuedDb([[freshSession]]);

    const result = await cleanStaleWorktrees(db, '/repo', 60_000, new Date('2026-04-08T00:00:00Z'));

    expect(removeWorktreeMock).not.toHaveBeenCalled();
    expect(result.targetCleaned).toEqual([]);
    expect(result.orphanDbCleaned).toEqual([]);
    expect(result.staleSkipped).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('continues cleaning when one stale target fails', async () => {
    const sessions = [
      {
        id: 'session-self-fail',
        worktreePath: '/repo/.worktrees/dev-fail',
        worktreeBranch: 'dev/fail',
        projectId: null,
        updatedAt: new Date('2026-04-01T00:00:00Z'),
      },
      {
        id: 'session-self-ok',
        worktreePath: '/repo/.worktrees/dev-ok',
        worktreeBranch: 'dev/ok',
        projectId: null,
        updatedAt: new Date('2026-04-01T00:00:00Z'),
      },
    ];
    const db = makeQueuedDb([sessions]);

    removeWorktreeMock
      .mockRejectedValueOnce(new Error('cannot remove'))
      .mockResolvedValueOnce(undefined);

    const result = await cleanStaleWorktrees(db, '/repo', 60_000, new Date('2026-04-08T00:00:00Z'));

    expect(result.errors).toHaveLength(1);
    expect(result.targetCleaned).toEqual(['dev/ok']);
  });
});
