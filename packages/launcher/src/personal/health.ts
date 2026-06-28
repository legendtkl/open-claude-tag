import { PERSONAL_INSTANCE_ID } from './config.js';

export interface HealthSnapshot {
  status?: string;
  db?: string;
  instanceId?: string;
  instanceRole?: string;
  port?: number;
  worker?: { status?: string };
  feishu?: { access?: string; websocket?: string };
  [key: string]: unknown;
}

export type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

export interface HealthDeps {
  fetch?: FetchLike;
  wait?: (ms: number) => Promise<void>;
  now?: () => number;
}

const defaultWait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Fetch and parse `/health`. Returns null on any network/parse error. */
export async function getHealth(
  healthUrl: string,
  deps: HealthDeps = {},
): Promise<HealthSnapshot | null> {
  const fetchImpl = deps.fetch ?? (globalThis.fetch as unknown as FetchLike);
  try {
    const res = await fetchImpl(healthUrl);
    if (!res.ok) return null;
    return (await res.json()) as HealthSnapshot;
  } catch {
    return null;
  }
}

export async function isHttpEndpointReachable(
  url: string,
  deps: Pick<HealthDeps, 'fetch'> = {},
): Promise<boolean> {
  const fetchImpl = deps.fetch ?? (globalThis.fetch as unknown as FetchLike);
  try {
    const res = await fetchImpl(url);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Whether a health snapshot is our personal stack, fully ready. The instance-id
 * check is load-bearing: the api registers its pid before it listens, so a port
 * collision could otherwise let a DIFFERENT api answer `/health`. We only accept
 * `instanceId === 'personal'` with a connected DB and a worker that is not down.
 */
export function isPersonalHealthReady(health: HealthSnapshot | null): boolean {
  if (!health) return false;
  if (health.instanceId !== PERSONAL_INSTANCE_ID) return false;
  if (health.db !== 'connected') return false;
  if (health.worker?.status === 'down') return false;
  return health.status === 'ok';
}

/** Poll `/health` until it is the ready personal stack or the timeout elapses. */
export async function waitForPersonalHealth(
  healthUrl: string,
  timeoutMs: number,
  deps: HealthDeps = {},
): Promise<HealthSnapshot | null> {
  const wait = deps.wait ?? defaultWait;
  const now = deps.now ?? (() => Date.now());
  const startedAt = now();
  let last: HealthSnapshot | null = null;
  while (now() - startedAt < timeoutMs) {
    last = await getHealth(healthUrl, deps);
    if (isPersonalHealthReady(last)) return last;
    await wait(500);
  }
  return last;
}
