export interface AdminSummary {
  profiles: number;
  agents: number;
  activeAgents: number;
  feishuApps: number;
  enabledFeishuApps: number;
  botBindings: number;
  chats: number;
  machines: number;
  onlineMachines: number;
}

export interface Machine {
  id: string;
  name: string;
  status: string;
  ownerOpenId: string;
  lastSeenAt: string | null;
  runtimes: string[];
  createdAt: string;
}

export interface Profile {
  id: string;
  name: string;
  displayName: string;
  description: string | null;
  systemPrompt: string | null;
  stylePrompt: string | null;
  skillRefs: string[];
  defaultRuntime: string | null;
  defaultModel: string | null;
  sourceType: string;
  sourceUri: string | null;
  // Console owner (R2-6). NULL = a builtin/shared profile (superadmin-only to
  // mutate). `platformOwner` is a compact label for the superadmin owner column;
  // null for a plain user (who only ever sees own + shared profiles).
  platformOwnerId: string | null;
  platformOwner: OwnerLabel | null;
  status: string;
}

export interface OwnerLabel {
  id: string;
  email: string | null;
  displayName: string | null;
}

export interface Me {
  id: string | null;
  email: string | null;
  displayName: string | null;
  role: 'user' | 'superadmin';
  computerAccessEnabled: boolean;
  tokenAdmin: boolean;
  /** True when this identity came from the test-only dev-auth path (design D-A6). */
  devAuth?: boolean;
}

export interface ComputerAccessUser {
  id: string;
  email: string | null;
  displayName: string | null;
  role: 'user' | 'superadmin';
  computerAccessEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Agent {
  id: string;
  tenantKey: string;
  scopeType: string;
  scopeId: string;
  handle: string;
  displayName: string;
  description: string | null;
  profileId: string;
  profile: Pick<Profile, 'id' | 'name' | 'displayName' | 'status'> | null;
  platformOwnerId: string | null;
  platformOwner: OwnerLabel | null;
  // Execution machine binding (design D-A8). `machineId` is null for a server-local
  // agent; `machine` carries a compact label used to group agents by machine.
  machineId: string | null;
  machine: AgentMachine | null;
  visibility: string;
  defaultRuntime: string | null;
  defaultWorkDir: string | null;
  runtimeEnvKeys: string[];
  /** Layer A long-term memory toggle ("Long-term memory" in the agent form). */
  memoryEnabled: boolean;
  status: string;
  binding: BotBinding | null;
}

/** Compact machine label embedded in {@link Agent} for the Agents-by-machine grouping (D-A8). */
export interface AgentMachine {
  id: string;
  name: string;
  status: string;
}

export interface FeishuApp {
  id: string;
  tenantKey: string;
  appId: string;
  appSecretRef: string;
  hasStoredSecret: boolean;
  botOpenId: string | null;
  botName: string | null;
  eventMode: string;
  status: string;
  platformOwnerId: string | null;
  platformOwner: OwnerLabel | null;
  binding: {
    id: string;
    agentId: string;
    agentHandle: string | null;
    agentDisplayName: string | null;
    status: string;
  } | null;
}

export interface FeishuPermissionGroupResult {
  anyOf: string[];
  satisfiedBy: string | null;
}

export interface FeishuPermissionCapabilityResult {
  id: string;
  label: string;
  description?: string;
  severity: string;
  status: string;
  groups: FeishuPermissionGroupResult[];
}

export interface FeishuPermissionCheckResult {
  feishuAppId: string;
  appId: string;
  checkedAt: string;
  status: 'pass' | 'fail';
  grantedScopes: string[];
  inventoryScopes: string[];
  extraGrantedScopes: string[];
  missingRequiredCapabilities: string[];
  optionalMissingCapabilities: string[];
  capabilities: FeishuPermissionCapabilityResult[];
  notes: string[];
}

export interface FeishuPermissionApplyResult {
  feishuAppId: string;
  appId: string;
  submittedAt: string;
  submitted: boolean;
  status?: 'submitted' | 'no_pending_scopes';
  message?: string;
}

export type FeishuAppRegistrationStatus =
  | 'pending'
  | 'completed'
  | 'failed'
  | 'expired'
  | 'cancelled';

export interface FeishuAppRegistration {
  id: string;
  status: FeishuAppRegistrationStatus;
  verificationUrl: string;
  expireIn: number;
  expiresAt: string;
  app: FeishuApp | null;
  error: string | null;
  sdkStatus: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BotBinding {
  id: string;
  agentId: string;
  feishuAppId: string;
  botOpenId: string | null;
  status: string;
}

export interface Chat {
  tenantKey: string;
  chatId: string;
  displayName: string;
  openFeishuUrl: string;
  defaultRuntime: string | null;
  defaultMachineId: string | null;
  defaultMachineName: string | null;
  agents: ChatAgent[];
  taskCount: number;
  lastTaskAt: string | null;
}

export interface ChatAgent {
  id: string;
  handle: string;
  displayName: string;
  status: string;
  taskCount: number;
  lastTaskAt: string | null;
}

export interface ConsoleData {
  summary: AdminSummary;
  profiles: Profile[];
  agents: Agent[];
  apps: FeishuApp[];
  chats: Chat[];
  machines: Machine[];
}

export interface DesktopConfig {
  apiUrl: string;
  configPath: string;
  defaultApiUrl: string;
  source: 'saved' | 'environment' | 'default';
}

export interface DesktopBridge {
  getConfig: () => Promise<DesktopConfig>;
  resetApiUrl: () => Promise<DesktopConfig>;
  setApiUrl: (apiUrl: string) => Promise<DesktopConfig>;
}

declare global {
  interface Window {
    openClaudeTagDesktop?: DesktopBridge;
  }
}

const ADMIN_TOKEN_STORAGE_KEY = 'open-claude-tag.adminToken';

function readStoredToken(key: string): string | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const stored = localStorage.getItem(key);
    return stored && stored.trim() ? stored : null;
  } catch {
    return null;
  }
}

