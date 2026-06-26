import { describe, expect, it, vi } from 'vitest';
import type { NormalizedEvent } from '@open-tag/core-types';
import { gatherPendingMessages, applyBufferGate } from '../buffer-gate.js';

// ── DB stub ──

interface SelectRow {
  content?: string;
  createdAt?: Date;
}

function makeDbStub(taskRows: SelectRow[], messageRows: SelectRow[]) {
  let callIndex = 0;
  const resultSets = [taskRows, messageRows];

  const chain = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => {
      const result = resultSets[callIndex] ?? [];
      callIndex++;
      return Promise.resolve(result);
    },
  };

  return { select: vi.fn(() => chain) } as any;
}

function makeEvent(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    eventId: 'evt_001',
    messageId: 'msg_001',
    chatId: 'chat_001',
    chatType: 'p2p',
    senderOpenId: 'ou_user1',
    tenantKey: 'tk_1',
    content: {
      type: 'text',
      text: 'hello',
      mentions: [],
      raw: {},
    },
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeEventWithBotMention(text = 'do it'): NormalizedEvent {
  return makeEvent({
    content: {
      type: 'text',
      text,
      mentions: [{ id: 'ou_bot', name: 'OpenClaudeTag', isBot: true }],
      raw: {},
    },
  });
}

// ── gatherPendingMessages tests ──

describe('gatherPendingMessages', () => {
  it('returns null when no user messages exist', async () => {
    const db = makeDbStub([], []);
    const result = await gatherPendingMessages(db, 'session_1');
    expect(result).toBeNull();
  });

  it('returns single message text without prefix', async () => {
    const db = makeDbStub([], [{ content: 'fix the bug' }]);
    const result = await gatherPendingMessages(db, 'session_1');
    expect(result).toEqual({ text: 'fix the bug', messageCount: 1 });
  });

  it('aggregates multiple messages with numbered prefixes', async () => {
    const db = makeDbStub([], [
      { content: 'fix the bug' },
      { content: 'also add tests' },
      { content: 'start' },
    ]);
    const result = await gatherPendingMessages(db, 'session_1');
    expect(result).toEqual({
      text: '[1] fix the bug\n[2] also add tests\n[3] start',
      messageCount: 3,
    });
  });

  it('filters out empty/whitespace-only messages', async () => {
    const db = makeDbStub([], [
      { content: 'fix the bug' },
      { content: '   ' },
      { content: '' },
      { content: 'add tests' },
    ]);
    const result = await gatherPendingMessages(db, 'session_1');
    expect(result).toEqual({
      text: '[1] fix the bug\n[2] add tests',
      messageCount: 2,
    });
  });

  it('returns null when all messages are empty', async () => {
    const db = makeDbStub([], [{ content: '' }, { content: '  ' }]);
    const result = await gatherPendingMessages(db, 'session_1');
    expect(result).toBeNull();
  });

  it('queries since last task createdAt when tasks exist', async () => {
    const lastTaskDate = new Date('2026-01-01');
    const db = makeDbStub(
      [{ createdAt: lastTaskDate }],
      [{ content: 'new message after task' }],
    );
    const result = await gatherPendingMessages(db, 'session_1');
    expect(result).toEqual({ text: 'new message after task', messageCount: 1 });
    // Two select calls: one for tasks, one for messages
    expect(db.select).toHaveBeenCalledTimes(2);
  });
});

// ── applyBufferGate tests ──

describe('applyBufferGate', () => {
  it('passes through slash commands without buffering', async () => {
    const db = makeDbStub([], []);
    const event = makeEvent({
      content: {
        type: 'command',
        command: '/status',
        args: '',
        text: '/status',
        mentions: [],
        raw: {},
      },
    });
    const result = await applyBufferGate(db, event, 'session_1');
    expect(result).toBe(event);
  });

  it('returns null (buffer) for messages without @bot mention', async () => {
    const db = makeDbStub([], []);
    const event = makeEvent();
    const result = await applyBufferGate(db, event, 'session_1');
    expect(result).toBeNull();
  });

  it('returns null when mentions array is empty', async () => {
    const db = makeDbStub([], []);
    const event = makeEvent({
      content: { type: 'text', text: 'hello', mentions: [], raw: {} },
    });
    const result = await applyBufferGate(db, event, 'session_1');
    expect(result).toBeNull();
  });

  it('aggregates messages when @bot is mentioned', async () => {
    const db = makeDbStub([], [
      { content: 'first message' },
      { content: 'second message' },
      { content: 'do it' },
    ]);
    const event = makeEventWithBotMention('do it');
    const result = await applyBufferGate(db, event, 'session_1');
    expect(result).not.toBeNull();
    expect(result!.content.text).toBe('[1] first message\n[2] second message\n[3] do it');
    // Preserves non-text fields
    expect(result!.eventId).toBe('evt_001');
    expect(result!.chatId).toBe('chat_001');
  });

  it('returns original event when @bot mentioned but no aggregated messages', async () => {
    const db = makeDbStub([], []);
    const event = makeEventWithBotMention('do it');
    const result = await applyBufferGate(db, event, 'session_1');
    // gatherPendingMessages returns null → original event passed through
    expect(result).toBe(event);
  });

  it('returns original event when only non-bot mentions exist', async () => {
    const db = makeDbStub([], []);
    const event = makeEvent({
      content: {
        type: 'text',
        text: 'hello',
        mentions: [{ id: 'ou_other', name: 'Alice', isBot: false }],
        raw: {},
      },
    });
    const result = await applyBufferGate(db, event, 'session_1');
    expect(result).toBeNull();
  });
});
