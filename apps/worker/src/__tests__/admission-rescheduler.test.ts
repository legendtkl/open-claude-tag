import { describe, expect, it, vi } from 'vitest';
import {
  runAdmissionReschedulerOnce,
  type AdmissionReschedulerDeps,
} from '../admission-rescheduler.js';

function createDeps(overrides: Partial<AdmissionReschedulerDeps> = {}): AdmissionReschedulerDeps {
  const jobData = {
    taskId: 'task_1',
    sessionId: 'session_1',
    agentId: 'agent_1',
    taskType: 'chat_reply',
    goal: 'hello',
    runtimeHint: null,
    constraints: { timeoutSec: 1800 },
  };

  return {
    listDueLeases: vi
      .fn()
      .mockResolvedValue([{ taskId: 'task_1', sessionId: 'session_1', jobData }]),
    loadTask: vi.fn().mockResolvedValue({
      status: 'queued',
    }),
    enqueue: vi.fn().mockResolvedValue('job_1'),
    deleteLease: vi.fn().mockResolvedValue(undefined),
    markLeaseRescheduled: vi.fn().mockResolvedValue(undefined),
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    batchSize: 25,
    retryDelayMs: 1000,
    now: () => 1000,
    ...overrides,
  };
}

describe('runAdmissionReschedulerOnce', () => {
  it('enqueues a due queued task with a delayed wake and deletes its lease', async () => {
    const deps = createDeps();

    const result = await runAdmissionReschedulerOnce(deps);

    expect(result).toEqual({ inspected: 1, enqueued: 1, deleted: 0, delayed: 0 });
    expect(deps.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task_1',
        sessionId: 'session_1',
        agentId: 'agent_1',
      }),
      { startAfter: new Date(1001) },
    );
    expect(deps.deleteLease).toHaveBeenCalledWith('task_1');
  });

  it('replays the persisted job data exactly when rescheduling a deferred task', async () => {
    const jobData = {
      taskId: 'task_1',
      sessionId: 'session_1',
      agentId: 'agent_1',
      feishuAppId: 'feishu_app_1',
      taskType: 'chat_reply',
      goal: 'hello',
      runtimeHint: 'claude',
      constraints: {
        timeoutSec: 1800,
        delegatedTask: true,
        futureField: { nested: ['kept'] },
      },
      sdkSessionId: 'sdk_session_1',
      runtimeBackend: 'claude',
    };
    const deps = createDeps({
      listDueLeases: vi
        .fn()
        .mockResolvedValue([{ taskId: 'task_1', sessionId: 'session_1', jobData }]),
    });

    await runAdmissionReschedulerOnce(deps);

    expect(deps.enqueue).toHaveBeenCalledWith(jobData, { startAfter: new Date(1001) });
  });

  it('preserves legacy SDK resume fields from persisted job data', async () => {
    const legacyJobData = {
      taskId: 'task_legacy',
      sessionId: 'session_legacy',
      taskType: 'chat_reply',
      goal: 'resume this turn',
      runtimeHint: 'codex',
      constraints: { timeoutSec: 1800 },
      sdkSessionId: 'legacy_sdk_session',
      runtimeBackend: 'codex',
    };
    const deps = createDeps({
      listDueLeases: vi.fn().mockResolvedValue([
        {
          taskId: 'task_legacy',
          sessionId: 'session_legacy',
          jobData: legacyJobData,
        },
      ]),
    });

    await runAdmissionReschedulerOnce(deps);

    expect(deps.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        sdkSessionId: 'legacy_sdk_session',
        runtimeBackend: 'codex',
      }),
      { startAfter: new Date(1001) },
    );
  });

  it('replays a durable delegation wake lease once and consumes it', async () => {
    const wakeJobData = {
      taskId: 'parent_task',
      sessionId: 'parent_session',
      agentId: 'parent_agent',
      feishuAppId: 'feishu_app',
      taskType: 'chat_reply',
      goal: 'resume parent with child results',
      runtimeHint: 'codex',
      constraints: {
        delegationResume: true,
        delegationResumePackage: { treeId: 'tree_1' },
      },
      sdkSessionId: 'sdk_parent',
      runtimeBackend: 'codex',
    };
    const deps = createDeps({
      listDueLeases: vi.fn().mockResolvedValue([
        {
          taskId: 'parent_task',
          sessionId: 'parent_session',
          jobData: wakeJobData,
        },
      ]),
    });

    const result = await runAdmissionReschedulerOnce(deps);

    expect(result).toEqual({ inspected: 1, enqueued: 1, deleted: 0, delayed: 0 });
    expect(deps.enqueue).toHaveBeenCalledTimes(1);
    expect(deps.enqueue).toHaveBeenCalledWith(wakeJobData, { startAfter: new Date(1001) });
    expect(deps.deleteLease).toHaveBeenCalledWith('parent_task');
  });

  it('keeps the lease when pg-boss reports a singleton collision', async () => {
    const deps = createDeps({
      enqueue: vi.fn().mockResolvedValue(null),
    });

    const result = await runAdmissionReschedulerOnce(deps);

    expect(result).toEqual({ inspected: 1, enqueued: 0, deleted: 0, delayed: 1 });
    expect(deps.deleteLease).not.toHaveBeenCalled();
    expect(deps.markLeaseRescheduled).toHaveBeenCalledWith({
      taskId: 'task_1',
      nextNotBefore: new Date(2000),
    });
  });

  it('deletes leases for tasks that are no longer queued', async () => {
    const deps = createDeps({
      loadTask: vi.fn().mockResolvedValue({ status: 'completed' } as never),
    });

    const result = await runAdmissionReschedulerOnce(deps);

    expect(result).toEqual({ inspected: 1, enqueued: 0, deleted: 1, delayed: 0 });
    expect(deps.enqueue).not.toHaveBeenCalled();
    expect(deps.deleteLease).toHaveBeenCalledWith('task_1');
  });
});
