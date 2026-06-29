import { createHmac } from 'node:crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { Readable } from 'node:stream';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { InboundMessage } from '@open-tag/channel-core';
import type { Logger } from '@open-tag/observability';
import type { Database } from '@open-tag/storage';

// In-memory dedupe stand-in for the shared Lark dedupe store, so the dispatcher's
// claim/release/processed seam is unit-testable without Postgres. State lives in
// the factory closure; tests use distinct dedupeKeys so it never leaks across them.
vi.mock('@open-tag/feishu-adapter', () => {
  const claimed = new Set<string>();
  return {
    checkAndRecordEvent: vi.fn(async (_db: unknown, eventId: string) => {
      if (claimed.has(eventId)) return { isDuplicate: true, eventId };
      claimed.add(eventId);
      return { isDuplicate: false, eventId };
    }),
    markEventProcessed: vi.fn(async () => {}),
    releaseInboundEventClaim: vi.fn(async (_db: unknown, eventId: string) => {
      claimed.delete(eventId);
    }),
  };
});

import { releaseInboundEventClaim } from '@open-tag/feishu-adapter';
import {
  SLACK_INTERACTIVE_PATH,
  createSlackInteractiveHandler,
  createSlackInteractionDispatch,
  type SlackInteractionDispatcher,
} from '../slack-interactive.js';

const SECRET = 'slack-signing-secret-fixture';
const TS = '1710000000';
const NOW_MS = 1710000000_000 + 2_000; // 2s after the timestamp → fresh

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger & { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
}

function sign(secret: string, timestamp: string, body: string): string {
  const digest = createHmac('sha256', secret).update(`v0:${timestamp}:${body}`, 'utf8').digest('hex');
  return `v0=${digest}`;
}

/** url-encode a Slack interaction payload exactly as Slack POSTs it. */
function encodePayload(payload: unknown): string {
  return new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
}

function blockActions(overrides: Record<string, unknown> = {}) {
  return {
    type: 'block_actions',
    team: { id: 'T999' },
    user: { id: 'U777' },
    api_app_id: 'A111',
    container: { type: 'message', message_ts: '1710000000.000100', channel_id: 'C123' },
    channel: { id: 'C123', name: 'general' },
    message: { ts: '1710000000.000100', text: 'approve?' },
    trigger_id: 'trig-123',
    response_url: 'https://hooks.slack.com/actions/T999/123/abc',
    actions: [
      {
        action_id: 'approve_button',
        block_id: 'b1',
        type: 'button',
        value: 'task-42',
        action_ts: '1710000005.123456',
      },
    ],
    ...overrides,
  };
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

function makeRequest(opts: {
  rawBody?: string;
  signature?: string;
  timestamp?: string;
}): FastifyRequest {
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
  };
  if (opts.signature !== undefined) headers['x-slack-signature'] = opts.signature;
  if (opts.timestamp !== undefined) headers['x-slack-request-timestamp'] = opts.timestamp;
  return {
    headers,
    ...(opts.rawBody !== undefined ? { rawBody: Buffer.from(opts.rawBody, 'utf8') } : {}),
  } as unknown as FastifyRequest;
}

function makeDispatchSpy() {
  return vi.fn(async (_message: InboundMessage) => {});
}

function makeHandler(dispatch: SlackInteractionDispatcher, logger: Logger) {
  return createSlackInteractiveHandler({
    signingSecret: SECRET,
    dispatch,
    logger,
    now: () => NOW_MS,
  });
}

