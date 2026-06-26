import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PrPollingService } from '../pr-polling-service.js';
import { MAX_COMMENTS } from '../pr-comment-fetcher.js';
import type { Database } from '@open-tag/storage';
import type { TaskQueue } from '@open-tag/queue';

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../pr-comment-fetcher.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../pr-comment-fetcher.js')>();
  return {
    ...actual,
    fetchNewPrComments: vi.fn(),
  };
});

vi.mock('../worktree-cleanup.js', () => ({
  getPrState: vi.fn(),
}));

// start() resolves bot logins via the `gh` subprocess; never spawn
// real CLIs (or hit the network) from a unit test.
vi.mock('child_process', () => ({
  execFile: vi.fn((...args: unknown[]) => {
    const callback = [...args]
      .reverse()
      .find((arg): arg is (err: Error | null, stdout: string, stderr: string) => void =>
        typeof arg === 'function',
      );
    callback?.(new Error('child_process disabled in unit tests'), '', '');
    return {};
  }),
}));

import { fetchNewPrComments } from '../pr-comment-fetcher.js';
import { getPrState } from '../worktree-cleanup.js';

const mockFetch = vi.mocked(fetchNewPrComments);
const mockGetPrState = vi.mocked(getPrState);

function makeDb(sessions: unknown[], taskContext: unknown[] = []): Database {
  const selectResults = [sessions, taskContext];
  const insertedRows: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];
  const takeNext = () => selectResults.shift() ?? [];
  const selectChain = {
    from: () => selectChain,
    where: () => selectChain,
    orderBy: () => selectChain,
    limit: async () => takeNext(),
    then: (resolve: (value: unknown[]) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(takeNext()).then(resolve, reject),
  };

  return {
    select: vi.fn(() => selectChain),
    update: vi.fn().mockImplementation(() => ({
      set: vi.fn().mockImplementation((values: Record<string, unknown>) => {
        updates.push(values);
        return {
          where: vi.fn().mockResolvedValue([]),
        };
      }),
    })),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockImplementation((row: Record<string, unknown>) => {
        insertedRows.push(row);
        return Promise.resolve([]);
      }),
    }),
    _insertedRows: insertedRows,
    _updates: updates,
  } as unknown as Database;
}

function makeQueue(): TaskQueue {
  return {
    enqueue: vi.fn().mockResolvedValue('job-id-1'),
  } as unknown as TaskQueue;
}

const SESSION = {
  id: 'sess-1',
  chatId: 'oc_chat_1',
  prUrl: 'https://github.com/owner/repo/pull/42',
  prLastPolledAt: null,
  sdkSessionId: null,
  runtimeBackend: 'claude_code',
};

const COMMENT = {
  id: 1,
  body: 'Please fix this function',
  user: { login: 'reviewer1' },
  created_at: '2024-07-01T10:00:00Z',
  html_url: 'https://github.com/owner/repo/pull/42#issuecomment-1',
};

// ── Tests ────────────────────────────────────────────────────────────────────

