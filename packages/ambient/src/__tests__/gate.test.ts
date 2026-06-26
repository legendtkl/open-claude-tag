import { describe, expect, it, vi } from 'vitest';
import { evaluateAmbientPost } from '../gate.js';
import type { AmbientInbound, AmbientPostInput } from '../types.js';

function baseMessage(overrides: Partial<AmbientInbound> = {}): AmbientInbound {
  return {
    messageId: 'm1',
    eventType: 'created',
    occurredAt: 1_700_000_000_000,
    scope: { kind: 'lark', scopeId: 'chat-1', isPrivate: false },
    sender: { id: 'u1', isBot: false },
    content: { type: 'text', text: 'Does anyone know how to fix the deploy?', mentions: [] },
    ...overrides,
  };
}

function input(overrides: Partial<AmbientPostInput> = {}): AmbientPostInput {
  return {
    message: baseMessage(),
    context: 'the team has been fighting the deploy pipeline all week',
    ambientEnabled: true,
    budget: { withinBudget: true },
    ...overrides,
  };
}

describe('evaluateAmbientPost — default OFF', () => {
  it('never posts when ambient is disabled, naming the gate', async () => {
    const res = await evaluateAmbientPost(input({ ambientEnabled: false }));
    expect(res).toEqual({ shouldPost: false, reason: 'ambient_disabled' });
  });

  it('treats any non-true flag as OFF (fail-closed)', async () => {
    for (const flag of [undefined, null, 0, '', 'true']) {
      const res = await evaluateAmbientPost(input({ ambientEnabled: flag as unknown as boolean }));
      expect(res).toEqual({ shouldPost: false, reason: 'ambient_disabled' });
    }
  });

  it('short-circuits before budget, heuristic, and judge when disabled', async () => {
    const judge = vi.fn(async () => ({ post: true, rationale: 'yes' }));
    const checkBudget = vi.fn(() => ({ withinBudget: true }));
    const res = await evaluateAmbientPost(
      input({ ambientEnabled: false, budget: checkBudget, judge }),
    );
    expect(res).toEqual({ shouldPost: false, reason: 'ambient_disabled' });
    expect(checkBudget).not.toHaveBeenCalled();
    expect(judge).not.toHaveBeenCalled();
  });
});

describe('evaluateAmbientPost — substantive & un-addressed gate', () => {
  it('skips a non created/updated event', async () => {
    const res = await evaluateAmbientPost(
      input({ message: baseMessage({ eventType: 'deleted' }) }),
    );
    expect(res).toEqual({ shouldPost: false, reason: 'unsupported_event_type' });
  });

  it('skips non-text content', async () => {
    const res = await evaluateAmbientPost(
      input({ message: baseMessage({ content: { type: 'image' } }) }),
    );
    expect(res).toEqual({ shouldPost: false, reason: 'non_text_content' });
  });

  it('accepts rich_text content with extracted text', async () => {
    const res = await evaluateAmbientPost(
      input({
        message: baseMessage({
          content: { type: 'rich_text', text: 'should we roll back the deploy?', mentions: [] },
        }),
      }),
    );
    expect(res).toEqual({ shouldPost: true, reason: 'unanswered_question' });
  });

  it('skips a bot sender', async () => {
    const res = await evaluateAmbientPost(
      input({ message: baseMessage({ sender: { id: 'b1', isBot: true } }) }),
    );
    expect(res).toEqual({ shouldPost: false, reason: 'bot_sender' });
  });

  it('skips an addressed (bot-mention) message', async () => {
    const res = await evaluateAmbientPost(
      input({
        message: baseMessage({
          content: {
            type: 'text',
            text: 'hey can you help?',
            mentions: [{ type: 'bot', id: 'b1' }],
          },
        }),
      }),
    );
    expect(res).toEqual({ shouldPost: false, reason: 'addressed' });
  });

  it('skips empty text', async () => {
    const res = await evaluateAmbientPost(
      input({ message: baseMessage({ content: { type: 'text', text: '   ', mentions: [] } }) }),
    );
    expect(res).toEqual({ shouldPost: false, reason: 'empty_content' });
  });

  it('skips a slash command', async () => {
    const res = await evaluateAmbientPost(
      input({
        message: baseMessage({ content: { type: 'text', text: '/deploy now', mentions: [] } }),
      }),
    );
    expect(res).toEqual({ shouldPost: false, reason: 'command' });
  });

  it('skips a trivial fragment', async () => {
    const res = await evaluateAmbientPost(
      input({ message: baseMessage({ content: { type: 'text', text: 'ok', mentions: [] } }) }),
    );
    expect(res).toEqual({ shouldPost: false, reason: 'trivial' });
  });
});