function writeStoredToken(key: string, value: string | null): void {
  if (typeof localStorage === 'undefined') return;
  try {
    if (value) {
      localStorage.setItem(key, value);
    } else {
      localStorage.removeItem(key);
    }
  } catch {
    // Best-effort persistence; the in-memory token still applies for this session.
  }
}

// Module-level admin token, mirrored into localStorage so it survives reloads.
// Sent as the `x-open-claude-tag-admin-token` header on every admin request; required
// when the console is not served from (and proxied to) a loopback API host.
let adminToken: string | null = readStoredToken(ADMIN_TOKEN_STORAGE_KEY);

export function getAdminToken(): string {
  return adminToken ?? '';
}

export function setAdminToken(token: string): void {
  const trimmed = token.trim();
  adminToken = trimmed ? trimmed : null;
  writeStoredToken(ADMIN_TOKEN_STORAGE_KEY, adminToken);
}

function optionalString(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim() ?? '';
  return trimmed ? trimmed : undefined;
}

function desktopBridge(): DesktopBridge | null {
  if (typeof window === 'undefined') return null;
  return window.openClaudeTagDesktop ?? null;
}

export function isDesktopApp(): boolean {
  return desktopBridge() !== null;
}

export async function getDesktopConfig(): Promise<DesktopConfig | null> {
  return (await desktopBridge()?.getConfig()) ?? null;
}

export async function saveDesktopApiUrl(apiUrl: string): Promise<DesktopConfig> {
  const bridge = desktopBridge();
  if (!bridge) {
    throw new Error('Desktop settings are only available in the macOS app.');
  }
  return bridge.setApiUrl(apiUrl);
}

export async function resetDesktopApiUrl(): Promise<DesktopConfig> {
  const bridge = desktopBridge();
  if (!bridge) {
    throw new Error('Desktop settings are only available in the macOS app.');
  }
  return bridge.resetApiUrl();
}

/** Ceiling for a single admin request; a stalled server otherwise hangs the console. */
const REQUEST_TIMEOUT_MS = 15000;

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  if (adminToken && !headers.has('x-open-claude-tag-admin-token')) {
    headers.set('x-open-claude-tag-admin-token', adminToken);
  }

  // Abort if the server stalls, while still honoring any caller-supplied signal.
  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = init?.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;

  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      // Send the httpOnly `cc_dev_user` dev-auth cookie so a dev-auth session
      // carries its identity on every admin request.
      credentials: init?.credentials ?? 'include',
      headers,
      signal,
    });
  } catch (error) {
    if (timeoutSignal.aborted || (error instanceof DOMException && error.name === 'TimeoutError')) {
      throw new Error('Request timed out. Please retry.', { cause: error });
    }
    throw error;
  }
  const body = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    const message =
      body && typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : `HTTP ${response.status}`;
    throw new Error(message);
  }
  return body as T;
}

export async function getMe(): Promise<Me> {
  return requestJson<Me>('/admin/me');
}

