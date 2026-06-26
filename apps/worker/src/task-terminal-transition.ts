import { TaskStatus } from '@open-tag/core-types';

export type TerminalTaskStatus =
  | TaskStatus.COMPLETED
  | TaskStatus.FAILED
  | TaskStatus.CANCELLED;

export type DiscussionTurnTerminalDeliveryResult =
  | 'not_discussion_turn'
  | 'discussion_missing'
  | 'not_advanced'
  | 'enqueued'
  | 'lease_retained';

export interface TaskTerminalTransitionInput {
  taskId: string;
  sessionId: string;
  agentId?: string;
  feishuAppId?: string;
  taskType: string;
  goal: string;
  runtimeHint: string | null;
  constraints: Record<string, unknown>;
  status: TerminalTaskStatus;
  result?: unknown;
  errorMessage?: string | null;
  content?: string | null;
}

export interface TaskTerminalTransitionDeps {
  deliverCompletedDiscussionTurn: (
    input: TaskTerminalTransitionInput,
  ) => Promise<DiscussionTurnTerminalDeliveryResult>;
  taskLifecycle: {
    transitionTask: (
      taskId: string,
      status: TerminalTaskStatus,
      options?: { result?: unknown; errorMessage?: string },
    ) => Promise<void>;
    notifyTaskStatusChanged: (input: {
      taskId: string;
      localStatus: TerminalTaskStatus;
    }) => Promise<void>;
  };
}

export interface TerminalCommitLogger {
  error: (context: Record<string, unknown>, message: string) => void;
}

export class DiscussionTerminalCommitError extends Error {
  constructor(
    public readonly taskId: string,
    public readonly status: TerminalTaskStatus,
    public readonly originalError: unknown,
  ) {
    const message =
      originalError instanceof Error
        ? originalError.message
        : 'Discussion terminal commit failed';
    super(message);
    this.name = 'DiscussionTerminalCommitError';
  }
}

function isPostCommitDeliveryError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'taskStateCommitted' in err &&
    (err as { taskStateCommitted?: unknown }).taskStateCommitted === true
  );
}

export async function transitionTaskOrDeliverDiscussionTurn(
  deps: TaskTerminalTransitionDeps,
  input: TaskTerminalTransitionInput,
): Promise<void> {
  let discussionDelivery: DiscussionTurnTerminalDeliveryResult;
  try {
    discussionDelivery = await deps.deliverCompletedDiscussionTurn(input);
  } catch (err) {
    if (isPostCommitDeliveryError(err)) {
      await deps.taskLifecycle.notifyTaskStatusChanged({
        taskId: input.taskId,
        localStatus: input.status,
      });
      throw err;
    }
    throw new DiscussionTerminalCommitError(input.taskId, input.status, err);
  }

  if (discussionDelivery === 'not_discussion_turn') {
    await deps.taskLifecycle.transitionTask(input.taskId, input.status, {
      result: input.result,
      errorMessage: input.errorMessage ?? undefined,
    });
    return;
  }

  await deps.taskLifecycle.notifyTaskStatusChanged({
    taskId: input.taskId,
    localStatus: input.status,
  });
}

export function rethrowDiscussionTerminalCommitError(
  err: unknown,
  logger: TerminalCommitLogger,
  taskId: string,
): void {
  if (!(err instanceof DiscussionTerminalCommitError)) {
    return;
  }

  logger.error(
    { taskId, status: err.status, err: err.originalError },
    'Discussion terminal commit failed; retrying job without rewriting turn status',
  );
  throw err.originalError;
}
