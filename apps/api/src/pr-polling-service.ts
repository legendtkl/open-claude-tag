import { randomUUID } from 'crypto';
import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import { createLogger } from '@open-tag/observability';
import { sessions, tasks } from '@open-tag/storage';
import { desc, isNotNull, eq } from 'drizzle-orm';
import { IntentType, TaskStatus } from '@open-tag/core-types';
import type { Database } from '@open-tag/storage';
import type { TaskQueue } from '@open-tag/queue';
import { fetchNewPrComments } from './pr-comment-fetcher.js';
import { getPrState } from './worktree-cleanup.js';
import type { PrComment } from './pr-comment-fetcher.js';

const execFileAsync = promisify(execFileCb);
const logger = createLogger('pr-polling');

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Resolve the GitHub login of the currently authenticated `gh` CLI user.
 * Used to exclude the bot's own reply comments from future polls.
 * Returns undefined if the call fails (polling will continue without filtering).
 */
async function resolveGhBotLogin(): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('gh', ['api', 'user', '-q', '.login'], {
      timeout: 10_000,
    });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

function computeNextPolledAt(comments: PrComment[], pollStartedAt: Date): Date {
  if (comments.length === 0) return pollStartedAt;

  const latestProcessedAt = comments.reduce<number | null>((latest, comment) => {
    const ts = new Date(comment.created_at).getTime();
    if (!Number.isFinite(ts)) return latest;
    return latest === null || ts > latest ? ts : latest;
  }, null);

  return latestProcessedAt === null ? pollStartedAt : new Date(latestProcessedAt);
}

/**
 * Background service that polls open review requests attached to sessions and
 * enqueues resolution tasks when new review comments are detected.
 */
