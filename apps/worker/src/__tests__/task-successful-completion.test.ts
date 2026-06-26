import { TaskStatus } from '@open-tag/core-types';
import type { CreateDelegatedTaskInput, CreateDelegatedTaskResult } from '@open-tag/orchestrator';
import type { TaskJobData } from '@open-tag/queue';
import { describe, expect, it, vi } from 'vitest';
import { completeSuccessfulTaskAfterHandoffs } from '../task-successful-completion.js';

function makeDelegationResult(input: CreateDelegatedTaskInput): CreateDelegatedTaskResult {
  const childTaskId = input.childTaskId ?? 'child_task';
  const childSessionId = input.childSessionId ?? 'child_session';

  return {
    childTaskId,
    childSessionId,
    delegation: {
      id: 'delegation_1',
      treeId: 'tree_1',
      parentDelegationId: null,
      depth: 1,
      childSessionId,
      parentTaskId: input.parentTaskId,
      childTaskId,
      callerAgentId: input.callerAgentId,
      calleeAgentId: input.calleeAgentId,
      goal: input.goal,
      inputSummary: input.contextSummary,
      permissionScope: input.permissionScope ?? {},
      status: 'pending',
      result: null,
      errorMessage: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
      completedAt: null,
    },
    taskPackage: {
      goal: input.goal,
      contextSummary: input.contextSummary,
      constraints: input.constraints ?? {},
      expectedOutput: input.expectedOutput ?? 'Return a concise result for the caller agent.',
      caller: {
        taskId: input.parentTaskId,
        agentId: input.callerAgentId,
      },
      permissionScope: input.permissionScope ?? {},
    },
    job: {
      taskId: childTaskId,
      sessionId: childSessionId,
      agentId: input.calleeAgentId,
      feishuAppId: input.calleeFeishuAppId ?? undefined,
      taskType: 'analysis',
      goal: input.goal,
      runtimeHint: input.runtimeHint ?? null,
      constraints: input.constraints ?? {},
    },
  };
}

function makeDeps() {
  const createDelegatedTask = vi.fn(async (input: CreateDelegatedTaskInput) =>
    makeDelegationResult(input),
  );
  return {
    handoff: {
      createDelegatedTask,
      resolveAgentByHandle: vi.fn(async () => ({ agentId: 'agent_b', feishuAppId: 'app_b' })),
      enqueue: vi.fn(async (_jobData: TaskJobData) => 'job_1'),
      deleteLease: vi.fn(async () => {}),
      sendVisibleRelayWake: vi.fn(async () => ({ messageId: 'om_visible_wake' })),
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    },
    terminalTransition: {
      deliverCompletedDiscussionTurn: vi.fn().mockResolvedValue('not_discussion_turn' as const),
      taskLifecycle: {
        transitionTask: vi.fn().mockResolvedValue(undefined),
        notifyTaskStatusChanged: vi.fn().mockResolvedValue(undefined),
      },
    },
    logger: {
      info: vi.fn(),
    },
  };
}

describe('completeSuccessfulTaskAfterHandoffs', () => {
  it('terminalizes a resumed relay parent instead of re-consuming stale relay metadata', async () => {
    const deps = makeDeps();
    const result = {
      taskId: 'parent_task',
      status: 'completed',
      output: { text: 'Parent synthesized child result' },
    };

    const completion = await completeSuccessfulTaskAfterHandoffs(deps, {
      taskId: 'parent_task',
      sessionId: 'parent_session',
      agentId: 'agent_a',
      feishuAppId: 'app_a',
      taskType: 'analysis',
      goal: 'Primary work',
      runtimeHint: null,
      constraints: {
        delegationResume: true,
        delegationResumePackage: {
          treeId: 'tree_1',
          parentTaskId: 'parent_task',
          children: [{ childTaskId: 'child_task', delegationId: 'delegation_1' }],
        },
        multiMentionRouting: {
          route: 'relay',
          status: 'pending',
          relayKey: 'relay:parent_task:Reviewer:0',
          targetHandle: 'Reviewer',
          target: { agentId: 'agent_b', feishuAppId: 'app_b', botOpenId: 'ou_agent_b' },
          goal: 'Review primary output',
          mode: 'return',
        },
      },
      result,
      content: 'Parent synthesized child result',
    });

    expect(completion).toEqual({ status: 'completed' });
    expect(deps.handoff.createDelegatedTask).not.toHaveBeenCalled();
    expect(deps.handoff.enqueue).not.toHaveBeenCalled();
    expect(deps.handoff.deleteLease).not.toHaveBeenCalled();
    expect(deps.terminalTransition.taskLifecycle.transitionTask).toHaveBeenCalledWith(
      'parent_task',
      TaskStatus.COMPLETED,
      expect.objectContaining({ result }),
    );
    expect(
      deps.terminalTransition.taskLifecycle.notifyTaskStatusChanged,
    ).not.toHaveBeenCalled();
    expect(deps.logger.info).not.toHaveBeenCalledWith(
      expect.anything(),
      'Task completion is waiting for relay handoff result',
    );
  });

  it('completes an initial relay parent then posts one visible delegate wake', async () => {
    const deps = makeDeps();
    const result = { taskId: 'parent_task', status: 'completed', output: { text: 'Primary done' } };

    const completion = await completeSuccessfulTaskAfterHandoffs(deps, {
      taskId: 'parent_task',
      sessionId: 'parent_session',
      agentId: 'agent_a',
      feishuAppId: 'app_a',
      taskType: 'analysis',
      goal: 'Primary work',
      runtimeHint: null,
      constraints: {
        multiMentionRouting: {
          route: 'relay',
          status: 'pending',
          relayKey: 'relay:parent_task:Reviewer:0',
          targetHandle: 'Reviewer',
          primary: { handle: 'Developer' },
          target: { agentId: 'agent_b', feishuAppId: 'app_b', botOpenId: 'ou_agent_b' },
          goal: 'Review primary output',
          mode: 'return',
        },
        chatId: 'chat_1',
        replyToMessageId: 'om_root',
      },
      result,
      content: 'Primary done',
    });

    expect(completion).toEqual({ status: 'completed' });
    expect(deps.terminalTransition.taskLifecycle.transitionTask).toHaveBeenCalledWith(
      'parent_task',
      TaskStatus.COMPLETED,
      expect.objectContaining({ result }),
    );
    expect(deps.handoff.sendVisibleRelayWake).toHaveBeenCalledWith({
      chatId: 'chat_1',
      replyToMessageId: 'om_root',
      uuid: 'relay:parent_task:Reviewer:0:visible-wake',
      text: '<at user_id="ou_agent_b">Reviewer</at> Review primary output @Developer 的结果',
    });
    expect(deps.handoff.createDelegatedTask).not.toHaveBeenCalled();
    expect(deps.handoff.enqueue).not.toHaveBeenCalled();
  });
});
