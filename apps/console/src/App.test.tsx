import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import type { Me } from './api';

const now = '2026-06-06T00:00:00.000Z';

const fixtures = {
  '/admin/auth/config': {
    devAuthEnabled: false,
    serverPublicUrl: 'http://10.37.206.226:3001',
    daemonVersion: '0.1.0',
  },
  '/admin/me': {
    id: 'pu-1',
    email: 'ops@example.com',
    displayName: 'Ops Admin',
    role: 'superadmin',
    computerAccessEnabled: true,
    tokenAdmin: false,
  },
  '/admin/settings/computer-access': [
    {
      id: 'pu-2',
      email: 'alice@example.com',
      displayName: 'Alice',
      role: 'user',
      computerAccessEnabled: false,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'pu-1',
      email: 'ops@example.com',
      displayName: 'Ops Admin',
      role: 'superadmin',
      computerAccessEnabled: true,
      createdAt: now,
      updatedAt: now,
    },
  ],
  '/admin/summary': {
    profiles: 1,
    agents: 1,
    activeAgents: 1,
    feishuApps: 1,
    enabledFeishuApps: 1,
    botBindings: 0,
    chats: 1,
    taskBoards: 1,
    machines: 2,
    onlineMachines: 1,
  },
  '/admin/machines': [
    {
      id: 'machine-1',
      name: 'studio-mbp',
      status: 'online',
      ownerOpenId: 'ou_owner_1234567890',
      lastSeenAt: now,
      runtimes: ['claude_code', 'codex'],
      createdAt: now,
    },
    {
      id: 'machine-2',
      name: 'old-laptop',
      status: 'offline',
      ownerOpenId: 'ou_owner_1234567890',
      lastSeenAt: null,
      runtimes: ['codex'],
      createdAt: now,
    },
  ],
  '/admin/agents': [
    {
      id: 'agent-1',
      tenantKey: 'default',
      scopeType: 'system',
      scopeId: 'default',
      handle: 'reviewer',
      displayName: 'Reviewer',
      description: null,
      profileId: 'profile-1',
      profile: { id: 'profile-1', name: 'reviewer', displayName: 'Reviewer', status: 'active' },
      platformOwnerId: 'pu-2',
      platformOwner: { id: 'pu-2', email: 'alice@example.com', displayName: 'Alice' },
      machineId: 'machine-1',
      machine: { id: 'machine-1', name: 'studio-mbp', status: 'online' },
      visibility: 'public',
      defaultRuntime: 'codex',
      defaultWorkDir: null,
      // EXISTING_FLAG plus stored per-agent Claude secrets (the API returns only
      // key names, never values) so credential-clearing edits can be exercised.
      runtimeEnvKeys: ['EXISTING_FLAG', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY'],
      memoryEnabled: true,
      status: 'active',
      binding: null,
    },
  ],
  '/admin/profiles': [
    {
      id: 'profile-1',
      name: 'reviewer',
      displayName: 'Reviewer',
      description: null,
      systemPrompt: 'Review code for correctness.',
      stylePrompt: 'Be concise.',
      skillRefs: ['code-review'],
      defaultRuntime: 'codex',
      defaultModel: null,
      sourceType: 'console',
      sourceUri: null,
      status: 'active',
    },
  ],
  '/admin/feishu-apps': [
    {
      id: 'app-1',
      tenantKey: 'default',
      appId: 'cli_reviewer',
      appSecretRef: 'FEISHU_REVIEWER_APP_SECRET',
      hasStoredSecret: false,
      botOpenId: 'ou_bot',
      botName: 'Reviewer Bot',
      eventMode: 'websocket',
      status: 'enabled',
      platformOwnerId: 'pu-2',
      platformOwner: { id: 'pu-2', email: 'alice@example.com', displayName: 'Alice' },
      binding: null,
    },
  ],
  '/admin/chats': [
    {
      tenantKey: 'default',
      chatId: 'oc_test',
      displayName: 'Engineering',
      openFeishuUrl: 'https://applink.feishu.cn/client/chat/open?openChatId=oc_test',
      defaultWorkDir: null,
      defaultRuntime: null,
      defaultAgentId: null,
      defaultAgent: null,
      defaultMachineId: null,
      defaultMachineName: null,
      memoryEnabled: false,
      memorySummaryNextRunAt: null,
      memorySummaryLastRunAt: null,
      memorySummaryLastStatus: null,
      memorySummaryLastError: null,
      agents: [
        {
          id: 'agent-1',
          handle: 'reviewer',
          displayName: 'Reviewer',
          status: 'active',
          taskCount: 2,
          lastTaskAt: now,
        },
      ],
      taskBoard: {
        id: 'board-1',
        name: 'Engineering任务看板',
        tasklistGuid: 'tl_test',
        openTasklistUrl: 'https://applink.feishu.cn/client/todo/task_list?guid=tl_test',
        taskCount: 1,
      },
      taskCount: 2,
      lastTaskAt: now,
    },
  ],
};

let fetchMock: ReturnType<typeof vi.fn>;
let oneClickRegistrationPollMode: 'completed' | 'missing';
let syncMetadataMode: 'success' | 'fail';
let feishuAppsState: typeof fixtures['/admin/feishu-apps'];

beforeEach(() => {
  oneClickRegistrationPollMode = 'completed';
  syncMetadataMode = 'success';
  feishuAppsState = JSON.parse(JSON.stringify(fixtures['/admin/feishu-apps']));
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url === '/admin/agents' && init?.method === 'POST') {
      const payload = JSON.parse(String(init.body));
      const { runtimeEnv, ...agentPayload } = payload;
      return new Response(
        JSON.stringify({
          ...fixtures['/admin/agents'][0],
          id: 'agent-new',
          profileId: 'profile-new',
          profile: {
            id: 'profile-new',
            name: 'triage-agent',
            displayName: payload.profile?.displayName ?? payload.displayName,
            status: 'active',
          },
          ...agentPayload,
          runtimeEnvKeys: Object.keys(runtimeEnv ?? {}).sort(),
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }

    if (url.startsWith('/admin/agents/') && init?.method === 'PATCH') {
      const payload = JSON.parse(String(init.body));
      const runtimeEnvKeys =
        'runtimeEnv' in payload ? Object.keys(payload.runtimeEnv ?? {}).sort() : ['EXISTING_FLAG'];
      return new Response(
        JSON.stringify({
          ...fixtures['/admin/agents'][0],
          ...payload,
          runtimeEnvKeys,
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }

    if (url === '/admin/agents/agent-1' && init?.method === 'DELETE') {
      return new Response(JSON.stringify(fixtures['/admin/agents'][0]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url === '/admin/feishu-apps' && init?.method === 'POST') {
      const payload = JSON.parse(String(init.body));
      return new Response(
        JSON.stringify({
          id: 'app-new',
          tenantKey: 'default',
          ...payload,
          appSecretRef: payload.appSecretRef ?? 'stored',
          hasStoredSecret: Boolean(payload.appSecret),
          botOpenId: payload.botOpenId ?? null,
          botName: payload.botName ?? null,
          eventMode: 'websocket',
          status: 'enabled',
          binding: null,
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }

    if (url === '/admin/feishu-apps/app-1' && init?.method === 'PATCH') {
      const payload = JSON.parse(String(init.body));
      feishuAppsState = feishuAppsState.map((app) =>
        app.id === 'app-1' ? { ...app, botName: payload.botName ?? null } : app,
      );
      return new Response(JSON.stringify(feishuAppsState[0]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url === '/admin/feishu-apps/app-1/sync-metadata' && init?.method === 'POST') {
      if (syncMetadataMode === 'fail') {
        return new Response(JSON.stringify({ error: 'Feishu app metadata sync failed' }), {
          status: 502,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      feishuAppsState = feishuAppsState.map((app) =>
        app.id === 'app-1' ? { ...app, botName: 'Synced Reviewer Bot' } : app,
      );
      return new Response(JSON.stringify(feishuAppsState[0]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url === '/admin/feishu-apps/one-click-registration' && init?.method === 'POST') {
      return new Response(
        JSON.stringify({
          id: '00000000-0000-4000-8000-0000000000f1',
          status: 'pending',
          verificationUrl: 'https://open.feishu.cn/page/launcher?user_code=one-click',
          expireIn: 600,
          expiresAt: '2026-06-06T00:10:00.000Z',
          app: null,
          error: null,
          sdkStatus: null,
          createdAt: now,
          updatedAt: now,
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }

    if (url === '/admin/feishu-apps/one-click-registration/00000000-0000-4000-8000-0000000000f1') {
      if (oneClickRegistrationPollMode === 'missing' && init?.method !== 'DELETE') {
        return new Response(JSON.stringify({ error: 'Feishu app registration not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({
          id: '00000000-0000-4000-8000-0000000000f1',
          status: init?.method === 'DELETE' ? 'cancelled' : 'completed',
          verificationUrl: 'https://open.feishu.cn/page/launcher?user_code=one-click',
          expireIn: 600,
          expiresAt: '2026-06-06T00:10:00.000Z',
          app:
            init?.method === 'DELETE'
              ? null
              : {
                  ...fixtures['/admin/feishu-apps'][0],
                  id: 'app-one-click',
                  appId: 'cli_one_click',
                  appSecretRef: 'stored',
                  hasStoredSecret: true,
                  botName: 'OpenClaudeTag Bot',
                },
          error: init?.method === 'DELETE' ? 'Registration cancelled' : null,
          sdkStatus: 'polling',
          createdAt: now,
          updatedAt: now,
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }

    if (url === '/admin/feishu-apps/app-1' && init?.method === 'DELETE') {
      return new Response(JSON.stringify(fixtures['/admin/feishu-apps'][0]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.startsWith('/admin/chats/') && init?.method === 'PATCH') {
      const payload = JSON.parse(String(init.body));
      return new Response(
        JSON.stringify({
          ...fixtures['/admin/chats'][0],
          defaultMachineId: payload.defaultMachineId ?? null,
          defaultMachineName: payload.defaultMachineId === 'machine-1' ? 'studio-mbp' : null,
          memoryEnabled: payload.memoryEnabled ?? fixtures['/admin/chats'][0].memoryEnabled,
          memorySummaryNextRunAt:
            payload.memoryEnabled === true ? '2026-06-06T01:30:00.000Z' : null,
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }

    if (url === '/admin/feishu-apps/app-1/permission-check' && init?.method === 'POST') {
      return new Response(
        JSON.stringify({
          feishuAppId: 'app-1',
          appId: 'cli_reviewer',
          checkedAt: now,
          status: 'pass',
          grantedScopes: ['im:message:send_as_bot'],
          inventoryScopes: ['im:message:send_as_bot', 'im:message.group_msg:readonly'],
          extraGrantedScopes: [],
          missingRequiredCapabilities: [],
          optionalMissingCapabilities: ['read-group-message'],
          capabilities: [
            {
              id: 'send-message-as-bot',
              label: 'Send and reply as bot',
              severity: 'required',
              status: 'ok',
              groups: [
                {
                  anyOf: ['im:message:send_as_bot'],
                  satisfiedBy: 'im:message:send_as_bot',
                },
              ],
            },
            {
              id: 'read-group-message',
              label: 'Read non-@ group message content',
              severity: 'optional',
              status: 'optional_missing',
              groups: [
                {
                  anyOf: ['im:message.group_msg:readonly'],
                  satisfiedBy: null,
                },
              ],
            },
          ],
          notes: ['Scope check only'],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }

    if (url === '/admin/feishu-apps/app-1/permission-apply' && init?.method === 'POST') {
      return new Response(
        JSON.stringify({
          feishuAppId: 'app-1',
          appId: 'cli_reviewer',
          submittedAt: now,
          submitted: true,
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }

    if (url === '/admin/machines/pairing-token' && init?.method === 'POST') {
      return new Response(
        JSON.stringify({
          token: 'pair-tok-abc123xyz',
          expiresAt: now,
          machineName: null,
          connectCommand:
            'npx @open-tag/daemon@latest --server-url http://10.37.206.226:3001 --token pair-tok-abc123xyz --background',
          serverConfigured: true,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    if (url.startsWith('/admin/settings/computer-access/') && init?.method === 'PATCH') {
      const payload = JSON.parse(String(init.body));
      return new Response(
        JSON.stringify({
          ...fixtures['/admin/settings/computer-access'][0],
          id: url.split('/').at(-1),
          computerAccessEnabled: payload.computerAccessEnabled,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    if (/^\/admin\/machines\/[^/]+\/disconnect$/.test(url) && init?.method === 'POST') {
      const id = url.split('/').at(-2);
      // machine-2 simulates a server-side failure so the error-UI path is testable.
      if (id === 'machine-2') {
        return new Response(JSON.stringify({ ok: false, error: 'Machine is offline' }), {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const machine = fixtures['/admin/machines'].find((m) => m.id === id);
      return new Response(JSON.stringify({ ...machine, status: 'offline' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const body =
      url === '/admin/feishu-apps'
        ? feishuAppsState
        : fixtures[url as keyof typeof fixtures] ?? {};
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(window, 'openClaudeTagDesktop');
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe('OpenClaudeTag Console', () => {
  it('keeps the console navigation focused on operational sections', async () => {
    render(<App />);

    const navigation = await screen.findByRole('navigation', { name: 'Console sections' });
    expect(within(navigation).getAllByRole('button').map((button) => button.textContent)).toEqual([
      'Overview',
      'Agents',
      'Bots',
      'Chats',
      'Machines',
      'Settings',
    ]);

    expect(within(navigation).queryByRole('button', { name: /Project Guide/i })).toBeNull();
    expect(within(navigation).queryByRole('button', { name: /Release Notes/i })).toBeNull();
    expect(within(navigation).queryByRole('button', { name: /Downloads/i })).toBeNull();
    expect(within(navigation).queryByRole('button', { name: /Task Boards/i })).toBeNull();
  });

  it('switches the whole console chrome and pages to Chinese', async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: '中文' }));

    expect(screen.queryByRole('button', { name: '项目手册' })).toBeNull();
    expect(screen.queryByRole('button', { name: '更新日志' })).toBeNull();
    expect(screen.queryByRole('button', { name: '下载' })).toBeNull();
    expect(screen.queryByText('本地服务')).not.toBeInTheDocument();
    expect(screen.getByText('面向飞书群协作的 AI 工程工作台。')).toBeInTheDocument();
    expect(screen.queryByText('用户指南')).not.toBeInTheDocument();
    expect(screen.queryByText('1. 绑定机器')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '会话' }));
    expect(await screen.findByText('打开飞书')).toBeInTheDocument();
    expect(screen.getByText('2 个任务')).toBeInTheDocument();
  });

  it('does not render a theme toggle', async () => {
    const { container } = render(<App />);

    await screen.findByRole('button', { name: 'EN' });

    expect(container.querySelector('.shell')).not.toHaveAttribute('data-theme');
    expect(screen.queryByRole('button', { name: 'Theme' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '主题' })).not.toBeInTheDocument();
  });

  it('does not expose community marketing links from the console sidebar', async () => {
    render(<App />);

    expect(await screen.findByText('OpenClaudeTag')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /user group/i })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '中文' }));
    expect(screen.queryByRole('link', { name: /用户群/ })).toBeNull();
  });

  it('omits the manual Refresh button from the sidebar', async () => {
    render(<App />);
    await screen.findByRole('navigation', { name: 'Console sections' });
    expect(screen.queryByRole('button', { name: /^Refresh$/i })).toBeNull();
  });

  it('renders overview counts from the admin API', async () => {
    const { container } = render(<App />);

    expect(await screen.findByText('OpenClaudeTag')).toBeInTheDocument();
    expect(
      await screen.findByText('A Feishu-native workspace for AI engineering collaboration.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('User Guide')).not.toBeInTheDocument();
    expect(screen.queryByText('1. Bind a machine')).not.toBeInTheDocument();
    expect(screen.queryByText('2. Create an agent')).not.toBeInTheDocument();
    expect(screen.queryByText('3. Connect a Feishu bot')).not.toBeInTheDocument();
    expect(screen.queryByText('4. Collaborate in Feishu groups')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByText('Agents').length).toBeGreaterThan(0));
    expect(screen.getAllByText('Feishu Apps').length).toBeGreaterThan(0);
    expect(screen.queryByText('Objects')).not.toBeInTheDocument();
    expect(screen.queryByText('Bot Bindings')).not.toBeInTheDocument();
    expect(screen.queryByText(/task boards/i)).not.toBeInTheDocument();
    expect(screen.queryByText('First Agent')).not.toBeInTheDocument();
    expect(screen.queryByText('Reviewer')).not.toBeInTheDocument();
    expect(container.querySelector('.overview-hero-copy')).toBeInTheDocument();
    expect(container.querySelector('.overview-status-meter span')).toHaveStyle({ width: '50%' });
  });

  it('starts one-click Feishu bot setup from the overview page', async () => {
    render(<App />);

    expect(await screen.findByText('Feishu Bot Setup')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Bot Name'), {
      target: { value: 'Reviewer Platform Bot' },
    });
    fireEvent.click(
      await screen.findByRole('button', { name: /Apply Bot And Scopes/i }),
    );

    const startCall = await waitFor(() =>
      fetchMock.mock.calls.find(
        ([input, init]) =>
          input === '/admin/feishu-apps/one-click-registration' &&
          (init as RequestInit | undefined)?.method === 'POST',
      ),
    );
    expect(startCall).toBeDefined();
    expect(JSON.parse(String((startCall?.[1] as RequestInit | undefined)?.body))).toEqual({
      botName: 'Reviewer Platform Bot',
      description: 'OpenClaudeTag AI engineering assistant for Feishu collaboration',
    });
    const openLink = await screen.findByRole('link', { name: /Open Feishu/i });
    expect(openLink).toHaveAttribute(
      'href',
      'https://open.feishu.cn/page/launcher?user_code=one-click',
    );
    expect(screen.getByText('Waiting for scan confirmation')).toBeInTheDocument();
  });

  it('prevents concurrent one-click Feishu bot setup starts', async () => {
    render(<App />);

    const startButton = await screen.findByRole('button', { name: /Apply Bot And Scopes/i });
    fireEvent.click(startButton);
    fireEvent.click(startButton);

    await screen.findByText('Waiting for scan confirmation');
    const startCalls = fetchMock.mock.calls.filter(
      ([input, init]) =>
        input === '/admin/feishu-apps/one-click-registration' &&
        (init as RequestInit | undefined)?.method === 'POST',
    );
    expect(startCalls).toHaveLength(1);
  });

  it('polls one-click Feishu bot setup to completion from the overview page', async () => {
    render(<App />);

    fireEvent.click(
      await screen.findByRole('button', { name: /Apply Bot And Scopes/i }),
    );
    await screen.findByText('Waiting for scan confirmation');

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([input, init]) =>
            input ===
              '/admin/feishu-apps/one-click-registration/00000000-0000-4000-8000-0000000000f1' &&
            (init as RequestInit | undefined)?.method !== 'DELETE',
        ),
      ).toBe(true),
      { timeout: 2500 },
    );
    expect(await screen.findByText('Bot app registered')).toBeInTheDocument();
    expect(screen.getByText('Registered app: cli_one_click')).toBeInTheDocument();
    await waitFor(
      () =>
        expect(
          fetchMock.mock.calls.filter(([input]) => input === '/admin/summary').length,
        ).toBeGreaterThan(1),
      { timeout: 2500 },
    );
    expect(screen.getByText('Bot app registered')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Open Bots/i }));
    expect(await screen.findByText('Feishu Apps')).toBeInTheDocument();
  });

  it('allows retry when one-click Feishu bot setup polling loses the session', async () => {
    oneClickRegistrationPollMode = 'missing';
    render(<App />);

    fireEvent.click(
      await screen.findByRole('button', { name: /Apply Bot And Scopes/i }),
    );

    await waitFor(() => expect(screen.getByText('Registration failed')).toBeInTheDocument(), {
      timeout: 2500,
    });
    expect(screen.getByText('Feishu app registration not found')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Retry/i })).toBeEnabled();
  });

  it('saves the desktop API URL through the Electron bridge', async () => {
    const bridge = {
      getConfig: vi.fn(async () => ({
        apiUrl: 'http://127.0.0.1:3000',
        configPath:
          '/Users/test/Library/Application Support/OpenClaudeTag Console/desktop-config.json',
        defaultApiUrl: 'http://127.0.0.1:3000',
        source: 'default' as const,
      })),
      resetApiUrl: vi.fn(),
      setApiUrl: vi.fn(async (apiUrl: string) => ({
        apiUrl,
        configPath:
          '/Users/test/Library/Application Support/OpenClaudeTag Console/desktop-config.json',
        defaultApiUrl: 'http://127.0.0.1:3000',
        source: 'saved' as const,
      })),
    };
    Object.defineProperty(window, 'openClaudeTagDesktop', {
      configurable: true,
      value: bridge,
    });

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /Settings/i }));
    expect(await screen.findByDisplayValue('http://127.0.0.1:3000')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('API Server'), {
      target: { value: 'http://127.0.0.1:51670' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => expect(bridge.setApiUrl).toHaveBeenCalledWith('http://127.0.0.1:51670'));
    expect(await screen.findByText('API URL saved')).toBeInTheDocument();
  });

  it('validates the desktop API URL before saving it', async () => {
    const bridge = {
      getConfig: vi.fn(async () => ({
        apiUrl: 'http://127.0.0.1:3000',
        configPath:
          '/Users/test/Library/Application Support/OpenClaudeTag Console/desktop-config.json',
        defaultApiUrl: 'http://127.0.0.1:3000',
        source: 'default' as const,
      })),
      resetApiUrl: vi.fn(),
      setApiUrl: vi.fn(),
    };
    Object.defineProperty(window, 'openClaudeTagDesktop', {
      configurable: true,
      value: bridge,
    });

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /Settings/i }));
    fireEvent.change(await screen.findByLabelText('API Server'), {
      target: { value: 'ftp://127.0.0.1:3000' },
    });

    expect(screen.getByText('Enter a valid HTTP(S) URL.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Save$/i })).toBeDisabled();
    expect(bridge.setApiUrl).not.toHaveBeenCalled();
  });

  it('shows chat and task board Feishu jump actions', async () => {
    render(<App />);

    const navigation = await screen.findByRole('navigation', { name: 'Console sections' });
    expect(within(navigation).queryByRole('button', { name: /Task Boards/i })).toBeNull();

    fireEvent.click(await screen.findByRole('button', { name: /Chats/i }));
    expect(await screen.findByText('Engineering')).toBeInTheDocument();
    // The chat agent pill shows the display name and status (handle is gone).
    expect(screen.getByText('Reviewer')).toBeInTheDocument();
    expect(screen.getByText('active')).toBeInTheDocument();
    expect(screen.queryByText('Default agent')).not.toBeInTheDocument();
    expect(screen.getByText(/Engineering任务看板/)).toBeInTheDocument();
    const openLink = await screen.findByRole('link', { name: /Open Feishu/i });
    const boardLink = await screen.findByRole('link', { name: /Board/i });

    expect(openLink).toHaveAttribute(
      'href',
      'https://applink.feishu.cn/client/chat/open?openChatId=oc_test',
    );
    expect(boardLink).toHaveAttribute(
      'href',
      'https://applink.feishu.cn/client/todo/task_list?guid=tl_test',
    );
  });

  it('omits empty optional bot fields when registering a Feishu app', async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /Bots/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Register Feishu App/i }));

    const dialog = await screen.findByRole('dialog', { name: /Register Feishu App/i });
    expect(within(dialog).queryByLabelText('Bot Open ID')).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText('Secret Ref')).not.toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('App ID'), {
      target: { value: 'cli_empty_optional' },
    });
    fireEvent.change(within(dialog).getByLabelText(/App Secret/), {
      target: { value: 'plain-secret-value' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: /^Register$/i }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/admin/feishu-apps',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    const postCall = fetchMock.mock.calls.find(
      ([input, init]) =>
        input === '/admin/feishu-apps' && (init as RequestInit | undefined)?.method === 'POST',
    );
    expect(postCall).toBeDefined();
    const body = JSON.parse(String((postCall?.[1] as RequestInit | undefined)?.body));
    expect(body).toEqual({
      appId: 'cli_empty_optional',
      appSecret: 'plain-secret-value',
    });
  });

  it('submits a stored secret without requiring a secret ref', async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /Bots/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Register Feishu App/i }));

    const dialog = await screen.findByRole('dialog', { name: /Register Feishu App/i });
    fireEvent.change(within(dialog).getByLabelText('App ID'), {
      target: { value: 'cli_stored_secret' },
    });
    fireEvent.change(within(dialog).getByLabelText(/App Secret/), {
      target: { value: 'plain-secret-value' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: /^Register$/i }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/admin/feishu-apps',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    const postCall = fetchMock.mock.calls.find(
      ([input, init]) =>
        input === '/admin/feishu-apps' && (init as RequestInit | undefined)?.method === 'POST',
    );
    const body = JSON.parse(String((postCall?.[1] as RequestInit | undefined)?.body));
    expect(body).toEqual({
      appId: 'cli_stored_secret',
      appSecret: 'plain-secret-value',
    });
  });

  it('requires an App Secret before registration', async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /Bots/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Register Feishu App/i }));

    const dialog = await screen.findByRole('dialog', { name: /Register Feishu App/i });
    fireEvent.change(within(dialog).getByLabelText('App ID'), {
      target: { value: 'cli_missing_secret' },
    });

    expect(within(dialog).queryByLabelText('Secret Ref')).not.toBeInTheDocument();
    expect(within(dialog).getByText('App Secret is required.')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /^Register$/i })).toBeDisabled();
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) =>
          input === '/admin/feishu-apps' &&
          (init as RequestInit | undefined)?.method === 'POST',
      ),
    ).toBe(false);
  });

  it('does not check Feishu permissions automatically when opening Bots', async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /Bots/i }));
    expect(await screen.findByText('Feishu Apps')).toBeInTheDocument();

    expect(
      fetchMock.mock.calls.some(([input]) => String(input).includes('/permission-check')),
    ).toBe(false);
  });

  it('edits a Feishu bot display name from the bot row', async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /Bots/i }));
    expect(await screen.findByText('Reviewer Bot')).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: /Edit Reviewer Bot/i }));

    const dialog = await screen.findByRole('dialog', { name: /Edit Bot Name/i });
    fireEvent.change(within(dialog).getByLabelText('Bot Name'), {
      target: { value: 'Reviewer Bot Local' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: /^Save$/i }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/admin/feishu-apps/app-1',
        expect.objectContaining({ method: 'PATCH' }),
      ),
    );
    const patchCall = fetchMock.mock.calls.find(
      ([input, init]) =>
        input === '/admin/feishu-apps/app-1' &&
        (init as RequestInit | undefined)?.method === 'PATCH',
    );
    expect(JSON.parse(String((patchCall?.[1] as RequestInit | undefined)?.body))).toEqual({
      botName: 'Reviewer Bot Local',
    });
    expect(await screen.findByText('Reviewer Bot Local')).toBeInTheDocument();
  });

  it('syncs a Feishu bot display name from the bot row', async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /Bots/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Sync Reviewer Bot/i }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/admin/feishu-apps/app-1/sync-metadata',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    expect(await screen.findByText('Synced Reviewer Bot')).toBeInTheDocument();
  });

  it('shows Feishu bot display name sync errors in the row', async () => {
    syncMetadataMode = 'fail';
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /Bots/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Sync Reviewer Bot/i }));

    expect(await screen.findByText('Feishu app metadata sync failed')).toBeInTheDocument();
    expect(screen.getByText('Reviewer Bot')).toBeInTheDocument();
  });

  it('starts one-click Feishu bot setup from the Bots page', async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /Bots/i }));
    expect(await screen.findByText('Feishu Apps')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Bot Name'), {
      target: { value: 'Bots Page Bot' },
    });
    fireEvent.click(
      await screen.findByRole('button', { name: /Apply Bot And Scopes/i }),
    );

    const startCall = await waitFor(() =>
      fetchMock.mock.calls.find(
        ([input, init]) =>
          input === '/admin/feishu-apps/one-click-registration' &&
          (init as RequestInit | undefined)?.method === 'POST',
      ),
    );
    expect(startCall).toBeDefined();
    expect(JSON.parse(String((startCall?.[1] as RequestInit | undefined)?.body))).toMatchObject({
      botName: 'Bots Page Bot',
    });
    const openLink = await screen.findByRole('link', { name: /Open Feishu/i });
    expect(openLink).toHaveAttribute(
      'href',
      'https://open.feishu.cn/page/launcher?user_code=one-click',
    );
    expect(screen.getByText('Waiting for scan confirmation')).toBeInTheDocument();
  });

  it('runs a manual Feishu permission check from the bot row', async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /Bots/i }));
    fireEvent.click(
      await screen.findByRole('button', { name: /Check permissions for Reviewer Bot/i }),
    );

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/admin/feishu-apps/app-1/permission-check',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    const request = fetchMock.mock.calls.find(
      ([input]) => input === '/admin/feishu-apps/app-1/permission-check',
    );
    const headers = (request?.[1] as RequestInit | undefined)?.headers as Headers;
    expect(headers).toBeInstanceOf(Headers);
    expect(headers.has('Content-Type')).toBe(false);
    expect(await screen.findByText('Permission check passed')).toBeInTheDocument();
    expect(screen.getByText('Optional gaps: read-group-message')).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(([input]) => input === '/admin/feishu-apps/app-1/permission-apply'),
    ).toBe(false);
    expect(screen.queryByRole('button', { name: /Request approval/i })).not.toBeInTheDocument();
  });

  it('automatically submits Feishu permission approval when the check fails', async () => {
    let permissionCheckRequests = 0;
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/admin/feishu-apps/app-1/permission-check' && init?.method === 'POST') {
        permissionCheckRequests += 1;
        const optionalScope =
          permissionCheckRequests === 1 ? 'im:message:readonly' : 'im:message.group_msg:readonly';
        return new Response(
          JSON.stringify({
            feishuAppId: 'app-1',
            appId: 'cli_reviewer',
            checkedAt: now,
            status: 'fail',
            grantedScopes: [],
            inventoryScopes: ['im:message.group_at_msg:readonly', optionalScope],
            extraGrantedScopes: [],
            missingRequiredCapabilities: ['receive-group-at-message'],
            optionalMissingCapabilities: ['read-group-message'],
            capabilities: [
              {
                id: 'receive-group-at-message',
                label: 'Receive group @bot messages',
                severity: 'required',
                status: 'missing',
                groups: [
                  {
                    anyOf: ['im:message.group_at_msg:readonly', 'im:message.group_at_msg'],
                    satisfiedBy: null,
                  },
                ],
              },
              {
                id: 'read-group-message',
                label: 'Read group messages',
                severity: 'optional',
                status: 'missing',
                groups: [
                  {
                    anyOf: [optionalScope],
                    satisfiedBy: null,
                  },
                ],
              },
            ],
            notes: [],
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }
      if (url === '/admin/feishu-apps/app-1/permission-apply' && init?.method === 'POST') {
        return new Response(
          JSON.stringify({
            feishuAppId: 'app-1',
            appId: 'cli_reviewer',
            submittedAt: now,
            submitted: true,
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }
      const body = fixtures[url as keyof typeof fixtures] ?? {};
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /Bots/i }));
    fireEvent.click(
      await screen.findByRole('button', { name: /Check permissions for Reviewer Bot/i }),
    );

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/admin/feishu-apps/app-1/permission-apply',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    const request = fetchMock.mock.calls.find(
      ([input]) => input === '/admin/feishu-apps/app-1/permission-apply',
    );
    const headers = (request?.[1] as RequestInit | undefined)?.headers as Headers;
    expect(headers).toBeInstanceOf(Headers);
    expect(headers.has('Content-Type')).toBe(false);
    expect(await screen.findByText('Missing permissions')).toBeInTheDocument();
    expect(await screen.findByText('Approval request submitted')).toBeInTheDocument();
    expect(
      screen.getByText('Missing permissions: Receive group @bot messages'),
    ).toBeInTheDocument();
    const requiredScopeList = screen.getByLabelText('Required scopes');
    expect(within(requiredScopeList).getByText('im:message.group_at_msg:readonly')).toBeInTheDocument();
    expect(screen.getByText('Optional gaps: read-group-message')).toBeInTheDocument();
    expect(requiredScopeList).not.toHaveTextContent('im:message:readonly');
    const approvalLink = screen.getByRole('link', { name: /Open Platform permissions/i });
    const approvalUrl = new URL(approvalLink.getAttribute('href') ?? '');
    expect(approvalUrl.origin).toBe('https://open.feishu.cn');
    expect(approvalUrl.pathname).toBe('/page/scope-apply');
    expect(approvalUrl.searchParams.get('clientID')).toBe('cli_reviewer');
    expect(approvalUrl.searchParams.get('scopes')).toBe('im:message.group_at_msg:readonly');
    const approvalQr = screen.getByRole('img', { name: /Open Platform permissions QR/i });
    expect(approvalQr.getAttribute('src')).toMatch(/^data:image\/svg\+xml;charset=utf-8,/);
    expect(approvalQr.getAttribute('src')).not.toContain('api.qrserver.com');
    fireEvent.click(screen.getByRole('button', { name: /Check permissions for Reviewer Bot/i }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(
          ([input]) => input === '/admin/feishu-apps/app-1/permission-check',
        ),
      ).toHaveLength(2),
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Check permissions for Reviewer Bot/i })).toBeEnabled(),
    );
    expect(
      fetchMock.mock.calls.filter(([input]) => input === '/admin/feishu-apps/app-1/permission-apply'),
    ).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /Request approval/i })).not.toBeInTheDocument();
  });

  it('renders no-pending-scope results after the automatic approval request', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/admin/feishu-apps/app-1/permission-check' && init?.method === 'POST') {
        return new Response(
          JSON.stringify({
            feishuAppId: 'app-1',
            appId: 'cli_reviewer',
            checkedAt: now,
            status: 'fail',
            grantedScopes: [],
            inventoryScopes: ['im:message.group_at_msg:readonly'],
            extraGrantedScopes: [],
            missingRequiredCapabilities: ['receive-group-at-message'],
            optionalMissingCapabilities: [],
            capabilities: [
              {
                id: 'receive-group-at-message',
                label: 'Receive group @bot messages',
                severity: 'required',
                status: 'missing',
                groups: [
                  {
                    anyOf: ['im:message.group_at_msg:readonly'],
                    satisfiedBy: null,
                  },
                ],
              },
            ],
            notes: [],
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }
      if (url === '/admin/feishu-apps/app-1/permission-apply' && init?.method === 'POST') {
        return new Response(
          JSON.stringify({
            feishuAppId: 'app-1',
            appId: 'cli_reviewer',
            submittedAt: now,
            submitted: false,
            status: 'no_pending_scopes',
            message:
              "No pending app-version scopes can be submitted for approval. Add the missing scopes to this app's permission configuration in Feishu Open Platform, publish or approve that app version, then run Check permissions again.",
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }
      const body = fixtures[url as keyof typeof fixtures] ?? {};
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /Bots/i }));
    fireEvent.click(
      await screen.findByRole('button', { name: /Check permissions for Reviewer Bot/i }),
    );

    expect(await screen.findByText('Missing permissions')).toBeInTheDocument();
    expect(screen.queryByText('Open Platform setup required')).not.toBeInTheDocument();
    expect(screen.queryByText('Approval request failed')).not.toBeInTheDocument();
    expect(
      await screen.findByText(/Add the required scopes in Feishu Open Platform/),
    ).toBeInTheDocument();
    const approvalLink = screen.getByRole('link', { name: /Open Platform permissions/i });
    const approvalUrl = new URL(approvalLink.getAttribute('href') ?? '');
    expect(approvalUrl.searchParams.get('scopes')).toBe('im:message.group_at_msg:readonly');
    expect(screen.getByRole('img', { name: /Open Platform permissions QR/i })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Check permissions for Reviewer Bot/i }),
    ).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: /Check permissions for Reviewer Bot/i }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(
          ([input]) => input === '/admin/feishu-apps/app-1/permission-check',
        ),
      ).toHaveLength(2),
    );
    expect(
      fetchMock.mock.calls.filter(([input]) => input === '/admin/feishu-apps/app-1/permission-apply'),
    ).toHaveLength(2);
  });

  it('renders Feishu task permission gaps with legal required scope names', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/admin/feishu-apps/app-1/permission-check' && init?.method === 'POST') {
        return new Response(
          JSON.stringify({
            feishuAppId: 'app-1',
            appId: 'cli_reviewer',
            checkedAt: now,
            status: 'fail',
            grantedScopes: [],
            inventoryScopes: [
              'task:custom_field:read',
              'task:custom_field:writeonly',
              'task:section:read',
              'task:section:write',
              'task:section:writeonly',
            ],
            extraGrantedScopes: [],
            missingRequiredCapabilities: ['custom-field-management', 'section-management'],
            optionalMissingCapabilities: [],
            capabilities: [
              {
                id: 'custom-field-management',
                label: 'Manage task custom fields and options',
                severity: 'required',
                status: 'missing',
                groups: [
                  { anyOf: ['task:custom_field:read'], satisfiedBy: null },
                  { anyOf: ['task:custom_field:writeonly'], satisfiedBy: null },
                ],
              },
              {
                id: 'section-management',
                label: 'Manage task sections',
                severity: 'required',
                status: 'missing',
                groups: [
                  { anyOf: ['task:section:read', 'task:section:write'], satisfiedBy: null },
                  { anyOf: ['task:section:writeonly', 'task:section:write'], satisfiedBy: null },
                ],
              },
            ],
            notes: [],
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }
      if (url === '/admin/feishu-apps/app-1/permission-apply' && init?.method === 'POST') {
        return new Response(
          JSON.stringify({
            feishuAppId: 'app-1',
            appId: 'cli_reviewer',
            submittedAt: now,
            submitted: true,
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }
      const body = fixtures[url as keyof typeof fixtures] ?? {};
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /Bots/i }));
    fireEvent.click(
      await screen.findByRole('button', { name: /Check permissions for Reviewer Bot/i }),
    );

    expect(await screen.findByText('Missing permissions')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Missing permissions: Manage task custom fields and options, Manage task sections',
      ),
    ).toBeInTheDocument();
    const renderedScopes = within(screen.getByLabelText('Required scopes'))
      .getAllByText(/^(task:custom_field|task:section)/)
      .map((scope) => scope.textContent);
    expect(renderedScopes).toEqual([
      'task:custom_field:read',
      'task:custom_field:writeonly',
      'task:section:read',
      'task:section:writeonly',
    ]);
    expect(renderedScopes).not.toContain('task:custom_field:write');
  });

  it('keeps raw Feishu permission approval errors out of the status badge', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/admin/feishu-apps/app-1/permission-check' && init?.method === 'POST') {
        return new Response(
          JSON.stringify({
            feishuAppId: 'app-1',
            appId: 'cli_reviewer',
            checkedAt: now,
            status: 'fail',
            grantedScopes: [],
            inventoryScopes: ['im:message.group_at_msg:readonly'],
            extraGrantedScopes: [],
            missingRequiredCapabilities: ['receive-group-at-message'],
            optionalMissingCapabilities: [],
            capabilities: [
              {
                id: 'receive-group-at-message',
                label: 'Receive group @bot messages',
                severity: 'required',
                status: 'missing',
                groups: [
                  {
                    anyOf: ['im:message.group_at_msg:readonly'],
                    satisfiedBy: null,
                  },
                ],
              },
            ],
            notes: [],
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }
      if (url === '/admin/feishu-apps/app-1/permission-apply' && init?.method === 'POST') {
        return new Response(
          JSON.stringify({
            error:
              'applyApplicationScopes failed: HTTP 400 {"code":212002,"msg":"unauthorized scopes were empty"}',
          }),
          {
            status: 502,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }
      const body = fixtures[url as keyof typeof fixtures] ?? {};
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /Bots/i }));
    fireEvent.click(
      await screen.findByRole('button', { name: /Check permissions for Reviewer Bot/i }),
    );

    expect(await screen.findByText('Approval request failed')).toBeInTheDocument();
    const rawError = await screen.findByText(/unauthorized scopes were empty/);
    expect(rawError).toHaveClass('permission-error');
    expect(rawError.closest('.badge')).toBeNull();
    expect(screen.getByRole('link', { name: /Open Platform permissions/i })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /Open Platform permissions QR/i })).toBeInTheDocument();
  });

  it('renders missing required Feishu permission gaps', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/admin/feishu-apps/app-1/permission-check' && init?.method === 'POST') {
        return new Response(
          JSON.stringify({
            feishuAppId: 'app-1',
            appId: 'cli_reviewer',
            checkedAt: now,
            status: 'fail',
            grantedScopes: [],
            inventoryScopes: ['im:message.group_at_msg:readonly'],
            extraGrantedScopes: [],
            missingRequiredCapabilities: ['receive-group-at-message', 'new-required-scope'],
            optionalMissingCapabilities: [],
            capabilities: [
              {
                id: 'receive-group-at-message',
                label: 'Receive group @bot messages',
                severity: 'required',
                status: 'missing',
                groups: [
                  {
                    anyOf: ['im:message.group_at_msg:readonly'],
                    satisfiedBy: null,
                  },
                ],
              },
            ],
            notes: [],
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }
      const body = fixtures[url as keyof typeof fixtures] ?? {};
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /Bots/i }));
    fireEvent.click(
      await screen.findByRole('button', { name: /Check permissions for Reviewer Bot/i }),
    );

    expect(await screen.findByText('Missing permissions')).toBeInTheDocument();
    expect(
      screen.getByText('Missing permissions: Receive group @bot messages, new-required-scope'),
    ).toBeInTheDocument();
  });

  it('renders Feishu permission check errors in the bot row', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/admin/feishu-apps/app-1/permission-check' && init?.method === 'POST') {
        return new Response(JSON.stringify({ error: 'Scope list unavailable' }), {
          status: 502,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const body = fixtures[url as keyof typeof fixtures] ?? {};
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /Bots/i }));
    fireEvent.click(
      await screen.findByRole('button', { name: /Check permissions for Reviewer Bot/i }),
    );

    expect(await screen.findByText('Scope list unavailable')).toBeInTheDocument();
  });

  it('shows unified agent controls without profile CRUD', async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /Agents/i }));

    expect(await screen.findByText('Agent Registry')).toBeInTheDocument();
    expect(screen.queryByText(/^Create Agent$/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Create Agent$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Edit Reviewer/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Save Agent/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Save Profile/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Create Profile/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Skills')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Workdir')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Visibility')).not.toBeInTheDocument();
  });

  it('deletes an agent after confirmation', async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /Agents/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Delete Reviewer/i }));

    const dialog = await screen.findByRole('dialog', { name: /Delete Agent/i });
    expect(within(dialog).getByText('Reviewer')).toBeInTheDocument();
    expect(
      within(dialog).getByText(/Active tasks may lose this agent as their execution identity/i),
    ).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: /^Delete$/i }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/admin/agents/agent-1',
        expect.objectContaining({ method: 'DELETE' }),
      ),
    );
    const deleteCall = fetchMock.mock.calls.find(
      ([input, init]) =>
        input === '/admin/agents/agent-1' && (init as RequestInit | undefined)?.method === 'DELETE',
    );
    const headers = (deleteCall?.[1] as RequestInit | undefined)?.headers as Headers;
    expect(headers.has('Content-Type')).toBe(false);
    expect(await screen.findByText('Agent deleted')).toBeInTheDocument();
  });

  it('opens agent edit controls from the agent row action', async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /Agents/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Edit Reviewer/i }));

    expect(await screen.findByRole('dialog', { name: /Edit Agent/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Save Agent/i })).toBeInTheDocument();
    // The single name field is editable now (the old read-only handle is gone).
    expect(screen.getByLabelText('Name')).not.toBeDisabled();
    expect(screen.getByLabelText('System Prompt')).toHaveValue(
      'Review code for correctness.\n\nBe concise.',
    );
    expect(screen.getByLabelText('Env')).toHaveValue('');
    expect(screen.getByText(/Configured env: EXISTING_FLAG/)).toBeInTheDocument();
    expect(screen.queryByText('EXISTING_FLAG=1')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Visibility')).not.toBeInTheDocument();
  });

  it('creates a subscription-mode Claude Code agent without credential runtimeEnv', async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /Agents/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^Create Agent$/i }));

    const dialog = await screen.findByRole('dialog', { name: /Create Agent/i });
    const runtimeSelect = within(dialog).getByLabelText('Runtime') as HTMLSelectElement;
    expect(Array.from(runtimeSelect.options).map((option) => option.value)).toEqual([
      '',
      'codex',
      'claude_code',
    ]);
    // The option is surfaced with its proper-noun brand name, not the raw value.
    expect(Array.from(runtimeSelect.options).map((option) => option.textContent)).toContain(
      'Claude Code',
    );

    // Credential fields stay hidden until claude_code is selected.
    expect(within(dialog).queryByLabelText('API Base URL')).not.toBeInTheDocument();
    fireEvent.change(runtimeSelect, { target: { value: 'claude_code' } });
    expect(within(dialog).getByRole('button', { name: /Subscription login/i })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(within(dialog).queryByLabelText('API Base URL')).not.toBeInTheDocument();

    fireEvent.change(within(dialog).getByLabelText('Name'), {
      target: { value: 'Claude Agent' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: /^Create Agent$/i }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/admin/agents',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    const postCall = fetchMock.mock.calls.find(
      ([input, init]) =>
        input === '/admin/agents' && (init as RequestInit | undefined)?.method === 'POST',
    );
    const body = JSON.parse(String((postCall?.[1] as RequestInit | undefined)?.body));
    expect(body.defaultRuntime).toBe('claude_code');
    expect(body.runtimeEnv).toEqual({});
  });

  it('serializes custom Claude Code Base URL + API Key into runtimeEnv', async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /Agents/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^Create Agent$/i }));

    const dialog = await screen.findByRole('dialog', { name: /Create Agent/i });
    fireEvent.change(within(dialog).getByLabelText('Runtime'), {
      target: { value: 'claude_code' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: /Custom credentials/i }));
    expect(within(dialog).getByLabelText('API Base URL')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('API Key')).toBeInTheDocument();

    fireEvent.change(within(dialog).getByLabelText('Name'), {
      target: { value: 'Claude Agent' },
    });
    fireEvent.change(within(dialog).getByLabelText('API Base URL'), {
      target: { value: 'https://gateway.example/v1' },
    });
    fireEvent.change(within(dialog).getByLabelText('API Key'), {
      target: { value: 'sk-secret' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: /^Create Agent$/i }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/admin/agents',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    const postCall = fetchMock.mock.calls.find(
      ([input, init]) =>
        input === '/admin/agents' && (init as RequestInit | undefined)?.method === 'POST',
    );
    const body = JSON.parse(String((postCall?.[1] as RequestInit | undefined)?.body));
    expect(body.defaultRuntime).toBe('claude_code');
    expect(body.runtimeEnv).toMatchObject({
      ANTHROPIC_BASE_URL: 'https://gateway.example/v1',
      ANTHROPIC_API_KEY: 'sk-secret',
    });
  });

  it('requires both Base URL and API Key when creating custom-credential claude_code agent', async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /Agents/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^Create Agent$/i }));

    const dialog = await screen.findByRole('dialog', { name: /Create Agent/i });
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Claude Agent' } });
    fireEvent.change(within(dialog).getByLabelText('Runtime'), {
      target: { value: 'claude_code' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: /Custom credentials/i }));
    // Only Base URL filled; API Key missing -> submit must stay blocked.
    fireEvent.change(within(dialog).getByLabelText('API Base URL'), {
      target: { value: 'https://gw.example' },
    });
    expect(within(dialog).getByRole('button', { name: /^Create Agent$/i })).toBeDisabled();
  });

  it('blocks a claude_code credential edit that fills only one of Base URL / API Key', async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /Agents/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Edit Reviewer/i }));

    const dialog = await screen.findByRole('dialog', { name: /Edit Agent/i });
    fireEvent.change(within(dialog).getByLabelText('Runtime'), {
      target: { value: 'claude_code' },
    });
    expect(within(dialog).getByRole('button', { name: /Custom credentials/i })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // Filling only the API Key would wholesale-replace runtimeEnv and drop the
    // stored Base URL, so the edit must be blocked until both are supplied.
    fireEvent.change(within(dialog).getByLabelText('API Key'), { target: { value: 'sk-new' } });
    expect(within(dialog).getByRole('button', { name: /Save Agent/i })).toBeDisabled();
  });

  it('blocks an Env edit that would drop existing Claude secrets, unblocks on re-entry', async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /Agents/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Edit Reviewer/i }));

    const dialog = await screen.findByRole('dialog', { name: /Edit Agent/i });
    fireEvent.change(within(dialog).getByLabelText('Runtime'), {
      target: { value: 'claude_code' },
    });
    expect(within(dialog).getByRole('button', { name: /Custom credentials/i })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // The agent already has stored ANTHROPIC_* secrets the API never echoes
    // back. Editing the Env textarea replaces runtimeEnv wholesale, which would
    // silently drop those secrets — so Save must be blocked while the Claude
    // fields are blank, until both Base URL and API Key are re-entered.
    fireEvent.change(within(dialog).getByLabelText('Env'), { target: { value: 'FOO=bar' } });
    expect(within(dialog).getByRole('button', { name: /Save Agent/i })).toBeDisabled();

    fireEvent.change(within(dialog).getByLabelText('API Base URL'), {
      target: { value: 'https://gw.example' },
    });
    fireEvent.change(within(dialog).getByLabelText('API Key'), { target: { value: 'sk-new' } });
    expect(within(dialog).getByRole('button', { name: /Save Agent/i })).toBeEnabled();
  });

  it('keeps existing agent env when the edit Env field is left blank', async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /Agents/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Edit Reviewer/i }));

    const dialog = await screen.findByRole('dialog', { name: /Edit Agent/i });
    fireEvent.change(within(dialog).getByLabelText('Name'), {
      target: { value: 'Reviewer v2' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: /Save Agent/i }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/admin/agents/agent-1',
        expect.objectContaining({ method: 'PATCH' }),
      ),
    );
    const patchCall = fetchMock.mock.calls.find(
      ([input, init]) =>
        input === '/admin/agents/agent-1' && (init as RequestInit | undefined)?.method === 'PATCH',
    );
    const body = JSON.parse(String((patchCall?.[1] as RequestInit | undefined)?.body));
    expect(body).not.toHaveProperty('runtimeEnv');
  });

  it('switches existing custom Claude credentials to subscription mode by clearing env', async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /Agents/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Edit Reviewer/i }));

    const dialog = await screen.findByRole('dialog', { name: /Edit Agent/i });
    fireEvent.change(within(dialog).getByLabelText('Runtime'), {
      target: { value: 'claude_code' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: /Subscription login/i }));
    fireEvent.click(within(dialog).getByRole('button', { name: /Save Agent/i }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/admin/agents/agent-1',
        expect.objectContaining({ method: 'PATCH' }),
      ),
    );
    const patchCall = fetchMock.mock.calls.find(
      ([input, init]) =>
        input === '/admin/agents/agent-1' && (init as RequestInit | undefined)?.method === 'PATCH',
    );
    const body = JSON.parse(String((patchCall?.[1] as RequestInit | undefined)?.body));
    expect(body.runtimeEnv).toEqual({});
  });

  it('clears configured agent env when requested', async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /Agents/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Edit Reviewer/i }));

    const dialog = await screen.findByRole('dialog', { name: /Edit Agent/i });
    fireEvent.click(within(dialog).getByLabelText('Clear configured env'));
    fireEvent.click(within(dialog).getByRole('button', { name: /Save Agent/i }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/admin/agents/agent-1',
        expect.objectContaining({ method: 'PATCH' }),
      ),
    );
    const patchCall = fetchMock.mock.calls.find(
      ([input, init]) =>
        input === '/admin/agents/agent-1' && (init as RequestInit | undefined)?.method === 'PATCH',
    );
    const body = JSON.parse(String((patchCall?.[1] as RequestInit | undefined)?.body));
    expect(body.runtimeEnv).toEqual({});
  });

  it('toggles agent long-term memory off through the edit form', async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /Agents/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Edit Reviewer/i }));

    const dialog = await screen.findByRole('dialog', { name: /Edit Agent/i });
    const memoryToggle = within(dialog).getByLabelText(/Enable long-term memory/);
    expect(memoryToggle).toBeChecked();
    fireEvent.click(memoryToggle);
    fireEvent.click(within(dialog).getByRole('button', { name: /Save Agent/i }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/admin/agents/agent-1',
        expect.objectContaining({ method: 'PATCH' }),
      ),
    );
    const patchCall = fetchMock.mock.calls.find(
      ([input, init]) =>
        input === '/admin/agents/agent-1' && (init as RequestInit | undefined)?.method === 'PATCH',
    );
    const body = JSON.parse(String((patchCall?.[1] as RequestInit | undefined)?.body));
    expect(body.memoryEnabled).toBe(false);
  });

  it('creates an agent from a single name while profile stays internal', async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /Agents/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^Create Agent$/i }));

    const dialog = await screen.findByRole('dialog', { name: /Create Agent/i });
    fireEvent.change(within(dialog).getByLabelText('Name'), {
      target: { value: 'Triage Agent' },
    });
    const promptField = within(dialog).getByLabelText('System Prompt');
    expect(promptField).toHaveAttribute(
      'placeholder',
      'You are a strict code reviewer, be concise and focus on bugs.',
    );
    fireEvent.change(promptField, {
      target: { value: 'Triage incoming bugs.' },
    });
    fireEvent.change(within(dialog).getByLabelText('Env'), {
      target: { value: 'a=b\nFEATURE_FLAG=enabled' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: /^Create Agent$/i }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/admin/agents',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    const postCall = fetchMock.mock.calls.find(
      ([input, init]) =>
        input === '/admin/agents' && (init as RequestInit | undefined)?.method === 'POST',
    );
    const body = JSON.parse(String((postCall?.[1] as RequestInit | undefined)?.body));
    expect(body).toMatchObject({
      displayName: 'Triage Agent',
      profile: {
        displayName: 'Triage Agent',
        systemPrompt: 'Triage incoming bugs.',
        stylePrompt: null,
      },
      runtimeEnv: {
        a: 'b',
        FEATURE_FLAG: 'enabled',
      },
    });
    expect(body).not.toHaveProperty('profileId');
    expect(body).not.toHaveProperty('visibility');
    expect(body).not.toHaveProperty('defaultWorkDir');
    expect(body.profile).not.toHaveProperty('skillRefs');

    expect(await screen.findByText('Agent created')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Bots/i }));
    expect(screen.queryByText('Agent created')).not.toBeInTheDocument();
  });

  it('validates required agent fields before creating an agent', async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /Agents/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^Create Agent$/i }));

    const dialog = await screen.findByRole('dialog', { name: /Create Agent/i });
    fireEvent.change(within(dialog).getByLabelText('Name'), {
      target: { value: '   ' },
    });

    expect(within(dialog).getByText('Name is required.')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /^Create Agent$/i })).toBeDisabled();
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) =>
          input === '/admin/agents' && (init as RequestInit | undefined)?.method === 'POST',
      ),
    ).toBe(false);
  });

  it('offers a machine selector (server-local + owner machines) in the agent create form (D-A8)', async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /Agents/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^Create Agent$/i }));

    const dialog = await screen.findByRole('dialog', { name: /Create Agent/i });
    const machineSelect = within(dialog).getByLabelText('Machine') as HTMLSelectElement;
    const optionLabels = Array.from(machineSelect.options).map((option) => option.textContent);
    // Server-local default + the two non-revoked owner machines, with status.
    expect(machineSelect.value).toBe('');
    expect(optionLabels).toEqual(
      expect.arrayContaining([
        'Server-local',
        expect.stringContaining('studio-mbp'),
        expect.stringContaining('old-laptop'),
      ]),
    );
  });

  it('forwards the chosen machine when creating an agent (D-A8)', async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /Agents/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^Create Agent$/i }));

    const dialog = await screen.findByRole('dialog', { name: /Create Agent/i });
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Triage Agent' } });
    fireEvent.change(within(dialog).getByLabelText('Machine'), { target: { value: 'machine-1' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /^Create Agent$/i }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/admin/agents',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    const postCall = fetchMock.mock.calls.find(
      ([input, init]) =>
        input === '/admin/agents' && (init as RequestInit | undefined)?.method === 'POST',
    );
    const body = JSON.parse(String((postCall?.[1] as RequestInit | undefined)?.body));
    expect(body.machineId).toBe('machine-1');
  });

  it('groups agents by machine with a section header per machine (D-A8)', async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /Agents/i }));
    expect(await screen.findByText('Agent Registry')).toBeInTheDocument();

    // The fixture agent is bound to machine-1 (studio-mbp): a group header renders
    // for that machine and the agent appears underneath it.
    const header = await screen.findByText('studio-mbp');
    const group = header.closest('.agent-machine-group') as HTMLElement;
    expect(group).not.toBeNull();
    expect(within(group).getByText('Reviewer')).toBeInTheDocument();
    expect(within(group).getByText('1 agent')).toBeInTheDocument();
  });

  it('opens bot binding from the Feishu app row action', async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /Bots/i }));
    expect(await screen.findByText('Feishu Apps')).toBeInTheDocument();
    expect(screen.queryByText(/^Bind Bot$/i)).not.toBeInTheDocument();

    fireEvent.click(await screen.findByRole('button', { name: /^Bind$/i }));

    const dialog = await screen.findByRole('dialog', { name: /Bind Bot/i });
    expect(within(dialog).getByLabelText('Bot')).toHaveValue('Reviewer Bot (cli_reviewer)');
    expect(within(dialog).getByLabelText('Agent')).toHaveValue('agent-1');
  });

  it('deletes a Feishu app after confirmation', async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /Bots/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Delete Reviewer Bot/i }));

    const dialog = await screen.findByRole('dialog', { name: /Delete Feishu App/i });
    expect(within(dialog).getByText('Reviewer Bot')).toBeInTheDocument();
    expect(
      within(dialog).getByText(/Active tasks may lose this app as their bot delivery identity/i),
    ).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: /^Delete$/i }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/admin/feishu-apps/app-1',
        expect.objectContaining({ method: 'DELETE' }),
      ),
    );
    const deleteCall = fetchMock.mock.calls.find(
      ([input, init]) =>
        input === '/admin/feishu-apps/app-1' &&
        (init as RequestInit | undefined)?.method === 'DELETE',
    );
    const headers = (deleteCall?.[1] as RequestInit | undefined)?.headers as Headers;
    expect(headers.has('Content-Type')).toBe(false);
    expect(await screen.findByText('Feishu app deleted')).toBeInTheDocument();
  });

  it('renders the machines view with status and runtimes', async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /Machines/i }));

    const firstMachine = await screen.findByText('studio-mbp');
    expect(firstMachine).toBeInTheDocument();
    expect(screen.getByText('old-laptop')).toBeInTheDocument();
    expect(screen.getByText('online')).toBeInTheDocument();
    expect(screen.getByText('offline')).toBeInTheDocument();
    // Runtimes render with their proper-noun display names (old-laptop = codex).
    expect(screen.getByText('Codex')).toBeInTheDocument();
    // claude_code is now a first-class console runtime, so the machine's
    // advertised runtimes render it alongside Codex, using brand names.
    expect(screen.getByText('Claude Code, Codex')).toBeInTheDocument();
    const guideTitle = screen.getByText('Connect a machine');
    const machinesStack = firstMachine.closest('.machines-stack');
    expect(machinesStack).toContainElement(guideTitle.closest('section'));
    expect(
      firstMachine.compareDocumentPosition(guideTitle) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('renders the daemon install guide as a single npx pairing path', async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /Machines/i }));

    // Guide card present.
    expect(await screen.findByText('Connect a machine')).toBeInTheDocument();
    // The npx spec always targets @latest regardless of daemonVersion.
    expect(
      screen.getByText(
        'npx @open-tag/daemon@latest --server-url http://10.37.206.226:3001 --token <TOKEN> --background',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Download daemon/i })).not.toBeInTheDocument();
    expect(screen.queryByText('/admin/daemon/artifact')).not.toBeInTheDocument();
    expect(screen.queryByText('npm install -g ./open-claude-tag-daemon.tgz')).not.toBeInTheDocument();
    expect(
      screen.queryByText(
        /open-claude-tag-daemon install --server-url http:\/\/10\.37\.206\.226:3001/,
      ),
    ).not.toBeInTheDocument();
  });

  it('generates a pairing token and substitutes it into the connect command (D-A7)', async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /Machines/i }));
    await screen.findByText('Connect a machine');

    // No Feishu /machine connect step remains anywhere in the guide.
    expect(screen.queryByText('/machine connect')).not.toBeInTheDocument();
    expect(screen.queryByText(/run \/machine connect/i)).not.toBeInTheDocument();

    // Click "Generate pairing token".
    fireEvent.click(screen.getByRole('button', { name: /Generate pairing token/i }));

    // The POST is issued and the returned token is rendered + filled into the
    // connect command (replacing the <TOKEN> placeholder).
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/admin/machines/pairing-token',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    expect(await screen.findByText('pair-tok-abc123xyz')).toBeInTheDocument();
    expect(
      screen.getByText(
        'npx @open-tag/daemon@latest --server-url http://10.37.206.226:3001 --token pair-tok-abc123xyz --background',
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(
        /open-claude-tag-daemon install --server-url http:\/\/10\.37\.206\.226:3001/,
      ),
    ).not.toBeInTheDocument();
  });

  it('lets a break-glass admin switch to a dev user before issuing a pairing token', async () => {
    let currentMe: Me = {
      ...fixtures['/admin/me'],
      id: null,
      displayName: null,
      role: 'superadmin',
      tokenAdmin: true,
    };

    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/admin/auth/config') {
        return new Response(
          JSON.stringify({ ...fixtures['/admin/auth/config'], devAuthEnabled: true }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url === '/admin/me') {
        return new Response(JSON.stringify(currentMe), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url === '/admin/auth/dev-login' && init?.method === 'POST') {
        currentMe = {
          id: 'pu-dev-alice',
          email: null,
          displayName: 'Alice',
          role: 'user',
          computerAccessEnabled: true,
          tokenAdmin: false,
          devAuth: true,
        };
        return new Response(JSON.stringify(currentMe), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url === '/admin/machines/pairing-token' && init?.method === 'POST') {
        if (currentMe.tokenAdmin) {
          return new Response(
            JSON.stringify({ ok: false, error: 'log in as a user to pair a machine' }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response(
          JSON.stringify({
            token: 'dev-pair-token',
            expiresAt: now,
            machineName: null,
            connectCommand:
              'npx @open-tag/daemon@latest --server-url http://10.37.206.226:3001 --token dev-pair-token --background',
            serverConfigured: true,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      const body = fixtures[url as keyof typeof fixtures] ?? {};
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /Machines/i }));
    await screen.findByText('Connect a machine');

    fireEvent.click(screen.getByRole('button', { name: /Generate pairing token/i }));
    expect(await screen.findByText('log in as a user to pair a machine')).toBeInTheDocument();
    expect(screen.getByText('User sign-in required')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Identity ID'), { target: { value: 'alice' } });
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Alice' } });
    fireEvent.click(screen.getByRole('button', { name: /Sign in as user/i }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/admin/auth/dev-login',
        expect.objectContaining({ method: 'POST' }),
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: /Generate pairing token/i }));
    expect(await screen.findByText('dev-pair-token')).toBeInTheDocument();
  });

  it('switches the daemon guide OS prerequisite between Linux and macOS', async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /Machines/i }));
    await screen.findByText('Connect a machine');

    // Linux is the default OS toggle.
    expect(screen.getByText('Linux: use nvm or your distro package manager.')).toBeInTheDocument();
    expect(
      screen.getByText(
        'npx @open-tag/daemon@latest status',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'npx @open-tag/daemon@latest stop',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'npx @open-tag/daemon@latest start --background',
      ),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'macOS' }));

    expect(screen.getByText('macOS: install via Homebrew or nvm.')).toBeInTheDocument();
    expect(
      screen.getByText(
        'npx @open-tag/daemon@latest status',
      ),
    ).toBeInTheDocument();
  });

  it('shows a SERVER_PUBLIC_URL placeholder when the server has not configured it', async () => {
    // Override only the config response for this test: serverPublicUrl absent.
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/admin/auth/config') {
        return new Response(
          JSON.stringify({ ...fixtures['/admin/auth/config'], serverPublicUrl: null }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      const body = fixtures[url as keyof typeof fixtures] ?? {};
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /Machines/i }));
    await screen.findByText('Connect a machine');
    expect(
      screen.getByText(
        'npx @open-tag/daemon@latest --server-url <SERVER_PUBLIC_URL> --token <TOKEN> --background',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/open-claude-tag-daemon install --server-url/)).not.toBeInTheDocument();
    expect(screen.getByText(/no SERVER_PUBLIC_URL configured/)).toBeInTheDocument();
  });

  it('binds a chat to a machine via the inline select', async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /Chats/i }));
    const chatTitle = await screen.findByText('Engineering');
    const chatCard = chatTitle.closest('.row-card') as HTMLElement;

    const machineSelect = within(chatCard).getByLabelText('Machines');
    fireEvent.change(machineSelect, { target: { value: 'machine-1' } });

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/admin/chats/default/oc_test',
        expect.objectContaining({ method: 'PATCH' }),
      ),
    );
    const patchCall = fetchMock.mock.calls.find(
      ([input, init]) =>
        input === '/admin/chats/default/oc_test' &&
        (init as RequestInit | undefined)?.method === 'PATCH',
    );
    const body = JSON.parse(String((patchCall?.[1] as RequestInit | undefined)?.body));
    expect(body).toEqual({ defaultMachineId: 'machine-1' });
    expect(await screen.findByText('Chat machine binding updated')).toBeInTheDocument();
  });

  it('keeps machines usable without computer access and hides only the server-local option', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/admin/me') {
        return new Response(
          JSON.stringify({
            id: 'pu-2',
            email: 'alice@example.com',
            displayName: 'Alice',
            role: 'user',
            computerAccessEnabled: false,
            tokenAdmin: false,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      const body = fixtures[url as keyof typeof fixtures] ?? {};
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    render(<App />);

    // Machines stay reachable and loaded: ownership scopes the data; the
    // computer-access allowlist only gates the server-local execution choice.
    expect(await screen.findByRole('button', { name: /^Machines$/i })).toBeInTheDocument();
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([input]) => input === '/admin/machines')).toBe(true),
    );

    fireEvent.click(screen.getByRole('button', { name: /^Agents$/i }));
    expect(await screen.findByText('Agent Registry')).toBeInTheDocument();
    expect(await screen.findByText('studio-mbp')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Create Agent$/i })).toBeInTheDocument();

    fireEvent.click(await screen.findByRole('button', { name: /Edit Reviewer/i }));
    const editDialog = await screen.findByRole('dialog', { name: /Edit Agent/i });
    expect(within(editDialog).getByLabelText('Runtime')).toBeInTheDocument();
    const machineSelect = within(editDialog).getByLabelText('Machine') as HTMLSelectElement;
    const optionLabels = Array.from(machineSelect.options).map((option) => option.text);
    expect(optionLabels.some((label) => label.includes('studio-mbp'))).toBe(true);
    expect(optionLabels.some((label) => /server-local/i.test(label))).toBe(false);
    fireEvent.click(within(editDialog).getByRole('button', { name: /^Save Agent$/i }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/admin/agents/agent-1',
        expect.objectContaining({ method: 'PATCH' }),
      ),
    );
    const agentPatchCall = fetchMock.mock.calls.find(
      ([input, init]) =>
        input === '/admin/agents/agent-1' && (init as RequestInit | undefined)?.method === 'PATCH',
    );
    const agentPatchBody = JSON.parse(
      String((agentPatchCall?.[1] as RequestInit | undefined)?.body),
    );
    // Runtime edits go through for every user; the unchanged machine binding is
    // omitted so the PATCH never trips the server-local permission check.
    expect(agentPatchBody).toHaveProperty('defaultRuntime');
    expect(agentPatchBody).not.toHaveProperty('machineId');

    fireEvent.click(screen.getByRole('button', { name: /^Chats$/i }));
    const chatCard = (await screen.findByText('Engineering')).closest('article') as HTMLElement;
    expect(within(chatCard).getByLabelText('Machines')).toBeInTheDocument();
  });

  it('attaches the admin token header to admin requests once configured', async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /Settings/i }));
    fireEvent.change(await screen.findByLabelText('Admin token'), {
      target: { value: 'console-secret-token' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Save token$/i }));

    expect(await screen.findByText('Admin token saved')).toBeInTheDocument();

    // The save triggers a console refresh; assert subsequent admin fetches carry the header.
    await waitFor(() => {
      const tokenized = fetchMock.mock.calls.find(([, init]) => {
        const headers = (init as RequestInit | undefined)?.headers as Headers | undefined;
        return headers?.get('x-open-claude-tag-admin-token') === 'console-secret-token';
      });
      expect(tokenized).toBeDefined();
    });

    // Clean up the module-level token so later tests start from a clean state.
    fireEvent.click(screen.getByRole('button', { name: /^Clear token$/i }));
    await screen.findByText('Admin token cleared');
  });

  it('does not expose chat memory controls from the settings tab', async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /Settings/i }));
    await screen.findByText('Access');
    expect(screen.queryByText('Chat memory')).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Chat memory Engineering' })).not.toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) =>
          input === '/admin/chats/default/oc_test' &&
          (init as RequestInit | undefined)?.method === 'PATCH',
      ),
    ).toBe(false);
  });

  it('lets a superadmin enable computer access from settings', async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /Settings/i }));
    expect(await screen.findByText('Computer access')).toBeInTheDocument();
    const aliceRow = screen.getByText('Alice').closest('tr') as HTMLElement;
    const checkbox = within(aliceRow).getByRole('checkbox');
    expect(checkbox).not.toBeChecked();

    fireEvent.click(checkbox);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/admin/settings/computer-access/pu-2',
        expect.objectContaining({ method: 'PATCH' }),
      ),
    );
    const patchCall = fetchMock.mock.calls.find(
      ([input, init]) =>
        input === '/admin/settings/computer-access/pu-2' &&
        (init as RequestInit | undefined)?.method === 'PATCH',
    );
    const body = JSON.parse(String((patchCall?.[1] as RequestInit | undefined)?.body));
    expect(body).toEqual({ computerAccessEnabled: true });
    expect(await screen.findByText('Computer access updated')).toBeInTheDocument();
  });

  it('renders an identity chip from /admin/me with the display name and logout action', async () => {
    render(<App />);

    expect(await screen.findByText('Ops Admin')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Log out' })).toBeInTheDocument();
    expect(screen.queryByText('Superadmin')).not.toBeInTheDocument();
  });

  it('shows an owner column on bots and agents for a superadmin', async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /^Agents$/i }));
    expect(await screen.findByRole('columnheader', { name: 'Owner' })).toBeInTheDocument();
    expect(screen.getByText('Alice')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^Bots$/i }));
    expect(await screen.findByRole('columnheader', { name: 'Owner' })).toBeInTheDocument();
  });

  it('hides the owner column from a plain user', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/admin/me') {
        return new Response(
          JSON.stringify({
            id: 'pu-2',
            email: 'alice@example.com',
            displayName: 'Alice',
            role: 'user',
            computerAccessEnabled: false,
            tokenAdmin: false,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      const body = fixtures[url as keyof typeof fixtures] ?? {};
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /^Agents$/i }));
    await screen.findByRole('columnheader', { name: 'Agent' });
    expect(screen.queryByRole('columnheader', { name: 'Owner' })).not.toBeInTheDocument();
  });

  it('exposes only the admin-token Access pair (no SSO JWT field)', async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /Settings/i }));
    await screen.findByLabelText('Admin token');
    expect(screen.queryByLabelText('SSO JWT')).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^Save token$/i })).toHaveLength(1);
  });

  it('keeps web settings focused on usable controls without a desktop-only empty panel', async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /Settings/i }));
    await screen.findByText('Access');
    expect(screen.queryByText('Chat memory')).not.toBeInTheDocument();
    expect(screen.getByText('Access')).toBeInTheDocument();
    expect(
      screen.queryByText('Desktop settings are available in the macOS app'),
    ).not.toBeInTheDocument();
  });
});

