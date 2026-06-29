/**
 * Slack OAuth v2 install flow for the gateway (Slack Milestone 1b, ADR-0014):
 * one Slack app installed into many workspaces. Two routes, both registered ONLY
 * when `SLACK_CLIENT_ID` + `SLACK_CLIENT_SECRET` are set (server.ts gate):
 *
 *  - `GET /slack/oauth/install` — behind the admin guard, so only an authenticated
 *    console user (or loopback/token superadmin) can start an install. It mints a
 *    signed `state` carrying the initiating platform user id and 302-redirects to
 *    Slack's authorize page.
 *  - `GET /slack/oauth/callback` — PUBLIC (it is Slack's browser redirect, not a
 *    console session). CSRF protection is the signed `state`, NOT the admin guard:
 *    an attacker cannot forge a valid state without the server secret. It verifies
 *    the state, exchanges the `code` for a bot token, and upserts the install row.
 *
 * SECURITY: a bot token, OAuth `code`, `state`, or `refresh_token` is NEVER logged
 * or placed in a response body. Only coarse outcomes (a failure reason, the
 * `team_id`) are logged. The `code` is single-use and the `state` is HMAC-signed
 * with a short TTL (a deliberate stateless-CSRF trade-off; a one-use nonce store
 * is a documented future hardening, ADR-0014).
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  buildSanitizedSlackInstallation,
  exchangeSlackOAuthCode,
  type SlackOAuthResult,
} from '@open-tag/channel-slack';
import type { Logger } from '@open-tag/observability';
import { SlackInstallationOwnershipError } from '@open-tag/storage';

export const SLACK_OAUTH_INSTALL_PATH = '/slack/oauth/install';
export const SLACK_OAUTH_CALLBACK_PATH = '/slack/oauth/callback';

/** Slack authorize endpoint (the consent screen the user is redirected to). */
const SLACK_AUTHORIZE_URL = 'https://slack.com/oauth/v2/authorize';

/** State link lifetime: long enough for a human OAuth consent, short for replay. */
const DEFAULT_STATE_TTL_MS = 10 * 60 * 1000;

/**
 * The bot scopes requested at install. A conservative set covering inbound
 * message events (@mentions across conversation kinds), the outbound ACK +
 * reactions, attachment download/upload, and roster lookup the `SlackChannel`
 * uses. Kept as a constant so the authorize request and docs stay in sync.
 */
export const SLACK_BOT_SCOPES = [
  'app_mentions:read',
  'channels:history',
  'channels:read',
  'chat:write',
  'files:read',
  'files:write',
  'groups:history',
  'im:history',
  'mpim:history',
  'reactions:read',
  'reactions:write',
  'users:read',
] as const;

// ── Signed OAuth state (stateless CSRF) ──────────────────────────────────────

interface SlackOAuthStatePayload {
  /** The initiating platform user id (`null` ⇒ a superadmin-initiated install). */
  u: string | null;
  /** Random nonce — unpredictability + per-flow uniqueness. */
  n: string;
  /** Issued-at, epoch ms (TTL bound). */
  t: number;
}

export type VerifySlackOAuthStateResult =
  | { ok: true; platformUserId: string | null; issuedAt: number }
  | { ok: false; reason: 'malformed' | 'mismatch' | 'expired' };

function base64url(input: Buffer | string): string {
  return (typeof input === 'string' ? Buffer.from(input, 'utf8') : input).toString('base64url');
}

function signPayload(body: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(body, 'utf8').digest();
}

/**
 * Build a signed state token `base64url(payload).base64url(HMAC)` carrying the
 * initiating platform user id, a nonce, and the issued-at time.
 */
export function signSlackOAuthState(
  input: { platformUserId: string | null; now?: number; nonce?: string },
  secret: string,
): string {
  const payload: SlackOAuthStatePayload = {
    u: input.platformUserId,
    n: input.nonce ?? randomBytes(16).toString('hex'),
    t: input.now ?? Date.now(),
  };
  const body = base64url(JSON.stringify(payload));
  return `${body}.${base64url(signPayload(body, secret))}`;
}

/**
 * Verify + decode a signed state token. Rejects a malformed/tampered token (bad
 * shape or HMAC mismatch) and one older than `ttlMs` (or issued in the future).
 * Constant-time signature compare. NEVER returns or logs the raw token.
 */
