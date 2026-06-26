import { errorMessage } from '@open-tag/core-types';
import type { TaskJobData } from '@open-tag/queue';

export interface DiscussionTurnEnqueueDeps {
  enqueue: (job: TaskJobData) => Promise<unknown>;
  markTaskFailed: (taskId: string, errorMessage: string) => Promise<void>;
  logger: {
    error(context: Record<string, unknown>, message?: string): void;
  };
}

/**
 * Enqueue an initial discussion turn job whose task row was already inserted
 * as QUEUED. If enqueueing fails nothing else will ever pick the task up
 * (startup recovery only covers RUNNING tasks), so mark it FAILED before
 * propagating the error to the caller.
 */
export async function enqueueDiscussionTurnTaskOrFail(
  deps: DiscussionTurnEnqueueDeps,
  job: TaskJobData,
): Promise<void> {
  try {
    await deps.enqueue(job);
  } catch (err) {
    const message = errorMessage(err);
    deps.logger.error(
      { err, taskId: job.taskId, sessionId: job.sessionId },
      'Failed to enqueue discussion turn task',
    );
    try {
      await deps.markTaskFailed(job.taskId, message);
    } catch (markErr) {
      deps.logger.error(
        { err: markErr, taskId: job.taskId },
        'Failed to mark discussion turn task failed after enqueue failure',
      );
    }
    throw err;
  }
}
