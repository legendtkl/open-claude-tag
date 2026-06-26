import { createHash, timingSafeEqual } from 'node:crypto';

export const DEFAULT_FEISHU_WEBHOOK_PATH = '/webhooks/feishu';
export const LEGACY_FEISHU_WEBHOOK_PATH = '/feishu/webhook';

export interface FeishuWebhookVerificationInput {
  payload: unknown;
  rawBody: Buffer;
  headers: Record<string, string | string[] | undefined>;
  verificationToken?: string;
  encryptKey?: string;
  requireAuthentication?: boolean;
  maxTimestampSkewSeconds?: number;
  now?: () => number;
}

export type FeishuWebhookVerificationResult =
  | {
      ok: true;
      payload: Record<string, unknown>;
      challenge?: string;
    }
  | {
      ok: false;
      statusCode: number;
      response: Record<string, unknown> | string;
    };

export interface FeishuWebhookRateLimiterOptions {
  windowMs: number;
  maxRequests: number;
  maxKeys: number;
  now?: () => number;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function getObject(value: unknown): Record<string, unknown> | undefined {
  return isObjectRecord(value) ? value : undefined;
}

function getHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function timingSafeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function normalizeFeishuWebhookPath(path: string | undefined): string {
  const trimmed = path?.trim() || DEFAULT_FEISHU_WEBHOOK_PATH;
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

export function getFeishuWebhookEventType(payload: Record<string, unknown>): string | undefined {
  const header = getObject(payload.header);
  return getString(header?.event_type) ?? getString(payload.event_type);
}

export function getFeishuWebhookAppId(payload: Record<string, unknown>): string | undefined {
  const header = getObject(payload.header);
  return getString(header?.app_id) ?? getString(payload.app_id);
}

export function getFeishuWebhookToken(payload: Record<string, unknown>): string | undefined {
  const header = getObject(payload.header);
  return getString(header?.token) ?? getString(payload.token);
}

export function getFeishuWebhookSignatureMetadata(
  headers: Record<string, string | string[] | undefined>,
): { timestamp: string; nonce: string; signature: string } | null {
  const timestamp = getHeader(headers, 'x-lark-request-timestamp') ?? '';
  const nonce = getHeader(headers, 'x-lark-request-nonce') ?? '';
  const signature = getHeader(headers, 'x-lark-signature') ?? '';
  if (!timestamp || !nonce || !signature) {
    return null;
  }
  return { timestamp, nonce, signature };
}

export function isFeishuWebhookTimestampFresh(input: {
  timestamp: string;
  maxTimestampSkewSeconds: number;
  now?: () => number;
}): boolean {
  const timestampSeconds = Number.parseInt(input.timestamp, 10);
  if (!Number.isFinite(timestampSeconds)) {
    return false;
  }

  const nowSeconds = Math.floor((input.now?.() ?? Date.now()) / 1000);
  return Math.abs(nowSeconds - timestampSeconds) <= input.maxTimestampSkewSeconds;
}

export function isFeishuWebhookSignatureValid(input: {
  headers: Record<string, string | string[] | undefined>;
  rawBody: Buffer;
  encryptKey: string;
}): boolean {
  const metadata = getFeishuWebhookSignatureMetadata(input.headers);
  if (!metadata) {
    return false;
  }

  const body = input.rawBody.toString('utf8');
  const computed = createHash('sha256')
    .update(`${metadata.timestamp}${metadata.nonce}${input.encryptKey}${body}`, 'utf8')
    .digest('hex');
  return timingSafeStringEqual(computed, metadata.signature);
}

export function verifyFeishuWebhookRequest(
  input: FeishuWebhookVerificationInput,
): FeishuWebhookVerificationResult {
  if (!isObjectRecord(input.payload)) {
    return { ok: false, statusCode: 400, response: { code: 400, msg: 'invalid json' } };
  }

  const verificationToken = input.verificationToken?.trim() ?? '';
  const encryptKey = input.encryptKey?.trim() ?? '';
  if (input.requireAuthentication && !verificationToken && !encryptKey) {
    return {
      ok: false,
      statusCode: 503,
      response: { code: 503, msg: 'Feishu webhook verification is not configured' },
    };
  }

  const payload = input.payload;
  const isChallenge = payload.type === 'url_verification';
  const incomingToken = getFeishuWebhookToken(payload) ?? '';
  if (verificationToken && !timingSafeStringEqual(incomingToken, verificationToken)) {
    return {
      ok: false,
      statusCode: 401,
      response: 'Invalid verification token',
    };
  }

  if (isChallenge) {
    return {
      ok: true,
      payload,
      challenge: typeof payload.challenge === 'string' ? payload.challenge : '',
    };
  }

  if (encryptKey) {
    const signatureMetadata = getFeishuWebhookSignatureMetadata(input.headers);
    if (!signatureMetadata || !isFeishuWebhookSignatureValid({ ...input, encryptKey })) {
      return {
        ok: false,
        statusCode: 401,
        response: 'Invalid signature',
      };
    }

    const maxTimestampSkewSeconds = input.maxTimestampSkewSeconds ?? 10 * 60;
    if (
      !isFeishuWebhookTimestampFresh({
        timestamp: signatureMetadata.timestamp,
        maxTimestampSkewSeconds,
        now: input.now,
      })
    ) {
      return {
        ok: false,
        statusCode: 401,
        response: 'Stale signature',
      };
    }
  }

  if (getString(payload.encrypt)) {
    return {
      ok: false,
      statusCode: 400,
      response: { code: 400, msg: 'encrypted webhook payloads are not supported' },
    };
  }

  return { ok: true, payload };
}

export function adaptFeishuWebhookCardActionPayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const header = getObject(payload.header);
  const event = getObject(payload.event) ?? payload;
  const context = getObject(event.context);
  const operator = getObject(event.operator);

  return {
    event_id: getString(header?.event_id) ?? getString(payload.event_id),
    header: header
      ? {
          event_id: getString(header.event_id),
        }
      : undefined,
    tenant_key: getString(header?.tenant_key) ?? getString(event.tenant_key),
    token: getString(event.token) ?? getString(header?.token) ?? getString(payload.token),
    open_message_id: getString(event.open_message_id) ?? getString(context?.open_message_id),
    open_chat_id: getString(event.open_chat_id) ?? getString(context?.open_chat_id),
    context,
    operator,
    open_id: getString(event.open_id) ?? getString(operator?.open_id),
    action: event.action,
  };
}

export function createFeishuWebhookRateLimiter(options: FeishuWebhookRateLimiterOptions) {
  const buckets = new Map<string, { count: number; windowStart: number }>();
  const now = options.now ?? Date.now;

  return function checkRateLimit(key: string): boolean {
    const current = now();
    const existing = buckets.get(key);
    if (existing && current - existing.windowStart <= options.windowMs) {
      if (existing.count >= options.maxRequests) {
        return false;
      }
      existing.count += 1;
      return true;
    }

    if (buckets.size >= options.maxKeys && !buckets.has(key)) {
      for (const [bucketKey, bucket] of buckets) {
        if (current - bucket.windowStart > options.windowMs) {
          buckets.delete(bucketKey);
        }
      }
      if (buckets.size >= options.maxKeys) {
        const oldestKey = buckets.keys().next().value as string | undefined;
        if (oldestKey) buckets.delete(oldestKey);
      }
    }

    buckets.set(key, { count: 1, windowStart: current });
    return true;
  };
}
