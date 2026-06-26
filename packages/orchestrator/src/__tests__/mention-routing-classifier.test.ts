import type { ChatMessage, LlmClient } from '@open-tag/llm-client';
import { describe, expect, it, vi } from 'vitest';
import {
  classifyMentionRouting,
  createMentionRoutingMemo,
  type MentionRoutingCandidate,
} from '../mention-routing-classifier.js';

const CANDIDATES: MentionRoutingCandidate[] = [
  { ref: 'agent_1', agentId: 'id-dev', handle: 'Developer', displayName: 'Developer' },
  { ref: 'agent_2', agentId: 'id-rev', handle: 'Reviewer', displayName: 'Reviewer' },
];

function mockClient(responses: string[] | (() => Promise<string>)): LlmClient & {
  calls: ChatMessage[][];
} {
  const calls: ChatMessage[][] = [];
  let index = 0;
  return {
    calls,
    provider: () => 'mock',
    async chat(messages: ChatMessage[]) {
      calls.push(messages);
      if (typeof responses === 'function') return responses();
      const response = responses[Math.min(index, responses.length - 1)];
      index += 1;
      return response;
    },
  };
}

const INCIDENT_TEXT =
  '@Developer 合并 /session 和 /sessions 命令，合并完艾特 @Reviewer 进行 code review';

describe('classifyMentionRouting', () => {
  it('returns a validated relay decision', async () => {
    const client = mockClient([
      JSON.stringify({
        route: 'relay',
        primary: 'agent_1',
        deferred: [
          { agent: 'agent_2', goal: '进行 code review', ack: '收到，等 @Developer 完成后我来 code review' },
        ],
      }),
    ]);
    const decision = await classifyMentionRouting(
      { text: INCIDENT_TEXT, candidates: CANDIDATES },
      client,
    );
    expect(decision).toEqual({
      route: 'relay',
      primaryAgentId: 'id-dev',
      deferred: [
        {
          agentId: 'id-rev',
          goal: '进行 code review',
          ack: '收到，等 @Developer 完成后我来 code review',
        },
      ],
    });
    expect(client.calls).toHaveLength(1);
  });

  it('retries once with targeted feedback on a hallucinated ref, then accepts', async () => {
    const client = mockClient([
      JSON.stringify({
        route: 'relay',
        primary: 'agent_99',
        deferred: [{ agent: 'agent_2', goal: 'review', ack: 'ok' }],
      }),
      JSON.stringify({
        route: 'relay',
        primary: 'agent_1',
        deferred: [{ agent: 'agent_2', goal: 'review', ack: 'ok' }],
      }),
    ]);
    const decision = await classifyMentionRouting(
      { text: INCIDENT_TEXT, candidates: CANDIDATES },
      client,
    );
    expect(decision?.route).toBe('relay');
    expect(client.calls).toHaveLength(2);
    const retryMessages = client.calls[1];
    const feedback = retryMessages[retryMessages.length - 1];
    expect(feedback.role).toBe('user');
    expect(feedback.content).toContain('invalid');
    expect(feedback.content).toContain('agent_1');
  });

  it('returns null after two invalid outputs', async () => {
    const client = mockClient(['not json at all', '{"route":"relay","primary":"agent_9"}']);
    const decision = await classifyMentionRouting(
      { text: INCIDENT_TEXT, candidates: CANDIDATES },
      client,
    );
    expect(decision).toBeNull();
    expect(client.calls).toHaveLength(2);
  });

  it('returns null on client error/timeout', async () => {
    const client = mockClient(() => Promise.reject(new Error('timeout')));
    const decision = await classifyMentionRouting(
      { text: INCIDENT_TEXT, candidates: CANDIDATES },
      client,
    );
    expect(decision).toBeNull();
  });

  it('returns null without a client or with fewer than two candidates', async () => {
    expect(
      await classifyMentionRouting({ text: INCIDENT_TEXT, candidates: CANDIDATES }, null),
    ).toBeNull();
    const client = mockClient(['{"route":"fanout"}']);
    expect(
      await classifyMentionRouting(
        { text: INCIDENT_TEXT, candidates: [CANDIDATES[0]] },
        client,
      ),
    ).toBeNull();
    expect(client.calls).toHaveLength(0);
  });

  it('rejects a relay that omits a mentioned agent (no silent drop)', async () => {
    const threeCandidates: MentionRoutingCandidate[] = [
      ...CANDIDATES,
      { ref: 'agent_3', agentId: 'id-qa', handle: 'QA', displayName: 'QA' },
    ];
    const client = mockClient([
      JSON.stringify({
        route: 'relay',
        primary: 'agent_1',
        deferred: [{ agent: 'agent_2', goal: 'review', ack: 'ok' }],
      }),
      JSON.stringify({
        route: 'relay',
        primary: 'agent_1',
        deferred: [
          { agent: 'agent_2', goal: 'review', ack: 'ok' },
          { agent: 'agent_3', goal: '测试', ack: 'ok' },
        ],
      }),
    ]);
    const decision = await classifyMentionRouting(
      { text: '@Developer 实现，然后 @Reviewer review、@QA 测试', candidates: threeCandidates },
      client,
    );
    expect(decision?.route).toBe('relay');
    if (decision?.route === 'relay') {
      expect(decision.deferred.map((entry) => entry.agentId)).toEqual(['id-rev', 'id-qa']);
    }
    expect(client.calls).toHaveLength(2);
    const feedback = client.calls[1][client.calls[1].length - 1];
    expect(feedback.content).toContain('agent_3');
  });

  it('rejects a deferred agent duplicated with the primary', async () => {
    const client = mockClient([
      JSON.stringify({
        route: 'relay',
        primary: 'agent_1',
        deferred: [{ agent: 'agent_1', goal: 'review', ack: 'ok' }],
      }),
      JSON.stringify({ route: 'fanout' }),
    ]);
    const decision = await classifyMentionRouting(
      { text: INCIDENT_TEXT, candidates: CANDIDATES },
      client,
    );
    expect(decision).toEqual({ route: 'fanout' });
  });

  it('validates reference decisions against the roster', async () => {
    const client = mockClient([
      JSON.stringify({ route: 'reference', actors: ['agent_2'], references: ['agent_1'] }),
    ]);
    const decision = await classifyMentionRouting(
      { text: '@Reviewer 看一下 @Developer 的 PR', candidates: CANDIDATES },
      client,
    );
    expect(decision).toEqual({
      route: 'reference',
      actorAgentIds: ['id-rev'],
      referenceAgentIds: ['id-dev'],
    });
  });
});

