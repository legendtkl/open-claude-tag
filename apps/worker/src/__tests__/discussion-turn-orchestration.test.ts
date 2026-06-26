import { describe, expect, it, vi } from 'vitest';
import { deliverDiscussionTurnAdvance } from '../discussion-turn-orchestration.js';
import type {
  DiscussionAdvanceResult,
  DiscussionParticipantRecord,
  DiscussionRecord,
  DiscussionTranscriptTurn,
} from '@open-tag/storage';

function makeDiscussion(): DiscussionRecord {
  return {
    id: 'discussion_1',
    tenantKey: 'default',
    chatId: 'chat_1',
    rootThreadId: 'om_root',
    feishuAppId: null,
    sessionId: 'session_1',
    topic: 'Should we ship discussion orchestration?',
    status: 'active',
    roundLimit: 2,
    currentRound: 1,
    currentTurnIndex: 0,
    version: 0,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    completedAt: null,
  };
}

function makeParticipants(): DiscussionParticipantRecord[] {
  return [
    {
      id: 'participant_a',
      discussionId: 'discussion_1',
      agentId: 'agent_a',
      feishuAppId: 'app_a',
      botOpenId: 'ou_a',
      displayName: 'Agent A',
      role: 'affirmative',
      orderIndex: 0,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    },
    {
      id: 'participant_b',
      discussionId: 'discussion_1',
      agentId: 'agent_b',
      feishuAppId: 'app_b',
      botOpenId: 'ou_b',
      displayName: 'Agent B',
      role: 'negative',
      orderIndex: 1,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    },
  ];
}

function makeTranscript(): DiscussionTranscriptTurn[] {
  return [
    {
      id: 'turn_0',
      discussionId: 'discussion_1',
      round: 1,
      turnIndex: 0,
      participantId: 'participant_a',
      agentId: 'agent_a',
      agentHandle: 'agent-a',
      agentDisplayName: 'Agent A',
      role: 'affirmative',
      taskId: 'task_current',
      status: 'queued',
      content: null,
      errorMessage: null,
      metadata: {},
      createdAt: new Date('2026-01-01T00:00:00Z'),
      completedAt: null,
    },
  ];
}

function makeCompletedTranscript(): DiscussionTranscriptTurn[] {
  return [
    {
      id: 'turn_0',
      discussionId: 'discussion_1',
      round: 1,
      turnIndex: 0,
      participantId: 'participant_a',
      agentId: 'agent_a',
      agentHandle: 'agent-a',
      agentDisplayName: 'Agent A',
      role: 'affirmative',
      taskId: 'task_a_1',
      status: 'completed',
      content: 'Opening argument',
      errorMessage: null,
      metadata: {},
      createdAt: new Date('2026-01-01T00:00:00Z'),
      completedAt: new Date('2026-01-01T00:01:00Z'),
    },
    {
      id: 'turn_1',
      discussionId: 'discussion_1',
      round: 1,
      turnIndex: 1,
      participantId: 'participant_b',
      agentId: 'agent_b',
      agentHandle: 'agent-b',
      agentDisplayName: 'Agent B',
      role: 'negative',
      taskId: 'task_current',
      status: 'queued',
      content: null,
      errorMessage: null,
      metadata: {},
      createdAt: new Date('2026-01-01T00:02:00Z'),
      completedAt: null,
    },
  ];
}

function makeDeps(
  overrides: Partial<{
    discussion: DiscussionRecord | null;
    participants: DiscussionParticipantRecord[];
    transcript: DiscussionTranscriptTurn[];
    advance: DiscussionAdvanceResult;
    enqueue: (jobData: unknown) => Promise<string | null>;
  }> = {},
) {
  const advance =
    overrides.advance ??
    ({
      status: 'advanced',
      discussionId: 'discussion_1',
      round: 1,
      turnIndex: 1,
      participantId: 'participant_b',
      agentId: 'agent_b',
      role: 'negative',
      taskId: 'next_task',
      version: 1,
    } satisfies DiscussionAdvanceResult);
  return {
    loadDiscussion: vi.fn().mockResolvedValue(overrides.discussion ?? makeDiscussion()),
    listParticipants: vi.fn().mockResolvedValue(overrides.participants ?? makeParticipants()),
    loadTranscript: vi.fn().mockResolvedValue(overrides.transcript ?? makeTranscript()),
    completeTaskAndAdvance: vi.fn().mockResolvedValue({ task: {}, turn: {}, advance }),
    enqueue: vi.fn(overrides.enqueue ?? (async () => 'job_1')),
    deleteLease: vi.fn().mockResolvedValue(undefined),
    renderCommittedTurns: vi.fn().mockResolvedValue(undefined),
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  };
}

