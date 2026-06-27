import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acquireLock,
  processMatchesMarker,
  readPidRecord,
  releaseLock,
  stopRecordedProcess,
  writePidRecord,
  type PidRecord,
  type ProcessOps,
} from '../process-control.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oct-pc-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeRecord(path: string, record: PidRecord): void {
  writePidRecord(path, record);
}

const consoleRecord = (pid: number): PidRecord => ({
  pid,
  role: 'console',
  cwd: '/repo',
  startedAt: Date.now(),
  port: 8080,
});

describe('processMatchesMarker', () => {
  it('matches when cmdline contains the marker', () => {
    const ops: ProcessOps = { cmdline: () => 'node serve-console.mjs' };
    expect(processMatchesMarker(123, 'serve-console.mjs', ops)).toBe(true);
  });
  it('fails closed on a clear mismatch', () => {
    const ops: ProcessOps = { cmdline: () => 'sshd: user@pts/0' };
    expect(processMatchesMarker(123, 'serve-console.mjs', ops)).toBe(false);
  });
  it('fails open when cmdline is unknown', () => {
    const ops: ProcessOps = { cmdline: () => null };
    expect(processMatchesMarker(123, 'serve-console.mjs', ops)).toBe(true);
  });
});

describe('stopRecordedProcess', () => {
  it('returns not-running with no pid file', async () => {
    const result = await stopRecordedProcess(join(dir, 'console.pid.json'), 'serve-console.mjs');
    expect(result.status).toBe('not-running');
  });

  it('removes a stale pid file for a dead process', async () => {
    const path = join(dir, 'console.pid.json');
    writeRecord(path, consoleRecord(4242));
    const deadKill = (_pid: number) => {
      const err = new Error('no such process') as NodeJS.ErrnoException;
      err.code = 'ESRCH';
      throw err;
    };
    const result = await stopRecordedProcess(path, 'serve-console.mjs', { ops: { kill: deadKill } });
    expect(result.status).toBe('stale-removed');
    expect(existsSync(path)).toBe(false);
  });

  it('SIGTERMs an owned live process and removes the pid file', async () => {
    const path = join(dir, 'console.pid.json');
    writeRecord(path, consoleRecord(5555));
    const alive = new Set([5555]);
    const kill = vi.fn((pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 'SIGTERM') {
        alive.delete(pid);
      } else if (signal === 0 && !alive.has(pid)) {
        const err = new Error('dead') as NodeJS.ErrnoException;
        err.code = 'ESRCH';
        throw err;
      }
    });
    const result = await stopRecordedProcess(path, 'serve-console.mjs', {
      ops: {
        kill,
        cmdline: () => 'node /repo/apps/console/serve-console.mjs',
        now: (() => {
          let t = 0;
          return () => (t += 100);
        })(),
        wait: async () => {},
      },
    });
    expect(kill).toHaveBeenCalledWith(5555, 'SIGTERM');
    expect(result.status).toBe('stopped');
    expect(existsSync(path)).toBe(false);
  });

  it('refuses to kill a live pid whose cmdline is not ours (pid reuse)', async () => {
    const path = join(dir, 'console.pid.json');
    writeRecord(path, consoleRecord(6666));
    const kill = vi.fn(() => {}); // pid stays "alive" (kill(0) never throws)
    const result = await stopRecordedProcess(path, 'serve-console.mjs', {
      ops: { kill, cmdline: () => 'postgres -D /var/lib/pg' },
    });
    expect(result.status).toBe('unverified-skipped');
    // never sent a terminating signal
    expect(kill).not.toHaveBeenCalledWith(6666, 'SIGTERM');
    expect(kill).not.toHaveBeenCalledWith(6666, 'SIGKILL');
    expect(existsSync(path)).toBe(false);
  });

  it('escalates to SIGKILL when allowed and SIGTERM is ignored', async () => {
    const path = join(dir, 'console.pid.json');
    writeRecord(path, consoleRecord(7777));
    const alive = new Set([7777]);
    const kill = vi.fn((pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 'SIGKILL') alive.delete(pid);
    });
    const result = await stopRecordedProcess(path, 'serve-console.mjs', {
      timeoutMs: 30,
      allowKill: true,
      ops: {
        kill,
        cmdline: () => 'node serve-console.mjs',
        now: (() => {
          let t = 0;
          return () => (t += 50);
        })(),
        wait: async () => {},
      },
    });
    expect(kill).toHaveBeenCalledWith(7777, 'SIGTERM');
    expect(kill).toHaveBeenCalledWith(7777, 'SIGKILL');
    expect(result.status).toBe('killed');
  });

  it('does not SIGKILL when allowKill is false (db-host)', async () => {
    const path = join(dir, 'db-host.pid.json');
    writeRecord(path, { pid: 8888, role: 'db-host', cwd: '/repo', startedAt: Date.now() });
    const kill = vi.fn(() => {}); // stays alive
    const result = await stopRecordedProcess(path, 'db-host', {
      timeoutMs: 20,
      allowKill: false,
      ops: {
        kill,
        cmdline: () => 'node cli.js db-host',
        now: (() => {
          let t = 0;
          return () => (t += 30);
        })(),
        wait: async () => {},
      },
    });
    expect(kill).toHaveBeenCalledWith(8888, 'SIGTERM');
    expect(kill).not.toHaveBeenCalledWith(8888, 'SIGKILL');
    expect(result.status).toBe('unverified-skipped');
    // pid file is left for the caller's dedicated fallback
    expect(existsSync(path)).toBe(true);
  });
});

describe('acquireLock / releaseLock', () => {
  it('acquires, blocks a second live holder, and releases', () => {
    const lockPath = join(dir, 'up.lock');
    const handle = acquireLock(lockPath, { kill: () => {} });
    expect(existsSync(lockPath)).toBe(true);
    expect(readPidRecord(lockPath)?.pid).toBe(process.pid);

    // a second acquire sees a live holder (kill(0) never throws) ⇒ aborts
    expect(() => acquireLock(lockPath, { kill: () => {} })).toThrow(/already in progress/);

    releaseLock(handle);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('reclaims a stale lock held by a dead pid', () => {
    const lockPath = join(dir, 'up.lock');
    writeFileSync(lockPath, JSON.stringify({ pid: 999999, startedAt: 1 }));
    const deadKill = (_pid: number) => {
      const err = new Error('no such process') as NodeJS.ErrnoException;
      err.code = 'ESRCH';
      throw err;
    };
    const handle = acquireLock(lockPath, { kill: deadKill });
    expect(readPidRecord(lockPath)?.pid).toBe(process.pid);
    releaseLock(handle);
  });

  it('releaseLock leaves a lock owned by someone else', () => {
    const lockPath = join(dir, 'up.lock');
    writeFileSync(lockPath, JSON.stringify({ pid: 123456, startedAt: 1 }));
    releaseLock({ path: lockPath, pid: process.pid });
    // not ours ⇒ untouched
    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath, 'utf8')).toContain('123456');
  });
});
