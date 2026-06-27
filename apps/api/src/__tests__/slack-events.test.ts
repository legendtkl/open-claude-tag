import { createHmac } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { SlackChannel } from '@open-tag/channel-slack';
import type { InboundMessage } from '@open-tag/channel-core';
import type { Logger } from '@open-tag/observability';
import { createSlackEventsHandler, type SlackInboundDispatcher } from '../slack-events.js';

/** A typed dispatch spy so `mock.calls[0]` carries the dispatcher's argument tuple. */
function makeDispatchSpy() {
  return vi.fn(async (_message: InboundMessage, _ctx: { retryNum?: number }) => {});
}

const SECRET = 'slack-signing-secret-fixture';
const TS = '1710000000';
const NOW_MS = 1710000000_000 + 2_000; // 2s after the timestamp → fresh
const channel = new SlackChannel({ token: 'xoxb-test' });

const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as Logger;

function sign(secret: string, timestamp: string, body: string): string {
  const digest = createHmac('sha256', secret).update(`v0:${timestamp}:${body}`, 'utf8').digest('hex');
  return `v0=${digest}`;
}

interface FakeReply {
  statusCode: number;
  code(n: number): FakeReply;
}

function makeReply(): FakeReply {
  const reply: FakeReply = {
    statusCode: 200,
    code(n: number) {
      this.statusCode = n;
      return this;
    },
  };
  return reply;
}

function makeRequest(opts: {
  body: unknown;
  rawBody?: string;
  signature?: string;
  timestamp?: string;
  contentType?: string;
  retryNum?: string;
}): FastifyRequest {
  const rawBody = opts.rawBody ?? JSON.stringify(opts.body);
  const headers: Record<string, string> = {
    'content-type': opts.contentType ?? 'application/json',
  };
  if (opts.signature !== undefined) headers['x-slack-signature'] = opts.signature;
  if (opts.timestamp !== undefined) headers['x-slack-request-timestamp'] = opts.timestamp;
  if (opts.retryNum !== undefined) headers['x-slack-retry-num'] = opts.retryNum;
  return {
    headers,
    body: opts.body,
    rawBody: Buffer.from(rawBody, 'utf8'),
  } as unknown as FastifyRequest;
}

function eventCallbackBody() {
  return {
    type: 'event_callback',
    team_id: 'T999',
    api_app_id: 'A111',
    event_id: 'Ev0001',
    event: {
      type: 'message',
      channel: 'C123',
      channel_type: 'channel',
      user: 'U777',
      text: '<@U999> hello there',
      ts: '1710000000.000100',
      event_ts: '1710000000.000100',
    },
  };
}

function makeHandler(dispatch: SlackInboundDispatcher) {
  return createSlackEventsHandler({
    signingSecret: SECRET,
    channel,
    dispatch,
    logger: silentLogger,
    now: () => NOW_MS,
  });
}

