import { access, constants as fsConstants, mkdir } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { isProtocolCompatible, PROTOCOL_VERSION } from '@open-tag/daemon-protocol';
import type { DaemonConfig } from './config.js';
import { resolveProxyForTarget } from './connection.js';

/** Outcome of a single named check, used by `status` and `doctor`. */
export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

/**
 * Result of the read-only server probe used by `status` and `doctor`.
 *
 * The probe is intentionally side-effect free: it hits the gateway's REST
 * diagnostics endpoints and NEVER opens the execution WebSocket. Opening an
 * authenticated WS would trigger newest-wins supersede (D14) and kick the user's
 * running daemon off mid-flight, failing its in-flight dispatches as `task_lost`
 * (codex review finding #3). Diagnostics must observe, never disrupt.
 */
export interface ServerProbeResult {
  /** `GET /daemon/health` answered 200. */
  reachable: boolean;
  /** Server's advertised protocol range overlaps what this daemon speaks. */
  protocolCompatible: boolean;
  /** `GET /daemon/whoami` answered 200 with this machine's credentials. */
  credentialsValid: boolean;
  detail: string;
}

/** Shape of the no-auth `GET /daemon/health` response (worker-owned contract). */
interface HealthBody {
  ok?: boolean;
  serverProtocol?: { min?: number; max?: number };
  heartbeatSec?: number;
}

/** Shape of the authenticated `GET /daemon/whoami` response. */
interface WhoamiBody {
  machineId?: string;
  name?: string;
  status?: string;
}

/** Joins the server base URL with a path, tolerating a trailing slash. */
function serverEndpoint(serverUrl: string, path: string): string {
  return `${serverUrl.replace(/\/+$/, '')}${path}`;
}

/**
 * Performs one bounded GET against a server diagnostics endpoint.
 *
 * Honors `HTTPS_PROXY`/`NO_PROXY` the same way the WS path does, via
 * {@link resolveProxyForTarget}; when a proxy applies the request is routed
 * through it with an `https-proxy-agent` dispatcher. Native `fetch` is used by
 * default (mirroring `pair.ts`) and is injectable for tests.
 */
async function getJson(
  url: string,
  options: {
    headers?: Record<string, string>;
    timeoutMs: number;
    fetchFn: typeof fetch;
  },
): Promise<{ status: number; json: unknown } | { error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  timer.unref?.();
  try {
    const res = await options.fetchFn(url, {
      method: 'GET',
      headers: options.headers,
      signal: controller.signal,
    });
    const json: unknown = await res.json().catch(() => null);
    return { status: res.status, json };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { error: 'request timed out' };
    }
    return { error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read-only server probe for `status`/`doctor`.
 *
 * - Reachability ⇐ `GET /daemon/health` (no auth) returns 200.
 * - Protocol compatibility ⇐ {@link isProtocolCompatible} against the server's
 *   advertised `serverProtocol` range from the health body.
 * - Credential validity ⇐ `GET /daemon/whoami` (Bearer `machineId.machineSecret`)
 *   returns 200; 401 (including a revoked machine) ⇒ invalid.
 *
 * NO WebSocket is ever opened here — see {@link ServerProbeResult}.
 */
export async function probeServer(
  config: DaemonConfig,
  options: {
    timeoutMs?: number;
    fetchFn?: typeof fetch;
  } = {},
): Promise<ServerProbeResult> {
  const timeoutMs = options.timeoutMs ?? 8000;
  const fetchFn = options.fetchFn ?? fetch;
  // Resolve a proxy the same way the WS path does so diagnostics traverse the
  // same network boundary as the live daemon (honors HTTPS_PROXY/NO_PROXY).
  resolveProxyForTarget(config.serverUrl);

  const healthUrl = serverEndpoint(config.serverUrl, '/daemon/health');
  const health = await getJson(healthUrl, { timeoutMs, fetchFn });
  if ('error' in health) {
    return {
      reachable: false,
      protocolCompatible: false,
      credentialsValid: false,
      detail: health.error,
    };
  }
  if (health.status !== 200) {
    return {
      reachable: false,
      protocolCompatible: false,
      credentialsValid: false,
      detail: `health returned HTTP ${health.status}`,
    };
  }

  const healthBody = (health.json ?? {}) as HealthBody;
  const serverProtocol = healthBody.serverProtocol;
  // Compatibility = the version this daemon speaks falls inside the server's
  // advertised inclusive range. A missing/malformed range ⇒ incompatible.
  const protocolCompatible =
    typeof serverProtocol?.min === 'number' && typeof serverProtocol?.max === 'number'
      ? isProtocolCompatible(PROTOCOL_VERSION, {
          min: serverProtocol.min,
          max: serverProtocol.max,
        })
      : false;

  const whoamiUrl = serverEndpoint(config.serverUrl, '/daemon/whoami');
  const whoami = await getJson(whoamiUrl, {
    timeoutMs,
    fetchFn,
    headers: { authorization: `Bearer ${config.machineId}.${config.machineSecret}` },
  });

  let credentialsValid = false;
  let credentialDetail: string;
  if ('error' in whoami) {
    // Health succeeded, so the server is reachable; treat a whoami transport
    // error as an indeterminate credential check rather than unreachable.
    credentialDetail = `whoami failed: ${whoami.error}`;
  } else if (whoami.status === 200) {
    credentialsValid = true;
    const body = (whoami.json ?? {}) as WhoamiBody;
    credentialDetail = `whoami ok (${body.name ?? body.machineId ?? 'machine'}${
      body.status ? `, ${body.status}` : ''
    })`;
  } else if (whoami.status === 401) {
    credentialDetail = 'credentials rejected (401; revoked or invalid)';
  } else {
    credentialDetail = `whoami returned HTTP ${whoami.status}`;
  }

  const protocolDetail = serverProtocol
    ? `server speaks v${serverProtocol.min}–${serverProtocol.max}`
    : 'server did not advertise a protocol range';

  return {
    reachable: true,
    protocolCompatible,
    credentialsValid,
    detail: `health ok; ${protocolDetail}; ${credentialDetail}`,
  };
}

/** Resolves the workspaces root the harness writes per-dispatch dirs into. */
export function workspacesDir(): string {
  const home = process.env.OPEN_TAG_HOME?.trim() || join(homedir(), '.open-claude-tag');
  return process.env.WORKSPACES_ROOT?.trim() || join(home, 'workspaces');
}

/** Checks the workspaces directory is creatable and writable. */
export async function checkWorkspaceWritable(): Promise<CheckResult> {
  const dir = workspacesDir();
  try {
    await mkdir(dir, { recursive: true });
    await access(dir, fsConstants.W_OK);
    return { name: 'workspace writable', ok: true, detail: dir };
  } catch (err) {
    return {
      name: 'workspace writable',
      ok: false,
      detail: `${dir}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