export function verifySlackOAuthState(
  token: string,
  secret: string,
  opts: { now?: number; ttlMs?: number } = {},
): VerifySlackOAuthStateResult {
  const now = opts.now ?? Date.now();
  const ttlMs = opts.ttlMs ?? DEFAULT_STATE_TTL_MS;

  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: 'malformed' };
  const [body, providedSigB64] = parts;

  const expected = signPayload(body, secret);
  let provided: Buffer;
  try {
    provided = Buffer.from(providedSigB64, 'base64url');
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (provided.length !== expected.length) return { ok: false, reason: 'mismatch' };
  if (!timingSafeEqual(provided, expected)) return { ok: false, reason: 'mismatch' };

  let payload: SlackOAuthStatePayload;
  try {
    const decoded = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as unknown;
    if (!isStatePayload(decoded)) return { ok: false, reason: 'malformed' };
    payload = decoded;
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  // Reject expired or future-dated (clock-skew) tokens. The 60s future tolerance
  // absorbs minor skew without widening the replay window meaningfully.
  if (now - payload.t > ttlMs || payload.t - now > 60_000) {
    return { ok: false, reason: 'expired' };
  }
  return { ok: true, platformUserId: payload.u, issuedAt: payload.t };
}

function isStatePayload(value: unknown): value is SlackOAuthStatePayload {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    (v.u === null || typeof v.u === 'string') &&
    typeof v.n === 'string' &&
    typeof v.t === 'number'
  );
}

/** Build the Slack authorize-URL the install route 302-redirects the user to. */
export function buildSlackAuthorizeUrl(input: {
  clientId: string;
  scopes: readonly string[];
  state: string;
  redirectUri?: string;
}): string {
  const url = new URL(SLACK_AUTHORIZE_URL);
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('scope', input.scopes.join(','));
  url.searchParams.set('state', input.state);
  if (input.redirectUri) url.searchParams.set('redirect_uri', input.redirectUri);
  return url.toString();
}

// ── Route handlers ───────────────────────────────────────────────────────────

/** Shared OAuth app config (server.ts reads these from the SLACK_* env). */
export interface SlackOAuthConfig {
  clientId: string;
  clientSecret: string;
  /** Must match between authorize + exchange; omitted ⇒ Slack's default redirect. */
  redirectUri?: string;
  /** HMAC key for the signed state (a server-only secret). */
  stateSecret: string;
  /** Defaults to {@link SLACK_BOT_SCOPES}. */
  scopes?: readonly string[];
}

/**
 * The full OAuth registration passed from server.ts into the admin route layer:
 * the app config plus optional test seams (`exchange`, `now`, `stateTtlMs`) and a
 * `successRedirectUrl`.
 */
export interface SlackOAuthRegistration extends SlackOAuthConfig {
  exchange?: typeof exchangeSlackOAuthCode;
  successRedirectUrl?: string;
  now?: () => number;
  stateTtlMs?: number;
}

export interface SlackOAuthInstallHandlerDeps extends SlackOAuthConfig {
  /** Resolve the initiating platform user id (from the admin guard identity). */
  resolvePlatformUserId: (request: FastifyRequest) => string | null;
  now?: () => number;
  nonce?: () => string;
  logger?: Logger;
}

