import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { dirname } from 'path';
import { execFileSync } from 'child_process';

export interface PidRecord {
  pid: number;
  role: 'console' | 'db-host';
  cwd: string;
  startedAt: number;
  /** db-host only: the Postgres data dir + port it owns, and whether it started it. */
  dataDir?: string;
  port?: number;
  startedByUs?: boolean;
  databaseUrl?: string;
}

export interface ProcessOps {
  kill?: (pid: number, signal?: NodeJS.Signals | number) => void;
  /** Returns the process's full command line, or null if it cannot be read. */
  cmdline?: (pid: number) => string | null;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
}

const defaultWait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function isMissingProcessError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'ESRCH'
  );
}

/** Whether a pid is alive. `kill(pid, 0)` probes without signalling. */
export function isProcessAlive(pid: number, ops: ProcessOps = {}): boolean {
  const kill = ops.kill ?? process.kill.bind(process);
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    if (isMissingProcessError(error)) return false;
    // EPERM ⇒ the process exists but is owned by someone else; treat as alive.
    return true;
  }
}

/** Best-effort read of a process's argv as a single string. Null when unknown. */
export function readCmdline(pid: number): string | null {
  const procPath = `/proc/${pid}/cmdline`;
  if (existsSync(procPath)) {
    try {
      // /proc cmdline is NUL-separated.
      return readFileSync(procPath, 'utf8').replace(/\0/g, ' ').trim();
    } catch {
      return null;
    }
  }
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

export function readPidRecord(filePath: string): PidRecord | null {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as PidRecord;
  } catch {
    return null;
  }
}

export function writePidRecord(filePath: string, record: PidRecord): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(record, null, 2)}\n`);
}

/**
 * Whether `pid` is plausibly the process we recorded. Fail-CLOSED on a clear
 * mismatch (cmdline is readable and does not mention our marker ⇒ a different,
 * possibly recycled, pid) and fail-OPEN when the cmdline cannot be read.
 */
export function processMatchesMarker(pid: number, marker: string, ops: ProcessOps = {}): boolean {
  const cmdline = (ops.cmdline ?? readCmdline)(pid);
  if (cmdline === null) return true;
  return cmdline.includes(marker);
}

async function waitForExit(
  pid: number,
  timeoutMs: number,
  ops: ProcessOps,
): Promise<boolean> {
  const now = ops.now ?? (() => Date.now());
  const wait = ops.wait ?? defaultWait;
  const startedAt = now();
  while (now() - startedAt < timeoutMs) {
    if (!isProcessAlive(pid, ops)) return true;
    await wait(250);
  }
  return !isProcessAlive(pid, ops);
}

export interface StopResult {
  status: 'not-running' | 'stale-removed' | 'unverified-skipped' | 'stopped' | 'killed';
  pid?: number;
}

/**
 * Stop a launcher-owned process by its pid file: verify ownership (alive + the
 * cmdline matches our marker), SIGTERM, wait, then escalate to SIGKILL. Refuses
 * to signal a live pid whose cmdline clearly is not ours (pid reuse). Always
 * removes our own pid file at the end. `allowKill=false` (db-host) means we
 * never SIGKILL — the caller handles a wedged process via a dedicated path.
 */
export async function stopRecordedProcess(
  pidPath: string,
  marker: string,
  opts: { timeoutMs?: number; allowKill?: boolean; ops?: ProcessOps } = {},
): Promise<StopResult> {
  const ops = opts.ops ?? {};
  const kill = ops.kill ?? process.kill.bind(process);
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const allowKill = opts.allowKill ?? true;

  const record = readPidRecord(pidPath);
  if (!record || typeof record.pid !== 'number') {
    if (existsSync(pidPath)) {
      rmSync(pidPath, { force: true });
      return { status: 'stale-removed' };
    }
    return { status: 'not-running' };
  }

  const pid = record.pid;
  if (!isProcessAlive(pid, ops)) {
    rmSync(pidPath, { force: true });
    return { status: 'stale-removed', pid };
  }

  if (!processMatchesMarker(pid, marker, ops)) {
    // The recorded pid is alive but belongs to something else now. Don't kill it.
    rmSync(pidPath, { force: true });
    return { status: 'unverified-skipped', pid };
  }

  kill(pid, 'SIGTERM');
  if (await waitForExit(pid, timeoutMs, ops)) {
    rmSync(pidPath, { force: true });
    return { status: 'stopped', pid };
  }

  if (!allowKill) {
    // Leave the pid file for the caller's dedicated fallback (e.g. db-host).
    return { status: 'unverified-skipped', pid };
  }

  kill(pid, 'SIGKILL');
  await waitForExit(pid, 5_000, ops);
  rmSync(pidPath, { force: true });
  return { status: 'killed', pid };
}

export interface LockHandle {
  path: string;
  pid: number;
}

export interface LockOps extends ProcessOps {
  open?: (path: string) => number;
  close?: (fd: number) => void;
  writeFile?: (path: string, content: string) => void;
}

/**
 * Acquire an exclusive `up` lock so two concurrent launches cannot both spawn a
 * database / services. Uses `openSync(path, 'wx')` (atomic create-or-fail). A
 * stale lock held by a dead pid is reclaimed once; a lock held by a live pid
 * aborts fast.
 */
export function acquireLock(lockPath: string, ops: LockOps = {}): LockHandle {
  const open = ops.open ?? ((p: string) => openSync(p, 'wx'));
  const close = ops.close ?? closeSync;
  const writeFile = ops.writeFile ?? ((p: string, c: string) => writeFileSync(p, c));
  mkdirSync(dirname(lockPath), { recursive: true });

  const tryCreate = (): boolean => {
    try {
      const fd = open(lockPath);
      close(fd);
      return true;
    } catch (error) {
      if (error && typeof error === 'object' && (error as { code?: string }).code === 'EEXIST') {
        return false;
      }
      throw error;
    }
  };

  if (!tryCreate()) {
    const holder = readPidRecord(lockPath) as { pid?: number } | null;
    const holderPid = typeof holder?.pid === 'number' ? holder.pid : undefined;
    if (holderPid !== undefined && isProcessAlive(holderPid, ops)) {
      throw new Error(
        `Another \`up\` is already in progress for this stack (pid ${holderPid}, lock ${lockPath}).`,
      );
    }
    // Stale lock: reclaim once.
    rmSync(lockPath, { force: true });
    if (!tryCreate()) {
      throw new Error(`Could not acquire the stack lock at ${lockPath}.`);
    }
  }

  writeFile(lockPath, `${JSON.stringify({ pid: process.pid, startedAt: Date.now() }, null, 2)}\n`);
  return { path: lockPath, pid: process.pid };
}

export function releaseLock(handle: LockHandle | null): void {
  if (!handle) return;
  const holder = readPidRecord(handle.path) as { pid?: number } | null;
  if (!holder || holder.pid === handle.pid) {
    rmSync(handle.path, { force: true });
  }
}
