import { createHmac } from 'node:crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { Readable } from 'node:stream';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from '@open-tag/observability';
import type { Database } from '@open-tag/storage';

const getSlackInstallationByTeamId = vi.fn();
vi.mock('@open-tag/storage', () => ({
  getSlackInstallationByTeamId: (...args: unknown[]) => getSlackInstallationByTeamId(...args),
}));

import { SLACK_COMMANDS_PATH, createSlackCommandsHandler } from '../slack-commands.js';

const SECRET = 'slack-signing-secret-fixture';
const TS = '1710000000';
const NOW_MS = 1710000000_000 + 2_000; // 2s after the timestamp → fresh
const dummyDb = {} as unknown as Database;

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger & {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
}

function sign(secret: string, timestamp: string, body: string): string {
  const digest = createHmac('sha256', secret).update(`v0:${timestamp}:${body}`, 'utf8').digest('hex');
  return `v0=${digest}`;
}

/** url-encode a Slack slash-command form exactly as Slack POSTs it (DIRECT fields). */
function encodeForm(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
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

function makeHandler(logger: Logger) {
  return createSlackCommandsHandler({
    signingSecret: SECRET,
    db: dummyDb,
    logger,
    now: () => NOW_MS,
  });
}

describe('createSlackCommandsHandler', () => {
  beforeEach(() => {
    getSlackInstallationByTeamId.mockReset();
  });

  it('rejects with 401 when the raw body was not captured (never re-serialize)', async () => {
    const logger = makeLogger();
    const handler = makeHandler(logger);
    const raw = encodeForm({ command: '/opentag', text: 'help' });

    const reply = makeReply();
    const result = await handler(
      makeRequest({ signature: sign(SECRET, TS, raw), timestamp: TS }), // no rawBody
      reply as unknown as FastifyReply,
    );

    expect(reply.statusCode).toBe(401);
    expect(result).toBe('Invalid signature');
  });

  it('rejects a forged signature with 401 and never logs the secret or signature', async () => {
    const logger = makeLogger();
    const handler = makeHandler(logger);
    const raw = encodeForm({ command: '/opentag', text: 'help' });
    const forged = sign('the-wrong-secret', TS, raw);

    const reply = makeReply();
    const result = await handler(
      makeRequest({ rawBody: raw, signature: forged, timestamp: TS }),
      reply as unknown as FastifyReply,
    );

    expect(reply.statusCode).toBe(401);
    expect(result).toBe('Invalid signature');

    const logged = JSON.stringify([
      ...logger.warn.mock.calls,
      ...logger.error.mock.calls,
      ...logger.info.mock.calls,
    ]);
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain(forged);
  });

  it('answers `help` with an ephemeral 200 containing the help text', async () => {
    const logger = makeLogger();
    const handler = makeHandler(logger);
    const raw = encodeForm({ command: '/opentag', text: 'help', team_id: 'T999' });

    const reply = makeReply();
    const result = (await handler(
      makeRequest({ rawBody: raw, signature: sign(SECRET, TS, raw), timestamp: TS }),
      reply as unknown as FastifyReply,
    )) as { response_type: string; text: string };

    expect(reply.statusCode).toBe(200);
    expect(result.response_type).toBe('ephemeral');
    expect(result.text).toContain('/opentag help');
    expect(result.text).toContain('/opentag status');
    expect(getSlackInstallationByTeamId).not.toHaveBeenCalled();
  });

  it('treats empty text as help', async () => {
    const logger = makeLogger();
    const handler = makeHandler(logger);
    const raw = encodeForm({ command: '/opentag', text: '', team_id: 'T999' });

    const reply = makeReply();
    const result = (await handler(
      makeRequest({ rawBody: raw, signature: sign(SECRET, TS, raw), timestamp: TS }),
      reply as unknown as FastifyReply,
    )) as { response_type: string; text: string };

    expect(reply.statusCode).toBe(200);
    expect(result.response_type).toBe('ephemeral');
    expect(result.text).toContain('/opentag help');
  });

  it('answers `status` with an onboarded line when an enabled install exists', async () => {
    getSlackInstallationByTeamId.mockResolvedValueOnce({
      teamId: 'T999',
      teamName: 'Acme Corp',
      status: 'enabled',
    });
    const logger = makeLogger();
    const handler = makeHandler(logger);
    const raw = encodeForm({ command: '/opentag', text: 'status', team_id: 'T999' });

    const reply = makeReply();
    const result = (await handler(
      makeRequest({ rawBody: raw, signature: sign(SECRET, TS, raw), timestamp: TS }),
      reply as unknown as FastifyReply,
    )) as { response_type: string; text: string };

    expect(reply.statusCode).toBe(200);
    expect(result.response_type).toBe('ephemeral');
    expect(result.text).toContain('connected');
    expect(result.text.toLowerCase()).toContain('onboarded');
    expect(result.text).toContain('Acme Corp');
    expect(getSlackInstallationByTeamId).toHaveBeenCalledWith(dummyDb, 'T999');
    // No bot token must ever leak into the user-facing text.
    expect(result.text).not.toContain('xoxb');
  });

  it('answers `status` with the basic connected line when no install exists', async () => {
    getSlackInstallationByTeamId.mockResolvedValueOnce(null);
    const logger = makeLogger();
    const handler = makeHandler(logger);
    const raw = encodeForm({ command: '/opentag', text: 'status', team_id: 'T999' });

    const reply = makeReply();
    const result = (await handler(
      makeRequest({ rawBody: raw, signature: sign(SECRET, TS, raw), timestamp: TS }),
      reply as unknown as FastifyReply,
    )) as { response_type: string; text: string };

    expect(reply.statusCode).toBe(200);
    expect(result.response_type).toBe('ephemeral');
    expect(result.text).toContain('connected');
    expect(result.text.toLowerCase()).not.toContain('onboarded');
  });

  it('falls back to the basic connected line (best-effort) when the DB lookup throws', async () => {
    getSlackInstallationByTeamId.mockRejectedValueOnce(new Error('db down'));
    const logger = makeLogger();
    const handler = makeHandler(logger);
    const raw = encodeForm({ command: '/opentag', text: 'status', team_id: 'T999' });

    const reply = makeReply();
    const result = (await handler(
      makeRequest({ rawBody: raw, signature: sign(SECRET, TS, raw), timestamp: TS }),
      reply as unknown as FastifyReply,
    )) as { response_type: string; text: string };

    // Never 5xx the user-facing status; degrade to the basic connected line.
    expect(reply.statusCode).toBe(200);
    expect(result.response_type).toBe('ephemeral');
    expect(result.text).toContain('connected');
    expect(logger.warn).toHaveBeenCalled();
  });

  it('answers an unknown subcommand with a polite ephemeral 200', async () => {
    const logger = makeLogger();
    const handler = makeHandler(logger);
    const raw = encodeForm({ command: '/opentag', text: 'frobnicate', team_id: 'T999' });

    const reply = makeReply();
    const result = (await handler(
      makeRequest({ rawBody: raw, signature: sign(SECRET, TS, raw), timestamp: TS }),
      reply as unknown as FastifyReply,
    )) as { response_type: string; text: string };

    expect(reply.statusCode).toBe(200);
    expect(result.response_type).toBe('ephemeral');
    expect(result.text).toContain('Unknown subcommand');
  });

  it('answers a misconfigured command (not /opentag) with a polite ephemeral 200', async () => {
    const logger = makeLogger();
    const handler = makeHandler(logger);
    const raw = encodeForm({ command: '/something-else', text: 'help', team_id: 'T999' });

    const reply = makeReply();
    const result = (await handler(
      makeRequest({ rawBody: raw, signature: sign(SECRET, TS, raw), timestamp: TS }),
      reply as unknown as FastifyReply,
    )) as { response_type: string; text: string };

    expect(reply.statusCode).toBe(200);
    expect(result.response_type).toBe('ephemeral');
    expect(result.text).toContain('Unknown command');
  });
});

describe('Slack slash-command Fastify wiring (urlencoded parser + rawBody capture)', () => {
  const MAX_BODY = 1024 * 1024;

  function buildApp() {
    const app = Fastify();
    const logger = makeLogger();

    app.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      (_req, body, done) => done(null, body),
    );

    app.addHook('preParsing', async (request, _reply, payload) => {
      if (request.url.split('?')[0] !== SLACK_COMMANDS_PATH) return payload;
      const chunks: Buffer[] = [];
      for await (const chunk of payload) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const rawBody = Buffer.concat(chunks);
      (request as unknown as { rawBody?: Buffer }).rawBody = rawBody;
      return Readable.from([rawBody]);
    });

    app.post(
      SLACK_COMMANDS_PATH,
      { bodyLimit: MAX_BODY },
      createSlackCommandsHandler({ signingSecret: SECRET, db: dummyDb, logger, now: () => NOW_MS }),
    );

    return app;
  }

  it('routes a signed urlencoded /opentag help through to an ephemeral 200 body', async () => {
    getSlackInstallationByTeamId.mockReset();
    const app = buildApp();
    const raw = encodeForm({ command: '/opentag', text: 'help', team_id: 'T999' });

    const res = await app.inject({
      method: 'POST',
      url: SLACK_COMMANDS_PATH,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-slack-signature': sign(SECRET, TS, raw),
        'x-slack-request-timestamp': TS,
      },
      payload: raw,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { response_type: string; text: string };
    expect(body.response_type).toBe('ephemeral');
    expect(body.text).toContain('/opentag help');
    await app.close();
  });
});
