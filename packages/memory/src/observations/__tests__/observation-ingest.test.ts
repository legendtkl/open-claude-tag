import { describe, expect, it } from 'vitest';
import type { Database } from '@open-tag/storage';
import { ingestObservation, type ObservationInbound } from '../ingest.js';

// A db that throws on any access, proving the skip-paths return BEFORE the write.
const throwingDb = new Proxy(
  {},
  {
    get() {
      throw new Error('db must not be touched on a skipped observation');
    },
  },
) as unknown as Database;

function inbound(overrides: Partial<ObservationInbound> = {}): ObservationInbound {
  return {
    messageId: 'msg_1',
    eventType: 'created',
    occurredAt: 1782864000000,
    scope: { kind: 'lark', scopeId: 'scope_1' },
    sender: { isBot: false },
    content: { type: 'text', text: 'a substantive human observation' },
    ...overrides,
  };
}

describe('ingestObservation gating (no DB)', () => {
  it('skips non-created/updated event types', async () => {
    for (const eventType of ['deleted', 'reaction', 'interaction']) {
      const result = await ingestObservation(throwingDb, inbound({ eventType }));
      expect(result).toEqual({ written: false, reason: 'unsupported_event_type' });
    }
  });

  it('ingests both created and updated', async () => {
    // Reaching the write means the gate passed — assert via the thrown db sentinel.
    for (const eventType of ['created', 'updated']) {
      await expect(ingestObservation(throwingDb, inbound({ eventType }))).rejects.toThrow(
        'db must not be touched',
      );
    }
  });

  it('skips non-text content', async () => {
    const result = await ingestObservation(
      throwingDb,
      inbound({ content: { type: 'command', text: '/help' } }),
    );
    expect(result).toEqual({ written: false, reason: 'non_text_content' });
  });

  it('skips bot senders', async () => {
    const result = await ingestObservation(throwingDb, inbound({ sender: { isBot: true } }));
    expect(result).toEqual({ written: false, reason: 'bot_sender' });
  });

  it('skips empty / whitespace-only content', async () => {
    for (const text of ['', '   ', '\n\t']) {
      const result = await ingestObservation(
        throwingDb,
        inbound({ content: { type: 'text', text } }),
      );
      expect(result).toEqual({ written: false, reason: 'empty_content' });
    }
  });

  it('skips slash commands typed as text', async () => {
    const result = await ingestObservation(
      throwingDb,
      inbound({ content: { type: 'text', text: '/forget everything' } }),
    );
    expect(result).toEqual({ written: false, reason: 'command' });
  });

  it('skips trivial one-character content', async () => {
    const result = await ingestObservation(
      throwingDb,
      inbound({ content: { type: 'text', text: 'k' } }),
    );
    expect(result).toEqual({ written: false, reason: 'trivial' });
  });

  it('skips messages carrying sensitive info', async () => {
    const result = await ingestObservation(
      throwingDb,
      inbound({
        content: { type: 'text', text: 'the deploy key is sk-abcdefghijklmnopqrstuvwxyz012345' },
      }),
    );
    expect(result).toEqual({ written: false, reason: 'sensitive' });
  });
});
