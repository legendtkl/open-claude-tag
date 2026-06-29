/**
 * Integration proof (real Postgres): a SIGNED Slack event_callback addressed to
 * the bot dispatches a task through the neutral path (ADR-0005) and the ACK is
 * routed to an injected stub Slack sender — verifiable WITHOUT live Slack creds.
 *
 * It drives the real route handler (createSlackEventsHandler) end to end:
 * signature verify → dedupe claim → neutral dispatch → task row in PG + enqueue
 * (captured) + ACK via the injected stub sender. A forged-signature request is
 * rejected 401 and never dispatches.
 *
 * Gated like the other PG-backed API tests: runs under the isolated runner /
 * OPEN_TAG_API_PG_INTEGRATION=1, skips in pure unit runs.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { SlackChannel } from '@open-tag/channel-slack';
import type { ConversationRef, DeliveryRef, OutboundMessage } from '@open-tag/channel-core';
import type { FeedbackChannelSender } from '@open-tag/feishu-adapter';
import { handleEvent, transitionTask } from '@open-tag/orchestrator';
import { resolveSession } from '@open-tag/session';
import {
  createDb,
  inboundEvents,
  sessions,
  tasks,
  setTaskAckDelivery,
  getTaskAckDelivery,
} from '@open-tag/storage';
import type { Database } from '@open-tag/storage';
import type { Logger } from '@open-tag/observability';
import { createSlackEventsHandler, createSlackInboundDispatch } from '../slack-events.js';
import { dispatchNeutralMessage } from '../neutral-dispatch.js';
import type { NeutralAckDelivery } from '../neutral-dispatch.js';
import { resolveChannelSender } from '../channel-sender-resolver.js';

const describePg =
  process.env.DATABASE_URL || process.env.OPEN_TAG_API_PG_INTEGRATION === '1'
    ? describe
    : describe.skip;

const SECRET = 'slack-signing-secret-fixture';
// Slack user ids are uppercase alphanumerics; the mention parser requires it.
const BOT_USER_ID = 'UBOT123';
const TS = '1710000000';
const NOW_MS = 1710000000_000 + 2_000; // fresh: 2s after the signed timestamp

const noopLogger = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger;

function sign(secret: string, timestamp: string, body: string): string {
  const digest = createHmac('sha256', secret).update(`v0:${timestamp}:${body}`, 'utf8').digest('hex');
  return `v0=${digest}`;
}

interface FakeReply {
  statusCode: number;
  code(n: number): FakeReply;
}
function makeReply(): FakeReply {
  return {
    statusCode: 200,
    code(n: number) {
      this.statusCode = n;
      return this;
    },
  };
}

function makeRequest(body: unknown, signature: string): FastifyRequest {
  const raw = JSON.stringify(body);
  return {
    headers: {
      'content-type': 'application/json',
      'x-slack-signature': signature,
      'x-slack-request-timestamp': TS,
    },
    body,
    rawBody: Buffer.from(raw, 'utf8'),
  } as unknown as FastifyRequest;
}

describePg('Slack neutral task dispatch (Postgres)', () => {
  let db: Database;
  const channel = new SlackChannel({ token: 'xoxb-test' });
  const scopeId = `C_slack_${randomUUID().slice(0, 8)}`;
  const teamId = `T_${randomUUID().slice(0, 8)}`;
  const eventId = `Ev_${randomUUID().slice(0, 8)}`;
  const dedupeKey = `slack:${eventId}`;
  // A DISTINCT, never-processed event for the forged-signature case, so a (broken)
  // handler that dispatched before verifying could not be masked by dedupe.
  const forgedEventId = `Ev_${randomUUID().slice(0, 8)}`;
  const forgedDedupeKey = `slack:${forgedEventId}`;
  const ts = '1710000000.000100';

  // Recording stub Slack sender (no live creds): captures ACK sends.
  const acks: Array<{ to: ConversationRef; msg: OutboundMessage }> = [];
  const stubSender: FeedbackChannelSender = {
    async send(to: ConversationRef, msg: OutboundMessage): Promise<DeliveryRef> {
      acks.push({ to, msg });
      return { kind: to.kind, logicalMessageId: 'ack_ts', revision: 0, physicalIds: ['ack_ts'] };
    },
    async update(ref: DeliveryRef): Promise<DeliveryRef> {
      return ref;
    },
  };

  const enqueued: Array<{ taskId: string }> = [];
  const enqueue = vi.fn(async (job: { taskId: string }) => {
    enqueued.push(job);
    return job.taskId;
  });

  function buildHandler(enqueueFn: (job: { taskId: string }) => Promise<string> = enqueue) {
    return createSlackEventsHandler({
      signingSecret: SECRET,
      channel,
      logger: noopLogger,
      now: () => NOW_MS,
      dispatch: createSlackInboundDispatch({
        db,
        logger: noopLogger,
        channelMemoryEnabled: false, // isolate the task path from observation memory
        resolveBotUserId: async () => BOT_USER_ID,
        dispatchTask: async (message) => {
          await dispatchNeutralMessage(message, {
            resolveSession: (m) => resolveSession(db, m),
            createTask: (m, sessionId, options) => handleEvent(db, m, sessionId, options),
            getTaskStatus: async (taskId) => {
              const [row] = await db
                .select({ status: tasks.status })
                .from(tasks)
                .where(eq(tasks.id, taskId))
                .limit(1);
              return row?.status ?? null;
            },
            transitionTask: (taskId, status) => transitionTask(db, taskId, status),
            enqueue: (job) => enqueueFn(job as { taskId: string }),
            resolveSender: async (kind) => resolveChannelSender(kind, { slackSender: stubSender }),
            persistAckDelivery: (taskId, ack) => setTaskAckDelivery(db, taskId, ack),
            loadAckDelivery: (taskId) => getTaskAckDelivery<NeutralAckDelivery>(db, taskId),
            logger: noopLogger,
          });
        },
      }),
    });
  }

  function bodyAddressed(eventIdOverride = eventId) {
    return {
      type: 'event_callback',
      team_id: teamId,
      api_app_id: 'A_test',
      event_id: eventIdOverride,
      event: {
        type: 'message',
        channel: scopeId,
        channel_type: 'channel',
        user: 'U_human',
        text: `<@${BOT_USER_ID}> run the integration thing`,
        ts,
        event_ts: ts,
      },
    };
  }

  beforeAll(() => {
    db = createDb(process.env.DATABASE_URL);
  });

  afterAll(async () => {
    for (const job of enqueued) {
      await db.delete(tasks).where(eq(tasks.id, job.taskId));
    }
    const sessionRows = await db.select().from(sessions).where(eq(sessions.chatId, scopeId));
    for (const row of sessionRows) {
      await db.delete(sessions).where(eq(sessions.id, row.id));
    }
    await db.delete(inboundEvents).where(eq(inboundEvents.eventId, dedupeKey));
    await db.delete(inboundEvents).where(eq(inboundEvents.eventId, forgedDedupeKey));
    await db.$client.end({ timeout: 5 });
  });

  it('dispatches a task and routes the ACK through the stub sender; forged sig 401 + no dispatch', async () => {
    const handler = buildHandler();

    // 1) Signed, bot-addressed event → 200, task created, enqueued, ACK captured.
    const body = bodyAddressed();
    const raw = JSON.stringify(body);
    const okReply = makeReply();
    const okResult = await handler(
      makeRequest(body, sign(SECRET, TS, raw)),
      okReply as unknown as FastifyReply,
    );
    expect(okReply.statusCode).toBe(200);
    expect(okResult).toEqual({ ok: true });

    // The queued job was captured.
    expect(enqueue).toHaveBeenCalledTimes(1);
    const taskId = enqueued[0].taskId;

    // A real task row exists in Postgres.
    const taskRows = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(taskRows).toHaveLength(1);
    expect(taskRows[0].goal).toContain('integration thing');
    const sessionId = taskRows[0].sessionId;
    expect(sessionId).toBeTruthy();

    // The session is keyed under the disjoint `slack:` namespace (never `feishu:`).
    const sessionRows = await db.select().from(sessions).where(eq(sessions.id, sessionId));
    expect(sessionRows).toHaveLength(1);
    expect(sessionRows[0].sessionKey.startsWith('slack:')).toBe(true);

    // The ACK was routed to the injected stub Slack sender.
    expect(acks).toHaveLength(1);
    expect(acks[0].to).toMatchObject({ kind: 'slack', scopeId });
    expect(acks[0].msg).toMatchObject({ kind: 'text' });

    // The captured ack handle is threaded into the enqueued job (ADR-0008) so the
    // worker can update that same message in place to the terminal state.
    const enqueuedJob = enqueued[0] as unknown as { constraints: Record<string, unknown> };
    expect(enqueuedJob.constraints.ackDelivery).toEqual({
      kind: 'slack',
      scopeId,
      messageId: 'ack_ts',
    });

    // 2) Forged signature on a FRESH (never-processed) event → 401, never
    // dispatches: no new enqueue / ack, and crucially the dedup claim is never
    // even created (so dispatch could not have run before the 401).
    const forgedBody = bodyAddressed(forgedEventId);
    const forgedRaw = JSON.stringify(forgedBody);
    const forgedReply = makeReply();
    const forgedResult = await handler(
      makeRequest(forgedBody, sign('the-wrong-secret', TS, forgedRaw)),
      forgedReply as unknown as FastifyReply,
    );
    expect(forgedReply.statusCode).toBe(401);
    expect(forgedResult).toBe('Invalid signature');
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(acks).toHaveLength(1);
    const forgedClaim = await db
      .select()
      .from(inboundEvents)
      .where(eq(inboundEvents.eventId, forgedDedupeKey));
    expect(forgedClaim).toHaveLength(0);
  });

  it('releases the dedup claim on dispatch failure so the immediate retry recovers', async () => {
    const recoverScope = `C_recover_${randomUUID().slice(0, 8)}`;
    const recoverEvent = `Ev_${randomUUID().slice(0, 8)}`;
    const recoverDedupe = `slack:${recoverEvent}`;
    const recoverTs = '1710000000.000200';
    let attempts = 0;
    const recovered: Array<{ taskId: string }> = [];
    // Fail the FIRST enqueue (transient), succeed on the retry.
    const flakyEnqueue = vi.fn(async (job: { taskId: string }) => {
      attempts += 1;
      if (attempts === 1) throw new Error('transient queue failure');
      recovered.push(job);
      return job.taskId;
    });
    const handler = buildHandler(flakyEnqueue);
    const body = {
      type: 'event_callback',
      team_id: teamId,
      api_app_id: 'A_test',
      event_id: recoverEvent,
      event: {
        type: 'message',
        channel: recoverScope,
        channel_type: 'channel',
        user: 'U_human',
        text: `<@${BOT_USER_ID}> recover please`,
        ts: recoverTs,
        event_ts: recoverTs,
      },
    };
    const raw = JSON.stringify(body);
    const sig = sign(SECRET, TS, raw);

    try {
      // 1st delivery: enqueue throws → 500, and the claim is RELEASED (not left
      // `received`), so the retry is not dropped as an in-flight duplicate.
      const firstReply = makeReply();
      const firstResult = await handler(
        makeRequest(body, sig),
        firstReply as unknown as FastifyReply,
      );
      expect(firstReply.statusCode).toBe(500);
      expect(firstResult).toEqual({ ok: false });
      const claimAfterFail = await db
        .select()
        .from(inboundEvents)
        .where(eq(inboundEvents.eventId, recoverDedupe));
      expect(claimAfterFail).toHaveLength(0);

      // 2nd delivery (retry): re-claims, createTask resolves to the existing task
      // id (task_duplicate, non-terminal), re-enqueue now succeeds → 200.
      const retryReply = makeReply();
      const retryResult = await handler(
        makeRequest(body, sig),
        retryReply as unknown as FastifyReply,
      );
      expect(retryReply.statusCode).toBe(200);
      expect(retryResult).toEqual({ ok: true });
      expect(recovered).toHaveLength(1);
      const recoveredRows = await db.select().from(tasks).where(eq(tasks.id, recovered[0].taskId));
      expect(recoveredRows).toHaveLength(1);
    } finally {
      for (const job of recovered) {
        await db.delete(tasks).where(eq(tasks.id, job.taskId));
      }
      const rows = await db.select().from(sessions).where(eq(sessions.chatId, recoverScope));
      for (const row of rows) await db.delete(sessions).where(eq(sessions.id, row.id));
      await db.delete(inboundEvents).where(eq(inboundEvents.eventId, recoverDedupe));
    }
  });
});
