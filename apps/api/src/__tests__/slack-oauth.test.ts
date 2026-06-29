import { describe, it, expect } from 'vitest';
import {
  buildSlackAuthorizeUrl,
  SLACK_BOT_SCOPES,
  signSlackOAuthState,
  verifySlackOAuthState,
} from '../slack-oauth.js';

const SECRET = 'state-signing-secret';

describe('signSlackOAuthState / verifySlackOAuthState', () => {
  it('round-trips the platform user id, nonce and issued-at', () => {
    const now = 1_700_000_000_000;
    const token = signSlackOAuthState({ platformUserId: 'U-platform', now }, SECRET);
    const result = verifySlackOAuthState(token, SECRET, { now: now + 1000 });
    expect(result).toEqual({ ok: true, platformUserId: 'U-platform', issuedAt: now });
  });

  it('carries a null platform user (superadmin-initiated install)', () => {
    const token = signSlackOAuthState({ platformUserId: null }, SECRET);
    const result = verifySlackOAuthState(token, SECRET);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.platformUserId).toBeNull();
  });

  it('rejects a token signed with a different secret', () => {
    const token = signSlackOAuthState({ platformUserId: 'U1' }, SECRET);
    expect(verifySlackOAuthState(token, 'other-secret')).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('rejects a tampered payload (flipped byte breaks the HMAC)', () => {
    const token = signSlackOAuthState({ platformUserId: 'U1' }, SECRET);
    const [body, sig] = token.split('.');
    const tamperedBody = `${body.slice(0, -1)}${body.endsWith('A') ? 'B' : 'A'}`;
    expect(verifySlackOAuthState(`${tamperedBody}.${sig}`, SECRET)).toEqual({
      ok: false,
      reason: 'mismatch',
    });
  });

  it('rejects an expired token', () => {
    const now = 1_700_000_000_000;
    const token = signSlackOAuthState({ platformUserId: 'U1', now }, SECRET);
    const result = verifySlackOAuthState(token, SECRET, {
      now: now + 11 * 60 * 1000,
      ttlMs: 10 * 60 * 1000,
    });
    expect(result).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects a future-dated token (beyond the skew tolerance)', () => {
    const now = 1_700_000_000_000;
    const token = signSlackOAuthState({ platformUserId: 'U1', now: now + 5 * 60 * 1000 }, SECRET);
    expect(verifySlackOAuthState(token, SECRET, { now }).ok).toBe(false);
  });

  it('rejects a malformed (non two-part) token', () => {
    expect(verifySlackOAuthState('garbage', SECRET)).toEqual({ ok: false, reason: 'malformed' });
    expect(verifySlackOAuthState('', SECRET)).toEqual({ ok: false, reason: 'malformed' });
  });
});

describe('buildSlackAuthorizeUrl', () => {
  it('builds the authorize URL with client id, scopes, state and redirect', () => {
    const url = new URL(
      buildSlackAuthorizeUrl({
        clientId: 'cid',
        scopes: SLACK_BOT_SCOPES,
        state: 'st-123',
        redirectUri: 'https://host/slack/oauth/callback',
      }),
    );
    expect(url.origin + url.pathname).toBe('https://slack.com/oauth/v2/authorize');
    expect(url.searchParams.get('client_id')).toBe('cid');
    expect(url.searchParams.get('scope')).toBe(SLACK_BOT_SCOPES.join(','));
    expect(url.searchParams.get('state')).toBe('st-123');
    expect(url.searchParams.get('redirect_uri')).toBe('https://host/slack/oauth/callback');
  });

  it('omits redirect_uri when none is given', () => {
    const url = new URL(
      buildSlackAuthorizeUrl({ clientId: 'cid', scopes: SLACK_BOT_SCOPES, state: 's' }),
    );
    expect(url.searchParams.has('redirect_uri')).toBe(false);
  });
});
