import { TaskStatus } from '@open-tag/core-types';
import type { DiscussionRecord } from '@open-tag/storage';

export interface DiscussionTurnGuardInput {
  taskId: string;
  constraints: Record<string, unknown>;
}

export interface DiscussionTurnGuardDeps {
  findDiscussionById(discussionId: string): Promise<DiscussionRecord | null>;
  transitionTask(
    taskId: string,
    status: TaskStatus.CANCELLED,
    extra: { errorMessage: string },
  ): Promise<void>;
  logger: {
    info(context: Record<string, unknown>, message: string): void;
    warn(context: Record<string, unknown>, message: string): void;
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

export async function skipInactiveDiscussionTurnIfNeeded(
  deps: DiscussionTurnGuardDeps,
  input: DiscussionTurnGuardInput,
): Promise<boolean> {
  const discussionId = stringValue(input.constraints.discussionId);
  if (!discussionId) {
    return false;
  }

  const discussion = await deps.findDiscussionById(discussionId);
  if (!discussion) {
    deps.logger.warn(
      { taskId: input.taskId, discussionId },
      'Discussion turn task references a missing discussion; allowing normal failure path',
    );
    return false;
  }

  const round = numberValue(input.constraints.discussionRound);
  const overBudget = round != null && round > discussion.roundLimit;
  if (discussion.status === 'active' && !overBudget) {
    return false;
  }

  const reason =
    discussion.status === 'active'
      ? `Discussion round ${round} exceeds round limit ${discussion.roundLimit}`
      : `Discussion is ${discussion.status}`;
  await deps.transitionTask(input.taskId, TaskStatus.CANCELLED, { errorMessage: reason });
  deps.logger.info(
    {
      taskId: input.taskId,
      discussionId,
      discussionStatus: discussion.status,
      round,
      roundLimit: discussion.roundLimit,
    },
    'Skipped stale discussion turn before runtime execution',
  );
  return true;
}
