import { describe, expect, it, vi } from 'vitest';
import {
  appendHandoffToolGuidance,
  deliverAgentHandoffToolCallIfNeeded,
  deliverRelayHandoffIfNeeded,
  extractHandoffToolCall,
} from '../handoff-delivery.js';
import type {
  CreateDelegatedTaskInput,
  CreateDelegatedTaskResult,
  DelegatedTaskJobData,
} from '@open-tag/orchestrator';
import type { TaskJobData } from '@open-tag/queue';

function makeDelegationResult(input: CreateDelegatedTaskInput): CreateDelegatedTaskResult {
  const childTaskId = input.childTaskId ?? 'child_task';
  const childSessionId = input.childSessionId ?? 'child_session';
  const job: DelegatedTaskJobData = {
    taskId: childTaskId,
    sessionId: childSessionId,
    agentId: input.calleeAgentId,
    feishuAppId: input.calleeFeishuAppId ?? undefined,
    taskType: 'analysis',
    goal: input.goal,
    runtimeHint: input.runtimeHint ?? null,
    constraints: {
      ...(input.constraints ?? {}),
      delegationMode: input.mode ?? 'return',
    },
  };

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
    job,
  };
}

function makeDeps(overrides: Partial<{
  enqueue: (jobData: TaskJobData) => Promise<string | null>;
  sendVisibleRelayWake: (input: {
    chatId: string;
    text: string;
    replyToMessageId?: string;
    uuid: string;
  }) => Promise<{ messageId: string }>;
  resolveAgentByHandle: (handle: string) => Promise<{ agentId: string; feishuAppId?: string | null } | null>;
}> = {}) {
  const createDelegatedTask = vi.fn(async (input: CreateDelegatedTaskInput) =>
    makeDelegationResult(input),
  );
  return {
    createDelegatedTask,
    resolveAgentByHandle: vi.fn(
      overrides.resolveAgentByHandle ??
        (async () => ({ agentId: 'agent_b', feishuAppId: 'app_b' })),
    ),
    enqueue: vi.fn(overrides.enqueue ?? (async () => 'job_1')),
    deleteLease: vi.fn(async () => {}),
    sendVisibleRelayWake: vi.fn(
      overrides.sendVisibleRelayWake ?? (async () => ({ messageId: 'om_visible_wake' })),
    ),
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  };
}

describe('extractHandoffToolCall', () => {
  it('parses tagged handoff_to_agent calls', () => {
    expect(
      extractHandoffToolCall(
        '<handoff_to_agent>{"handle":"agent-b","goal":"Review output","expected_output":"risks","mode":"chain"}</handoff_to_agent>',
      ),
    ).toEqual({
      handle: 'agent-b',
      goal: 'Review output',
      expectedOutput: 'risks',
      mode: 'chain',
    });
  });

  it('parses inline handoff_to_agent calls', () => {
    expect(
      extractHandoffToolCall(
        'handoff_to_agent({"handle":"agent-b","goal":"Follow up","expectedOutput":"summary"})',
      ),
    ).toMatchObject({
      handle: 'agent-b',
      goal: 'Follow up',
      expectedOutput: 'summary',
      mode: 'return',
    });
  });

  it('parses the new short-code `agent` field, preferring it over a legacy handle', () => {
    expect(
      extractHandoffToolCall(
        '<handoff_to_agent>{"agent":"agent_2","handle":"ignored","goal":"Do it","mode":"return"}</handoff_to_agent>',
      ),
    ).toMatchObject({ handle: 'agent_2', goal: 'Do it', mode: 'return' });
  });
});

describe('appendHandoffToolGuidance', () => {
  it('omits the tool entirely when there are no delegable agents', () => {
    expect(appendHandoffToolGuidance('SYS', [])).toBe('SYS');
  });

  it('lists candidates by short code and instructs the model to use `agent`', () => {
    const out = appendHandoffToolGuidance('SYS', [
      { ref: 'agent_1', agentId: 'id-1', displayName: 'Reviewer', feishuAppId: 'app-1' },
      { ref: 'agent_2', agentId: 'id-2', displayName: 'Tester', feishuAppId: null },
    ]);
    expect(out).toContain('[agent_1] Reviewer');
    expect(out).toContain('[agent_2] Tester');
    expect(out).toContain('"agent":"agent_1"');
    // The real UUIDs must never be exposed to the model.
    expect(out).not.toContain('id-1');
  });
});