describe('createSlackEventsHandler', () => {
  it('verifies and dispatches a signed event_callback, acking 200', async () => {
    const dispatch = makeDispatchSpy();
    const handler = makeHandler(dispatch);
    const body = eventCallbackBody();
    const raw = JSON.stringify(body);
    const reply = makeReply();

    const result = await handler(
      makeRequest({ body, rawBody: raw, signature: sign(SECRET, TS, raw), timestamp: TS }),
      reply as unknown as FastifyReply,
    );

    expect(reply.statusCode).toBe(200);
    expect(result).toEqual({ ok: true });
    expect(dispatch).toHaveBeenCalledTimes(1);
    const [message] = dispatch.mock.calls[0];
    expect(message.dedupeKey).toBe('slack:Ev0001');
    expect(message.scope.kind).toBe('slack');
  });

  it('rejects a forged signature with 401 and never dispatches', async () => {
    const dispatch = makeDispatchSpy();
    const handler = makeHandler(dispatch);
    const body = eventCallbackBody();
    const raw = JSON.stringify(body);
    const reply = makeReply();

    const result = await handler(
      makeRequest({
        body,
        rawBody: raw,
        signature: sign('the-wrong-secret', TS, raw),
        timestamp: TS,
      }),
      reply as unknown as FastifyReply,
    );

    expect(reply.statusCode).toBe(401);
    expect(result).toBe('Invalid signature');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('rejects a missing signature with 401 and never dispatches', async () => {
    const dispatch = makeDispatchSpy();
    const handler = makeHandler(dispatch);
    const body = eventCallbackBody();
    const reply = makeReply();

    await handler(
      makeRequest({ body, timestamp: TS }),
      reply as unknown as FastifyReply,
    );

    expect(reply.statusCode).toBe(401);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('rejects an expired (replayed) but otherwise valid request with 401', async () => {
    const dispatch = makeDispatchSpy();
    const handler = createSlackEventsHandler({
      signingSecret: SECRET,
      channel,
      dispatch,
      logger: silentLogger,
      now: () => NOW_MS + 600_000, // 10 min later → outside the replay window
    });
    const body = eventCallbackBody();
    const raw = JSON.stringify(body);
    const reply = makeReply();

    await handler(
      makeRequest({ body, rawBody: raw, signature: sign(SECRET, TS, raw), timestamp: TS }),
      reply as unknown as FastifyReply,
    );

    expect(reply.statusCode).toBe(401);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('echoes the url_verification challenge (still signature-verified) without dispatching', async () => {
    const dispatch = makeDispatchSpy();
    const handler = makeHandler(dispatch);
    const body = { type: 'url_verification', challenge: 'chal-xyz', token: 'tok' };
    const raw = JSON.stringify(body);
    const reply = makeReply();

    const result = await handler(
      makeRequest({ body, rawBody: raw, signature: sign(SECRET, TS, raw), timestamp: TS }),
      reply as unknown as FastifyReply,
    );

    expect(reply.statusCode).toBe(200);
    expect(result).toEqual({ challenge: 'chal-xyz' });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('does not echo a url_verification challenge when the signature is forged', async () => {
    const dispatch = makeDispatchSpy();
    const handler = makeHandler(dispatch);
    const body = { type: 'url_verification', challenge: 'chal-xyz' };
    const raw = JSON.stringify(body);
    const reply = makeReply();

    const result = await handler(
      makeRequest({ body, rawBody: raw, signature: sign('wrong', TS, raw), timestamp: TS }),
      reply as unknown as FastifyReply,
    );

    expect(reply.statusCode).toBe(401);
    expect(result).toBe('Invalid signature');
  });

  it('rejects with 401 when the raw body was not captured (no re-serialization)', async () => {
    const dispatch = makeDispatchSpy();
    const handler = makeHandler(dispatch);
    const body = eventCallbackBody();
    const raw = JSON.stringify(body);
    // A request whose preParsing hook did not run → rawBody is absent.
    const request = {
      headers: {
        'content-type': 'application/json',
        'x-slack-signature': sign(SECRET, TS, raw),
        'x-slack-request-timestamp': TS,
      },
      body,
    } as unknown as FastifyRequest;
    const reply = makeReply();

    const result = await handler(request, reply as unknown as FastifyReply);

    expect(reply.statusCode).toBe(401);
    expect(result).toBe('Invalid signature');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('rejects a non-JSON content type with 415', async () => {
    const dispatch = makeDispatchSpy();
    const handler = makeHandler(dispatch);
    const reply = makeReply();

    const result = await handler(
      makeRequest({ body: {}, contentType: 'text/plain' }),
      reply as unknown as FastifyReply,
    );

    expect(reply.statusCode).toBe(415);
    expect(result).toBe('Unsupported Media Type');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('surfaces X-Slack-Retry-Num to the dispatcher (retry de-dupe seam)', async () => {
    const dispatch = makeDispatchSpy();
    const handler = makeHandler(dispatch);
    const body = eventCallbackBody();
    const raw = JSON.stringify(body);

    await handler(
      makeRequest({
        body,
        rawBody: raw,
        signature: sign(SECRET, TS, raw),
        timestamp: TS,
        retryNum: '3',
      }),
      makeReply() as unknown as FastifyReply,
    );

    expect(dispatch).toHaveBeenCalledTimes(1);
    const [, ctx] = dispatch.mock.calls[0];
    expect(ctx).toEqual({ retryNum: 3 });
  });

  it('acks 200 without dispatching when the event normalizes to nothing (bot message)', async () => {
    const dispatch = makeDispatchSpy();
    const handler = makeHandler(dispatch);
    const body = {
      type: 'event_callback',
      event_id: 'Ev0002',
      event: { type: 'message', channel: 'C1', user: 'U1', bot_id: 'B1', ts: '1.0' },
    };
    const raw = JSON.stringify(body);
    const reply = makeReply();

    const result = await handler(
      makeRequest({ body, rawBody: raw, signature: sign(SECRET, TS, raw), timestamp: TS }),
      reply as unknown as FastifyReply,
    );

    expect(reply.statusCode).toBe(200);
    expect(result).toEqual({ ok: true });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('returns 500 when the durable dispatch claim fails (so Slack retries)', async () => {
    const dispatch = vi.fn(async () => {
      throw new Error('db down');
    });
    const handler = makeHandler(dispatch);
    const body = eventCallbackBody();
    const raw = JSON.stringify(body);
    const reply = makeReply();

    const result = await handler(
      makeRequest({ body, rawBody: raw, signature: sign(SECRET, TS, raw), timestamp: TS }),
      reply as unknown as FastifyReply,
    );

    expect(reply.statusCode).toBe(500);
    expect(result).toEqual({ ok: false });
  });
});