export type MeResult =
  | { authenticated: true; me: Me }
  | { authenticated: false; status: number | null };

/**
 * Resolve the current identity, distinguishing "unauthenticated" (401/403, which
 * drives the login gate) from network/other errors. The login gate only renders
 * for 401/403; transient errors keep the console mounted with an error banner.
 */
export async function getMeResult(): Promise<MeResult> {
  const headers = new Headers();
  const token = getAdminToken();
  if (token) headers.set('x-open-claude-tag-admin-token', token);
  try {
    const response = await fetch('/admin/me', { credentials: 'include', headers });
    if (response.status === 401 || response.status === 403) {
      return { authenticated: false, status: response.status };
    }
    if (!response.ok) return { authenticated: false, status: response.status };
    const me = (await response.json()) as Me;
    return { authenticated: true, me };
  } catch {
    return { authenticated: false, status: null };
  }
}

/** True when a break-glass admin token is configured. */
export function hasBreakGlassToken(): boolean {
  return Boolean(getAdminToken());
}

export interface AuthConfig {
  /** True when the local dev-auth login mode is active (design D-A6). */
  devAuthEnabled: boolean;
  /**
   * True when the server runs in single-user personal mode
   * (`OPEN_TAG_PERSONAL_MODE=enabled`). The console uses this to auto-launch the
   * first-run onboarding wizard, frame server-local execution as the default, and
   * de-emphasize team-only machine pairing. Defaults to false so the full
   * multi-tenant console behavior is unchanged when the flag is off.
   */
  personalMode: boolean;
  /**
   * Public base URL a user's daemon dials (the worker daemon gateway). Null when
   * the deployer has not set `SERVER_PUBLIC_URL`; the install guide then shows a
   * `<SERVER_PUBLIC_URL>` placeholder.
   */
  serverPublicUrl: string | null;
  /** Version of `@open-tag/daemon` this server distributes, or null. */
  daemonVersion: string | null;
}

/**
 * Read the auth config (whether the local dev-auth mode is on, plus the
 * daemon-install hints for the Machines page). Falls back to dev-auth-OFF /
 * no-daemon-hints defaults so a failed config call never leaks a login path
 * (dev-auth stays hidden on failure — secure by default).
 */
