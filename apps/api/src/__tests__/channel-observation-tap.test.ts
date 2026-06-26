import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NormalizedEvent } from '@open-tag/core-types';
import type { Database } from '@open-tag/storage';

// Mock only the channel-scoped observation writer; adaptNormalizedEvent stays
// real so the test exercises the actual InboundMessage projection the tap feeds
// to ingestObservation.
const ingestObservationMock = vi.fn();
vi.mock('@open-tag/memory', () => ({
  ingestObservation: (...args: unknown[]) => ingestObservationMock(...args),
}));

const { tapChannelObservation } = await import('../channel-observation-tap.js');

function makeNormalizedEvent(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    eventId: 'evt_obs_001',
    messageId: 'msg_obs_001',
    chatId: 'oc_chat_obs',
    chatType: 'group',
    threadId: 'thread_obs',
    rootMessageId: 'root_obs',
    parentMessageId: 'parent_obs',
    senderOpenId: 'ou_user_obs',
    senderUnionId: 'on_user_obs',
    senderType: 'user',
    tenantKey: 'tenant_obs',
    content: {
      type: 'text',
      text: 'the staging deploy uses region us-west-2',
      raw: { schema: '2.0' },
    },
    replyLanguage: 'en-US',
    timestamp: 1782864000000,
    ...overrides,
  };
}

// ingestObservation is mocked, so the db handle is never dereferenced here.
const fakeDb = {} as unknown as Database;

// Drain pending microtasks so the fire-and-forget `.catch().finally()` chain
// runs (the `.finally` decrements the in-flight counter) — keeps the shared
// module-level counter deterministic across tests.
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
}

describe('tapChannelObservation', () => {
  beforeEach(() => {
    ingestObservationMock.mockReset();
  });

  it('ingests a normal (un-addressed) text message into channel memory', async () => {
    ingestObservationMock.mockResolvedValue({ written: true });

    tapChannelObservation(fakeDb, makeNormalizedEvent(), true);

    expect(ingestObservationMock).toHaveBeenCalledTimes(1);
    const [dbArg, inbound] = ingestObservationMock.mock.calls[0];
    expect(dbArg).toBe(fakeDb);
    // Faithfully projected via adaptNormalizedEvent — no @mention required for a
    // channel observation; the whole point is "following the channel".
    expect(inbound.scope.scopeId).toBe('oc_chat_obs');
    expect(inbound.eventType).toBe('created');
    expect(inbound.sender.isBot).toBe(false);
    expect(inbound.content).toMatchObject({
      type: 'text',
      text: 'the staging deploy uses region us-west-2',
    });

    await flushMicrotasks();
  });

  it('does not call ingestObservation when the toggle is off', () => {
    tapChannelObservation(fakeDb, makeNormalizedEvent(), false);
    expect(ingestObservationMock).not.toHaveBeenCalled();
  });

  it('swallows an ingestObservation rejection so the handler never throws (error isolation)', async () => {
    ingestObservationMock.mockRejectedValue(new Error('observation store down'));

    // The tap returns synchronously and must not throw even though the async
    // write rejects — a failed observation write cannot break message handling.
    expect(() => tapChannelObservation(fakeDb, makeNormalizedEvent(), true)).not.toThrow();
    expect(ingestObservationMock).toHaveBeenCalledTimes(1);

    // Flush microtasks so the fire-and-forget `.catch()` runs; the rejection
    // must be handled internally (no unhandled rejection, no escape).
    await flushMicrotasks();
  });

  it('sheds observations past the in-flight cap, then recovers once writes drain', async () => {
    // Hold every write open so the in-flight counter climbs to the cap.
    const resolvers: Array<() => void> = [];
    ingestObservationMock.mockImplementation(
      () =>
        new Promise<{ written: boolean }>((resolve) => {
          resolvers.push(() => resolve({ written: true }));
        }),
    );

    // Cap is 8: the first 8 are accepted, the 9th is shed (no write started).
    for (let i = 0; i < 9; i += 1) {
      tapChannelObservation(fakeDb, makeNormalizedEvent({ eventId: `evt_${i}` }), true);
    }
    expect(ingestObservationMock).toHaveBeenCalledTimes(8);

    // Drain the in-flight writes; the counter returns to zero.
    resolvers.forEach((resolve) => resolve());
    await flushMicrotasks();

    // A subsequent message is accepted again now that capacity freed up.
    tapChannelObservation(fakeDb, makeNormalizedEvent({ eventId: 'evt_after' }), true);
    expect(ingestObservationMock).toHaveBeenCalledTimes(9);
    resolvers.forEach((resolve) => resolve());
    await flushMicrotasks();
  });
});

// Source-level guard for the chokepoint wiring: the unit tests above prove the
// helper's behavior, but not that server.ts actually calls it at the right
// place. Pin that the tap is invoked exactly once, after the dedup check and
// before enrichment/routing — so it fires for un-addressed messages too and
// can't silently regress (removed, moved below @mention routing, or duplicated).
describe('channel observation tap wiring in server.ts', () => {
  const serverSrc = readFileSync(
    fileURLToPath(new URL('../server.ts', import.meta.url)),
    'utf8',
  );

  it('calls tapChannelObservation exactly once on the inbound chokepoint', () => {
    const callMatches = serverSrc.match(/tapChannelObservation\(db, event\)/g) ?? [];
    expect(callMatches).toHaveLength(1);
  });

  it('taps after the duplicate-event check and before enrichment/routing', () => {
    const dedupIdx = serverSrc.indexOf('Duplicate event, skipping');
    const tapIdx = serverSrc.indexOf('tapChannelObservation(db, event)');
    const enrichIdx = serverSrc.indexOf('enrichEventWithCurrentMessageThread(event');
    expect(dedupIdx).toBeGreaterThan(-1);
    expect(tapIdx).toBeGreaterThan(dedupIdx);
    expect(enrichIdx).toBeGreaterThan(tapIdx);
  });
});
