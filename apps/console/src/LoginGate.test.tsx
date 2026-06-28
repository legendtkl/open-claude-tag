import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { setAdminToken } from './api';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

type FetchHandler = (url: string, init?: RequestInit) => Response | Promise<Response>;

let fetchMock: ReturnType<typeof vi.fn>;

function installFetch(handler: FetchHandler) {
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    return handler(url, init);
  });
  vi.stubGlobal('fetch', fetchMock);
}

function hasAdminTokenHeader(init?: RequestInit): boolean {
  const headers = init?.headers;
  if (!headers) return false;
  const value =
    headers instanceof Headers
      ? headers.get('x-open-claude-tag-admin-token')
      : (headers as Record<string, string>)['x-open-claude-tag-admin-token'];
  return Boolean(value);
}

const EMPTY_SUMMARY = {
  profiles: 0,
  agents: 0,
  activeAgents: 0,
  feishuApps: 0,
  enabledFeishuApps: 0,
  botBindings: 0,
  chats: 0,
  machines: 0,
  onlineMachines: 0,
};

// Default: unauthenticated console, dev-auth OFF, no break-glass token ⇒ gate.
function defaultHandler(): FetchHandler {
  return (url) => {
    if (url === '/admin/me') return jsonResponse({ error: 'forbidden' }, 403);
    if (url === '/admin/auth/config') return jsonResponse({ devAuthEnabled: false });
    return jsonResponse({});
  };
}

