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

describe('FeishuClient.downloadImage', () => {
  let client: FeishuClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new FeishuClient({ appId: 'app_id', appSecret: 'secret' });
  });

  it('returns image Buffer on success', async () => {
    const imageBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG header
    fetchMock
      .mockResolvedValueOnce(makeTokenResponse())
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => imageBytes.buffer,
      });

    const result = await client.downloadImage('msg_001', 'img_key_001');
    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result[0]).toBe(0x89);
    expect(result[1]).toBe(0x50);

    const calls = fetchMock.mock.calls;
    expect(calls[1][0]).toContain('/im/v1/messages/msg_001/resources/img_key_001?type=image');
    expect(calls[1][1].headers.Authorization).toBe('Bearer test_token');
  });

  it('throws Error when API returns non-2xx status', async () => {
    fetchMock
      .mockResolvedValueOnce(makeTokenResponse())
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => 'Forbidden',
      });

    await expect(client.downloadImage('msg_001', 'img_key_bad')).rejects.toThrow(
      'downloadImage failed: HTTP 403 Forbidden',
    );
  });
});

describe('FeishuClient.downloadFile', () => {
  let client: FeishuClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new FeishuClient({ appId: 'app_id', appSecret: 'secret' });
  });

  it('returns file Buffer on success', async () => {
    const fileBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    fetchMock
      .mockResolvedValueOnce(makeTokenResponse())
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => fileBytes.buffer,
      });

    const result = await client.downloadFile('msg_001', 'file_key_001');
    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result[0]).toBe(0x25);

    const calls = fetchMock.mock.calls;
    expect(calls[1][0]).toContain('/im/v1/messages/msg_001/resources/file_key_001?type=file');
    expect(calls[1][1].headers.Authorization).toBe('Bearer test_token');
  });

  it('uses the requested Feishu resource type', async () => {
    const mediaBytes = new Uint8Array([0x00, 0x00, 0x00, 0x20]);
    fetchMock
      .mockResolvedValueOnce(makeTokenResponse())
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => mediaBytes.buffer,
      });

    await client.downloadFile('msg_001', 'media_key_001', 'media');

    const calls = fetchMock.mock.calls;
    expect(calls[1][0]).toContain('/im/v1/messages/msg_001/resources/media_key_001?type=media');
  });

  it('throws Error when file download returns non-2xx status', async () => {
    fetchMock
      .mockResolvedValueOnce(makeTokenResponse())
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => 'Forbidden',
      });

    await expect(client.downloadFile('msg_001', 'file_key_bad')).rejects.toThrow(
      'downloadFile failed: HTTP 403 Forbidden',
    );
  });
});