describe('createSlackInteractiveHandler', () => {
  it('rejects with 401 when the raw body was not captured (never re-serialize)', async () => {
    const dispatch = makeDispatchSpy();
    const logger = makeLogger();
    const handler = makeHandler(dispatch, logger);
    const raw = encodePayload(blockActions());

    const reply = makeReply();
    const result = await handler(
      makeRequest({ signature: sign(SECRET, TS, raw), timestamp: TS }), // no rawBody
      reply as unknown as FastifyReply,
    );

    expect(reply.statusCode).toBe(401);
    expect(result).toBe('Invalid signature');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('rejects a forged signature with 401 and never logs the secret or signature', async () => {
    const dispatch = makeDispatchSpy();
    const logger = makeLogger();
    const handler = makeHandler(dispatch, logger);
    const raw = encodePayload(blockActions());
    const forged = sign('the-wrong-secret', TS, raw);

    const reply = makeReply();
    const result = await handler(
      makeRequest({ rawBody: raw, signature: forged, timestamp: TS }),
      reply as unknown as FastifyReply,
    );

    expect(reply.statusCode).toBe(401);
    expect(result).toBe('Invalid signature');
    expect(dispatch).not.toHaveBeenCalled();

    // The signing secret and the raw signature must never reach the logs.
    const logged = JSON.stringify([
      ...logger.warn.mock.calls,
      ...logger.error.mock.calls,
      ...logger.info.mock.calls,
    ]);
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain(forged);
  });

  it('verifies and dispatches a valid urlencoded block_actions, returning an empty 200', async () => {
    const dispatch = makeDispatchSpy();
    const logger = makeLogger();
    const handler = makeHandler(dispatch, logger);
    const raw = encodePayload(blockActions());

    const reply = makeReply();
    const result = await handler(
      makeRequest({ rawBody: raw, signature: sign(SECRET, TS, raw), timestamp: TS }),
      reply as unknown as FastifyReply,
    );

    expect(reply.statusCode).toBe(200);
    // block_actions wants an EMPTY 200 body (Slack just closes the action).
    expect(result).toBe('');
    expect(dispatch).toHaveBeenCalledTimes(1);
    const [message] = dispatch.mock.calls[0];
    expect(message.dedupeKey).toBe(
      'slack:interaction:T999:C123:1710000000.000100:U777:approve_button:1710000005.123456',
    );
    expect(message.content.interaction?.action).toBe('approve_button');

    // The response_url must never be logged.
    const logged = JSON.stringify(logger.info.mock.calls);
    expect(logged).not.toContain('https://hooks.slack.com/actions/T999/123/abc');
  });

  it('acks 200 (ignore) when the payload form field is missing', async () => {
    const dispatch = makeDispatchSpy();
    const logger = makeLogger();
    const handler = makeHandler(dispatch, logger);
    const raw = 'foo=bar'; // no `payload` field

    const reply = makeReply();
    const result = await handler(
      makeRequest({ rawBody: raw, signature: sign(SECRET, TS, raw), timestamp: TS }),
      reply as unknown as FastifyReply,
    );

    expect(reply.statusCode).toBe(200);
    expect(result).toEqual({ ok: true });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('acks 200 (ignore) when the payload field is not valid JSON', async () => {
    const dispatch = makeDispatchSpy();
    const logger = makeLogger();
    const handler = makeHandler(dispatch, logger);
    const raw = new URLSearchParams({ payload: '{not-json' }).toString();

    const reply = makeReply();
    const result = await handler(
      makeRequest({ rawBody: raw, signature: sign(SECRET, TS, raw), timestamp: TS }),
      reply as unknown as FastifyReply,
    );

    expect(reply.statusCode).toBe(200);
    expect(result).toEqual({ ok: true });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('acks 200 (ignore) for an unsupported interaction type (e.g. view_submission)', async () => {
    const dispatch = makeDispatchSpy();
    const logger = makeLogger();
    const handler = makeHandler(dispatch, logger);
    const raw = encodePayload({ type: 'view_submission' });

    const reply = makeReply();
    const result = await handler(
      makeRequest({ rawBody: raw, signature: sign(SECRET, TS, raw), timestamp: TS }),
      reply as unknown as FastifyReply,
    );

    expect(reply.statusCode).toBe(200);
    expect(result).toEqual({ ok: true });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('returns 500 when dispatch throws (so Slack retries)', async () => {
    const dispatch = vi.fn(async () => {
      throw new Error('db down');
    });
    const logger = makeLogger();
    const handler = makeHandler(dispatch, logger);
    const raw = encodePayload(blockActions());

    const reply = makeReply();
    const result = await handler(
      makeRequest({ rawBody: raw, signature: sign(SECRET, TS, raw), timestamp: TS }),
      reply as unknown as FastifyReply,
    );

    expect(reply.statusCode).toBe(500);
    expect(result).toEqual({ ok: false });
  });
});

describe('createSlackInteractionDispatch', () => {
  const dummyDb = {} as unknown as Database;

  beforeEach(() => {
    vi.mocked(releaseInboundEventClaim).mockClear();
  });

  function makeMessage(actionTs: string): InboundMessage {
    return {
      channel: { kind: 'slack', native: {} },
      eventId: `trig-${actionTs}`,
      messageId: '1710000000.000100',
      eventType: 'interaction',
      occurredAt: 1710000005123,
      dedupeKey: `slack:interaction:T999:C123:1710000000.000100:U777:approve_button:${actionTs}`,
      conversation: { kind: 'slack', scopeId: 'C123' },
      scope: { kind: 'slack', scopeId: 'C123', installationId: 'T999', isPrivate: false },
      sender: { id: 'U777', isBot: false },
      content: {
        type: 'interaction',
        interaction: { action: 'approve_button', value: { actionTs } },
        mentions: [],
        attachments: [],
      },
    };
  }

  it('invokes onInteraction once and drops a duplicate delivery of the same dedupeKey', async () => {
    const onInteraction = vi.fn(async (_m: InboundMessage) => {});
    const logger = makeLogger();
    const dispatch = createSlackInteractionDispatch({ db: dummyDb, logger, onInteraction });
    const message = makeMessage('1710000005.111111');

    await dispatch(message);
    await dispatch(message); // redelivery of the same composite dedupeKey

    expect(onInteraction).toHaveBeenCalledTimes(1);
  });

  it('releases the claim and rethrows when onInteraction throws (route 500s, Slack retries)', async () => {
    const boom = new Error('consumer failed');
    const onInteraction = vi.fn(async () => {
      throw boom;
    });
    const logger = makeLogger();
    const dispatch = createSlackInteractionDispatch({ db: dummyDb, logger, onInteraction });
    const message = makeMessage('1710000005.222222');

    await expect(dispatch(message)).rejects.toThrow('consumer failed');
    expect(vi.mocked(releaseInboundEventClaim)).toHaveBeenCalledWith(
      dummyDb,
      message.dedupeKey,
      undefined,
    );
  });

  it('is a no-op consumer (still dedupes) when onInteraction is unset', async () => {
    const logger = makeLogger();
    const dispatch = createSlackInteractionDispatch({ db: dummyDb, logger });
    const message = makeMessage('1710000005.333333');
    await expect(dispatch(message)).resolves.toBeUndefined();
  });
});

describe('Slack interactivity Fastify wiring (urlencoded parser + rawBody capture)', () => {
  const MAX_BODY = 1024 * 1024;

  /** Build a Fastify app wired exactly like server.ts: rawBody preParsing hook + urlencoded passthrough parser. */
  function buildApp(dispatch: SlackInteractionDispatcher) {
    const app = Fastify();
    const logger = makeLogger();

    // Mirror server.ts: a thin passthrough so Fastify does not 415 the urlencoded
    // interaction request; the route reads request.rawBody for both signature and payload.
    app.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      (_req, body, done) => done(null, body),
    );

    app.addHook('preParsing', async (request, _reply, payload) => {
      if (request.url.split('?')[0] !== SLACK_INTERACTIVE_PATH) return payload;
      const chunks: Buffer[] = [];
      for await (const chunk of payload) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const rawBody = Buffer.concat(chunks);
      (request as unknown as { rawBody?: Buffer }).rawBody = rawBody;
      return Readable.from([rawBody]);
    });

    app.post(
      SLACK_INTERACTIVE_PATH,
      { bodyLimit: MAX_BODY },
      createSlackInteractiveHandler({ signingSecret: SECRET, dispatch, logger, now: () => NOW_MS }),
    );

    // A normal JSON route must still parse correctly after registering the parser above.
    app.post('/echo-json', async (request) => request.body);

    return app;
  }

  it('routes a signed urlencoded block_actions through to dispatch with an empty 200', async () => {
    const dispatch = makeDispatchSpy();
    const app = buildApp(dispatch);
    const raw = encodePayload(blockActions());

    const res = await app.inject({
      method: 'POST',
      url: SLACK_INTERACTIVE_PATH,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-slack-signature': sign(SECRET, TS, raw),
        'x-slack-request-timestamp': TS,
      },
      payload: raw,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('');
    expect(dispatch).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('still parses a normal JSON route after the urlencoded parser is registered', async () => {
    const app = buildApp(makeDispatchSpy());
    const res = await app.inject({
      method: 'POST',
      url: '/echo-json',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ hello: 'world' }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ hello: 'world' });
    await app.close();
  });
});
