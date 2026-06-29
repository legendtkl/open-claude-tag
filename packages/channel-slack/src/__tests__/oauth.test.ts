import { describe, it, expect, vi } from 'vitest';
import {
  buildSanitizedSlackInstallation,
  exchangeSlackOAuthCode,
  type SlackOAuthResult,
} from '../oauth.js';

const BOT_TOKEN = 'xoxb-real-secret-token';
const REFRESH_TOKEN = 'xoxe-1-refresh-secret';

/** A mock `fetch` returning a fixed JSON body and recording the call. */
function mockFetch(json: Record<string, unknown>, httpOk = true, status = 200) {
  const calls = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => ({
    ok: httpOk,
    status,
    json: async () => json,
  }));
  return { fetch: calls as unknown as typeof fetch, calls };
}

function successBody() {
  return {
    ok: true,
    access_token: BOT_TOKEN,
    token_type: 'bot',
    scope: 'app_mentions:read,chat:write',
    bot_user_id: 'U_BOT',
    app_id: 'A_APP',
    team: { id: 'T_TEAM', name: 'Acme' },
    authed_user: { id: 'U_HUMAN', scope: 'identify', access_token: 'xoxp-user-secret' },
  };
}

describe('exchangeSlackOAuthCode', () => {
  it('parses a successful oauth.v2.access response into typed fields', async () => {
    const { fetch, calls } = mockFetch(successBody());
    const result = await exchangeSlackOAuthCode({
      code: 'code-123',
      clientId: 'cid',
      clientSecret: 'csecret',
      redirectUri: 'https://host/slack/oauth/callback',
      fetch,
    });

    expect(result.accessToken).toBe(BOT_TOKEN);
    expect(result.botUserId).toBe('U_BOT');
    expect(result.appId).toBe('A_APP');
    expect(result.team).toEqual({ id: 'T_TEAM', name: 'Acme' });
    expect(result.scope).toBe('app_mentions:read,chat:write');
    expect(result.authedUser).toEqual({ id: 'U_HUMAN', scope: 'identify' });

    // It POSTs form-encoded to oauth.v2.access carrying the code + client creds.
    const [url, init] = calls.mock.calls[0];
    expect(String(url)).toBe('https://slack.com/api/oauth.v2.access');
    expect((init as RequestInit).method).toBe('POST');
    expect((init as RequestInit).headers).toMatchObject({
      'Content-Type': 'application/x-www-form-urlencoded',
    });
    const body = (init as RequestInit).body as string;
    const params = new URLSearchParams(body);
    expect(params.get('code')).toBe('code-123');
    expect(params.get('client_id')).toBe('cid');
    expect(params.get('client_secret')).toBe('csecret');
    expect(params.get('redirect_uri')).toBe('https://host/slack/oauth/callback');
  });

  it('omits redirect_uri from the body when none is provided', async () => {
    const { fetch, calls } = mockFetch(successBody());
    await exchangeSlackOAuthCode({ code: 'c', clientId: 'i', clientSecret: 's', fetch });
    const params = new URLSearchParams((calls.mock.calls[0][1] as RequestInit).body as string);
    expect(params.has('redirect_uri')).toBe(false);
  });

  it('throws the Slack error code on ok:false, never leaking a token', async () => {
    const { fetch } = mockFetch({ ok: false, error: 'invalid_code', access_token: BOT_TOKEN });
    await expect(
      exchangeSlackOAuthCode({ code: 'bad', clientId: 'i', clientSecret: 's', fetch }),
    ).rejects.toThrow(/invalid_code/);

    try {
      await exchangeSlackOAuthCode({ code: 'bad', clientId: 'i', clientSecret: 's', fetch });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as Error).message).not.toContain('xoxb');
      expect((err as Error).message).not.toContain(BOT_TOKEN);
    }
  });

  it('throws on a non-2xx HTTP response without a token in the message', async () => {
    const { fetch } = mockFetch({ ok: true, access_token: BOT_TOKEN }, false, 502);
    await expect(
      exchangeSlackOAuthCode({ code: 'c', clientId: 'i', clientSecret: 's', fetch }),
    ).rejects.toThrow(/HTTP 502/);
    try {
      await exchangeSlackOAuthCode({ code: 'c', clientId: 'i', clientSecret: 's', fetch });
    } catch (err) {
      expect((err as Error).message).not.toContain(BOT_TOKEN);
    }
  });

  it('throws when a required field is missing (no token echoed)', async () => {
    const { fetch } = mockFetch({ ok: true, access_token: BOT_TOKEN, team: { id: 'T1' } });
    try {
      await exchangeSlackOAuthCode({ code: 'c', clientId: 'i', clientSecret: 's', fetch });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as Error).message).toMatch(/missing required fields/);
      expect((err as Error).message).not.toContain(BOT_TOKEN);
    }
  });
});

describe('buildSanitizedSlackInstallation', () => {
  it('keeps non-secret install facts and drops every token', () => {
    const result: SlackOAuthResult = {
      accessToken: BOT_TOKEN,
      tokenType: 'bot',
      scope: 'chat:write',
      botUserId: 'U_BOT',
      appId: 'A_APP',
      team: { id: 'T_TEAM', name: 'Acme' },
      authedUser: { id: 'U_HUMAN', scope: 'identify' },
    };
    const sanitized = buildSanitizedSlackInstallation(result);
    const serialized = JSON.stringify(sanitized);
    expect(serialized).not.toContain('xoxb');
    expect(serialized).not.toContain(BOT_TOKEN);
    expect(serialized).not.toContain(REFRESH_TOKEN);
    expect(serialized).not.toContain('access_token');
    expect(sanitized).toMatchObject({
      team: { id: 'T_TEAM', name: 'Acme' },
      bot_user_id: 'U_BOT',
      app_id: 'A_APP',
      scope: 'chat:write',
      authed_user: { id: 'U_HUMAN', scope: 'identify' },
    });
  });
});
