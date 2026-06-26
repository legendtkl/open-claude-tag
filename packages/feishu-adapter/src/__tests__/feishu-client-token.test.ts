import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FeishuClient } from '../feishu-client.js';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const TOKEN_URL_PART = 'tenant_access_token/internal';

function tokenResponse(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ code: 0, tenant_access_token: 'token_1', expire: 7200, ...overrides }),
    text: async () => '',
  };
}

function messageResponse() {
  return {
    ok: true,
    status: 200,
    json: async () => ({ code: 0, data: { message_id: 'msg_1' } }),
    text: async () => '',
  };
}

function sendText(client: FeishuClient, chatId = 'chat_1') {
  return client.sendMessage('chat_id', chatId, {
    msg_type: 'text',
    content: { text: 'hello' },
  });
}

function tokenFetchCalls() {
  return fetchMock.mock.calls.filter(([url]) => String(url).includes(TOKEN_URL_PART));
}

describe('FeishuClient token handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('deduplicates concurrent token refreshes into a single fetch', async () => {
    let resolveToken: (value: unknown) => void = () => {};
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes(TOKEN_URL_PART)) {
        return new Promise((resolve) => {
          resolveToken = resolve;
        });
      }
      return Promise.resolve(messageResponse());
    });

    const client = new FeishuClient({ appId: 'app', appSecret: 'secret' });
    const first = sendText(client, 'chat_1');
    const second = sendText(client, 'chat_2');

    // Let both callers reach ensureToken before the token request resolves.
    await new Promise((resolve) => setImmediate(resolve));
    resolveToken(tokenResponse());

    await Promise.all([first, second]);
    expect(tokenFetchCalls()).toHaveLength(1);
  });

  it('rejects on Feishu token error codes and does not cache the failure', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ code: 99991663, msg: 'app not found' }),
        text: async () => '',
      })
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(messageResponse());

    const client = new FeishuClient({ appId: 'app', appSecret: 'secret', retryDelayMs: 0 });

    await expect(sendText(client)).rejects.toThrow(/ensureToken failed/);
    // The failed refresh must not poison the cache: the next call retries the
    // token endpoint instead of sending `Bearer undefined`.
    await expect(sendText(client)).resolves.toEqual({ messageId: 'msg_1' });
    expect(tokenFetchCalls()).toHaveLength(2);
  });

  it('rejects when the token response is missing tenant_access_token', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ code: 0, expire: 7200 }),
      text: async () => '',
    });

    const client = new FeishuClient({ appId: 'app', appSecret: 'secret', retryDelayMs: 0 });
    await expect(sendText(client)).rejects.toThrow(/ensureToken failed/);
  });

  it('retries the token fetch on transient 5xx responses', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}), text: async () => 'boom' })
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(messageResponse());

    const client = new FeishuClient({ appId: 'app', appSecret: 'secret', retryDelayMs: 0 });
    await expect(sendText(client)).resolves.toEqual({ messageId: 'msg_1' });
    expect(tokenFetchCalls()).toHaveLength(2);
  });

  it('rejects with an HTTP error when the token endpoint keeps failing', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({}),
      text: async () => 'unavailable',
    });

    const client = new FeishuClient({
      appId: 'app',
      appSecret: 'secret',
      retryDelayMs: 0,
      maxRequestAttempts: 2,
    });
    await expect(sendText(client)).rejects.toThrow(/ensureToken failed: HTTP 503/);
    expect(tokenFetchCalls()).toHaveLength(2);
  });

  it('attaches an abort signal to every request for timeout protection', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(messageResponse());

    const client = new FeishuClient({ appId: 'app', appSecret: 'secret', requestTimeoutMs: 5000 });
    await sendText(client);

    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const [, init] of fetchMock.mock.calls) {
      expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('reuses a cached unexpired token across calls', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValue(messageResponse());

    const client = new FeishuClient({ appId: 'app', appSecret: 'secret' });
    await sendText(client, 'chat_1');
    await sendText(client, 'chat_2');
    expect(tokenFetchCalls()).toHaveLength(1);
  });
});
