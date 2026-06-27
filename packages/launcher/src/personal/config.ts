import { join } from 'path';
import { resolveDbMode } from '../select.js';
import { resolveEmbeddedConfig, type EmbeddedConfig } from '../config.js';
import type { DbMode } from '../types.js';

/**
 * The instance id stamped on the personal stack. Forced (never inherited from
 * the ambient env) so the launcher can verify `/health.instanceId` and the
 * personal pid files never collide with a `start:local` "primary".
 */
export const PERSONAL_INSTANCE_ID = 'personal';

/** Root of the personal runtime tree; one sub-dir per personal stack (by api port). */
export const PERSONAL_RUNTIME_ROOT = '/tmp/open-claude-tag/personal';

export const DEFAULT_API_PORT = 3000;
export const DEFAULT_CONSOLE_PORT = 8080;

export interface PersonalConfig {
  dbMode: DbMode;
  repoRoot: string;
  apiPort: number;
  consolePort: number;
  apiUrl: string;
  consoleUrl: string;
  healthUrl: string;
  feishuAccess: 'enabled' | 'disabled';
  runtimeDir: string;
  lockPath: string;
  apiPidPath: string;
  workerPidPath: string;
  consolePidPath: string;
  dbHostPidPath: string;
  consoleLogPath: string;
  dbHostLogPath: string;
  /** Present only in embedded mode: the cluster the launcher owns. */
  embedded?: EmbeddedConfig;
}

function parsePort(raw: string | undefined, fallback: number, label: string): number {
  const trimmed = raw?.trim();
  if (!trimmed) return fallback;
  const port = Number(trimmed);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`Invalid ${label}: "${raw}". Expected an integer in 1-65535.`);
  }
  return port;
}

/**
 * Resolve everything the personal launcher needs from the effective env. Pure:
 * same inputs in, same config out. The runtime dir (and therefore every pid
 * file) is keyed by the api port so two stacks on different ports never share
 * pid files — which is also what lets the e2e proof run on an isolated port.
 */
export function resolvePersonalConfig(
  env: NodeJS.ProcessEnv,
  options: { repoRoot: string },
): PersonalConfig {
  const dbMode = resolveDbMode(env);
  const apiPort = parsePort(
    env.OPEN_TAG_API_PORT ?? env.API_PORT ?? env.PORT,
    DEFAULT_API_PORT,
    'OPEN_TAG_API_PORT',
  );
  const consolePort = parsePort(
    env.OPEN_TAG_CONSOLE_PORT ?? env.CONSOLE_PORT,
    DEFAULT_CONSOLE_PORT,
    'OPEN_TAG_CONSOLE_PORT',
  );

  const runtimeDir = join(PERSONAL_RUNTIME_ROOT, String(apiPort));
  const apiUrl = `http://127.0.0.1:${apiPort}`;
  const consoleUrl = `http://127.0.0.1:${consolePort}`;

  // Stage A only boots the stack. Live Feishu is opt-in (the Stage B onboarding
  // wizard wires it); default disabled so `up` never opens a websocket with real
  // credentials by accident and the e2e proof stays hermetic.
  const feishuAccess = env.OPEN_TAG_FEISHU_ACCESS === 'enabled' ? 'enabled' : 'disabled';

  return {
    dbMode,
    repoRoot: options.repoRoot,
    apiPort,
    consolePort,
    apiUrl,
    consoleUrl,
    healthUrl: `${apiUrl}/health`,
    feishuAccess,
    runtimeDir,
    lockPath: join(runtimeDir, 'up.lock'),
    apiPidPath: join(runtimeDir, 'api.pid.json'),
    workerPidPath: join(runtimeDir, 'worker.pid.json'),
    consolePidPath: join(runtimeDir, 'console.pid.json'),
    dbHostPidPath: join(runtimeDir, 'db-host.pid.json'),
    consoleLogPath: join(runtimeDir, 'console.log'),
    dbHostLogPath: join(runtimeDir, 'db-host.log'),
    embedded: dbMode === 'embedded' ? resolveEmbeddedConfig(env) : undefined,
  };
}
