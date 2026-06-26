import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import { createLogger } from '@open-tag/observability';
import { parseReviewRequestUrl } from './review-request.js';

const execFileAsync = promisify(execFileCb);
const logger = createLogger('pr-comment-fetcher');

export const MAX_COMMENTS = 20;

export interface PrComment {
  id: number | string;
  body: string;
  user: { login: string };
  created_at: string;
  html_url: string;
  /** Set for inline review comments */
  path?: string;
  line?: number;
}

/**
 * Fetch new PR comments (both issue-level and inline review comments) created
 * after `since`. When `since` is null, all existing comments are returned.
 * Results are capped at MAX_COMMENTS (oldest first) so capped batches can
 * drain across multiple polling cycles without repeating the same newest items.
 *
 * `excludeLogin` filters out comments made by the bot itself to prevent
 * polling loops where the bot's own reply triggers a new resolution task.
 *
 * Returns an empty array if the URL is invalid. Returns null if the `gh` CLI
 * fails so callers do not advance polling cursors on transient failures.
 */
export async function fetchNewPrComments(
  prUrl: string,
  since: Date | null,
  excludeLogin?: string | string[],
): Promise<PrComment[] | null> {
  const request = parseReviewRequestUrl(prUrl);
  if (!request) return [];

  const excludedLogins = new Set(
    (Array.isArray(excludeLogin) ? excludeLogin : [excludeLogin])
      .filter((login): login is string => typeof login === 'string' && login.trim().length > 0)
      .map((login) => login.trim().toLowerCase()),
  );

  try {
    const all = await fetchGithubPrComments(request.owner, request.repo, request.number);
    return filterAndSortComments(all, since, excludedLogins);
  } catch (err) {
    logger.warn({ err, prUrl }, 'Failed to fetch review request comments');
    return null;
  }
}

async function fetchGithubPrComments(
  owner: string,
  repo: string,
  prNumber: string,
): Promise<PrComment[]> {
  const [issueResult, reviewResult] = await Promise.all([
    execFileAsync(
      'gh',
      // --paginate --slurp concatenates multi-page output into a single JSON array
      ['api', `repos/${owner}/${repo}/issues/${prNumber}/comments`, '--paginate', '--slurp'],
      { timeout: 15_000 },
    ),
    execFileAsync(
      'gh',
      ['api', `repos/${owner}/${repo}/pulls/${prNumber}/comments`, '--paginate', '--slurp'],
      { timeout: 15_000 },
    ),
  ]);

  // --slurp wraps each page into an outer array; flatten one level
  const issuePages: PrComment[][] = JSON.parse(issueResult.stdout);
  const reviewPages: PrComment[][] = JSON.parse(reviewResult.stdout);
  const issueComments = issuePages.flat();
  const reviewComments = reviewPages.flat();

  return [...issueComments, ...reviewComments];
}

function filterAndSortComments(
  comments: PrComment[],
  since: Date | null,
  excludedLogins: Set<string>,
): PrComment[] {
  let filtered = comments;

  // Exclude comments made by the authenticated bot to prevent feedback loops.
  if (excludedLogins.size > 0) {
    filtered = filtered.filter((c) => !excludedLogins.has(c.user.login.trim().toLowerCase()));
  }

  filtered = since ? filtered.filter((c) => new Date(c.created_at) > since) : filtered;

  filtered.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  return filtered.slice(0, MAX_COMMENTS);
}