afterEach(() => {
  setAdminToken('');
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Login gate', () => {
  it('renders the admin-token login card when unauthenticated with no break-glass token', async () => {
    installFetch(defaultHandler());
    render(<App />);

    expect(await screen.findByRole('button', { name: /Continue/i })).toBeInTheDocument();
    expect(screen.getByLabelText('Admin token')).toBeInTheDocument();
    expect(screen.getByText('OpenClaudeTag Console')).toBeInTheDocument();
    // No SSO entry point remains.
    expect(screen.queryByRole('button', { name: /SSO/i })).not.toBeInTheDocument();
    // The console shell (nav) must not render behind the gate.
    expect(screen.queryByRole('button', { name: /^Agents$/i })).not.toBeInTheDocument();
  });

  it('applies a typed admin token and mounts the console', async () => {
    installFetch((url, init) => {
      if (url === '/admin/me') {
        return hasAdminTokenHeader(init)
          ? jsonResponse({
              id: null,
              email: null,
              displayName: null,
              role: 'superadmin',
              computerAccessEnabled: true,
              tokenAdmin: true,
            })
          : jsonResponse({ error: 'forbidden' }, 403);
      }
      if (url === '/admin/auth/config') return jsonResponse({ devAuthEnabled: false });
      if (url === '/admin/summary') return jsonResponse(EMPTY_SUMMARY);
      return jsonResponse([]);
    });

    render(<App />);
    fireEvent.change(await screen.findByLabelText('Admin token'), {
      target: { value: 'console-secret-token' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Continue/i }));

    expect(await screen.findByRole('button', { name: /^Agents$/i })).toBeInTheDocument();
    // The token is attached to subsequent admin requests.
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([input, init]) => input === '/admin/me' && hasAdminTokenHeader(init as RequestInit)),
      ).toBe(true),
    );
  });

  it('logs out by clearing the cookie and returning to the gate', async () => {
    let loggedOut = false;
    installFetch((url, init) => {
      if (url === '/admin/me') {
        return loggedOut
          ? jsonResponse({ error: 'forbidden' }, 403)
          : jsonResponse({
              id: 'pu-1',
              email: 'alice@example.com',
              displayName: 'Alice',
              role: 'superadmin',
              computerAccessEnabled: true,
              tokenAdmin: false,
            });
      }
      if (url === '/admin/auth/config') return jsonResponse({ devAuthEnabled: false });
      if (url === '/admin/auth/logout' && init?.method === 'POST') {
        loggedOut = true;
        return jsonResponse({ ok: true });
      }
      if (url === '/admin/summary') return jsonResponse(EMPTY_SUMMARY);
      return jsonResponse([]);
    });

    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /Log out/i }));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([input, init]) =>
            input === '/admin/auth/logout' && (init as RequestInit | undefined)?.method === 'POST',
        ),
      ).toBe(true),
    );
    // Back on the login gate after logout.
    expect(await screen.findByRole('button', { name: /Continue/i })).toBeInTheDocument();
  });

  it('hides the dev sign-in section when dev-auth is disabled', async () => {
    installFetch(defaultHandler());
    render(<App />);
    await screen.findByRole('button', { name: /Continue/i });
    expect(screen.queryByRole('button', { name: /Sign in as/i })).not.toBeInTheDocument();
  });

  it('renders the dev sign-in section only when dev-auth is enabled', async () => {
    installFetch((url) => {
      if (url === '/admin/me') return jsonResponse({ error: 'forbidden' }, 403);
      if (url === '/admin/auth/config') return jsonResponse({ devAuthEnabled: true });
      return jsonResponse({});
    });
    render(<App />);

    expect(await screen.findByText('Dev sign-in')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Sign in as/i })).toBeInTheDocument();
    expect(screen.getByText(/Local only/i)).toBeInTheDocument();
  });

  it('issues a dev-login POST and mounts the console with the typed display name only', async () => {
    let meAuthenticated = false;
    installFetch((url, init) => {
      if (url === '/admin/me') {
        return meAuthenticated
          ? jsonResponse({
              id: 'pu-dev-1',
              email: null,
              displayName: 'Alice Dev',
              role: 'user',
              computerAccessEnabled: false,
              tokenAdmin: false,
              devAuth: true,
            })
          : jsonResponse({ error: 'forbidden' }, 403);
      }
      if (url === '/admin/auth/config') return jsonResponse({ devAuthEnabled: true });
      if (url === '/admin/auth/dev-login' && init?.method === 'POST') {
        meAuthenticated = true;
        return jsonResponse({
          id: 'pu-dev-1',
          role: 'user',
          computerAccessEnabled: false,
          tokenAdmin: false,
          devAuth: true,
        });
      }
      if (url === '/admin/summary') return jsonResponse(EMPTY_SUMMARY);
      return jsonResponse([]);
    });

    render(<App />);
    const subInput = await screen.findByLabelText(/Identity ID/i);
    fireEvent.change(subInput, { target: { value: 'alice' } });
    fireEvent.change(screen.getByLabelText(/Display name/i), { target: { value: 'Alice Dev' } });
    fireEvent.click(screen.getByRole('button', { name: /Sign in as/i }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([input, reqInit]) =>
          input === '/admin/auth/dev-login' &&
          (reqInit as RequestInit | undefined)?.method === 'POST',
      );
      expect(call).toBeDefined();
      const body = JSON.parse(String((call?.[1] as RequestInit | undefined)?.body));
      expect(body).toEqual({ sub: 'alice', name: 'Alice Dev' });
    });

    expect(await screen.findByText('Alice Dev')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Log out/i })).toBeInTheDocument();
  });

  it('validates dev-auth identity ids before posting dev-login', async () => {
    installFetch((url) => {
      if (url === '/admin/me') return jsonResponse({ error: 'forbidden' }, 403);
      if (url === '/admin/auth/config') return jsonResponse({ devAuthEnabled: true });
      return jsonResponse({});
    });

    render(<App />);
    const subInput = await screen.findByLabelText(/Identity ID/i);
    fireEvent.change(subInput, { target: { value: 'alice dev' } });

    expect(screen.getByText(/Use letters, numbers/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Sign in as/i })).toBeDisabled();
    expect(
      fetchMock.mock.calls.some(
        ([input, reqInit]) =>
          input === '/admin/auth/dev-login' &&
          (reqInit as RequestInit | undefined)?.method === 'POST',
      ),
    ).toBe(false);
  });

  it('keeps the console mounted when a break-glass admin token is configured', async () => {
    setAdminToken('console-secret-token');
    installFetch((url) => {
      if (url === '/admin/me') return jsonResponse({ error: 'forbidden' }, 403);
      if (url === '/admin/auth/config') return jsonResponse({ devAuthEnabled: false });
      if (url === '/admin/summary') return jsonResponse(EMPTY_SUMMARY);
      return jsonResponse([]);
    });

    render(<App />);
    // With a break-glass token the gate is bypassed even on a 403 /admin/me.
    expect(await screen.findByRole('button', { name: /^Agents$/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Continue/i })).not.toBeInTheDocument();
  });
});
