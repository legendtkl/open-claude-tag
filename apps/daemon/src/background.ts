import { execFile, spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { chmod, mkdir, open, readFile, rm, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { resolveDaemonHome } from './config.js';

const PID_FILE_MODE = 0o600;
const STOP_TIMEOUT_MS = 5_000;
const START_READY_TIMEOUT_MS = 8_000;
const LOCK_RETRY_MS = 100;
const LOCK_TIMEOUT_MS = 5_000;

type BackgroundState = 'starting' | 'ready' | 'failed';

interface BackgroundPidMetadata {
  pid: number;
  nonce: string;
  processStartedAt: string;
  state: BackgroundState;
  createdAt: string;
  readyAt?: string;
  failedAt?: string;
  error?: string;
}

export interface BackgroundStatus {
  pid: number | null;
  running: boolean;
  stale: boolean;
  unverified: boolean;
  ready: boolean;
  state: BackgroundState | null;
  pidPath: string;
  logPath: string;
}

export interface BackgroundStartResult extends BackgroundStatus {
  started: boolean;
}

export interface BackgroundStopResult extends BackgroundStatus {
  stopped: boolean;
}

export interface StartBackgroundDaemonOptions {
  home?: string;
  entryPath?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  restartExisting?: boolean;
  readyTimeoutMs?: number;
}

export class BackgroundProcessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackgroundProcessError';
  }
}

export function resolvePidPath(home = resolveDaemonHome()): string {
  return join(home, 'daemon.pid');
}

export function resolveLogPath(home = resolveDaemonHome()): string {
  return join(home, 'daemon.log');
}

function resolveLockPath(home = resolveDaemonHome()): string {
  return join(home, 'daemon.pid.lock');
}

