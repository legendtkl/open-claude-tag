import { spawn, spawnSync } from 'child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import type { PersonalConfig } from './config.js';
import { PERSONAL_INSTANCE_ID } from './config.js';
import { isProcessAlive, writePidRecord } from './process-control.js';

interface StackConfig {
  instanceRole: 'personal';
  instanceId: string;
  cwd: string;
  apiUrl: string;
  apiPidPath: string;
  workerPidPath: string;
}

interface StackControlModule {
  startStack: (options: {
    config: StackConfig;
    env: NodeJS.ProcessEnv;
    timeoutMs?: number;
  }) => Promise<unknown>;
  stopStack: (options: {
    config: StackConfig;
    env: NodeJS.ProcessEnv;
    timeoutMs?: number;
  }) => Promise<unknown>;
}

const STACK_START_TIMEOUT_MS = 120_000;

/** Dynamically load the shared api+worker supervisor (a plain `.mjs`). */
async function loadStackControl(repoRoot: string): Promise<StackControlModule> {
  const modulePath = join(repoRoot, 'tools', 'instance', 'stack-control.mjs');
  return (await import(pathToFileURL(modulePath).href)) as unknown as StackControlModule;
}

function stackConfig(config: PersonalConfig): StackConfig {
  return {
    instanceRole: 'personal',
    instanceId: PERSONAL_INSTANCE_ID,
    cwd: config.repoRoot,
    apiUrl: config.apiUrl,
    apiPidPath: config.apiPidPath,
    workerPidPath: config.workerPidPath,
  };
}

/** The env every spawned service inherits: the effective env plus the personal knobs. */
export function buildServiceEnv(
  config: PersonalConfig,
  effectiveEnv: NodeJS.ProcessEnv,
  databaseUrl: string,
): NodeJS.ProcessEnv {
  return {
    ...effectiveEnv,
    DATABASE_URL: databaseUrl,
    PORT: String(config.apiPort),
    API_PORT: String(config.apiPort),
    API_URL: config.apiUrl,
    OPEN_TAG_FEISHU_ACCESS: config.feishuAccess,
  };
}

export async function startApiWorker(
  config: PersonalConfig,
  effectiveEnv: NodeJS.ProcessEnv,
  databaseUrl: string,
): Promise<void> {
  const { startStack } = await loadStackControl(config.repoRoot);
  await startStack({
    config: stackConfig(config),
    env: buildServiceEnv(config, effectiveEnv, databaseUrl),
    timeoutMs: STACK_START_TIMEOUT_MS,
  });
}

export async function stopApiWorker(
  config: PersonalConfig,
  effectiveEnv: NodeJS.ProcessEnv,
): Promise<unknown> {
  const { stopStack } = await loadStackControl(config.repoRoot);
  return stopStack({ config: stackConfig(config), env: effectiveEnv });
}

// ── Console ──────────────────────────────────────────────────────────────────

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Start the console (apps/console/serve-console.mjs) bound to 127.0.0.1, then
 * confirm it is actually listening before recording its pid. A bare spawn is not
 * enough: if the port is occupied the child exits immediately, so we poll the
 * console URL while checking the child is alive, and only persist the pid file
 * once it answers. serve-console.mjs is left untouched.
 */
export async function startConsole(
  config: PersonalConfig,
  effectiveEnv: NodeJS.ProcessEnv,
): Promise<{ status: 'started' | 'already-running' }> {
  const serveScript = join(config.repoRoot, 'apps', 'console', 'serve-console.mjs');

  mkdirSync(config.runtimeDir, { recursive: true });
  const logFd = openSync(config.consoleLogPath, 'a');
  const child = spawn('node', [serveScript], {
    cwd: config.repoRoot,
    detached: true,
    shell: false,
    stdio: ['ignore', logFd, logFd],
    env: {
      ...effectiveEnv,
      CONSOLE_HOST: '127.0.0.1',
      CONSOLE_PORT: String(config.consolePort),
      API_URL: config.apiUrl,
    },
  });
  closeSync(logFd);
  child.unref();
  const pid = child.pid;
  if (typeof pid !== 'number') {
    throw new Error('Failed to spawn the console process.');
  }

  let childExited = false;
  child.on('exit', () => {
    childExited = true;
  });

  const killChild = () => {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // already gone
    }
  };

  try {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (childExited || !isProcessAlive(pid)) {
        throw new Error(
          `Console process exited during startup (port ${config.consolePort} may be in use). ` +
            `See ${config.consoleLogPath}.`,
        );
      }
      try {
        const res = await fetch(config.consoleUrl);
        // Require a real 200 from our own still-alive child — never record the
        // pid if a foreign server answered or our child has already died.
        if (res.ok && !childExited && isProcessAlive(pid)) {
          writePidRecord(config.consolePidPath, {
            pid,
            role: 'console',
            cwd: config.repoRoot,
            startedAt: Date.now(),
            port: config.consolePort,
          });
          return { status: 'started' };
        }
      } catch {
        // not listening yet
      }
      await wait(300);
    }
    throw new Error(
      `Console did not start listening on ${config.consoleUrl} in time. See ${config.consoleLogPath}.`,
    );
  } catch (error) {
    // Never leak an unrecorded console process that `down` could not clean up.
    killChild();
    throw error;
  }
}

