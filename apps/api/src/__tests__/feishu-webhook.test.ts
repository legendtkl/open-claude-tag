import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  adaptFeishuWebhookCardActionPayload,
  createFeishuWebhookRateLimiter,
  getFeishuWebhookSignatureMetadata,
  isFeishuWebhookSignatureValid,
  isFeishuWebhookTimestampFresh,
  normalizeFeishuWebhookPath,
  verifyFeishuWebhookRequest,
} from '../feishu-webhook.js';

function sign(input: { timestamp: string; nonce: string; encryptKey: string; body: string }): string {
  return createHash('sha256')
    .update(`${input.timestamp}${input.nonce}${input.encryptKey}${input.body}`, 'utf8')
    .digest('hex');
}

describe('Feishu webhook helpers', () => {
  it('verifies URL challenge tokens before echoing the challenge', () => {
    const payload = {
      type: 'url_verification',
      token: 'verify-token',
      challenge: 'challenge-value',
    };

    const result = verifyFeishuWebhookRequest({
      payload,
      rawBody: Buffer.from(JSON.stringify(payload)),
      headers: {},
      verificationToken: 'verify-token',
      requireAuthentication: true,
    });

    expect(result).toEqual({
      ok: true,
      payload,
      challenge: 'challenge-value',
    });
  });

  it('rejects webhook payloads with invalid verification tokens', () => {
    const payload = {
      header: {
        token: 'wrong-token',
        event_type: 'im.message.receive_v1',
      },
      event: {},
    };

    const result = verifyFeishuWebhookRequest({
      payload,
      rawBody: Buffer.from(JSON.stringify(payload)),
      headers: {},
      verificationToken: 'verify-token',
      requireAuthentication: true,
    });

    expect(result).toMatchObject({
      ok: false,
      statusCode: 401,
    });
  });

  it('validates Feishu callback signatures with the raw JSON body', () => {
    const body = '{"header":{"event_type":"im.message.receive_v1"},"event":{}}';
    const timestamp = '1781093200';
    const nonce = 'nonce-001';
    const encryptKey = 'encrypt-key';
    const signature = sign({ timestamp, nonce, encryptKey, body });

    expect(
      isFeishuWebhookSignatureValid({
        rawBody: Buffer.from(body),
        encryptKey,
        headers: {
          'x-lark-request-timestamp': timestamp,
          'x-lark-request-nonce': nonce,
          'x-lark-signature': signature,
        },
      }),
    ).toBe(true);
  });

  it('extracts signature metadata and rejects stale signed callbacks', () => {
    const body = '{"header":{"event_type":"im.message.receive_v1"},"event":{}}';
    const timestamp = '1000';
    const nonce = 'nonce-001';
    const encryptKey = 'encrypt-key';
    const signature = sign({ timestamp, nonce, encryptKey, body });
    const headers = {
      'x-lark-request-timestamp': timestamp,
      'x-lark-request-nonce': nonce,
      'x-lark-signature': signature,
    };

    expect(getFeishuWebhookSignatureMetadata(headers)).toEqual({
      timestamp,
      nonce,
      signature,
    });
    expect(
      isFeishuWebhookTimestampFresh({
        timestamp,
        maxTimestampSkewSeconds: 60,
        now: () => 1_030_000,
      }),
    ).toBe(true);
    expect(
      verifyFeishuWebhookRequest({
        payload: { header: { event_type: 'im.message.receive_v1' }, event: {} },
        rawBody: Buffer.from(body),
        headers,
        encryptKey,
        maxTimestampSkewSeconds: 60,
        now: () => 1_120_000,
        requireAuthentication: true,
      }),
    ).toEqual({
      ok: false,
      statusCode: 401,
      response: 'Stale signature',
    });
  });

  it('rejects encrypted webhook payloads explicitly', () => {
    const payload = { encrypt: 'ciphertext' };
    const result = verifyFeishuWebhookRequest({
      payload,
      rawBody: Buffer.from(JSON.stringify(payload)),
      headers: {},
      requireAuthentication: false,
    });

    expect(result).toEqual({
      ok: false,
      statusCode: 400,
      response: { code: 400, msg: 'encrypted webhook payloads are not supported' },
    });
  });

  it('adapts webhook card action payloads to the internal handler shape', () => {
    expect(
      adaptFeishuWebhookCardActionPayload({
        header: {
          event_id: 'evt_001',
          tenant_key: 'tenant_001',
          token: 'verify-token',
        },
        event: {
          operator: { open_id: 'ou_user' },
          context: {
            open_message_id: 'om_card',
            open_chat_id: 'oc_chat',
          },
          action: {
            tag: 'button',
            value: { action: 'task_retry', task_id: 'task_001' },
          },
        },
      }),
    ).toMatchObject({
      event_id: 'evt_001',
      header: { event_id: 'evt_001' },
      tenant_key: 'tenant_001',
      token: 'verify-token',
      open_message_id: 'om_card',
      open_chat_id: 'oc_chat',
      open_id: 'ou_user',
      action: {
        tag: 'button',
        value: { action: 'task_retry', task_id: 'task_001' },
      },
    });
  });

  it('rate limits repeated webhook requests per key', () => {
    const limiter = createFeishuWebhookRateLimiter({
      windowMs: 60_000,
      maxRequests: 2,
      maxKeys: 16,
      now: () => 1_000,
    });

    expect(limiter('app:path:ip')).toBe(true);
    expect(limiter('app:path:ip')).toBe(true);
    expect(limiter('app:path:ip')).toBe(false);
  });

  it('normalizes custom webhook paths', () => {
    expect(normalizeFeishuWebhookPath('custom/path')).toBe('/custom/path');
    expect(normalizeFeishuWebhookPath('/custom/path')).toBe('/custom/path');
    expect(normalizeFeishuWebhookPath(undefined)).toBe('/webhooks/feishu');
  });
});
