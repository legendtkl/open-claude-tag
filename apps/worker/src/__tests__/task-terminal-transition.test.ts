import { TaskStatus } from '@open-tag/core-types';
import { describe, expect, it, vi } from 'vitest';
import {
  DiscussionTerminalCommitError,
  rethrowDiscussionTerminalCommitError,
  transitionTaskOrDeliverDiscussionTurn,
} from '../task-terminal-transition.js';

function makeDeps() {
  return {
    deliverCompletedDiscussionTurn: vi.fn().mockResolvedValue('not_discussion_turn' as const),
    taskLifecycle: {
      transitionTask: vi.fn().mockResolvedValue(undefined),
      notifyTaskStatusChanged: vi.fn().mockResolvedValue(undefined),
    },
  };
}

function makeInput(status: TaskStatus.COMPLETED | TaskStatus.FAILED | TaskStatus.CANCELLED) {
  return {
    taskId: 'task_1',
    sessionId: 'session_1',
    agentId: 'agent_1',
    feishuAppId: 'app_1',
    taskType: 'chat_reply',
    goal: 'answer the user',
    runtimeHint: null,
    constraints: {
      discussionId: 'discussion_1',
      discussionRound: 1,
      discussionTurnIndex: 0,
    },
    status,
    content: status === TaskStatus.COMPLETED ? 'successful answer' : null,
    errorMessage: status === TaskStatus.COMPLETED ? null : 'runtime failed',
  };
}

describe('task terminal transition', () => {
  it('uses the ordinary task lifecycle for non-discussion terminal transitions', async () => {
    const deps = makeDeps();

    await transitionTaskOrDeliverDiscussionTurn(deps, makeInput(TaskStatus.COMPLETED));

    expect(deps.taskLifecycle.transitionTask).toHaveBeenCalledWith(
      'task_1',
      TaskStatus.COMPLETED,
      expect.objectContaining({ errorMessage: undefined }),
    );
    expect(deps.taskLifecycle.notifyTaskStatusChanged).not.toHaveBeenCalled();
  });

  it('wraps completed discussion commit failures without falling back to ordinary terminalization', async () => {
    const deps = makeDeps();
    const commitError = new Error('advance failed');
    deps.deliverCompletedDiscussionTurn.mockRejectedValueOnce(commitError);

    await expect(
      transitionTaskOrDeliverDiscussionTurn(deps, makeInput(TaskStatus.COMPLETED)),
    ).rejects.toMatchObject({
      taskId: 'task_1',
      status: TaskStatus.COMPLETED,
      originalError: commitError,
    });
    expect(deps.taskLifecycle.transitionTask).not.toHaveBeenCalled();
    expect(deps.taskLifecycle.notifyTaskStatusChanged).not.toHaveBeenCalled();
  });

  it('notifies terminal task state before retrying post-commit delivery failures', async () => {
    const deps = makeDeps();
    const renderError = Object.assign(new Error('render failed'), {
      taskStateCommitted: true,
    });
    deps.deliverCompletedDiscussionTurn.mockRejectedValueOnce(renderError);

    await expect(
      transitionTaskOrDeliverDiscussionTurn(deps, makeInput(TaskStatus.COMPLETED)),
    ).rejects.toBe(renderError);

    expect(deps.taskLifecycle.transitionTask).not.toHaveBeenCalled();
    expect(deps.taskLifecycle.notifyTaskStatusChanged).toHaveBeenCalledWith({
      taskId: 'task_1',
      localStatus: TaskStatus.COMPLETED,
    });
  });

  it('rethrows completed-turn commit failures before generic catch can record a failed turn', async () => {
    const originalError = new Error('transient commit failure');
    const logger = { error: vi.fn() };
    const failedTurnConversion = vi.fn().mockResolvedValue(undefined);

    await expect(
      (async () => {
        try {
          throw new DiscussionTerminalCommitError(
            'task_1',
            TaskStatus.COMPLETED,
            originalError,
          );
        } catch (err) {
          rethrowDiscussionTerminalCommitError(err, logger, 'task_1');
          await failedTurnConversion();
        }
      })(),
    ).rejects.toBe(originalError);

    expect(failedTurnConversion).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task_1',
        status: TaskStatus.COMPLETED,
        err: originalError,
      }),
      'Discussion terminal commit failed; retrying job without rewriting turn status',
    );
  });

  it('lets real runtime failures continue into the failed-turn conversion path', async () => {
    const logger = { error: vi.fn() };
    const failedTurnConversion = vi.fn().mockResolvedValue(undefined);

    try {
      throw new Error('runtime failed');
    } catch (err) {
      rethrowDiscussionTerminalCommitError(err, logger, 'task_1');
      await failedTurnConversion();
    }

    expect(failedTurnConversion).toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('also rethrows failed-turn commit failures', async () => {
    const deps = makeDeps();
    const commitError = new Error('failed-turn commit failed');
    deps.deliverCompletedDiscussionTurn.mockRejectedValueOnce(commitError);
    const logger = { error: vi.fn() };

    await expect(
      (async () => {
        try {
          await transitionTaskOrDeliverDiscussionTurn(deps, makeInput(TaskStatus.FAILED));
        } catch (err) {
          rethrowDiscussionTerminalCommitError(err, logger, 'task_1');
        }
      })(),
    ).rejects.toBe(commitError);
  });
});
