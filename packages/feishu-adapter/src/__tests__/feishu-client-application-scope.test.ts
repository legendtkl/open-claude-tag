import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FeishuClient } from '../feishu-client.js';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

function makeTokenResponse() {
  return {
    ok: true,
    json: async () => ({ tenant_access_token: 'test_token', expire: 7200 }),
  };
}

function makeApiResponse(data: unknown) {
  return {
    ok: true,
    json: async () => ({ code: 0, data }),
  };
}

describe('FeishuClient application scopes', () => {
  let client: FeishuClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new FeishuClient({ appId: 'app_id', appSecret: 'secret' });
  });

  it('lists application scope grant status', async () => {
    fetchMock.mockResolvedValueOnce(makeTokenResponse()).mockResolvedValueOnce(
      makeApiResponse({
        scopes: [
          { scope_name: 'im:message:send_as_bot', grant_status: 1 },
          { scope_name: 'im:message.group_msg:readonly', grant_status: 2 },
        ],
      }),
    );

    const scopes = await client.listApplicationScopes();

    expect(scopes).toEqual([
      { scopeName: 'im:message:send_as_bot', grantStatus: 1 },
      { scopeName: 'im:message.group_msg:readonly', grantStatus: 2 },
    ]);
    const [url, opts] = fetchMock.mock.calls[1];
    expect(url).toBe('https://open.feishu.cn/open-apis/application/v6/scopes');
    expect(opts.method).toBe('GET');
    expect(opts.headers.Authorization).toBe('Bearer test_token');
  });

  it('drops malformed scope rows from the API response', async () => {
    fetchMock.mockResolvedValueOnce(makeTokenResponse()).mockResolvedValueOnce(
      makeApiResponse({
        scopes: [
          { scope_name: 'im:message:send_as_bot', grant_status: 1 },
          { scope_name: '', grant_status: 1 },
          { scope_name: 'missing_status' },
        ],
      }),
    );

    await expect(client.listApplicationScopes()).resolves.toEqual([
      { scopeName: 'im:message:send_as_bot', grantStatus: 1 },
    ]);
  });

  it('submits an application scope approval request with tenant token auth and no body', async () => {
    fetchMock.mockResolvedValueOnce(makeTokenResponse()).mockResolvedValueOnce(makeApiResponse({}));

    await expect(client.applyApplicationScopes()).resolves.toEqual({ submitted: true });

    const [url, opts] = fetchMock.mock.calls[1];
    expect(url).toBe('https://open.feishu.cn/open-apis/application/v6/scopes/apply');
    expect(opts.method).toBe('POST');
    expect(opts.headers.Authorization).toBe('Bearer test_token');
    expect(opts.headers['Content-Type']).toBeUndefined();
    expect(opts.body).toBeUndefined();
  });

  it('propagates Feishu application scope approval errors', async () => {
    fetchMock.mockResolvedValueOnce(makeTokenResponse()).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ code: 99991400, msg: 'apply frequency limited' }),
    });

    await expect(client.applyApplicationScopes()).rejects.toThrow(
      /applyApplicationScopes failed: code 99991400 apply frequency limited/,
    );
  });

  it('gets localized application information', async () => {
    fetchMock.mockResolvedValueOnce(makeTokenResponse()).mockResolvedValueOnce(
      makeApiResponse({
        app: {
          app_id: 'cli_app',
          app_name: 'OpenClaudeTag Dev Bot',
          status: 1,
        },
      }),
    );

    const info = await client.getApplicationInfo({ appId: 'cli_app', lang: 'en_us' });

    expect(info).toEqual({
      appId: 'cli_app',
      appName: 'OpenClaudeTag Dev Bot',
      status: 1,
    });
    const [url, opts] = fetchMock.mock.calls[1];
    expect(url).toBe(
      'https://open.feishu.cn/open-apis/application/v6/applications/cli_app?lang=en_us&user_id_type=open_id',
    );
    expect(opts.method).toBe('GET');
    expect(opts.headers.Authorization).toBe('Bearer test_token');
  });

  it('requires an application name in application information responses', async () => {
    fetchMock.mockResolvedValueOnce(makeTokenResponse()).mockResolvedValueOnce(
      makeApiResponse({
        app: {
          app_id: 'cli_app',
          app_name: '',
        },
      }),
    );

    await expect(client.getApplicationInfo({ appId: 'cli_app' })).rejects.toThrow(
      /getApplicationInfo returned no application name/,
    );
  });
});
