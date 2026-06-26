import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FeishuClient } from '../feishu-client.js';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

function makeTokenResponse() {
  return {
    ok: true,
    json: async () => ({ tenant_access_token: 'test_token', expire: 7200 }),
  };
}

describe('FeishuClient messaging', () => {
  let client: FeishuClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new FeishuClient({ appId: 'app_id', appSecret: 'secret' });
  });

  describe('sendMessage', () => {
    it('throws on non-2xx reply response', async () => {
      fetchMock
        .mockResolvedValueOnce(makeTokenResponse())
        .mockResolvedValueOnce({ ok: false, status: 400, text: async () => 'invalid card json' });

      await expect(
        client.sendMessage(
          'chat_id',
          'chat_123',
          {
            msg_type: 'interactive',
            card: { schema: '2.0', body: { elements: [] } },
          },
          'msg_parent_123',
        ),
      ).rejects.toThrow('sendMessage failed: HTTP 400 invalid card json');
    });

    it('throws on Feishu API error codes even when HTTP status is 200', async () => {
      fetchMock
        .mockResolvedValueOnce(makeTokenResponse())
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ code: 230099, msg: 'content too long' }),
        });

      await expect(
        client.sendMessage('chat_id', 'chat_123', {
          msg_type: 'text',
          content: { text: 'hello' },
        }),
      ).rejects.toThrow('sendMessage failed: code 230099 content too long');
    });
  });

  describe('updateMessage', () => {
    it('throws on non-2xx PATCH response', async () => {
      fetchMock
        .mockResolvedValueOnce(makeTokenResponse())
        .mockResolvedValueOnce({ ok: false, status: 400, text: async () => 'invalid card json' });

      await expect(
        client.updateMessage('msg_123', {
          msg_type: 'interactive',
          card: { schema: '2.0', body: { elements: [] } },
        }),
      ).rejects.toThrow('updateMessage failed: HTTP 400 invalid card json');
    });

    it('throws on Feishu API error codes even when PATCH HTTP status is 200', async () => {
      fetchMock
        .mockResolvedValueOnce(makeTokenResponse())
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ code: 230099, msg: 'content too long' }),
          text: async () => 'content too long',
        });

      await expect(
        client.updateMessage('msg_123', {
          msg_type: 'interactive',
          card: { schema: '2.0', body: { elements: [] } },
        }),
      ).rejects.toThrow('updateMessage failed: code 230099 content too long');
    });
  });
});