/** `GET /slack/oauth/install` → 302 to Slack's authorize page with a signed state. */
export function createSlackOAuthInstallHandler(deps: SlackOAuthInstallHandlerDeps) {
  const scopes = deps.scopes ?? SLACK_BOT_SCOPES;
  return async function handleSlackOAuthInstall(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<unknown> {
    const platformUserId = deps.resolvePlatformUserId(request);
    const state = signSlackOAuthState(
      {
        platformUserId,
        ...(deps.now ? { now: deps.now() } : {}),
        ...(deps.nonce ? { nonce: deps.nonce() } : {}),
      },
      deps.stateSecret,
    );
    const url = buildSlackAuthorizeUrl({
      clientId: deps.clientId,
      scopes,
      state,
      ...(deps.redirectUri ? { redirectUri: deps.redirectUri } : {}),
    });
    // The state token is short-lived; do not let a browser/proxy cache the link.
    reply.header('cache-control', 'no-store');
    return reply.redirect(url);
  };
}

/** Provisioning seam: persist an OAuth install (NO token in the result). */
export type SlackOAuthUpsert = (input: {
  teamId: string;
  teamName: string | null;
  botToken: string;
  botUserId: string | null;
  slackAppId: string | null;
  installation: Record<string, unknown>;
  ownerPlatformUserId: string | null;
}) => Promise<{ teamId: string; teamName: string | null; created: boolean }>;

export interface SlackOAuthCallbackHandlerDeps extends SlackOAuthConfig {
  /** Persist the install (the admin store's `upsertSlackInstallationFromOAuth`). */
  upsertInstallation: SlackOAuthUpsert;
  /** Injectable for tests; defaults to the real `exchangeSlackOAuthCode`. */
  exchange?: typeof exchangeSlackOAuthCode;
  /** Optional success URL to 302 to; otherwise a minimal 200 HTML page. */
  successRedirectUrl?: string;
  now?: () => number;
  stateTtlMs?: number;
  logger?: Logger;
}

/** `GET /slack/oauth/callback` → verify state, exchange code, upsert install. */
export function createSlackOAuthCallbackHandler(deps: SlackOAuthCallbackHandlerDeps) {
  const exchange = deps.exchange ?? exchangeSlackOAuthCode;
  return async function handleSlackOAuthCallback(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<unknown> {
    const query = (request.query ?? {}) as Record<string, unknown>;
    const code = typeof query.code === 'string' ? query.code : '';
    const state = typeof query.state === 'string' ? query.state : '';
    const oauthError = typeof query.error === 'string' ? query.error : '';

    // The user denied/cancelled consent (Slack appends `?error=access_denied`).
    if (oauthError) {
      deps.logger?.info({ event: 'slack_oauth_denied' }, 'Slack OAuth consent denied');
      return htmlPage(reply, 400, 'Installation cancelled', 'The Slack installation was cancelled.');
    }

    if (!code) {
      return htmlPage(reply, 400, 'Invalid request', 'Missing authorization code.');
    }

    const verified = verifySlackOAuthState(state, deps.stateSecret, {
      ...(deps.now ? { now: deps.now() } : {}),
      ...(deps.stateTtlMs !== undefined ? { ttlMs: deps.stateTtlMs } : {}),
    });
    if (!verified.ok) {
      // Never log the raw state or code — only the coarse reason.
      deps.logger?.warn(
        { event: 'slack_oauth_invalid_state', reason: verified.reason },
        'Rejected Slack OAuth callback: invalid state',
      );
      return htmlPage(reply, 400, 'Invalid or expired link', 'This install link is invalid or has expired. Please start the installation again.');
    }

    let result: SlackOAuthResult;
    try {
      result = await exchange({
        code,
        clientId: deps.clientId,
        clientSecret: deps.clientSecret,
        ...(deps.redirectUri ? { redirectUri: deps.redirectUri } : {}),
      });
    } catch {
      // The thrown error may carry a Slack error code (safe) but we log only a
      // generic event to be certain no code/token/error object is ever recorded.
      deps.logger?.warn({ event: 'slack_oauth_exchange_failed' }, 'Slack OAuth code exchange failed');
      return htmlPage(reply, 502, 'Installation failed', 'Slack rejected the installation. Please try again.');
    }

    try {
      const upserted = await deps.upsertInstallation({
        teamId: result.team.id,
        teamName: result.team.name ?? null,
        botToken: result.accessToken,
        botUserId: result.botUserId,
        slackAppId: result.appId,
        installation: buildSanitizedSlackInstallation(result),
        ownerPlatformUserId: verified.platformUserId,
      });
      deps.logger?.info(
        { event: 'slack_oauth_installed', teamId: upserted.teamId, created: upserted.created },
        'Slack installation provisioned via OAuth',
      );
      if (deps.successRedirectUrl) {
        reply.header('cache-control', 'no-store');
        return reply.redirect(deps.successRedirectUrl);
      }
      return htmlPage(
        reply,
        200,
        'Installation complete',
        `OpenClaudeTag is now connected to ${escapeHtml(upserted.teamName ?? 'your Slack workspace')}. You can close this window.`,
      );
    } catch (err) {
      if (err instanceof SlackInstallationOwnershipError) {
        deps.logger?.warn(
          { event: 'slack_oauth_owner_conflict', teamId: err.teamId },
          'Rejected Slack OAuth callback: workspace owned by another user',
        );
        return htmlPage(reply, 403, 'Already connected', 'This Slack workspace is already connected by another user.');
      }
      throw err;
    }
  };
}

/** A minimal, escaped HTML response (no token, no reflected user input unescaped). */
function htmlPage(reply: FastifyReply, status: number, title: string, body: string): string {
  reply.code(status);
  reply.header('content-type', 'text/html; charset=utf-8');
  reply.header('cache-control', 'no-store');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body><h1>${escapeHtml(title)}</h1><p>${body}</p></body></html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