describe('console-e2e-audit-fixes', () => {
  it('syncs <html lang> with the locale and persists the choice across reloads', async () => {
    const { unmount } = render(<App />);
    await screen.findByRole('button', { name: '中文' });

    fireEvent.click(screen.getByRole('button', { name: '中文' }));
    await waitFor(() => expect(document.documentElement.lang).toBe('zh-CN'));
    expect(localStorage.getItem('open-claude-tag.console.locale')).toBe('zh');

    unmount();
    // A fresh mount (reload) reads the persisted locale and starts in Chinese.
    render(<App />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '中文' })).toHaveAttribute('aria-pressed', 'true'),
    );
  });

  it('closes the create-agent modal on Escape and via the Cancel button', async () => {
    render(<App />);
    const nav = await screen.findByRole('navigation', { name: 'Console sections' });
    fireEvent.click(within(nav).getByRole('button', { name: 'Agents' }));

    // Escape closes.
    fireEvent.click(await screen.findByRole('button', { name: /Create Agent/i }));
    await screen.findByRole('dialog', { name: /Create Agent/i });
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: /Create Agent/i })).toBeNull(),
    );

    // Cancel closes.
    fireEvent.click(screen.getByRole('button', { name: /Create Agent/i }));
    const dialog = await screen.findByRole('dialog', { name: /Create Agent/i });
    fireEvent.click(within(dialog).getByRole('button', { name: /^Cancel$/i }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: /Create Agent/i })).toBeNull(),
    );
  });

  it('disconnects a paired machine and refreshes the console', async () => {
    render(<App />);
    const nav = await screen.findByRole('navigation', { name: 'Console sections' });
    fireEvent.click(within(nav).getByRole('button', { name: 'Machines' }));

    const summaryCallsBefore = fetchMock.mock.calls.filter(([u]) => u === '/admin/summary').length;
    const disconnectButtons = await screen.findAllByRole('button', { name: /Disconnect/i });
    fireEvent.click(disconnectButtons[0]); // machine-1 (online)

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringMatching(/\/admin\/machines\/machine-1\/disconnect$/),
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    // A successful disconnect triggers a full console refresh (re-fetches summary).
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([u]) => u === '/admin/summary').length,
      ).toBeGreaterThan(summaryCallsBefore),
    );
  });

  it('surfaces an inline error when disconnecting a machine fails', async () => {
    render(<App />);
    const nav = await screen.findByRole('navigation', { name: 'Console sections' });
    fireEvent.click(within(nav).getByRole('button', { name: 'Machines' }));

    const disconnectButtons = await screen.findAllByRole('button', { name: /Disconnect/i });
    fireEvent.click(disconnectButtons[1]); // machine-2 → mocked 409

    expect(await screen.findByText('Machine is offline')).toBeInTheDocument();
  });
});
