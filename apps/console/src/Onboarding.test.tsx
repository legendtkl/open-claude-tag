import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import type { Agent, FeishuApp } from './api';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const SUPERADMIN_ME = {
  id: null,
  email: null,
  displayName: null,
  role: 'superadmin',
  computerAccessEnabled: true,
  tokenAdmin: true,
};

function summaryFor(apps: FeishuApp[], agents: Agent[]) {
  const botBindings = apps.filter((app) => app.binding?.status === 'active').length;
  return {
    profiles: 0,
    agents: agents.length,
    activeAgents: agents.filter((a) => a.status === 'active').length,
    feishuApps: apps.length,
    enabledFeishuApps: apps.filter((a) => a.status === 'enabled').length,
    botBindings,
    chats: 0,
    taskBoards: 0,
    machines: 0,
    onlineMachines: 0,
  };
}

function enabledBoundApp(): FeishuApp {
  return {
    id: 'app-1',
    tenantKey: 'default',
    appId: 'cli_personal',
    appSecretRef: 'stored',
    hasStoredSecret: true,
    botOpenId: 'ou_bot',
    botName: 'Personal Bot',
    eventMode: 'websocket',
    status: 'enabled',
    platformOwnerId: null,
    platformOwner: null,
    binding: {
      id: 'binding-1',
      agentId: 'agent-1',
      agentHandle: 'dev',
      agentDisplayName: 'Dev',
      status: 'active',
    },
  };
}

function activeAgent(): Agent {
  return {
    id: 'agent-1',
    tenantKey: 'default',
    scopeType: 'tenant',
    scopeId: 'default',
    handle: 'dev',
    displayName: 'Dev',
    description: null,
    profileId: 'profile-1',
    profile: { id: 'profile-1', name: 'dev', displayName: 'Dev', status: 'active' },
    platformOwnerId: null,
    platformOwner: null,
    machineId: null,
    machine: null,
    visibility: 'tenant',
    defaultRuntime: 'codex',
    defaultWorkDir: null,
    runtimeEnvKeys: [],
    memoryEnabled: true,
    status: 'active',
    binding: null,
  };
}

interface HandlerOptions {
  personalMode?: boolean;
  apps?: FeishuApp[];
  agents?: Agent[];
  /** /health feishu.apps entries. */
  liveAppIds?: string[];
  websocket?: 'live' | 'unhealthy' | 'disabled';
}

let fetchMock: ReturnType<typeof vi.fn>;

function installHandler(options: HandlerOptions = {}) {
  const apps = options.apps ?? [];
  const agents = options.agents ?? [];
  const personalMode = options.personalMode ?? true;
  const liveAppIds = new Set(options.liveAppIds ?? []);
  const websocket = options.websocket ?? 'disabled';

  fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url === '/admin/me') return jsonResponse(SUPERADMIN_ME);
    if (url === '/admin/auth/config') {
      return jsonResponse({ devAuthEnabled: false, personalMode });
    }
    if (url === '/admin/summary') return jsonResponse(summaryFor(apps, agents));
    if (url === '/admin/feishu-apps') return jsonResponse(apps);
    if (url === '/admin/agents') return jsonResponse(agents);
    if (url === '/health') {
      return jsonResponse({
        status: 'ok',
        feishu: {
          access: 'enabled',
          websocket,
          apps: apps.map((app) => ({
            appId: app.appId,
            wsStatus: liveAppIds.has(app.appId) ? 'live' : 'disabled',
            hasActiveBotBinding: app.binding?.status === 'active',
          })),
        },
      });
    }
    // profiles / chats / machines and anything else: empty list.
    return jsonResponse([]);
  });
  vi.stubGlobal('fetch', fetchMock);
}

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Onboarding wizard', () => {
  it('auto-launches the wizard on an empty personal-mode console', async () => {
    installHandler({ personalMode: true, apps: [], agents: [] });
    render(<App />);

    expect(await screen.findByText(/Get started with OpenClaudeTag/i)).toBeInTheDocument();
    // The personal-mode nav entry is present.
    expect(screen.getByRole('button', { name: /Get Started/i })).toBeInTheDocument();
    // The old overview hero is not shown while the wizard is open.
    expect(screen.queryByText(/A Feishu-native workspace/i)).not.toBeInTheDocument();
  });

  it('does not auto-launch when personal mode is off, even with no setup', async () => {
    installHandler({ personalMode: false, apps: [], agents: [] });
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Agents' })).toBeInTheDocument();
    expect(screen.queryByText(/A Feishu-native workspace/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Get started with OpenClaudeTag/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Get Started/i })).not.toBeInTheDocument();
  });

  it('does not auto-launch when setup is complete and the bot is live', async () => {
    installHandler({
      personalMode: true,
      apps: [enabledBoundApp()],
      agents: [activeAgent()],
      liveAppIds: ['cli_personal'],
      websocket: 'live',
    });
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Agents' })).toBeInTheDocument();
    expect(screen.queryByText(/A Feishu-native workspace/i)).not.toBeInTheDocument();
    // Give the auto-route health probe a chance to resolve; it must not route.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/health', expect.anything()));
    expect(screen.queryByText(/Get started with OpenClaudeTag/i)).not.toBeInTheDocument();
  });

  it('gates Next on the connect-Feishu step until an app exists', async () => {
    installHandler({ personalMode: true, apps: [], agents: [] });
    render(<App />);

    await screen.findByText(/Get started with OpenClaudeTag/i);
    // Welcome step: Next is enabled.
    const next = screen.getByRole('button', { name: /^Next$/i });
    expect(next).toBeEnabled();
    fireEvent.click(next);

    // Connect-Feishu step: no app yet, so Next is gated.
    expect(await screen.findByText(/Apply Bot And Scopes/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Next$/i })).toBeDisabled();
  });

  it('skips to the console and persists the dismissal across reloads', async () => {
    installHandler({ personalMode: true, apps: [], agents: [] });
    const first = render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /Skip to console/i }));
    // The normal console is now shown.
    expect(await screen.findByRole('heading', { name: 'Agents' })).toBeInTheDocument();
    expect(screen.queryByText(/A Feishu-native workspace/i)).not.toBeInTheDocument();
    first.unmount();

    // A fresh mount (same localStorage) must not re-route into the wizard.
    installHandler({ personalMode: true, apps: [], agents: [] });
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Agents' })).toBeInTheDocument();
    expect(screen.queryByText(/A Feishu-native workspace/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Get started with OpenClaudeTag/i)).not.toBeInTheDocument();
  });
});
