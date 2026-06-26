import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';
import {
  backgroundStatus,
  isProcessRunning,
  resolvePidPath,
  startBackgroundDaemon,
  stopBackgroundDaemon,
} from '../background.js';

const fixture = fileURLToPath(new URL('./fixtures/background-sleeper.js', import.meta.url));

describe('background daemon process manager', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'daemon-bg-'));
  });

  afterEach(async () => {
    await stopBackgroundDaemon(home);
    await rm(home, { recursive: true, force: true });
  });

  it('starts a detached process, writes status files, and stops it', async () => {
    const started = await startBackgroundDaemon({ home, entryPath: fixture, args: [] });
    expect(started.started).toBe(true);
    expect(started.pid).toBeGreaterThan(0);
    expect(isProcessRunning(started.pid ?? 0)).toBe(true);

    const status = await backgroundStatus(home);
    expect(status.running).toBe(true);
    expect(status.ready).toBe(true);
    expect(status.unverified).toBe(false);
    expect(status.pid).toBe(started.pid);

    const duplicate = await startBackgroundDaemon({ home, entryPath: fixture, args: [] });
    expect(duplicate.started).toBe(false);
    expect(duplicate.pid).toBe(started.pid);

    await vi.waitFor(async () => {
      await expect(readFile(started.logPath, 'utf8')).resolves.toContain(
        'background fixture started',
      );
    });

    const stopped = await stopBackgroundDaemon(home);
    expect(stopped.stopped).toBe(true);
    expect(await backgroundStatus(home)).toMatchObject({ pid: null, running: false, stale: false });
  });

  it('removes a stale pid file before starting', async () => {
    await writeFile(resolvePidPath(home), '999999\n');
    const started = await startBackgroundDaemon({ home, entryPath: fixture, args: [] });
    expect(started.started).toBe(true);
    expect(started.pid).not.toBe(999999);
  });

  it('refuses to manage a running pid that cannot be verified as its child', async () => {
    await writeFile(resolvePidPath(home), `${process.pid}\n`);

    await expect(
      startBackgroundDaemon({ home, entryPath: fixture, args: [] }),
    ).rejects.toThrow(/unverified daemon pid/);

    const stopped = await stopBackgroundDaemon(home);
    expect(stopped.stopped).toBe(false);
    expect(stopped.unverified).toBe(true);
    expect(isProcessRunning(process.pid)).toBe(true);
  });

  it('restarts an existing managed daemon when requested', async () => {
    const first = await startBackgroundDaemon({ home, entryPath: fixture, args: [] });
    const second = await startBackgroundDaemon({
      home,
      entryPath: fixture,
      args: [],
      restartExisting: true,
    });

    expect(second.started).toBe(true);
    expect(second.pid).not.toBe(first.pid);
    expect(first.pid ? isProcessRunning(first.pid) : false).toBe(false);
    expect(second.pid ? isProcessRunning(second.pid) : false).toBe(true);
  });

  it('fails when the spawned daemon exits before becoming ready', async () => {
    await expect(
      startBackgroundDaemon({
        home,
        entryPath: join(home, 'missing-entry.js'),
        args: [],
        readyTimeoutMs: 1_000,
      }),
    ).rejects.toThrow(/exited before startup completed|process identity/);
  });
});
