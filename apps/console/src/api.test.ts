import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyFeishuAppPermissions,
  bindBot,
  cancelFeishuAppRegistration,
  checkFeishuAppPermissions,
  deleteAgent,
  deleteFeishuApp,
  devLogin,
  disconnectMachine,
  getFeishuAppRegistration,
  getAdminToken,
  getAuthConfig,
  getMe,
  issuePairingToken,
  loadConsoleData,
  listComputerAccessUsers,
  listMachines,
  setAdminToken,
  startFeishuAppRegistration,
  syncFeishuAppMetadata,
  unbindBot,
  updateFeishuApp,
  updateChat,
  updateComputerAccessUser,
} from './api';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('console API requests', () => {
  afterEach(() => {
    setAdminToken('');
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it('POSTs to the pairing-token endpoint and returns the issued token (D-A7)', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({
        token: 'tok-1',
        expiresAt: '2026-06-10T00:00:00.000Z',
        machineName: 'laptop',
        connectCommand:
          'npx @open-tag/daemon@latest --server-url https://x --token tok-1 --background',
        serverConfigured: true,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const issued = await issuePairingToken('laptop');

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/admin/machines/pairing-token');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ name: 'laptop' });
    expect(issued.token).toBe('tok-1');
    expect(issued.connectCommand).toContain('--token tok-1');
  });

  it('does not send a JSON content type for empty DELETE requests', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({
        id: 'binding-1',
        agentId: 'agent-1',
        feishuAppId: 'app-1',
        botOpenId: null,
        status: 'inactive',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await unbindBot('binding-1');

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.method).toBe('DELETE');
    expect(init?.body).toBeUndefined();
    expect(init?.headers).toBeInstanceOf(Headers);
    expect((init?.headers as Headers).has('Content-Type')).toBe(false);
  });

  it('DELETEs agents without a request body', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({
        id: 'agent-1',
        handle: 'reviewer',
        displayName: 'Reviewer',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await deleteAgent('agent-1');

    const [input, init] = fetchMock.mock.calls[0]!;
    expect(input).toBe('/admin/agents/agent-1');
    expect(init?.method).toBe('DELETE');
    expect(init?.body).toBeUndefined();
    expect((init?.headers as Headers).has('Content-Type')).toBe(false);
  });

  it('DELETEs Feishu apps without a request body', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({
        id: 'app-1',
        appId: 'cli_reviewer',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await deleteFeishuApp('app-1');

    const [input, init] = fetchMock.mock.calls[0]!;
    expect(input).toBe('/admin/feishu-apps/app-1');
    expect(init?.method).toBe('DELETE');
    expect(init?.body).toBeUndefined();
    expect((init?.headers as Headers).has('Content-Type')).toBe(false);
  });

  it('sets JSON content type when a request body is present', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({
        id: 'binding-1',
        agentId: 'agent-1',
        feishuAppId: 'app-1',
        botOpenId: null,
        status: 'active',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await bindBot({ agentId: 'agent-1', feishuAppId: 'app-1' });

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.method).toBe('POST');
    expect(init?.headers).toBeInstanceOf(Headers);
    expect((init?.headers as Headers).get('Content-Type')).toBe('application/json');
  });

  it('does not send a JSON content type for empty permission-check POST requests', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({
        feishuAppId: 'app-1',
        appId: 'cli_reviewer',
        checkedAt: '2026-06-06T00:00:00.000Z',
        status: 'pass',
        grantedScopes: [],
        inventoryScopes: [],
        extraGrantedScopes: [],
        missingRequiredCapabilities: [],
        optionalMissingCapabilities: [],
        capabilities: [],
        notes: [],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await checkFeishuAppPermissions('app-1');

    const [input, init] = fetchMock.mock.calls[0]!;
    expect(input).toBe('/admin/feishu-apps/app-1/permission-check');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBeUndefined();
    expect(init?.headers).toBeInstanceOf(Headers);
    expect((init?.headers as Headers).has('Content-Type')).toBe(false);
  });

  it('does not send a JSON content type for empty permission-apply POST requests', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({
        feishuAppId: 'app-1',
        appId: 'cli_reviewer',
        submittedAt: '2026-06-06T00:00:00.000Z',
        submitted: true,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await applyFeishuAppPermissions('app-1');

    const [input, init] = fetchMock.mock.calls[0]!;
    expect(input).toBe('/admin/feishu-apps/app-1/permission-apply');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBeUndefined();
    expect(init?.headers).toBeInstanceOf(Headers);
    expect((init?.headers as Headers).has('Content-Type')).toBe(false);
  });

  it('PATCHes Feishu app bot names with a JSON body', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({
        id: 'app-1',
        appId: 'cli_reviewer',
        botName: 'Reviewer Bot Local',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await updateFeishuApp('app-1', { botName: 'Reviewer Bot Local' });

    const [input, init] = fetchMock.mock.calls[0]!;
    expect(input).toBe('/admin/feishu-apps/app-1');
    expect(init?.method).toBe('PATCH');
    expect(JSON.parse(String(init?.body))).toEqual({ botName: 'Reviewer Bot Local' });
    expect((init?.headers as Headers).get('Content-Type')).toBe('application/json');
  });

  it('POSTs to sync Feishu app metadata without a request body', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({
        id: 'app-1',
        appId: 'cli_reviewer',
        botName: 'Synced Reviewer Bot',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await syncFeishuAppMetadata('app-1');

    const [input, init] = fetchMock.mock.calls[0]!;
    expect(input).toBe('/admin/feishu-apps/app-1/sync-metadata');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBeUndefined();
    expect((init?.headers as Headers).has('Content-Type')).toBe(false);
  });

  it('starts one-click Feishu app registration with preset metadata', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({
        id: 'registration-1',
        status: 'pending',
        verificationUrl: 'https://open.feishu.cn/page/launcher?user_code=test',
        expireIn: 600,
        expiresAt: '2026-06-06T00:10:00.000Z',
        app: null,
        error: null,
        sdkStatus: null,
        createdAt: '2026-06-06T00:00:00.000Z',
        updatedAt: '2026-06-06T00:00:00.000Z',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await startFeishuAppRegistration({
      botName: 'Reviewer Bot',
      description: 'Reviews code',
    });

    const [input, init] = fetchMock.mock.calls[0]!;
    expect(input).toBe('/admin/feishu-apps/one-click-registration');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({
      botName: 'Reviewer Bot',
      description: 'Reviews code',
    });
  });

  it('polls and cancels one-click Feishu app registrations', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({
        id: 'registration-1',
        status: 'cancelled',
        verificationUrl: 'https://open.feishu.cn/page/launcher?user_code=test',
        expireIn: 600,
        expiresAt: '2026-06-06T00:10:00.000Z',
        app: null,
        error: 'Registration cancelled',
        sdkStatus: null,
        createdAt: '2026-06-06T00:00:00.000Z',
        updatedAt: '2026-06-06T00:00:00.000Z',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await getFeishuAppRegistration('registration-1');
    await cancelFeishuAppRegistration('registration-1');

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      '/admin/feishu-apps/one-click-registration/registration-1',
    );
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.method).toBeUndefined();
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      '/admin/feishu-apps/one-click-registration/registration-1',
    );
    expect((fetchMock.mock.calls[1]?.[1] as RequestInit | undefined)?.method).toBe('DELETE');
  });

  it('omits the admin token header when no token is configured', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse([]));
    vi.stubGlobal('fetch', fetchMock);

    await listMachines();

    const [, init] = fetchMock.mock.calls[0]!;
    expect((init?.headers as Headers).has('x-open-claude-tag-admin-token')).toBe(false);
  });

  it('sends the admin token header on every request once set', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse([]));
    vi.stubGlobal('fetch', fetchMock);

    setAdminToken('  remote-secret  ');
    expect(getAdminToken()).toBe('remote-secret');
    expect(localStorage.getItem('open-claude-tag.adminToken')).toBe('remote-secret');

    await listMachines();
    await updateChat('default', 'oc_test', { defaultMachineId: 'machine-1' });

    for (const [, init] of fetchMock.mock.calls) {
      expect((init?.headers as Headers).get('x-open-claude-tag-admin-token')).toBe('remote-secret');
    }
  });

  it('clears the admin token header and storage when set to empty', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse([]));
    vi.stubGlobal('fetch', fetchMock);

    setAdminToken('temp');
    setAdminToken('');
    expect(getAdminToken()).toBe('');
    expect(localStorage.getItem('open-claude-tag.adminToken')).toBeNull();

    await listMachines();
    const [, init] = fetchMock.mock.calls[0]!;
    expect((init?.headers as Headers).has('x-open-claude-tag-admin-token')).toBe(false);
  });

  it('never sends the removed x-jwt-token header', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse([]));
    vi.stubGlobal('fetch', fetchMock);

    setAdminToken('admin-tok');
    await listMachines();

    const [, init] = fetchMock.mock.calls[0]!;
    expect((init?.headers as Headers).has('x-jwt-token')).toBe(false);
    expect((init?.headers as Headers).get('x-open-claude-tag-admin-token')).toBe('admin-tok');
  });

  it('fetches the current identity from /admin/me', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({
        id: 'pu-1',
        email: 'me@example.com',
        displayName: 'Me',
        role: 'user',
        computerAccessEnabled: false,
        tokenAdmin: false,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const me = await getMe();
    expect(me).toMatchObject({ role: 'user', email: 'me@example.com' });
    expect(fetchMock.mock.calls[0]![0]).toBe('/admin/me');
  });

  it('lists and updates computer access settings', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/admin/settings/computer-access' && !init?.method) {
        return jsonResponse([
          {
            id: 'pu-1',
            email: 'alice@example.com',
            displayName: 'Alice',
            role: 'user',
            computerAccessEnabled: false,
            createdAt: '2026-06-06T00:00:00.000Z',
            updatedAt: '2026-06-06T00:00:00.000Z',
          },
        ]);
      }
      return jsonResponse({
        id: 'pu-1',
        email: 'alice@example.com',
        displayName: 'Alice',
        role: 'user',
        computerAccessEnabled: true,
        createdAt: '2026-06-06T00:00:00.000Z',
        updatedAt: '2026-06-06T00:00:00.000Z',
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const users = await listComputerAccessUsers();
    expect(users[0]?.computerAccessEnabled).toBe(false);
    const updated = await updateComputerAccessUser('pu-1', { computerAccessEnabled: true });

    expect(updated.computerAccessEnabled).toBe(true);
    expect(fetchMock.mock.calls[0]![0]).toBe('/admin/settings/computer-access');
    const [url, init] = fetchMock.mock.calls[1]!;
    expect(url).toBe('/admin/settings/computer-access/pu-1');
    expect(init?.method).toBe('PATCH');
    expect(JSON.parse(String(init?.body))).toEqual({ computerAccessEnabled: true });
  });

  it('exposes devAuthEnabled from the auth config (default false when absent)', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ devAuthEnabled: true }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const config = await getAuthConfig();
    expect(config.devAuthEnabled).toBe(true);

    fetchMock.mockResolvedValueOnce(jsonResponse({}));
    const fallback = await getAuthConfig();
    expect(fallback.devAuthEnabled).toBe(false);
  });

  it('exposes personalMode from the auth config (default false when absent)', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ personalMode: true }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const config = await getAuthConfig();
    expect(config.personalMode).toBe(true);

    fetchMock.mockResolvedValueOnce(jsonResponse({ devAuthEnabled: true }));
    const fallback = await getAuthConfig();
    expect(fallback.personalMode).toBe(false);
  });

  it('POSTs the chosen identity to /admin/auth/dev-login', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ role: 'user', devAuth: true }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const ok = await devLogin('alice', 'Alice Dev');
    expect(ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/admin/auth/dev-login');
    expect(init?.method).toBe('POST');
    expect(init?.credentials).toBe('include');
    expect(JSON.parse(String(init?.body))).toEqual({ sub: 'alice', name: 'Alice Dev' });
  });

  it('omits an empty dev-login name', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ role: 'user', devAuth: true }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await devLogin('bob', '   ');
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toEqual({ sub: 'bob' });
  });

  it('URL-encodes the binding id when unbinding a bot', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ id: 'bind 1', status: 'inactive' }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await unbindBot('bind 1/../x');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/admin/bot-bindings/bind%201%2F..%2Fx');
    expect(init?.method).toBe('DELETE');
  });

  it('POSTs to the encoded machine disconnect endpoint', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ id: 'm 1', status: 'offline' }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await disconnectMachine('m 1');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/admin/machines/m%201/disconnect');
    expect(init?.method).toBe('POST');
  });

  it('surfaces a timeout error instead of hanging when the request times out', async () => {
    const fetchMock = vi.fn(async () => {
      throw new DOMException('The operation timed out.', 'TimeoutError');
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(getMe()).rejects.toThrow(/timed out/i);
  });

  it('passes an abort signal to fetch so requests are bounded', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return jsonResponse({ id: 'pu-1', role: 'user' });
    });
    vi.stubGlobal('fetch', fetchMock);
    await getMe();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('loads console data without fetching the removed standalone task board view', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/admin/task-boards')) {
        throw new Error(`Unexpected task board request: ${url}`);
      }
      const bodyByUrl: Record<string, unknown> = {
        '/admin/summary': {
          profiles: 0,
          agents: 0,
          activeAgents: 0,
          feishuApps: 0,
          enabledFeishuApps: 0,
          botBindings: 0,
          chats: 0,
          taskBoards: 0,
          machines: 0,
          onlineMachines: 0,
        },
        '/admin/profiles': [],
        '/admin/agents': [],
        '/admin/feishu-apps': [],
        '/admin/chats': [],
        '/admin/machines': [],
      };
      return jsonResponse(bodyByUrl[url] ?? {});
    });
    vi.stubGlobal('fetch', fetchMock);

    const data = await loadConsoleData();

    expect(data.summary.taskBoards).toBe(0);
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      '/admin/summary',
      '/admin/profiles',
      '/admin/agents',
      '/admin/feishu-apps',
      '/admin/chats',
      '/admin/machines',
    ]);
  });
});