// ── Migrations + seed ─────────────────────────────────────────────────────────

function runRepoCommand(
  config: PersonalConfig,
  effectiveEnv: NodeJS.ProcessEnv,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
): void {
  const result = spawnSync('pnpm', args, {
    cwd: config.repoRoot,
    env: { ...effectiveEnv, ...extraEnv },
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(`\`pnpm ${args.join(' ')}\` failed with exit code ${result.status ?? 'unknown'}.`);
  }
}

export function migrateAndSeed(
  config: PersonalConfig,
  effectiveEnv: NodeJS.ProcessEnv,
  databaseUrl: string,
): void {
  const env = { DATABASE_URL: databaseUrl };
  runRepoCommand(config, effectiveEnv, ['--filter', '@open-tag/storage', 'run', 'db:migrate'], env);
  runRepoCommand(config, effectiveEnv, ['--filter', '@open-tag/storage', 'run', 'db:seed'], env);
}

// ── Build ──────────────────────────────────────────────────────────────────────

export interface BuildSentinelDeps {
  exists?: (path: string) => boolean;
  readDir?: (path: string) => string[];
  readFile?: (path: string) => string;
}

/**
 * Find workspace packages whose built `dist` entry is missing. The api/worker
 * run from source (tsx) but import their workspace deps through `dist`, and the
 * console is served from `apps/console/dist`. This detects "not built yet"
 * (prebuilt vs not); it does NOT detect source that changed after a build — use
 * `up --build` (or `pnpm build`) after editing code.
 */
export function missingBuildSentinels(repoRoot: string, deps: BuildSentinelDeps = {}): string[] {
  const exists = deps.exists ?? existsSync;
  const readDir = deps.readDir ?? ((p: string) => readdirSync(p));
  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, 'utf8'));

  const missing: string[] = [];

  const consoleIndex = join(repoRoot, 'apps', 'console', 'dist', 'index.html');
  if (!exists(consoleIndex)) missing.push(consoleIndex);

  const packagesDir = join(repoRoot, 'packages');
  let pkgNames: string[];
  try {
    pkgNames = readDir(packagesDir);
  } catch {
    pkgNames = [];
  }
  for (const name of pkgNames) {
    const pkgJsonPath = join(packagesDir, name, 'package.json');
    if (!exists(pkgJsonPath)) continue;
    let pkgJson: { scripts?: Record<string, string>; main?: string };
    try {
      pkgJson = JSON.parse(readFile(pkgJsonPath));
    } catch {
      continue;
    }
    // Only packages that actually build a dist entry.
    if (!pkgJson.scripts?.build || !pkgJson.main) continue;
    const mainPath = join(packagesDir, name, pkgJson.main);
    if (!exists(mainPath)) missing.push(mainPath);
  }

  return missing;
}

export function ensureBuilt(
  config: PersonalConfig,
  effectiveEnv: NodeJS.ProcessEnv,
  options: { force?: boolean; skip?: boolean; log?: (m: string) => void } = {},
): void {
  const log = options.log ?? (() => {});
  if (options.skip) {
    log('Skipping build (--no-build).');
    return;
  }
  const missing = options.force ? ['(forced)'] : missingBuildSentinels(config.repoRoot);
  if (missing.length === 0) {
    log('Build artifacts present; skipping build.');
    return;
  }
  log(options.force ? 'Building (forced)…' : `Building (missing ${missing.length} dist artifact(s))…`);
  runRepoCommand(config, effectiveEnv, ['build']);
}

// re-export for callers that clean up the console log on teardown
export function removeIfExists(path: string): void {
  if (existsSync(path)) rmSync(path, { force: true });
}
