import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { SlackChannel } from '@open-tag/channel-slack';
import type { InboundMessage } from '@open-tag/channel-core';
import type { Logger } from '@open-tag/observability';
import { channelObservations, createDb, inboundEvents } from '@open-tag/storage';
import type { Database } from '@open-tag/storage';
import { createSlackInboundDispatch } from '../slack-events.js';

// Real-Postgres dispatch test: exercises the channel-neutral observation write
// plus the reused dedupe store. Gated like the ownership matrix test — runs under
// the isolated runner / OPEN_TAG_API_PG_INTEGRATION=1, skips in pure unit runs.
const describePg =
  process.env.DATABASE_URL || process.env.OPEN_TAG_API_PG_INTEGRATION === '1'
    ? describe
    : describe.skip;

const noopLogger = {
  info() {},
  warn() {},
  error() {},
} as unknown as Logger;

const channel = new SlackChannel({ token: 'xoxb-test' });

/** Build a normalized Slack InboundMessage with a unique scope + event id. */
function makeMessage(scopeId: string, eventId: string, text: string): InboundMessage {
  const message = channel.normalize({
    type: 'event_callback',
    team_id: 'T_test',
    api_app_id: 'A_test',
    event_id: eventId,
    event: {
      type: 'message',
      channel: scopeId,
      channel_type: 'channel',
      user: 'U_human',
      text,
      ts: '1710000000.000100',
      event_ts: '1710000000.000100',
    },
  });
  if (!message) throw new Error('fixture failed to normalize');
  return message;
}

describePg('createSlackInboundDispatch (Postgres)', () => {
  let db: Database;
  const scopeId = `C_slack_${randomUUID().slice(0, 8)}`;
  const eventId = `Ev_${randomUUID().slice(0, 8)}`;
  const dedupeKey = `slack:${eventId}`;

  beforeAll(() => {
    db = createDb(process.env.DATABASE_URL);
  });

  afterAll(async () => {
    await db.delete(channelObservations).where(eq(channelObservations.scopeId, scopeId));
    await db.delete(inboundEvents).where(eq(inboundEvents.eventId, dedupeKey));
    await db.$client.end({ timeout: 5 });
  });

  it('writes a channel-neutral observation and dedupes a retried delivery', async () => {
    const dispatch = createSlackInboundDispatch({ db, logger: noopLogger, channelMemoryEnabled: true });
    const message = makeMessage(scopeId, eventId, 'integration test observation body');

    // First delivery: writes one observation row + closes the dedupe claim.
    await dispatch(message, {});
    const afterFirst = await db
      .select()
      .from(channelObservations)
      .where(eq(channelObservations.scopeId, scopeId));
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0].channelKind).toBe('slack');
    expect(afterFirst[0].gist).toContain('integration test observation body');

    // The claim is closed (processed), not left dangling as `received`.
    const afterFirstClaim = await db
      .select()
      .from(inboundEvents)
      .where(eq(inboundEvents.eventId, dedupeKey));
    expect(afterFirstClaim).toHaveLength(1);
    expect(afterFirstClaim[0].status).toBe('processed');

    // Retry (same event id → same dedupeKey): dropped by the dedupe store, no
    // second observation row written.
    await dispatch(message, { retryNum: 1 });
    const afterRetry = await db
      .select()
      .from(channelObservations)
      .where(eq(channelObservations.scopeId, scopeId));
    expect(afterRetry).toHaveLength(1);

    // The shared dedupe store marks a detected redelivery as `duplicate` (never
    // back to `received`), so a retry can never re-dispatch.
    const afterRetryClaim = await db
      .select()
      .from(inboundEvents)
      .where(eq(inboundEvents.eventId, dedupeKey));
    expect(afterRetryClaim).toHaveLength(1);
    expect(afterRetryClaim[0].status).toBe('duplicate');
  });
});
