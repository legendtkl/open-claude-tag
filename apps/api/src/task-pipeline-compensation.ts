import { errorMessage } from '@open-tag/core-types';

export interface FailTaskCreatedPipelineInput {
  taskId: string;
  goal: string;
  error: unknown;
  /** Ack card id when one was sent before the failure; null skips card compensation. */
  ackMessageId: string | null;
  feedback: { updateFailed(goal: string, message: string): Promise<void> } | null;
  persistFailedFeedbackState: () => Promise<void>;
  transitionTaskFailed: (message: string) => Promise<void>;
  logger: {
    error(meta: Record<string, unknown>, message: string): void;
    warn(meta: Record<string, unknown>, message: string): void;
  };
}

/**
 * Compensation for a failure anywhere between task creation and enqueue.
 *
 * The task row already exists; letting the error escape strands it in
 * PENDING/QUEUED forever, and (because the event is never marked processed)
 * a webhook redelivery then creates a SECOND task for the same message. This
 * terminates the task as FAILED with best-effort feedback so the handler can
 * complete normally and the event dedups on retry. Never throws — every step
 * is individually guarded.
 */
export async function failTaskCreatedPipeline(
  input: FailTaskCreatedPipelineInput,
): Promise<void> {
  const message = errorMessage(input.error);
  input.logger.error(
    { err: input.error, taskId: input.taskId },
    'Task-created pipeline failed; compensating task to FAILED',
  );

  if (input.ackMessageId && input.feedback) {
    try {
      await input.feedback.updateFailed(input.goal, message);
    } catch (err) {
      input.logger.warn(
        { err, taskId: input.taskId },
        'Failed to update task feedback during pipeline compensation',
      );
    }
    try {
      await input.persistFailedFeedbackState();
    } catch (err) {
      input.logger.warn(
        { err, taskId: input.taskId },
        'Failed to persist feedback state during pipeline compensation',
      );
    }
  }

  try {
    await input.transitionTaskFailed(message);
  } catch (err) {
    input.logger.error(
      { err, taskId: input.taskId },
      'Failed to transition task to FAILED during pipeline compensation',
    );
  }
}
