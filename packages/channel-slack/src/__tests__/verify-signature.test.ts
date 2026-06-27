import { createHmac } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { verifySlackSignature } from '../verify-signature.js';

const SECRET = 'slack-signing-secret-fixture';
// 2024-03-09T16:00:00Z in Unix seconds — paired with a NOW just after it.
const TS = '1710000000';
const NOW_MS = 1710000000_000 + 5_000; // 5s after the timestamp → fresh
const BODY = JSON.stringify({ type: 'event_callback', event_id: 'Ev1' });

/** Compute a valid `v0=` Slack signature for the fixture inputs. */
function sign(secret: string, timestamp: string, body: string): string {
  const digest = createHmac('sha256', secret).update(`v0:${timestamp}:${body}`, 'utf8').digest('hex');
  return `v0=${digest}`;
}

describe('verifySlackSignature', () => {
  it('accepts a correctly signed request', () => {
    const result = verifySlackSignature({
      signingSecret: SECRET,
      signatureHeader: sign(SECRET, TS, BODY),
      timestampHeader: TS,
      rawBody: BODY,
      now: NOW_MS,
    });
    expect(result).toEqual({ ok: true });
  });

  it('accepts a Buffer raw body identical to the signed bytes', () => {
    const result = verifySlackSignature({
      signingSecret: SECRET,
      signatureHeader: sign(SECRET, TS, BODY),
      timestampHeader: TS,
      rawBody: Buffer.from(BODY, 'utf8'),
      now: NOW_MS,
    });
    expect(result).toEqual({ ok: true });
  });

  it('accepts an uppercase-hex signature (case-insensitive compare)', () => {
    const result = verifySlackSignature({
      signingSecret: SECRET,
      signatureHeader: sign(SECRET, TS, BODY).toUpperCase().replace('V0=', 'v0='),
      timestampHeader: TS,
      rawBody: BODY,
      now: NOW_MS,
    });
    expect(result).toEqual({ ok: true });
  });

  it('rejects a tampered body', () => {
    const result = verifySlackSignature({
      signingSecret: SECRET,
      signatureHeader: sign(SECRET, TS, BODY),
      timestampHeader: TS,
      rawBody: `${BODY} tampered`,
      now: NOW_MS,
    });
    expect(result).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('rejects a signature computed with the wrong secret', () => {
    const result = verifySlackSignature({
      signingSecret: SECRET,
      signatureHeader: sign('the-wrong-secret', TS, BODY),
      timestampHeader: TS,
      rawBody: BODY,
      now: NOW_MS,
    });
    expect(result).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('rejects an expired (too old) timestamp', () => {
    const result = verifySlackSignature({
      signingSecret: SECRET,
      signatureHeader: sign(SECRET, TS, BODY),
      timestampHeader: TS,
      rawBody: BODY,
      now: NOW_MS + 301_000, // > 300s after the timestamp
    });
    expect(result).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects a timestamp too far in the future', () => {
    const result = verifySlackSignature({
      signingSecret: SECRET,
      signatureHeader: sign(SECRET, TS, BODY),
      timestampHeader: TS,
      rawBody: BODY,
      now: NOW_MS - 310_000, // clock > 300s behind the timestamp → timestamp is in the future
    });
    expect(result).toEqual({ ok: false, reason: 'expired' });
  });

  it('honors a custom replay window', () => {
    const result = verifySlackSignature({
      signingSecret: SECRET,
      signatureHeader: sign(SECRET, TS, BODY),
      timestampHeader: TS,
      rawBody: BODY,
      now: NOW_MS + 60_000, // 60s after → within 300s default but outside a 30s window
      replayWindowSeconds: 30,
    });
    expect(result).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects a malformed signature header', () => {
    const result = verifySlackSignature({
      signingSecret: SECRET,
      signatureHeader: 'not-a-valid-signature',
      timestampHeader: TS,
      rawBody: BODY,
      now: NOW_MS,
    });
    expect(result).toEqual({ ok: false, reason: 'malformed_signature' });
  });

  it('rejects a non-numeric timestamp header', () => {
    const result = verifySlackSignature({
      signingSecret: SECRET,
      signatureHeader: sign(SECRET, TS, BODY),
      timestampHeader: 'not-a-number',
      rawBody: BODY,
      now: NOW_MS,
    });
    expect(result).toEqual({ ok: false, reason: 'malformed_timestamp' });
  });

  it('rejects a missing signature header', () => {
    const result = verifySlackSignature({
      signingSecret: SECRET,
      signatureHeader: undefined,
      timestampHeader: TS,
      rawBody: BODY,
      now: NOW_MS,
    });
    expect(result).toEqual({ ok: false, reason: 'missing_signature' });
  });

  it('rejects a missing timestamp header', () => {
    const result = verifySlackSignature({
      signingSecret: SECRET,
      signatureHeader: sign(SECRET, TS, BODY),
      timestampHeader: undefined,
      rawBody: BODY,
      now: NOW_MS,
    });
    expect(result).toEqual({ ok: false, reason: 'missing_timestamp' });
  });

  it('rejects when no signing secret is configured', () => {
    const result = verifySlackSignature({
      signingSecret: '',
      signatureHeader: sign(SECRET, TS, BODY),
      timestampHeader: TS,
      rawBody: BODY,
      now: NOW_MS,
    });
    expect(result).toEqual({ ok: false, reason: 'missing_signing_secret' });
  });
});