export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function readPidMetadata(
  path = resolvePidPath(),
): Promise<{ pid: number; metadata: BackgroundPidMetadata | null; legacy: boolean } | null> {
  try {
    const raw = await readFile(path, 'utf8');
    const trimmed = raw.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith('{')) {
      const parsed = JSON.parse(trimmed) as Partial<BackgroundPidMetadata>;
      const pid = Number(parsed.pid);
      if (!Number.isSafeInteger(pid) || pid <= 0) return null;
      if (
        typeof parsed.nonce !== 'string' ||
        typeof parsed.processStartedAt !== 'string' ||
        typeof parsed.createdAt !== 'string' ||
        (parsed.state !== 'starting' && parsed.state !== 'ready' && parsed.state !== 'failed')
      ) {
        return { pid, metadata: null, legacy: true };
      }
      return { pid, metadata: parsed as BackgroundPidMetadata, legacy: false };
    }
    const pid = Number.parseInt(trimmed, 10);
    return Number.isSafeInteger(pid) && pid > 0 ? { pid, metadata: null, legacy: true } : null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

async function writePidMetadata(path: string, metadata: BackgroundPidMetadata): Promise<void> {
  await writeFile(path, `${JSON.stringify(metadata, null, 2)}\n`, { mode: PID_FILE_MODE });
  await chmod(path, PID_FILE_MODE);
}

async function getProcessStartedAt(pid: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('ps', ['-p', String(pid), '-o', 'lstart='], (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      const value = stdout.trim().replace(/\s+/g, ' ');
      resolve(value || null);
    });
  });
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function withPidLock<T>(home: string, fn: () => Promise<T>): Promise<T> {
  await mkdir(home, { recursive: true });
  const lockPath = resolveLockPath(home);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let handle: Awaited<ReturnType<typeof open>> | null = null;

  while (!handle) {
    try {
      handle = await open(lockPath, 'wx', PID_FILE_MODE);
      await handle.writeFile(`${process.pid}\n`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const lockPid = await readFile(lockPath, 'utf8')
        .then((raw) => Number.parseInt(raw.trim(), 10))
        .catch(() => null);
      if (!lockPid || !isProcessRunning(lockPid)) {
        await rm(lockPath, { force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new BackgroundProcessError('Timed out waiting for daemon pid-file lock.');
      }
      await sleep(LOCK_RETRY_MS);
    }
  }

  try {
    return await fn();
  } finally {
    await handle.close();
    await rm(lockPath, { force: true });
  }
}

export async function backgroundStatus(home?: string): Promise<BackgroundStatus> {
  const pidPath = resolvePidPath(home);
  const logPath = resolveLogPath(home);
  const parsed = await readPidMetadata(pidPath);
  const pid = parsed?.pid ?? null;
  const processRunning = pid !== null && isProcessRunning(pid);
  let verified = false;
  if (processRunning && parsed?.metadata) {
    const currentStartedAt = await getProcessStartedAt(pid);
    verified =
      currentStartedAt !== null && currentStartedAt === parsed.metadata.processStartedAt;
  }
  const running = processRunning && verified;
  return {
    pid,
    running,
    stale: pid !== null && !processRunning,
    unverified: pid !== null && processRunning && !verified,
    ready: running && parsed?.metadata?.state === 'ready',
    state: parsed?.metadata?.state ?? null,
    pidPath,
    logPath,
  };
}

export async function clearBackgroundPid(
  pid = process.pid,
  home?: string,
  nonce = process.env.OPEN_TAG_DAEMON_BACKGROUND_NONCE,
): Promise<void> {
  const pidPath = resolvePidPath(home);
  const parsed = await readPidMetadata(pidPath);
  if (parsed?.pid !== pid) return;
  if (parsed.metadata?.nonce && parsed.metadata.nonce !== nonce) return;
  await rm(pidPath, { force: true });
}

export async function markBackgroundReady(
  pid = process.pid,
  home?: string,
  nonce = process.env.OPEN_TAG_DAEMON_BACKGROUND_NONCE,
): Promise<void> {
  if (!nonce) return;
  const pidPath = resolvePidPath(home);
  const parsed = await readPidMetadata(pidPath);
  if (!parsed?.metadata || parsed.pid !== pid || parsed.metadata.nonce !== nonce) return;
  await writePidMetadata(pidPath, {
    ...parsed.metadata,
    state: 'ready',
    readyAt: new Date().toISOString(),
  });
}

export async function markBackgroundFailed(
  error: string,
  pid = process.pid,
  home?: string,
  nonce = process.env.OPEN_TAG_DAEMON_BACKGROUND_NONCE,
): Promise<void> {
  if (!nonce) return;
  const pidPath = resolvePidPath(home);
  const parsed = await readPidMetadata(pidPath);
  if (!parsed?.metadata || parsed.pid !== pid || parsed.metadata.nonce !== nonce) return;
  await writePidMetadata(pidPath, {
    ...parsed.metadata,
    state: 'failed',
    failedAt: new Date().toISOString(),
    error,
  });
}

async function waitForStartup(
  pid: number,
  pidPath: string,
  timeoutMs: number,
): Promise<{ ready: boolean; error?: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const parsed = await readPidMetadata(pidPath);
    if (!parsed || parsed.pid !== pid) {
      return { ready: false, error: 'Background daemon exited before startup completed.' };
    }
    if (!isProcessRunning(pid)) {
      await rm(pidPath, { force: true });
      return { ready: false, error: 'Background daemon exited before startup completed.' };
    }
    if (parsed.metadata?.state === 'ready') return { ready: true };
    if (parsed.metadata?.state === 'failed') {
      await rm(pidPath, { force: true });
      return {
        ready: false,
        error: parsed.metadata.error ?? 'Background daemon failed during startup.',
      };
    }
    await sleep(100);
  }
  return { ready: false };
}

export async function startBackgroundDaemon(
  options: StartBackgroundDaemonOptions = {},
): Promise<BackgroundStartResult> {
  const home = options.home ?? resolveDaemonHome();
  let startedStatus: BackgroundStatus | null = null;
  const childPid = await withPidLock(home, async () => {
    const existing = await backgroundStatus(home);
    if (existing.unverified) {
      throw new BackgroundProcessError(
        `Refusing to manage unverified daemon pid ${existing.pid}. Stop that process manually and remove ${existing.pidPath}.`,
      );
    }
    if (existing.running && !options.restartExisting) {
      startedStatus = existing;
      return null;
    }
    if (existing.running && options.restartExisting) {
      const stopped = await stopBackgroundDaemonUnlocked(home);
      if (!stopped.stopped) {
        throw new BackgroundProcessError(
          `Could not stop existing background daemon pid ${existing.pid}.`,
        );
      }
    }
    if (existing.stale) {
      await rm(existing.pidPath, { force: true });
    }

    await mkdir(dirname(existing.pidPath), { recursive: true });
    const logFile = await open(existing.logPath, 'a');
    let spawnedPid: number;
    try {
      const nonce = randomUUID();
      const entryPath = options.entryPath ?? process.argv[1] ?? '';
      const child = spawn(process.execPath, [entryPath, ...(options.args ?? ['start'])], {
        detached: true,
        env: {
          ...process.env,
          ...(options.home ? { OPEN_TAG_HOME: options.home } : {}),
          ...options.env,
          OPEN_TAG_DAEMON_BACKGROUND_CHILD: '1',
          OPEN_TAG_DAEMON_BACKGROUND_NONCE: nonce,
        },
        stdio: ['ignore', logFile.fd, logFile.fd],
      });
      if (!child.pid) {
        throw new Error('Failed to spawn background daemon process');
      }
      spawnedPid = child.pid;
      const processStartedAt = await getProcessStartedAt(spawnedPid);
      if (!processStartedAt) {
        child.kill('SIGTERM');
        throw new BackgroundProcessError('Background daemon exited before its process identity could be captured.');
      }
      await writePidMetadata(existing.pidPath, {
        pid: spawnedPid,
        nonce,
        processStartedAt,
        state: 'starting',
        createdAt: new Date().toISOString(),
      });
      child.unref();
    } finally {
      await logFile.close();
    }
    return spawnedPid;
  });

  if (childPid === null) {
    if (!startedStatus) {
      throw new BackgroundProcessError('Background daemon start did not produce a process.');
    }
    const existingStatus: BackgroundStatus = startedStatus;
    return { ...existingStatus, started: false };
  }

  const startup = await waitForStartup(
    childPid,
    resolvePidPath(home),
    options.readyTimeoutMs ?? START_READY_TIMEOUT_MS,
  );
  if (startup.error) {
    throw new BackgroundProcessError(`${startup.error} Logs: ${resolveLogPath(home)}`);
  }

  const status = await backgroundStatus(home);
  return { ...status, started: true };
}

async function waitUntilStopped(pid: number, timeoutMs = STOP_TIMEOUT_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !isProcessRunning(pid);
}

async function stopBackgroundDaemonUnlocked(home: string): Promise<BackgroundStopResult> {
  const status = await backgroundStatus(home);
  if (!status.pid) {
    return { ...status, stopped: false };
  }
  if (status.unverified) {
    return { ...status, stopped: false };
  }
  if (!status.running) {
    await rm(status.pidPath, { force: true });
    return { ...status, stopped: false };
  }

  process.kill(status.pid, 'SIGTERM');
  const stopped = await waitUntilStopped(status.pid);
  if (stopped) {
    await rm(status.pidPath, { force: true });
  }
  const next = await backgroundStatus(home);
  return { ...next, pid: status.pid, stopped };
}

export async function stopBackgroundDaemon(home?: string): Promise<BackgroundStopResult> {
  const resolvedHome = home ?? resolveDaemonHome();
  return withPidLock(resolvedHome, () => stopBackgroundDaemonUnlocked(resolvedHome));
}