export class PrPollingService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private botLogins: string[] = [];

  constructor(
    private readonly db: Database,
    private readonly queue: TaskQueue,
    private readonly intervalMs: number = parseInt(
      process.env.PR_POLLING_INTERVAL_MS ?? String(DEFAULT_INTERVAL_MS),
      10,
    ),
  ) {}

  async start(): Promise<void> {
    if (this.timer) return;
    // Resolve bot login once at startup to filter own comments on every poll.
    this.botLogins = [
      process.env.REVIEW_BOT_LOGIN,
      process.env.GH_BOT_LOGIN,
      await resolveGhBotLogin(),
    ].filter((login): login is string => typeof login === 'string' && login.trim().length > 0);
    if (this.botLogins.length > 0) {
      logger.info(
        { botLoginCount: this.botLogins.length },
        'Review request polling will exclude bot comments',
      );
    }
    this.timer = setInterval(() => {
      this.pollOnce().catch((err) => {
        logger.error({ err }, 'Review request polling tick failed');
      });
    }, this.intervalMs);
    logger.info({ intervalMs: this.intervalMs }, 'Review request polling service started');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    logger.info('Review request polling service stopped');
  }

  /**
   * Run a single poll cycle: check all sessions with a review request URL for new comments.
   */
  async pollOnce(): Promise<void> {
    const activeSessions = await this.db
      .select({
        id: sessions.id,
        chatId: sessions.chatId,
        prUrl: sessions.prUrl,
        prLastPolledAt: sessions.prLastPolledAt,
        sdkSessionId: sessions.sdkSessionId,
        runtimeBackend: sessions.runtimeBackend,
      })
      .from(sessions)
      .where(isNotNull(sessions.prUrl));

    if (activeSessions.length === 0) return;

    logger.debug({ count: activeSessions.length }, 'Polling sessions for review request comments');

    for (const session of activeSessions) {
      try {
        await this.processSession(session);
      } catch (err) {
        logger.error({ err, sessionId: session.id }, 'Failed to poll session review request');
      }
    }
  }

  private async processSession(session: {
    id: string;
    chatId: string;
    prUrl: string | null;
    prLastPolledAt: Date | null;
    sdkSessionId: string | null;
    runtimeBackend: string | null;
  }): Promise<void> {
    if (!session.prUrl) return;

    const prState = await getPrState(session.prUrl);
    if (prState === 'MERGED' || prState === 'CLOSED') {
      logger.debug(
        { sessionId: session.id, prUrl: session.prUrl, prState },
        'Review request merged or closed, skipping poll',
      );
      return;
    }

    const pollStartedAt = new Date();
    const newComments = await fetchNewPrComments(
      session.prUrl,
      session.prLastPolledAt,
      this.botLogins,
    );
    if (newComments === null) {
      logger.debug(
        { sessionId: session.id },
        'Review request comment fetch failed; cursor unchanged',
      );
      return;
    }

    // The fetcher returns the oldest unprocessed comments first. Advance only
    // to a timestamp we know has been processed so comments arriving during the
    // provider call remain eligible on the next tick.
    const nextPolledAt = computeNextPolledAt(newComments, pollStartedAt);

    if (newComments.length === 0) {
      await this.advanceSessionPoll(session.id, nextPolledAt);
      logger.debug({ sessionId: session.id }, 'No new review request comments');
      return;
    }

    logger.info(
      { sessionId: session.id, prUrl: session.prUrl, commentCount: newComments.length },
      'New review request comments found, enqueueing resolution task',
    );

    const taskId = randomUUID();
    const goal = buildResolutionTaskGoal(session.prUrl, newComments);
    const taskContext = await this.loadLatestTaskContext(session.id);
    const runtimeHint = taskContext?.runtimeHint ?? null;
    const agentId = taskContext?.agentId ?? undefined;
    const feishuAppId = taskContext?.feishuAppId ?? undefined;

    await this.db.insert(tasks).values({
      id: taskId,
      sessionId: session.id,
      agentId: taskContext?.agentId ?? null,
      feishuAppId: taskContext?.feishuAppId ?? null,
      parentTaskId: taskContext?.id ?? null,
      taskType: IntentType.SELF_DEV,
      goal,
      runtimeHint,
      status: TaskStatus.QUEUED,
      constraints: {
        chatId: session.chatId,
        timeoutSec: 1800,
        ...(agentId ? { agentId } : {}),
        ...(feishuAppId ? { feishuAppId } : {}),
      },
    });

    let jobId: string | null;
    try {
      jobId = await this.queue.enqueue({
        taskId,
        sessionId: session.id,
        agentId,
        feishuAppId,
        taskType: IntentType.SELF_DEV,
        goal,
        runtimeHint,
        constraints: {
          chatId: session.chatId,
          ...(agentId ? { agentId } : {}),
          ...(feishuAppId ? { feishuAppId } : {}),
        },
        sdkSessionId: agentId ? undefined : (session.sdkSessionId ?? undefined),
        runtimeBackend: agentId ? undefined : (session.runtimeBackend ?? undefined),
      });
    } catch (err) {
      await this.cancelInsertedReviewTask(taskId, 'Queue enqueue failed');
      throw err;
    }

    if (!jobId) {
      // singletonKey collision: another task is already queued/running for this session.
      // Leave prLastPolledAt unchanged so these comments are retried on the next poll.
      await this.cancelInsertedReviewTask(
        taskId,
        'Another task is already queued for this session',
      );
      logger.debug(
        { sessionId: session.id },
        'Task already queued for session, skipping review comment task insertion',
      );
      return;
    }

    await this.advanceSessionPoll(session.id, nextPolledAt);
  }

  private async advanceSessionPoll(sessionId: string, nextPolledAt: Date): Promise<void> {
    await this.db
      .update(sessions)
      .set({ prLastPolledAt: nextPolledAt, updatedAt: new Date() })
      .where(eq(sessions.id, sessionId));
  }

  private async cancelInsertedReviewTask(taskId: string, reason: string): Promise<void> {
    await this.db
      .update(tasks)
      .set({
        status: TaskStatus.CANCELLED,
        errorMessage: reason,
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, taskId));
  }

  private async loadLatestTaskContext(sessionId: string): Promise<{
    id: string;
    agentId: string | null;
    feishuAppId: string | null;
    runtimeHint: string | null;
  } | null> {
    const [taskContext] = await this.db
      .select({
        id: tasks.id,
        agentId: tasks.agentId,
        feishuAppId: tasks.feishuAppId,
        runtimeHint: tasks.runtimeHint,
      })
      .from(tasks)
      .where(eq(tasks.sessionId, sessionId))
      .orderBy(desc(tasks.createdAt))
      .limit(1);

    return taskContext ?? null;
  }
}

/**
 * Build the task goal string that instructs the agent to review and address
 * the given PR comments.
 */
export function buildResolutionTaskGoal(prUrl: string, comments: PrComment[]): string {
  const commentBlock = comments
    .map((c) => {
      const location = c.path ? ` (${c.path}${c.line ? `:${c.line}` : ''})` : '';
      return `[${c.user.login}${location} at ${c.created_at}]:\n${c.body}`;
    })
    .join('\n---\n');

  return `Continue the existing task session and address review comments on this GitHub PR: ${prUrl}.

New comments since last check:
---
${commentBlock}
---

Instructions:
1. Analyse each comment carefully. Decide if a code change is needed.
2. For comments requiring changes: implement the fix, commit, and push to the PR branch.
3. For comments that are questions or informational: no code change needed.
4. After completing all changes (or confirming none are needed), post a reply comment on the review request at ${prUrl} summarising what was done and why.
5. For GitHub PR review threads, reply on the PR with a concise summary after the fix is pushed.`;
}
