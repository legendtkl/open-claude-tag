import { describe, it, expect, vi } from 'vitest';
import type { TaskJobData } from '@open-tag/queue';
import { enqueueDiscussionTurnTaskOrFail } from '../discussion-turn-enqueue.js';

function makeJob(): TaskJobData {
  return {
    taskId: 'task_1',
    sessionId: 'session_1',
    taskType: 'chat_reply',
    goal: 'discuss',
    runtimeHint: 'auto',
    constraints: {},
  };
}

describe('enqueueDiscussionTurnTaskOrFail', () => {
  it('enqueues without touching the task on success', async () => {
    const deps = {
      enqueue: vi.fn().mockResolvedValue('job_1'),
      markTaskFailed: vi.fn(),
      logger: { error: vi.fn() },
    };

    await enqueueDiscussionTurnTaskOrFail(deps, makeJob());

    expect(deps.enqueue).toHaveBeenCalledTimes(1);
    expect(deps.markTaskFailed).not.toHaveBeenCalled();
    expect(deps.logger.error).not.toHaveBeenCalled();
  });

  it('marks the task failed and rethrows when enqueue fails', async () => {
    const enqueueError = new Error('queue down');
    const deps = {
      enqueue: vi.fn().mockRejectedValue(enqueueError),
      markTaskFailed: vi.fn().mockResolvedValue(undefined),
      logger: { error: vi.fn() },
    };

    await expect(enqueueDiscussionTurnTaskOrFail(deps, makeJob())).rejects.toThrow('queue down');

    expect(deps.markTaskFailed).toHaveBeenCalledWith('task_1', 'queue down');
    expect(deps.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'task_1', sessionId: 'session_1' }),
      expect.stringContaining('Failed to enqueue discussion turn task'),
    );
  });

  it('still rethrows the enqueue error when marking failed also fails', async () => {
    const deps = {
      enqueue: vi.fn().mockRejectedValue(new Error('queue down')),
      markTaskFailed: vi.fn().mockRejectedValue(new Error('db down')),
      logger: { error: vi.fn() },
    };

    await expect(enqueueDiscussionTurnTaskOrFail(deps, makeJob())).rejects.toThrow('queue down');
    expect(deps.logger.error).toHaveBeenCalledTimes(2);
  });
});