describe('deliverRelayHandoffIfNeeded', () => {
  it('posts a deterministic visible delegate wake without creating a backend child', async () => {
    const deps = makeDeps();

    const result = await deliverRelayHandoffIfNeeded(deps, {
      taskId: 'parent_task',
      callerAgentId: 'agent_a',
      parentGoal: 'Primary work',
      outputText: 'Primary output',
      parentWorkspacePath: '/repo/.worktrees/dev-parent',
      constraints: {
        multiMentionRouting: {
          route: 'relay',
          status: 'pending',
          relayKey: 'relay:parent_task:agent-b:0',
          targetHandle: 'agent-b',
          primary: { handle: 'agent-a' },
          target: { agentId: 'agent_b', feishuAppId: 'app_b', botOpenId: 'ou_agent_b' },
          goal: '继续实现测试',
          mode: 'return',
        },
        chatId: 'chat_1',
        replyToMessageId: 'om_root',
      },
    });

    expect(result).toEqual({ status: 'visible_relay_notified', messageId: 'om_visible_wake' });
    expect(deps.sendVisibleRelayWake).toHaveBeenCalledWith({
      chatId: 'chat_1',
      replyToMessageId: 'om_root',
      uuid: 'relay:parent_task:agent-b:0:visible-wake',
      text: '<at user_id="ou_agent_b">agent-b</at> 继续实现测试 @agent-a 的结果',
    });
    expect(deps.createDelegatedTask).not.toHaveBeenCalled();
    expect(deps.enqueue).not.toHaveBeenCalled();
    expect(deps.deleteLease).not.toHaveBeenCalled();
  });

  it('uses the same visible wake uuid for duplicate relay completion input', async () => {
    const deps = makeDeps();
    const input = {
      taskId: 'parent_task',
      callerAgentId: 'agent_a',
      parentGoal: 'Primary work',
      outputText: 'Primary output',
      constraints: {
        multiMentionRouting: {
          route: 'relay',
          status: 'pending',
          relayKey: 'relay:parent_task:agent-b:0',
          targetHandle: 'agent-b',
          primary: { handle: 'agent-a' },
          target: { agentId: 'agent_b', feishuAppId: 'app_b', botOpenId: 'ou_agent_b' },
          goal: 'Review primary output',
        },
        chatId: 'chat_1',
      },
    };

    await deliverRelayHandoffIfNeeded(deps, input);
    await deliverRelayHandoffIfNeeded(deps, input);

    expect(deps.sendVisibleRelayWake.mock.calls[0][0].uuid).toBe(
      deps.sendVisibleRelayWake.mock.calls[1][0].uuid,
    );
    expect(deps.createDelegatedTask).not.toHaveBeenCalled();
  });

  it('does not re-trigger relay handoff when the parent is resuming with child results', async () => {
    const deps = makeDeps();

    const result = await deliverRelayHandoffIfNeeded(deps, {
      taskId: 'parent_task',
      callerAgentId: 'agent_a',
      parentGoal: 'Primary work',
      outputText: 'Parent synthesized child result',
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
          relayKey: 'relay:parent_task:agent-b:0',
          targetHandle: 'agent-b',
          target: { agentId: 'agent_b', feishuAppId: 'app_b', botOpenId: 'ou_agent_b' },
          goal: 'Review primary output',
          mode: 'return',
        },
      },
    });

    expect(result).toEqual({ status: 'not_applicable' });
    expect(deps.createDelegatedTask).not.toHaveBeenCalled();
    expect(deps.enqueue).not.toHaveBeenCalled();
    expect(deps.deleteLease).not.toHaveBeenCalled();
  });

  it('does not create a backend child when visible wake posting fails', async () => {
    const deps = makeDeps({
      sendVisibleRelayWake: async () => {
        throw new Error('Feishu unavailable');
      },
    });

    const result = await deliverRelayHandoffIfNeeded(deps, {
      taskId: 'parent_task',
      callerAgentId: 'agent_a',
      parentGoal: 'Primary work',
      outputText: 'Primary output',
      constraints: {
        multiMentionRouting: {
          route: 'relay',
          status: 'pending',
          relayKey: 'relay:parent_task:agent-b:0',
          targetHandle: 'agent-b',
          target: { agentId: 'agent_b', feishuAppId: 'app_b', botOpenId: 'ou_agent_b' },
          goal: 'Review primary output',
        },
        chatId: 'chat_1',
      },
    });

    expect(result).toEqual({ status: 'visible_relay_failed' });
    expect(deps.createDelegatedTask).not.toHaveBeenCalled();
    expect(deps.enqueue).not.toHaveBeenCalled();
    expect(deps.deleteLease).not.toHaveBeenCalled();
  });

  it('ignores incomplete relay metadata without creating a child', async () => {
    const deps = makeDeps();

    const result = await deliverRelayHandoffIfNeeded(deps, {
      taskId: 'parent_task',
      callerAgentId: 'agent_a',
      parentGoal: 'Primary work',
      outputText: 'Primary output',
      constraints: {
        multiMentionRouting: {
          route: 'relay',
          status: 'pending',
          relayKey: 'relay:parent_task:agent-b:0',
          targetHandle: 'agent-b',
        },
      },
    });

    expect(result).toEqual({ status: 'not_applicable' });
    expect(deps.createDelegatedTask).not.toHaveBeenCalled();
    expect(deps.enqueue).not.toHaveBeenCalled();
  });
});