describe('evaluateAmbientPost — budget gate', () => {
  it('does not post when over budget, before any judge spend', async () => {
    const judge = vi.fn(async () => ({ post: true, rationale: 'yes' }));
    const res = await evaluateAmbientPost(input({ budget: { withinBudget: false }, judge }));
    expect(res).toEqual({ shouldPost: false, reason: 'budget_exhausted' });
    expect(judge).not.toHaveBeenCalled();
  });

  it('resolves an injected async checkBudget()', async () => {
    const res = await evaluateAmbientPost(input({ budget: async () => ({ withinBudget: false }) }));
    expect(res).toEqual({ shouldPost: false, reason: 'budget_exhausted' });
  });

  it('fails closed when the budget check throws (no post, no judge)', async () => {
    const judge = vi.fn(async () => ({ post: true, rationale: 'yes' }));
    const res = await evaluateAmbientPost(
      input({
        budget: () => {
          throw new Error('budget store down');
        },
        judge,
      }),
    );
    expect(res).toEqual({ shouldPost: false, reason: 'budget_check_failed' });
    expect(judge).not.toHaveBeenCalled();
  });
});

describe('evaluateAmbientPost — heuristic & judge', () => {
  it('posts on a substantive unanswered question with no judge', async () => {
    const res = await evaluateAmbientPost(input());
    expect(res).toEqual({ shouldPost: true, reason: 'unanswered_question' });
  });

  it('posts on a topic the channel cares about (context overlap), no judge', async () => {
    const res = await evaluateAmbientPost(
      input({
        message: baseMessage({
          content: { type: 'text', text: 'the deploy pipeline broke again', mentions: [] },
        }),
        context: 'the team keeps fighting the deploy pipeline',
      }),
    );
    expect(res).toEqual({ shouldPost: true, reason: 'channel_topic' });
  });

  it('does not post when nothing is worth saying', async () => {
    const res = await evaluateAmbientPost(
      input({
        message: baseMessage({
          content: { type: 'text', text: 'sounds good to me', mentions: [] },
        }),
        context: 'unrelated chatter about lunch plans',
      }),
    );
    expect(res).toEqual({ shouldPost: false, reason: 'not_worth_saying' });
  });

  it('does not treat a shared stopword as a channel topic', async () => {
    // Only common function words overlap → no real topic → no judge-less post.
    const res = await evaluateAmbientPost(
      input({
        message: baseMessage({
          content: { type: 'text', text: 'that would have been with this', mentions: [] },
        }),
        context: 'this that been have with would',
      }),
    );
    expect(res).toEqual({ shouldPost: false, reason: 'not_worth_saying' });
  });

  it('does not post when the injected judge declines', async () => {
    const judge = vi.fn(async () => ({ post: false, rationale: 'low value' }));
    const res = await evaluateAmbientPost(input({ judge }));
    expect(res).toEqual({ shouldPost: false, reason: 'judge_declined' });
    expect(judge).toHaveBeenCalledTimes(1);
  });

  it('posts when the injected judge confirms', async () => {
    const judge = vi.fn(async () => ({ post: true, rationale: 'worth it' }));
    const res = await evaluateAmbientPost(input({ judge }));
    expect(res).toEqual({ shouldPost: true, reason: 'judge_approved' });
    expect(judge).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the injected judge throws', async () => {
    const judge = vi.fn(async () => {
      throw new Error('llm timeout');
    });
    const res = await evaluateAmbientPost(input({ judge }));
    expect(res).toEqual({ shouldPost: false, reason: 'judge_failed' });
    expect(judge).toHaveBeenCalledTimes(1);
  });

  it('passes the heuristic signal to the judge', async () => {
    const judge = vi.fn(async () => ({ post: true, rationale: 'ok' }));
    await evaluateAmbientPost(input({ judge }));
    expect(judge).toHaveBeenCalledWith(
      expect.objectContaining({ heuristic: 'unanswered_question' }),
    );
  });
});

describe('evaluateAmbientPost — gate ordering', () => {
  it('runs cheap checks before budget, and budget before the judge', async () => {
    const calls: string[] = [];
    const checkBudget = vi.fn(() => {
      calls.push('budget');
      return { withinBudget: true };
    });
    const judge = vi.fn(async () => {
      calls.push('judge');
      return { post: true, rationale: 'ok' };
    });

    // A trivial message never reaches budget or judge.
    await evaluateAmbientPost(
      input({
        message: baseMessage({ content: { type: 'text', text: 'ok', mentions: [] } }),
        budget: checkBudget,
        judge,
      }),
    );
    expect(calls).toEqual([]);

    // A worth-saying message reaches budget THEN judge, in that order.
    calls.length = 0;
    await evaluateAmbientPost(input({ budget: checkBudget, judge }));
    expect(calls).toEqual(['budget', 'judge']);
  });
});
