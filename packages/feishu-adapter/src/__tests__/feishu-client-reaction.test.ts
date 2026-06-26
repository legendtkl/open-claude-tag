import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FeishuClient } from '../feishu-client.js';

// Stub global fetch
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

function makeTokenResponse() {
  return {
    ok: true,
    json: async () => ({ tenant_access_token: 'test_token', expire: 7200 }),
  };
}

describe('FeishuClient reactions', () => {
  let client: FeishuClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new FeishuClient({ appId: 'app_id', appSecret: 'secret' });
  });

  describe('addReaction', () => {
    it('returns reactionId from API response', async () => {
      fetchMock
        .mockResolvedValueOnce(makeTokenResponse()) // token fetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ data: { reaction_id: 'reaction_abc123' } }),
        });

      const result = await client.addReaction('msg_001', 'OK');

      expect(result.reactionId).toBe('reaction_abc123');
      const [url, opts] = fetchMock.mock.calls[1];
      expect(url).toContain('/im/v1/messages/msg_001/reactions');
      expect(opts.method).toBe('POST');
      expect(JSON.parse(opts.body)).toEqual({ reaction_type: { emoji_type: 'OK' } });
    });

    it('returns empty reactionId when API response has no reaction_id', async () => {
      fetchMock
        .mockResolvedValueOnce(makeTokenResponse())
        .mockResolvedValueOnce({ ok: true, json: async () => ({}) });

      const result = await client.addReaction('msg_001', 'THUMBSUP');

      expect(result.reactionId).toBe('');
    });

    it('throws on non-2xx response', async () => {
      fetchMock
        .mockResolvedValueOnce(makeTokenResponse())
        .mockResolvedValueOnce({ ok: false, status: 403, text: async () => 'Forbidden' });

      await expect(client.addReaction('msg_001', 'OK')).rejects.toThrow('addReaction failed: HTTP 403');
    });
  });

  describe('removeReaction', () => {
    it('calls DELETE on correct endpoint', async () => {
      fetchMock
        .mockResolvedValueOnce(makeTokenResponse())
        .mockResolvedValueOnce({ ok: true, text: async () => '' });

      await client.removeReaction('msg_001', 'reaction_abc123');

      const [url, opts] = fetchMock.mock.calls[1];
      expect(url).toContain('/im/v1/messages/msg_001/reactions/reaction_abc123');
      expect(opts.method).toBe('DELETE');
    });

    it('throws on non-2xx response', async () => {
      fetchMock
        .mockResolvedValueOnce(makeTokenResponse())
        .mockResolvedValueOnce({ ok: false, status: 404, text: async () => 'Not Found' });

      await expect(client.removeReaction('msg_001', 'reaction_abc123')).rejects.toThrow('removeReaction failed: HTTP 404');
    });
  });
});
