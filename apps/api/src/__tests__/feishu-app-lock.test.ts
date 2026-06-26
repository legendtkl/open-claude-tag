import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireFeishuAppLock } from '../feishu-app-lock.js';

describe('feishu-app-lock', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'open-claude-tag-feishu-app-lock-'));
    process.env.OPEN_TAG_FEISHU_LOCK_ROOT = tempDir;
    process.env.OPEN_TAG_INSTANCE_ROLE = 'isolated';
    process.env.OPEN_TAG_INSTANCE_ID = 'lock-test';
  });

  afterEach(() => {
    delete process.env.OPEN_TAG_FEISHU_LOCK_ROOT;
    delete process.env.OPEN_TAG_INSTANCE_ROLE;
    delete process.env.OPEN_TAG_INSTANCE_ID;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('acquires and releases a lock for a Feishu app id', () => {
    const result = acquireFeishuAppLock('cli_test_app');

    expect(result.acquired).toBe(true);
    expect(result.lock?.appId).toBe('cli_test_app');

    const owner = JSON.parse(readFileSync(result.lock!.path, 'utf8'));
    expect(owner).toMatchObject({
      appId: 'cli_test_app',
      pid: process.pid,
      instanceRole: 'isolated',
      instanceId: 'lock-test',
    });

    result.lock!.release();
    const reacquired = acquireFeishuAppLock('cli_test_app');
    expect(reacquired.acquired).toBe(true);
    reacquired.lock?.release();
  });

  it('rejects a second live owner for the same Feishu app id', () => {
    const first = acquireFeishuAppLock('cli_test_app');
    expect(first.acquired).toBe(true);

    const second = acquireFeishuAppLock('cli_test_app');
    expect(second.acquired).toBe(false);
    expect(second.owner).toMatchObject({
      appId: 'cli_test_app',
      pid: process.pid,
    });

    first.lock?.release();
  });

  it('reclaims a stale lock whose process no longer exists', () => {
    const first = acquireFeishuAppLock('cli_test_app');
    expect(first.acquired).toBe(true);
    const lockPath = first.lock!.path;
    first.lock?.release();

    writeFileSync(
      lockPath,
      JSON.stringify({
        appId: 'cli_test_app',
        pid: 999_999_999,
        instanceId: 'stale',
      }),
      { flag: 'wx' },
    );

    const second = acquireFeishuAppLock('cli_test_app');
    expect(second.acquired).toBe(true);
    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toMatchObject({
      pid: process.pid,
      instanceId: 'lock-test',
    });
    second.lock?.release();
  });

  it('does not release a lock that was replaced by another owner', () => {
    const first = acquireFeishuAppLock('cli_test_app');
    expect(first.acquired).toBe(true);
    const lockPath = first.lock!.path;
    rmSync(lockPath, { force: true });
    writeFileSync(
      lockPath,
      JSON.stringify({
        appId: 'cli_test_app',
        pid: 12345,
        instanceId: 'other',
      }),
      { flag: 'wx' },
    );

    first.lock?.release();

    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toMatchObject({
      pid: 12345,
      instanceId: 'other',
    });
  });
});