describe('deliverAgentHandoffToolCallIfNeeded', () => {
  it('resolves target handle and creates chain-mode tool handoff', async () => {
    const deps = makeDeps();

    const result = await deliverAgentHandoffToolCallIfNeeded(deps, {
      taskId: 'parent_task',
      callerAgentId: 'agent_a',
      parentGoal: 'Parent work',
      outputText:
        '<handoff_to_agent>{"handle":"agent-b","goal":"Continue analysis","mode":"chain"}</handoff_to_agent>',
      constraints: {},
    });

    expect(result.status).toBe('delegated_chain');
    expect(deps.resolveAgentByHandle).toHaveBeenCalledWith('agent-b');
    expect(deps.createDelegatedTask).toHaveBeenCalledWith(
      expect.objectContaining({
        calleeAgentId: 'agent_b',
        calleeFeishuAppId: 'app_b',
        mode: 'chain',
        goal: 'Continue analysis',
      }),
    );
  });

  it('keeps tool child identity stable across retry wording changes', async () => {
    const deps = makeDeps();

    await deliverAgentHandoffToolCallIfNeeded(deps, {
      taskId: 'parent_task',
      callerAgentId: 'agent_a',
      parentGoal: 'Parent work',
      outputText:
        '<handoff_to_agent>{"handle":"agent-b","goal":"Continue analysis","mode":"return"}</handoff_to_agent>',
      constraints: {},
    });
    await deliverAgentHandoffToolCallIfNeeded(deps, {
      taskId: 'parent_task',
      callerAgentId: 'agent_a',
      parentGoal: 'Parent work',
      outputText:
        '<handoff_to_agent>{"handle":"agent-b","goal":"Please review this result with slightly different wording","mode":"return"}</handoff_to_agent>',
      constraints: {},
    });

    expect(deps.createDelegatedTask.mock.calls[0][0].childTaskId).toBe(
      deps.createDelegatedTask.mock.calls[1][0].childTaskId,
    );
    expect(deps.createDelegatedTask.mock.calls[0][0].childSessionId).toBe(
      deps.createDelegatedTask.mock.calls[1][0].childSessionId,
    );
    expect(deps.createDelegatedTask.mock.calls[0][0].constraints).toMatchObject({
      handoffSource: 'tool',
      handoffCallIndex: 0,
      targetHandle: 'agent-b',
    });
  });
});