export async function getAuthConfig(): Promise<AuthConfig> {
  try {
    const response = await fetch('/admin/auth/config', { credentials: 'include' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as Partial<AuthConfig>;
    return {
      devAuthEnabled: body.devAuthEnabled === true,
      personalMode: body.personalMode === true,
      serverPublicUrl: body.serverPublicUrl?.trim() || null,
      daemonVersion: body.daemonVersion?.trim() || null,
    };
  } catch {
    return {
      devAuthEnabled: false,
      personalMode: false,
      serverPublicUrl: null,
      daemonVersion: null,
    };
  }
}

/** Per-app Feishu WebSocket health entry from `GET /health` (`feishu.apps[]`). */
export interface FeishuAppHealth {
  appId: string;
  wsStatus: 'disabled' | 'starting' | 'live' | 'unhealthy';
  hasActiveBotBinding: boolean;
}

/** Minimal `GET /health` shape the onboarding wizard reads to confirm go-live. */
export interface HealthSummary {
  status: string;
  feishu: {
    access: string;
    websocket: 'live' | 'unhealthy' | 'disabled';
    apps: FeishuAppHealth[];
  };
}

/**
 * Best-effort read of `GET /health`. Returns null on any error so callers (the
 * onboarding wizard's runtime check + go-live poll) can degrade gracefully rather
 * than throw. Unauthenticated, like the rest of `/health`.
 */
export async function getHealth(signal?: AbortSignal): Promise<HealthSummary | null> {
  try {
    const response = await fetch('/health', { credentials: 'include', signal });
    if (!response.ok) return null;
    const body = (await response.json()) as Partial<HealthSummary> | null;
    if (!body || typeof body !== 'object' || !body.feishu) return null;
    const feishu = body.feishu;
    return {
      status: typeof body.status === 'string' ? body.status : 'unknown',
      feishu: {
        access: typeof feishu.access === 'string' ? feishu.access : 'unknown',
        websocket:
          feishu.websocket === 'live' || feishu.websocket === 'unhealthy'
            ? feishu.websocket
            : 'disabled',
        apps: Array.isArray(feishu.apps)
          ? feishu.apps.map((app) => ({
              appId: String(app.appId),
              wsStatus:
                app.wsStatus === 'live' ||
                app.wsStatus === 'starting' ||
                app.wsStatus === 'unhealthy'
                  ? app.wsStatus
                  : 'disabled',
              hasActiveBotBinding: app.hasActiveBotBinding === true,
            }))
          : [],
      },
    };
  } catch {
    return null;
  }
}

/**
 * Sign in via the test-only dev-auth path (design D-A6). POSTs the chosen
 * identity to `/admin/auth/dev-login`, which sets the `cc_dev_user` httpOnly
 * cookie and returns the `/admin/me` payload. Only meaningful when the server
 * reports `devAuthEnabled` (otherwise the endpoint 404s). Returns true on
 * success so the caller can reload into the console.
 */
export async function devLogin(sub: string, name?: string): Promise<boolean> {
  try {
    const response = await fetch('/admin/auth/dev-login', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sub, name: name?.trim() || undefined }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** Clear the local dev-auth session cookie. */
export async function logout(): Promise<void> {
  try {
    await fetch('/admin/auth/logout', { method: 'POST', credentials: 'include' });
  } catch {
    // Best effort; the gate reload below still drops the in-memory identity.
  }
}

export async function loadConsoleData(
  options: { includeMachines?: boolean } = {},
): Promise<ConsoleData> {
  const includeMachines = options.includeMachines !== false;
  const [summary, profiles, agents, apps, chats, machines] = await Promise.all([
    requestJson<AdminSummary>('/admin/summary'),
    requestJson<Profile[]>('/admin/profiles'),
    requestJson<Agent[]>('/admin/agents'),
    requestJson<FeishuApp[]>('/admin/feishu-apps'),
    requestJson<Chat[]>('/admin/chats'),
    includeMachines ? requestJson<Machine[]>('/admin/machines') : Promise.resolve([]),
  ]);
  return { summary, profiles, agents, apps, chats, machines };
}

export async function listMachines(): Promise<Machine[]> {
  return requestJson<Machine[]>('/admin/machines');
}

export async function listComputerAccessUsers(): Promise<ComputerAccessUser[]> {
  return requestJson<ComputerAccessUser[]>('/admin/settings/computer-access');
}

export async function updateComputerAccessUser(
  id: string,
  input: { computerAccessEnabled: boolean },
): Promise<ComputerAccessUser> {
  return requestJson<ComputerAccessUser>(
    `/admin/settings/computer-access/${encodeURIComponent(id)}`,
    {
      method: 'PATCH',
      body: JSON.stringify(input),
    },
  );
}

/** Result of minting a console pairing token (design D-A7). */
export interface IssuedPairingToken {
  /** One-time plaintext token; only returned here. */
  token: string;
  /** ISO expiry timestamp. */
  expiresAt: string;
  /** Optional machine name recorded with the token. */
  machineName: string | null;
  /** Ready-to-run `npx …` installer command with the token + server substituted. */
  connectCommand: string;
  /** True when SERVER_PUBLIC_URL is configured (else the command has a placeholder). */
  serverConfigured: boolean;
}

/**
 * Mint a one-time pairing token in the console (design D-A7). The plaintext token
 * and a ready-to-run connect command are returned only here; the token is stored
 * server-side as a SHA-256 hash. The resulting machine is owned by the calling
 * platform user.
 */
export async function issuePairingToken(name?: string): Promise<IssuedPairingToken> {
  return requestJson<IssuedPairingToken>('/admin/machines/pairing-token', {
    method: 'POST',
    body: JSON.stringify({ name: optionalString(name) }),
  });
}

/**
 * Server-initiated disconnect of a paired machine (design D-A9). Owner-scoped and
 * idempotent; returns the updated machine record.
 */
export async function disconnectMachine(id: string): Promise<Machine> {
  return requestJson<Machine>(`/admin/machines/${encodeURIComponent(id)}/disconnect`, {
    method: 'POST',
  });
}

export async function createAgent(input: {
  // The internal handle is derived from displayName server-side; the console
  // only collects a single user-facing name.
  displayName: string;
  description?: string | null;
  profileId?: string;
  profile?: {
    name?: string;
    displayName?: string;
    description?: string | null;
    systemPrompt?: string | null;
    stylePrompt?: string | null;
    skillRefs?: string[];
    defaultRuntime?: string | null;
    defaultModel?: string | null;
  };
  visibility?: string;
  defaultRuntime?: string | null;
  defaultWorkDir?: string | null;
  runtimeEnv?: Record<string, string>;
  memoryEnabled?: boolean;
  /** Execution machine binding (design D-A8); null = server-local. */
  machineId?: string | null;
}): Promise<Agent> {
  return requestJson<Agent>('/admin/agents', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function updateAgent(
  id: string,
  input: {
    displayName?: string;
    description?: string | null;
    profileId?: string;
    profile?: {
      displayName?: string;
      description?: string | null;
      systemPrompt?: string | null;
      stylePrompt?: string | null;
      skillRefs?: string[];
      defaultRuntime?: string | null;
      defaultModel?: string | null;
      status?: string;
    };
    visibility?: string;
    defaultRuntime?: string | null;
    defaultWorkDir?: string | null;
    runtimeEnv?: Record<string, string>;
    memoryEnabled?: boolean;
    status?: string;
    /** Execution machine binding (design D-A8); null = server-local. */
    machineId?: string | null;
  },
): Promise<Agent> {
  return requestJson<Agent>(`/admin/agents/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export async function deleteAgent(id: string): Promise<Agent> {
  return requestJson<Agent>(`/admin/agents/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

export async function createFeishuApp(input: {
  appId: string;
  appSecretRef?: string;
  appSecret?: string;
  botName?: string;
  botOpenId?: string;
}): Promise<FeishuApp> {
  const body = {
    appId: input.appId.trim(),
    appSecretRef: optionalString(input.appSecretRef),
    appSecret: optionalString(input.appSecret),
    botName: optionalString(input.botName),
    botOpenId: optionalString(input.botOpenId),
  };
  return requestJson<FeishuApp>('/admin/feishu-apps', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function updateFeishuApp(
  id: string,
  input: {
    botName?: string | null;
  },
): Promise<FeishuApp> {
  return requestJson<FeishuApp>(`/admin/feishu-apps/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({
      botName:
        input.botName === null
          ? null
          : input.botName === undefined
            ? undefined
            : optionalString(input.botName),
    }),
  });
}

export async function deleteFeishuApp(id: string): Promise<FeishuApp> {
  return requestJson<FeishuApp>(`/admin/feishu-apps/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

export async function checkFeishuAppPermissions(
  feishuAppId: string,
): Promise<FeishuPermissionCheckResult> {
  return requestJson<FeishuPermissionCheckResult>(
    `/admin/feishu-apps/${encodeURIComponent(feishuAppId)}/permission-check`,
    { method: 'POST' },
  );
}

export async function applyFeishuAppPermissions(
  feishuAppId: string,
): Promise<FeishuPermissionApplyResult> {
  return requestJson<FeishuPermissionApplyResult>(
    `/admin/feishu-apps/${encodeURIComponent(feishuAppId)}/permission-apply`,
    { method: 'POST' },
  );
}

export async function startFeishuAppRegistration(input: {
  botName?: string;
  description?: string;
} = {}): Promise<FeishuAppRegistration> {
  return requestJson<FeishuAppRegistration>('/admin/feishu-apps/one-click-registration', {
    method: 'POST',
    body: JSON.stringify({
      botName: optionalString(input.botName),
      description: optionalString(input.description),
    }),
  });
}

export async function getFeishuAppRegistration(id: string): Promise<FeishuAppRegistration> {
  return requestJson<FeishuAppRegistration>(
    `/admin/feishu-apps/one-click-registration/${encodeURIComponent(id)}`,
  );
}

export async function cancelFeishuAppRegistration(id: string): Promise<FeishuAppRegistration> {
  return requestJson<FeishuAppRegistration>(
    `/admin/feishu-apps/one-click-registration/${encodeURIComponent(id)}`,
    { method: 'DELETE' },
  );
}

export async function bindBot(input: {
  agentId: string;
  feishuAppId: string;
}): Promise<BotBinding> {
  return requestJson<BotBinding>('/admin/bot-bindings', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function unbindBot(bindingId: string): Promise<BotBinding> {
  return requestJson<BotBinding>(`/admin/bot-bindings/${encodeURIComponent(bindingId)}`, {
    method: 'DELETE',
  });
}

export async function updateChat(
  tenantKey: string,
  chatId: string,
  input: {
    defaultMachineId?: string | null;
  },
): Promise<Chat> {
  return requestJson<Chat>(
    `/admin/chats/${encodeURIComponent(tenantKey)}/${encodeURIComponent(chatId)}`,
    {
      method: 'PATCH',
      body: JSON.stringify(input),
    },
  );
}
