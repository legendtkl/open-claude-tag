import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stopEmbeddedPostmaster } from '../embedded-stop.js';
import type { ProcessOps } from '../process-control.js';

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'oct-pg-'));
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function writePostmaster(pid: number): void {
  writeFileSync(join(dataDir, 'postmaster.pid'), `${pid}\n${dataDir}\n5599\n`);
}

const fastClock = (): Pick<ProcessOps, 'now' | 'wait'> => ({
  now: (() => {
    let t = 0;
    return () => (t += 100);
  })(),
  wait: async () => {},
});

describe('stopEmbeddedPostmaster', () => {
  it('returns no-postmaster when the cluster file is absent', async () => {
    const result = await stopEmbeddedPostmaster(dataDir, { ops: { kill: () => {} } });
    expect(result.status).toBe('no-postmaster');
  });

  it('refuses to signal when ownership cannot be proven (cmdline unreadable)', async () => {
    writePostmaster(4242);
    const kill = vi.fn(() => {});
    const result = await stopEmbeddedPostmaster(dataDir, {
      ops: { kill, cmdline: () => null, ...fastClock() },
    });
    expect(result.status).toBe('unverified');
    expect(kill).not.toHaveBeenCalledWith(4242, 'SIGINT');
  });

  it('refuses to signal a foreign postgres (cmdline does not include our data dir)', async () => {
    writePostmaster(4243);
    const kill = vi.fn(() => {});
    const result = await stopEmbeddedPostmaster(dataDir, {
      ops: { kill, cmdline: () => 'postgres -D /var/lib/postgresql/16/main', ...fastClock() },
    });
    expect(result.status).toBe('unverified');
    expect(kill).not.toHaveBeenCalledWith(4243, 'SIGINT');
  });

  it('SIGINTs our own cluster when the cmdline proves ownership', async () => {
    writePostmaster(4244);
    const alive = new Set([4244]);
    const kill = vi.fn((pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 'SIGINT') alive.delete(pid);
      else if (signal === 0 && !alive.has(pid)) {
        const err = new Error('dead') as NodeJS.ErrnoException;
        err.code = 'ESRCH';
        throw err;
      }
    });
    const result = await stopEmbeddedPostmaster(dataDir, {
      ops: { kill, cmdline: () => `postgres -D ${dataDir} -p 5599`, ...fastClock() },
    });
    expect(kill).toHaveBeenCalledWith(4244, 'SIGINT');
    expect(result.status).toBe('stopped');
  });
});
