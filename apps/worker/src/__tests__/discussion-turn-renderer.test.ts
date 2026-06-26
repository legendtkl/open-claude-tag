import { describe, expect, it, vi } from 'vitest';
import { renderDiscussionTurnsThrough } from '../discussion-turn-renderer.js';
import { createLarkChannelSender } from '../channel-sender.js';
import type {
  DiscussionParticipantRecord,
  DiscussionRecord,
  DiscussionTranscriptTurn,
} from '@open-tag/storage';
import type { FeishuClient } from '@open-tag/feishu-adapter';

function makeDiscussion(overrides: Partial<DiscussionRecord> = {}): DiscussionRecord {
  return {
    id: 'discussion_1',
    tenantKey: 'default',
    chatId: 'chat_1',
    rootThreadId: 'om_root',
    feishuAppId: null,
    sessionId: 'session_1',
    topic: 'Render the discussion',
    status: 'active',
    roundLimit: 2,
    currentRound: 1,
    currentTurnIndex: 1,
    version: 1,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    completedAt: null,
    ...overrides,
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

function makeTurn(
  input: Partial<DiscussionTranscriptTurn> & Pick<DiscussionTranscriptTurn, 'id' | 'taskId'>,
): DiscussionTranscriptTurn {
  return {
    discussionId: 'discussion_1',
    round: 1,
    turnIndex: 0,
    participantId: 'participant_a',
    agentId: 'agent_a',
    agentHandle: 'agent-a',
    agentDisplayName: 'Agent A',
    role: 'affirmative',
    status: 'completed',
    content: 'Opening argument',
    errorMessage: null,
    metadata: {},
    createdAt: new Date('2026-01-01T00:00:00Z'),
    completedAt: new Date('2026-01-01T00:01:00Z'),
    ...input,
  };
}

function makeDeps(overrides: {
  discussion?: DiscussionRecord;
  transcript?: DiscussionTranscriptTurn[];
  sendMessage?: ReturnType<typeof vi.fn>;
} = {}) {
  const sendMessage =
    overrides.sendMessage ?? vi.fn(async () => ({ messageId: `om_${sendMessage.mock.calls.length}` }));
  const client = { sendMessage } as unknown as FeishuClient;
  return {
    loadDiscussion: vi.fn().mockResolvedValue(overrides.discussion ?? makeDiscussion()),
    listParticipants: vi.fn().mockResolvedValue(makeParticipants()),
    loadTranscript: vi.fn().mockResolvedValue(
      overrides.transcript ?? [
        makeTurn({ id: 'turn_a', taskId: 'task_a' }),
        makeTurn({
          id: 'turn_b',
          taskId: 'task_b',
          turnIndex: 1,
          participantId: 'participant_b',
          agentId: 'agent_b',
          agentHandle: 'agent-b',
          agentDisplayName: 'Agent B',
          role: 'negative',
          content: 'Rebuttal',
        }),
      ],
    ),
    getChannelSender: vi.fn().mockResolvedValue(createLarkChannelSender(client)),
    markRendered: vi.fn().mockResolvedValue({}),
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    sendMessage,
  };
}

describe('renderDiscussionTurnsThrough', () => {
  it('renders missing terminal turns through the current task in transcript order', async () => {
    const deps = makeDeps();

    await renderDiscussionTurnsThrough(deps, {
      discussionId: 'discussion_1',
      throughTaskId: 'task_b',
    });

    expect(deps.sendMessage).toHaveBeenCalledTimes(2);
    expect(deps.sendMessage.mock.calls[0][2].content.text).toContain('Agent A');
    expect(deps.sendMessage.mock.calls[1][2].content.text).toContain('Agent B');
    expect(deps.sendMessage.mock.calls.map((call) => call[3])).toEqual(['om_root', 'om_root']);
    expect(deps.sendMessage.mock.calls.map((call) => call[4].uuid)).toHaveLength(2);
    expect(deps.markRendered).toHaveBeenCalledTimes(2);
    expect(deps.markRendered.mock.calls.map((call) => call[0].kind)).toEqual(['turn', 'turn']);
  });

  it('skips turns already marked as rendered', async () => {
    const deps = makeDeps({
      transcript: [
        makeTurn({
          id: 'turn_a',
          taskId: 'task_a',
          metadata: {
            feishuRender: { renderKey: 'existing', messageId: 'om_existing' },
          },
        }),
        makeTurn({
          id: 'turn_b',
          taskId: 'task_b',
          turnIndex: 1,
          participantId: 'participant_b',
          content: 'Rebuttal',
        }),
      ],
    });

    await renderDiscussionTurnsThrough(deps, {
      discussionId: 'discussion_1',
      throughTaskId: 'task_b',
    });

    expect(deps.sendMessage).toHaveBeenCalledTimes(1);
    expect(deps.sendMessage.mock.calls[0][2].content.text).toContain('Rebuttal');
    expect(deps.markRendered).toHaveBeenCalledWith(
      expect.objectContaining({ turnId: 'turn_b', kind: 'turn' }),
    );
  });

  it('renders a completed turn with empty content', async () => {
    const deps = makeDeps({
      transcript: [
        makeTurn({
          id: 'turn_empty',
          taskId: 'task_empty',
          content: '',
        }),
      ],
    });

    await renderDiscussionTurnsThrough(deps, {
      discussionId: 'discussion_1',
      throughTaskId: 'task_empty',
    });

    expect(deps.sendMessage).toHaveBeenCalledTimes(1);
    expect(deps.sendMessage.mock.calls[0][2].content.text).toContain('Agent A');
    expect(deps.sendMessage.mock.calls[0][2].content.text).toContain('Topic: Render the discussion');
    expect(deps.markRendered).toHaveBeenCalledWith(
      expect.objectContaining({ turnId: 'turn_empty', kind: 'turn' }),
    );
  });

  it('renders a closing message once when the current turn completes the discussion', async () => {
    const deps = makeDeps({ discussion: makeDiscussion({ status: 'completed' }) });

    await renderDiscussionTurnsThrough(deps, {
      discussionId: 'discussion_1',
      throughTaskId: 'task_b',
      includeClosing: true,
    });

    expect(deps.sendMessage).toHaveBeenCalledTimes(3);
    expect(deps.sendMessage.mock.calls[2][2].content.text).toContain('Discussion completed');
    expect(deps.markRendered.mock.calls[2][0]).toMatchObject({
      turnId: 'turn_b',
      kind: 'closing',
    });
  });

  it('renders closing once when the final completed turn has empty content', async () => {
    const deps = makeDeps({
      discussion: makeDiscussion({ status: 'completed' }),
      transcript: [
        makeTurn({
          id: 'turn_a',
          taskId: 'task_a',
          metadata: {
            feishuRender: { renderKey: 'existing', messageId: 'om_existing' },
          },
        }),
        makeTurn({
          id: 'turn_empty_final',
          taskId: 'task_empty_final',
          turnIndex: 1,
          participantId: 'participant_b',
          agentId: 'agent_b',
          agentHandle: 'agent-b',
          agentDisplayName: 'Agent B',
          role: 'negative',
          content: '',
        }),
      ],
    });

    await renderDiscussionTurnsThrough(deps, {
      discussionId: 'discussion_1',
      throughTaskId: 'task_empty_final',
      includeClosing: true,
    });

    expect(deps.sendMessage).toHaveBeenCalledTimes(2);
    expect(deps.sendMessage.mock.calls[0][2].content.text).toContain('Agent B');
    expect(deps.sendMessage.mock.calls[1][2].content.text).toContain('Discussion completed');
    expect(deps.markRendered.mock.calls.map((call) => call[0].kind)).toEqual(['turn', 'closing']);

    await renderDiscussionTurnsThrough(
      makeDeps({
        discussion: makeDiscussion({ status: 'completed' }),
        transcript: [
          makeTurn({
            id: 'turn_empty_final',
            taskId: 'task_empty_final',
            content: '',
            metadata: {
              feishuRender: { renderKey: 'existing-turn', messageId: 'om_turn' },
              feishuClosingRender: { renderKey: 'existing-closing', messageId: 'om_closing' },
            },
          }),
        ],
        sendMessage: deps.sendMessage,
      }),
      {
        discussionId: 'discussion_1',
        throughTaskId: 'task_empty_final',
        includeClosing: true,
      },
    );

    expect(deps.sendMessage).toHaveBeenCalledTimes(2);
  });
});
