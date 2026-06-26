import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import { createLogger } from '@open-tag/observability';

const execFileAsync = promisify(execFileCb);
const logger = createLogger('review-request');

const GH_PR_URL_RE = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)$/;

export type ReviewRequestProvider = 'github';
export type ReviewRequestState = 'OPEN' | 'MERGED' | 'CLOSED';

export type ReviewRequestInfo = {
  provider: 'github';
  owner: string;
  repo: string;
  number: string;
  url: string;
};

export function parseReviewRequestUrl(url: string | null): ReviewRequestInfo | null {
  if (!url) return null;

  const githubMatch = GH_PR_URL_RE.exec(url);
  if (githubMatch) {
    const [, owner, repo, number] = githubMatch;
    return { provider: 'github', owner, repo, number, url };
  }

  return null;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function normalizeState(value: unknown): ReviewRequestState | null {
  if (typeof value !== 'string') return null;

  const state = value.trim().toLowerCase();
  if (state === 'open' || state === 'opened') return 'OPEN';
  if (state === 'merged') return 'MERGED';
  if (state === 'closed' || state === 'close') return 'CLOSED';
  return null;
}

export async function getReviewRequestState(
  reviewUrl: string | null,
): Promise<ReviewRequestState | null> {
  const request = parseReviewRequestUrl(reviewUrl);
  if (!request) return null;

  try {
    const { stdout } = await execFileAsync(
      'gh',
      ['pr', 'view', request.url, '--json', 'state', '-q', '.state'],
      { timeout: 10_000 },
    );
    return normalizeState(stdout);
  } catch (err) {
    logger.warn({ err, reviewUrl }, 'Failed to fetch review request state');
    return null;
  }
}