function makeInput(overrides: Record<string, unknown> = {}) {
  return {
    taskId: 'task_current',
    sessionId: 'session_1',
    agentId: 'agent_a',
    feishuAppId: 'app_a',
    taskType: 'chat_reply',
    goal: 'current turn',
    runtimeHint: 'auto',
    constraints: {
      timeoutSec: 1800,
      tenantKey: 'default',
      chatId: 'chat_1',
      userMessageId: 'om_root',
      discussionId: 'discussion_1',
      discussionParticipantId: 'participant_a',
      discussionRound: 1,
      discussionTurnIndex: 0,
      discussionRole: 'affirmative',
      ...overrides,
    },
    content: 'Opening argument',
    status: 'completed' as const,
  };
}

describe('deliverDiscussionTurnAdvance', () => {
  it('no-ops for ordinary non-discussion tasks', async () => {
    const deps = makeDeps();

    const result = await deliverDiscussionTurnAdvance(deps, {
      ...makeInput(),
      constraints: {},
    });

    expect(result).toBe('not_discussion_turn');
    expect(deps.completeTaskAndAdvance).not.toHaveBeenCalled();
    expect(deps.enqueue).not.toHaveBeenCalled();
  });

  it('commits completion and advance, enqueues the next turn, then deletes the durable lease', async () => {
    const deps = makeDeps();

    const result = await deliverDiscussionTurnAdvance(deps, makeInput());

    expect(result).toBe('enqueued');
    expect(deps.completeTaskAndAdvance).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task_current',
        status: 'completed',
      }),
      expect.objectContaining({
        discussionId: 'discussion_1',
        taskId: 'task_current',
        round: 1,
        turnIndex: 0,
        content: 'Opening argument',
      }),
      expect.objectContaining({
        nextTurn: expect.objectContaining({
          sessionId: 'session_1',
          agentId: 'agent_b',
          feishuAppId: 'app_b',
          taskType: 'chat_reply',
          constraints: expect.objectContaining({
            discussionId: 'discussion_1',
            discussionParticipantId: 'participant_b',
            discussionRound: 1,
            discussionTurnIndex: 1,
          }),
        }),
      }),
    );
    expect(deps.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session_1',
        agentId: 'agent_b',
        feishuAppId: 'app_b',
        taskType: 'chat_reply',
        goal: expect.stringContaining('Opening argument'),
        constraints: expect.objectContaining({
          discussionTurnIndex: 1,
        }),
      }),
    );
    const enqueuedJob = vi.mocked(deps.enqueue).mock.calls[0][0] as { taskId: string };
    expect(deps.deleteLease).toHaveBeenCalledWith(enqueuedJob.taskId);
    expect(deps.renderCommittedTurns).toHaveBeenCalledWith({
      discussionId: 'discussion_1',
      throughTaskId: 'task_current',
      includeClosing: false,
    });
  });

  it('retains the durable lease when enqueue throws after the storage commit', async () => {
    const deps = makeDeps({
      enqueue: async () => {
        throw new Error('pg-boss down');
      },
    });

    const result = await deliverDiscussionTurnAdvance(deps, makeInput());

    expect(result).toBe('lease_retained');
    expect(deps.completeTaskAndAdvance).toHaveBeenCalled();
    expect(deps.deleteLease).not.toHaveBeenCalled();
    expect(deps.renderCommittedTurns).toHaveBeenCalledWith({
      discussionId: 'discussion_1',
      throughTaskId: 'task_current',
      includeClosing: false,
    });
    expect(deps.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task_current',
        discussionId: 'discussion_1',
      }),
      'Discussion next turn enqueue failed; durable lease retained',
    );
  });

  it('records failed turns and still advances instead of stranding the discussion', async () => {
    const deps = makeDeps();

    const result = await deliverDiscussionTurnAdvance(deps, {
      ...makeInput(),
      status: 'failed',
      content: null,
      errorMessage: 'runtime timed out',
    });

    expect(result).toBe('enqueued');
    expect(deps.completeTaskAndAdvance).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task_current',
        status: 'failed',
        errorMessage: 'runtime timed out',
      }),
      expect.objectContaining({
        status: 'failed',
        content: null,
        errorMessage: 'runtime timed out',
      }),
      expect.objectContaining({
        nextTurn: expect.objectContaining({
          agentId: 'agent_b',
          constraints: expect.objectContaining({
            discussionRound: 1,
            discussionTurnIndex: 1,
          }),
        }),
      }),
    );
    expect(deps.enqueue).toHaveBeenCalled();
  });

  it('does not enqueue when the atomic task-and-discussion commit fails', async () => {
    const deps = makeDeps();
    deps.completeTaskAndAdvance.mockRejectedValueOnce(new Error('advance failed'));

    await expect(deliverDiscussionTurnAdvance(deps, makeInput())).rejects.toThrow(
      'advance failed',
    );

    expect(deps.enqueue).not.toHaveBeenCalled();
    expect(deps.deleteLease).not.toHaveBeenCalled();
  });

  it('wraps from B back to A in the next round with prior turns in the prompt', async () => {
    const deps = makeDeps({
      transcript: makeCompletedTranscript(),
      advance: {
        status: 'advanced',
        discussionId: 'discussion_1',
        round: 2,
        turnIndex: 0,
        participantId: 'participant_a',
        agentId: 'agent_a',
        role: 'affirmative',
        taskId: 'task_a_2',
        version: 2,
      },
    });

    const result = await deliverDiscussionTurnAdvance(
      deps,
      makeInput({
        discussionParticipantId: 'participant_b',
        discussionRound: 1,
        discussionTurnIndex: 1,
        discussionRole: 'negative',
      }),
    );

    expect(result).toBe('enqueued');
    expect(deps.completeTaskAndAdvance).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        nextTurn: expect.objectContaining({
          agentId: 'agent_a',
          feishuAppId: 'app_a',
          goal: expect.stringContaining('Opening argument'),
          constraints: expect.objectContaining({
            discussionParticipantId: 'participant_a',
            discussionRound: 2,
            discussionTurnIndex: 0,
            discussionRole: 'affirmative',
          }),
        }),
      }),
    );
    const advanceInput = vi.mocked(deps.completeTaskAndAdvance).mock.calls[0][2];
    expect(advanceInput.nextTurn?.goal).toContain('Opening argument');
    expect(advanceInput.nextTurn?.goal).toContain('Agent A');
    expect(advanceInput.nextTurn?.goal).toContain('Agent B');
  });

  it('does not enqueue when the discussion is completed by the storage commit', async () => {
    const deps = makeDeps({
      discussion: { ...makeDiscussion(), roundLimit: 1 },
      advance: {
        status: 'completed',
        discussionId: 'discussion_1',
        version: 1,
      },
    });

    const result = await deliverDiscussionTurnAdvance(deps, makeInput({ discussionTurnIndex: 1 }));

    expect(result).toBe('not_advanced');
    expect(deps.completeTaskAndAdvance).toHaveBeenCalled();
    expect(deps.enqueue).not.toHaveBeenCalled();
    expect(deps.deleteLease).not.toHaveBeenCalled();
    expect(deps.renderCommittedTurns).toHaveBeenCalledWith({
      discussionId: 'discussion_1',
      throughTaskId: 'task_current',
      includeClosing: true,
    });
  });
});
