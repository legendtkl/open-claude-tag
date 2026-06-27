/**
 * Slack request signature verification — Slack's `v0` HMAC scheme, implemented
 * with `node:crypto` only (no `@slack/*` SDK). Pure and side-effect-free so the
 * transport can verify the RAW request bytes BEFORE trusting any parsed JSON.
 *
 * Scheme (https://api.slack.com/authentication/verifying-requests-from-slack):
 *   basestring = `v0:{X-Slack-Request-Timestamp}:{rawBody}`
 *   expected   = `v0=` + HMAC_SHA256(signingSecret, basestring) in lowercase hex
 *   valid      ⇔ constant-time-equal(expected, X-Slack-Signature)
 *
 * The timestamp is also replay-window checked (default ±300s) to reject captured
 * requests. The signing secret and the raw signature are NEVER returned or
 * logged from here — the caller only ever sees a coarse failure {@link reason}.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

const SIGNATURE_VERSION = 'v0';
const DEFAULT_REPLAY_WINDOW_SECONDS = 300;
/** `v0=` + 64 lowercase/uppercase hex chars. Case is normalized before compare. */
const SIGNATURE_RE = /^v0=[0-9a-f]{64}$/i;
/** A bare, unsigned count of seconds (Slack sends positive Unix seconds). */
const TIMESTAMP_RE = /^\d+$/;

export type VerifySlackSignatureFailureReason =
  | 'missing_signing_secret'
  | 'missing_signature'
  | 'missing_timestamp'
  | 'malformed_signature'
  | 'malformed_timestamp'
  | 'expired'
  | 'mismatch';

export type VerifySlackSignatureResult =
  | { ok: true }
  | { ok: false; reason: VerifySlackSignatureFailureReason };

export interface VerifySlackSignatureInput {
  /** The Slack app signing secret (from the app's Basic Information page). */
  signingSecret: string;
  /** `X-Slack-Signature` header, e.g. `v0=a1b2…`. */
  signatureHeader: string | undefined;
  /** `X-Slack-Request-Timestamp` header (Unix seconds, as a string). */
  timestampHeader: string | undefined;
  /** The EXACT request bytes the signature was computed over. */
  rawBody: string | Buffer;
  /** Injectable wall clock in epoch ms (default {@link Date.now}). */
  now?: number;
  /** Replay tolerance in seconds (default {@link DEFAULT_REPLAY_WINDOW_SECONDS}). */
  replayWindowSeconds?: number;
}

/**
 * Verify a Slack Events API request signature. Returns a typed pass/fail; the
 * caller maps any failure to a 401 and never dispatches an unverified request.
 */
export function verifySlackSignature(input: VerifySlackSignatureInput): VerifySlackSignatureResult {
  const { signingSecret, signatureHeader, timestampHeader, rawBody } = input;
  const nowMs = input.now ?? Date.now();
  const replayWindowSeconds = input.replayWindowSeconds ?? DEFAULT_REPLAY_WINDOW_SECONDS;

  if (!signingSecret) return { ok: false, reason: 'missing_signing_secret' };
  if (!signatureHeader) return { ok: false, reason: 'missing_signature' };
  if (!timestampHeader) return { ok: false, reason: 'missing_timestamp' };

  // The timestamp must be a bare integer. Reject anything else (whitespace,
  // signs, non-numeric) before it can perturb the HMAC basestring.
  if (!TIMESTAMP_RE.test(timestampHeader)) {
    return { ok: false, reason: 'malformed_timestamp' };
  }
  const timestampSeconds = Number.parseInt(timestampHeader, 10);
  if (!Number.isFinite(timestampSeconds)) {
    return { ok: false, reason: 'malformed_timestamp' };
  }
  // Replay window: reject requests too far in the past OR the future.
  const nowSeconds = Math.floor(nowMs / 1000);
  if (Math.abs(nowSeconds - timestampSeconds) > replayWindowSeconds) {
    return { ok: false, reason: 'expired' };
  }

  // Reject a malformed signature before any compare, so timingSafeEqual only
  // ever sees a well-formed, fixed-length candidate.
  if (!SIGNATURE_RE.test(signatureHeader)) {
    return { ok: false, reason: 'malformed_signature' };
  }

  // HMAC over the EXACT raw body using the raw timestamp header verbatim. Feed a
  // Buffer body as raw bytes (staged update) rather than decoding to UTF-8 first,
  // so verification is byte-exact even for non-UTF-8 payloads.
  const hmac = createHmac('sha256', signingSecret);
  hmac.update(`${SIGNATURE_VERSION}:${timestampHeader}:`, 'utf8');
  hmac.update(typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody);
  const digest = hmac.digest('hex');
  const expected = Buffer.from(`${SIGNATURE_VERSION}=${digest}`, 'utf8');
  // Hex case-insensitive: compare a lowercased copy so a correct-but-uppercase
  // signature still matches; the digest above is already lowercase.
  const provided = Buffer.from(signatureHeader.toLowerCase(), 'utf8');

  // Length-guard before timingSafeEqual (it throws on unequal lengths). The
  // regex already pins both to 67 bytes; this is defense-in-depth.
  if (expected.length !== provided.length) {
    return { ok: false, reason: 'mismatch' };
  }
  if (!timingSafeEqual(expected, provided)) {
    return { ok: false, reason: 'mismatch' };
  }
  return { ok: true };
}
