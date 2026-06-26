import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IntentType, TaskStatus } from '@open-tag/core-types';
import { TaskLifecycleService, type TaskLifecycleObserver } from '../task-lifecycle.js';

const { transitionTaskMock } = vi.hoisted(() => ({
  transitionTaskMock: vi.fn(),
}));

vi.mock('../orchestrator.js', () => ({
  transitionTask: transitionTaskMock,
}));

describe('TaskLifecycleService', () => {
  let observer: Required<TaskLifecycleObserver>;

  beforeEach(() => {
    vi.clearAllMocks();
    observer = {
      onTaskCreated: vi.fn().mockResolvedValue(undefined),
      onTaskStatusChanged: vi.fn().mockResolvedValue(undefined),
    };
  });

  it('notifies observers when a task is created', async () => {
    const service = new TaskLifecycleService({} as any, observer);

    await service.notifyTaskCreated({
      taskId: 'task_1',
      taskType: IntentType.SELF_DEV,
      summary: 'Implement feature',
      localStatus: TaskStatus.PENDING,
      sourceMessageId: 'om_1',
    });

    expect(observer.onTaskCreated).toHaveBeenCalledWith({
      taskId: 'task_1',
      taskType: IntentType.SELF_DEV,
      summary: 'Implement feature',
      localStatus: TaskStatus.PENDING,
      sourceMessageId: 'om_1',
    });
  });

  it('commits local transition before notifying status observers', async () => {
    const service = new TaskLifecycleService({} as any, observer);

    await service.transitionTask('task_1', TaskStatus.WAITING_APPROVAL, {
      interactionReason: 'clarify',
    });

    expect(transitionTaskMock).toHaveBeenCalledWith(
      {} as any,
      'task_1',
      TaskStatus.WAITING_APPROVAL,
      {
        interactionReason: 'clarify',
      },
    );
    expect(observer.onTaskStatusChanged).toHaveBeenCalledWith({
      taskId: 'task_1',
      localStatus: TaskStatus.WAITING_APPROVAL,
      interactionReason: 'clarify',
    });
  });

  it('does not project WAITING_DELEGATION to external observers', async () => {
    const service = new TaskLifecycleService({} as any, observer);

    await service.transitionTask('task_1', TaskStatus.WAITING_DELEGATION);

    expect(transitionTaskMock).toHaveBeenCalledWith(
      {} as any,
      'task_1',
      TaskStatus.WAITING_DELEGATION,
      undefined,
    );
    expect(observer.onTaskStatusChanged).not.toHaveBeenCalled();
  });

  it('does not fail lifecycle operations when observers fail', async () => {
    vi.mocked(observer.onTaskCreated).mockRejectedValueOnce(new Error('observer failed'));
    vi.mocked(observer.onTaskStatusChanged).mockRejectedValueOnce(new Error('observer failed'));
    const service = new TaskLifecycleService({} as any, observer);

    await expect(
      service.notifyTaskCreated({
        taskId: 'task_1',
        taskType: IntentType.SELF_DEV,
        summary: 'Implement feature',
        localStatus: TaskStatus.PENDING,
      }),
    ).resolves.toBeUndefined();
    await expect(service.transitionTask('task_1', TaskStatus.RUNNING)).resolves.toBeUndefined();
  });

  it('logs observer failures so external desync is observable', async () => {
    const error = new Error('observer failed');
    vi.mocked(observer.onTaskCreated).mockRejectedValueOnce(error);
    vi.mocked(observer.onTaskStatusChanged).mockRejectedValueOnce(error);
    const logger = { warn: vi.fn() };
    const service = new TaskLifecycleService({} as any, observer, logger);

    await service.notifyTaskCreated({
      taskId: 'task_1',
      taskType: IntentType.SELF_DEV,
      summary: 'Implement feature',
      localStatus: TaskStatus.PENDING,
    });
    await service.transitionTask('task_1', TaskStatus.RUNNING);

    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: error, taskId: 'task_1' }),
      expect.stringContaining('observer failed'),
    );
  });
});