describe('createMentionRoutingMemo', () => {
  it('shares one in-flight classification across concurrent callers', async () => {
    let resolveResponse!: (value: string) => void;
    const client = mockClient(
      () => new Promise<string>((resolve) => (resolveResponse = resolve)),
    );
    const memo = createMentionRoutingMemo();
    const input = { text: INCIDENT_TEXT, candidates: CANDIDATES };

    const [first, second] = [
      memo.classifyOnce('om_x1', input, client),
      memo.classifyOnce('om_x1', input, client),
    ];
    resolveResponse('{"route":"fanout"}');
    const [a, b] = await Promise.all([first, second]);

    expect(a).toEqual({ route: 'fanout' });
    expect(b).toBe(a);
    expect(client.calls).toHaveLength(1);
  });

  it('evicts expired entries', async () => {
    vi.useFakeTimers();
    try {
      const client = mockClient(['{"route":"fanout"}']);
      const memo = createMentionRoutingMemo(1000);
      await memo.classifyOnce('om_a', { text: INCIDENT_TEXT, candidates: CANDIDATES }, client);
      expect(memo.size()).toBe(1);
      vi.setSystemTime(Date.now() + 2000);
      await memo.classifyOnce('om_b', { text: INCIDENT_TEXT, candidates: CANDIDATES }, client);
      expect(memo.size()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
