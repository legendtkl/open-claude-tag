import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchNewPrComments, type PrComment } from '../pr-comment-fetcher.js';
import * as childProcess from 'child_process';

// Mock execFile
vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

const mockExecFile = vi.mocked(childProcess.execFile);

/**
 * gh api --paginate --slurp returns each page as an element of an outer array.
 * Helper to create that format from a flat list of comments.
 */
function slurpOf(comments: PrComment[]): string {
  return JSON.stringify([comments]);
}

function mockExecFileOutputs(issueOut: string, reviewOut: string): void {
  mockExecFile
    .mockImplementationOnce((_cmd, _args, _opts, cb?: unknown) => {
      const callback = cb as (err: null, result: { stdout: string }) => void;
      callback(null, { stdout: issueOut });
      return {} as any;
    })
    .mockImplementationOnce((_cmd, _args, _opts, cb?: unknown) => {
      const callback = cb as (err: null, result: { stdout: string }) => void;
      callback(null, { stdout: reviewOut });
      return {} as any;
    });
}

function mockExecFileError(err: Error): void {
  mockExecFile.mockImplementation((_cmd, _args, _opts, cb?: unknown) => {
    const callback = cb as (err: Error) => void;
    callback(err);
    return {} as any;
  });
}

describe('fetchNewPrComments', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty array for invalid prUrl', async () => {
    const result = await fetchNewPrComments('not-a-url', null);
    expect(result).toEqual([]);
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('returns empty array when no comments match since filter', async () => {
    const issueComments: PrComment[] = [
      {
        id: 1,
        body: 'old comment',
        user: { login: 'reviewer' },
        created_at: '2024-01-01T00:00:00Z',
        html_url: 'https://github.com/owner/repo/pull/1#issuecomment-1',
      },
    ];

    mockExecFileOutputs(slurpOf(issueComments), slurpOf([]));

    const since = new Date('2024-06-01T00:00:00Z');
    const result = await fetchNewPrComments('https://github.com/owner/repo/pull/1', since);
    expect(result).toEqual([]);
  });

  it('returns new comments after since date, capped at 20', async () => {
    const baseTime = new Date('2024-06-01T00:00:00Z');
    const newTime = new Date('2024-07-01T00:00:00Z');

    const issueComments: PrComment[] = Array.from({ length: 25 }, (_, i) => ({
      id: i + 1,
      body: `comment ${i + 1}`,
      user: { login: 'reviewer' },
      created_at: new Date(newTime.getTime() + i * 1000).toISOString(),
      html_url: `https://github.com/owner/repo/pull/1#issuecomment-${i + 1}`,
    }));

    mockExecFileOutputs(slurpOf(issueComments), slurpOf([]));

    const result = await fetchNewPrComments('https://github.com/owner/repo/pull/1', baseTime);
    expect(result).toHaveLength(20);
    expect(result?.[0].id).toBe(1);
    expect(result?.[19].id).toBe(20);
  });

  it('returns all new comments when since is null (first poll)', async () => {
    const issueComments: PrComment[] = [
      {
        id: 1,
        body: 'first review comment',
        user: { login: 'copilot' },
        created_at: '2024-01-01T00:00:00Z',
        html_url: 'https://github.com/owner/repo/pull/1#issuecomment-1',
      },
    ];
    const reviewComments: PrComment[] = [
      {
        id: 2,
        body: 'inline suggestion',
        user: { login: 'human' },
        created_at: '2024-01-02T00:00:00Z',
        html_url: 'https://github.com/owner/repo/pull/1#discussion_r2',
        path: 'src/foo.ts',
        line: 42,
      },
    ];

    mockExecFileOutputs(slurpOf(issueComments), slurpOf(reviewComments));

    const result = await fetchNewPrComments('https://github.com/owner/repo/pull/1', null);
    expect(result).toHaveLength(2);
  });

  it('returns null when gh CLI fails', async () => {
    mockExecFileError(new Error('gh: not found'));
    const result = await fetchNewPrComments('https://github.com/owner/repo/pull/1', null);
    expect(result).toBeNull();
  });

  it('combines issue-level and inline review comments', async () => {
    const since = new Date('2024-01-01T00:00:00Z');
    const issueComments: PrComment[] = [
      {
        id: 10,
        body: 'issue comment',
        user: { login: 'reviewer' },
        created_at: '2024-02-01T00:00:00Z',
        html_url: 'https://github.com/owner/repo/pull/5#issuecomment-10',
      },
    ];
    const reviewComments: PrComment[] = [
      {
        id: 20,
        body: 'inline comment',
        user: { login: 'reviewer2' },
        created_at: '2024-02-02T00:00:00Z',
        html_url: 'https://github.com/owner/repo/pull/5#discussion_r20',
        path: 'src/bar.ts',
        line: 10,
      },
    ];

    mockExecFileOutputs(slurpOf(issueComments), slurpOf(reviewComments));

    const result = await fetchNewPrComments('https://github.com/owner/repo/pull/5', since);
    const comments = result ?? [];
    expect(comments).toHaveLength(2);
    expect(comments.some((c) => c.body === 'issue comment')).toBe(true);
    expect(comments.some((c) => c.body === 'inline comment')).toBe(true);
  });

  it('excludes comments from excludeLogin (bot self-reply filter)', async () => {
    const since = new Date('2024-01-01T00:00:00Z');
    const issueComments: PrComment[] = [
      {
        id: 30,
        body: 'bot reply summary',
        user: { login: 'my-bot' },
        created_at: '2024-02-01T00:00:00Z',
        html_url: 'https://github.com/owner/repo/pull/5#issuecomment-30',
      },
      {
        id: 31,
        body: 'human review',
        user: { login: 'human-reviewer' },
        created_at: '2024-02-02T00:00:00Z',
        html_url: 'https://github.com/owner/repo/pull/5#issuecomment-31',
      },
    ];

    mockExecFileOutputs(slurpOf(issueComments), slurpOf([]));

    const result = await fetchNewPrComments(
      'https://github.com/owner/repo/pull/5',
      since,
      'my-bot',
    );
    const comments = result ?? [];
    expect(comments).toHaveLength(1);
    expect(comments[0].user.login).toBe('human-reviewer');
  });

  it('handles multi-page results by flattening slurp output', async () => {
    const since = new Date('2024-01-01T00:00:00Z');
    const page1: PrComment[] = [
      {
        id: 1,
        body: 'page 1 comment',
        user: { login: 'user1' },
        created_at: '2024-02-01T00:00:00Z',
        html_url: 'https://github.com/owner/repo/pull/9#issuecomment-1',
      },
    ];
    const page2: PrComment[] = [
      {
        id: 2,
        body: 'page 2 comment',
        user: { login: 'user2' },
        created_at: '2024-02-02T00:00:00Z',
        html_url: 'https://github.com/owner/repo/pull/9#issuecomment-2',
      },
    ];

    // Simulate --slurp output with 2 pages
    mockExecFileOutputs(JSON.stringify([page1, page2]), slurpOf([]));

    const result = await fetchNewPrComments('https://github.com/owner/repo/pull/9', since);
    expect(result).toHaveLength(2);
  });
});