describe('PrPollingService', () => {
  const originalGhBotLogin = process.env.GH_BOT_LOGIN;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetPrState.mockResolvedValue('OPEN');
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalGhBotLogin === undefined) {
      delete process.env.GH_BOT_LOGIN;
    } else {
      process.env.GH_BOT_LOGIN = originalGhBotLogin;
    }
  });

  it('skips poll when no sessions have prUrl', async () => {
    const db = makeDb([]);
    const queue = makeQueue();
    const svc = new PrPollingService(db, queue);

    await svc.pollOnce();

    expect(mockFetch).not.toHaveBeenCalled();
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it('skips session with merged PR', async () => {
    const db = makeDb([SESSION]);
    const queue = makeQueue();
    mockGetPrState.mockResolvedValue('MERGED');

    const svc = new PrPollingService(db, queue);
    await svc.pollOnce();

    expect(mockFetch).not.toHaveBeenCalled();
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it('enqueues task when new comments are found', async () => {
    const db = makeDb([SESSION]);
    const queue = makeQueue();
    mockFetch.mockResolvedValue([COMMENT]);

    const svc = new PrPollingService(db, queue);
    await svc.pollOnce();

    expect(queue.enqueue).toHaveBeenCalledOnce();
    const jobArg = (queue.enqueue as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(jobArg.sessionId).toBe('sess-1');
    expect(jobArg.goal).toContain('https://github.com/owner/repo/pull/42');
    expect(jobArg.goal).toContain('reviewer1');
    expect(jobArg.goal).toContain('Please fix this function');
  });

  it('inherits the latest task agent identity and lets worker choose runtime from agent state', async () => {
    const db = makeDb(
      [SESSION],
      [
        {
          id: 'task-original',
          agentId: 'agent-1',
          feishuAppId: 'app-1',
          runtimeHint: 'auto',
        },
      ],
    );
    const queue = makeQueue();
    mockFetch.mockResolvedValue([COMMENT]);

    const svc = new PrPollingService(db, queue);
    await svc.pollOnce();

    expect(queue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-1',
        feishuAppId: 'app-1',
        runtimeHint: 'auto',
        sdkSessionId: undefined,
        runtimeBackend: undefined,
        constraints: expect.objectContaining({
          agentId: 'agent-1',
          feishuAppId: 'app-1',
        }),
      }),
    );
    const inserted = (db as unknown as { _insertedRows: Record<string, unknown>[] })
      ._insertedRows[0];
    expect(inserted).toMatchObject({
      agentId: 'agent-1',
      feishuAppId: 'app-1',
      parentTaskId: 'task-original',
      runtimeHint: 'auto',
    });
  });

  it('does not enqueue task when no new comments', async () => {
    const db = makeDb([SESSION]);
    const queue = makeQueue();
    mockFetch.mockResolvedValue([]);

    const svc = new PrPollingService(db, queue);
    await svc.pollOnce();

    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it('inserts the follow-up task before enqueueing and updates prLastPolledAt last', async () => {
    const db = makeDb([SESSION]);
    const queue = makeQueue();
    mockFetch.mockResolvedValue([COMMENT]);

    const callOrder: string[] = [];
    (db.update as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      set: vi.fn().mockImplementation((values: Record<string, unknown>) => ({
        where: vi.fn().mockImplementation(() => {
          if ('prLastPolledAt' in values) {
            callOrder.push('update');
          }
          return Promise.resolve([]);
        }),
      })),
    }));
    (db.insert as ReturnType<typeof vi.fn>).mockReturnValue({
      values: vi.fn().mockImplementation(() => {
        callOrder.push('insert');
        return Promise.resolve([]);
      }),
    });
    (queue.enqueue as ReturnType<typeof vi.fn>).mockImplementation(() => {
      callOrder.push('enqueue');
      return Promise.resolve('job-1');
    });

    const svc = new PrPollingService(db, queue);
    await svc.pollOnce();

    expect(callOrder).toEqual(['insert', 'enqueue', 'update']);
  });

  it('start() and stop() register/clear the interval', async () => {
    process.env.GH_BOT_LOGIN = 'open-claude-tag-bot';
    vi.useFakeTimers();
    const db = makeDb([]);
    const queue = makeQueue();
    const svc = new PrPollingService(db, queue, 1000);

    await svc.start();
    expect((svc as any).timer).not.toBeNull();

    svc.stop();
    expect((svc as any).timer).toBeNull();
  });

  it('cancels the inserted task and leaves prLastPolledAt unchanged when enqueue fails', async () => {
    const db = makeDb([SESSION]);
    const queue = {
      enqueue: vi.fn().mockRejectedValue(new Error('Failed to enqueue task task-1')),
    } as unknown as TaskQueue;
    mockFetch.mockResolvedValue([COMMENT]);

    const svc = new PrPollingService(db, queue);
    await svc.pollOnce();

    expect(db.insert).toHaveBeenCalled();
    const updates = (db as unknown as { _updates: Record<string, unknown>[] })._updates;
    expect(updates).toContainEqual(
      expect.objectContaining({
        status: 'cancelled',
        errorMessage: 'Queue enqueue failed',
      }),
    );
    expect(updates.some((update) => 'prLastPolledAt' in update)).toBe(false);
    expect(queue.enqueue).toHaveBeenCalled();
  });

  it('does not advance prLastPolledAt when comment fetch fails', async () => {
    const db = makeDb([SESSION]);
    const queue = makeQueue();
    mockFetch.mockResolvedValue(null);

    const svc = new PrPollingService(db, queue);
    await svc.pollOnce();

    expect(queue.enqueue).not.toHaveBeenCalled();
    const updates = (db as unknown as { _updates: Record<string, unknown>[] })._updates;
    expect(updates.some((update) => 'prLastPolledAt' in update)).toBe(false);
  });

  it('sets prLastPolledAt to newest processed comment timestamp when cap is hit', async () => {
    // Generate MAX_COMMENTS comments (exactly at the cap)
    const baseDate = new Date('2024-07-01T00:00:00Z');
    const comments: typeof COMMENT[] = Array.from({ length: MAX_COMMENTS }, (_, i) => ({
      id: i + 1,
      body: `comment ${i + 1}`,
      user: { login: 'reviewer' },
      created_at: new Date(baseDate.getTime() + i * 1000).toISOString(),
      html_url: `https://github.com/owner/repo/pull/42#issuecomment-${i + 1}`,
    }));

    const db = makeDb([SESSION]);
    const queue = makeQueue();
    mockFetch.mockResolvedValue(comments);

    let capturedSet: Record<string, unknown> = {};
    (db.update as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      set: vi.fn().mockImplementation((vals: Record<string, unknown>) => {
        capturedSet = vals;
        return { where: vi.fn().mockResolvedValue([]) };
      }),
    }));

    const svc = new PrPollingService(db, queue);
    await svc.pollOnce();

    const expectedTs = new Date(comments[comments.length - 1].created_at);
    expect((capturedSet.prLastPolledAt as Date).getTime()).toBe(expectedTs.getTime());
  });
});
