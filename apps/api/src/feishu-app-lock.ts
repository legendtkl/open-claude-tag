import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

export interface FeishuAppLockOwner {
  appId: string;
  pid: number;
  cwd?: string;
  instanceRole?: string;
  instanceId?: string;
  acquiredAt?: string;
}

export interface FeishuAppLock {
  appId: string;
  path: string;
  release(): void;
}

export interface AcquireFeishuAppLockResult {
  acquired: boolean;
  lock?: FeishuAppLock;
  owner?: FeishuAppLockOwner;
}

const DEFAULT_LOCK_ROOT = '/tmp/open-claude-tag/feishu-app-locks';

function lockRoot(): string {
  return process.env.OPEN_TAG_FEISHU_LOCK_ROOT ?? DEFAULT_LOCK_ROOT;
}

function lockPathForApp(appId: string): string {
  const digest = createHash('sha256').update(appId).digest('hex').slice(0, 24);
  return join(lockRoot(), `${digest}.json`);
}

function readOwner(path: string): FeishuAppLockOwner | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as FeishuAppLockOwner;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ESRCH'
    ) {
      return false;
    }
    return true;
  }
}

function removeStaleLock(path: string): boolean {
  const owner = readOwner(path);
  if (owner?.pid && isProcessAlive(owner.pid)) return false;
  rmSync(path, { force: true });
  return true;
}

export function acquireFeishuAppLock(appId: string): AcquireFeishuAppLockResult {
  if (!appId.trim()) {
    return { acquired: false };
  }

  const path = lockPathForApp(appId);
  mkdirSync(lockRoot(), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(
        path,
        JSON.stringify(
          {
            appId,
            pid: process.pid,
            cwd: process.cwd(),
            instanceRole: process.env.OPEN_TAG_INSTANCE_ROLE ?? 'primary',
            instanceId: process.env.OPEN_TAG_INSTANCE_ID ?? 'primary',
            acquiredAt: new Date().toISOString(),
          } satisfies FeishuAppLockOwner,
          null,
          2,
        ),
        { flag: 'wx' },
      );

      return {
        acquired: true,
        lock: {
          appId,
          path,
          release() {
            const owner = readOwner(path);
            if (!owner || owner.pid === process.pid) {
              rmSync(path, { force: true });
            }
          },
        },
      };
    } catch (error) {
      if (
        typeof error !== 'object' ||
        error === null ||
        !('code' in error) ||
        (error as NodeJS.ErrnoException).code !== 'EEXIST'
      ) {
        throw error;
      }

      if (attempt === 0 && removeStaleLock(path)) {
        continue;
      }
      return { acquired: false, owner: readOwner(path) };
    }
  }

  return { acquired: false, owner: existsSync(path) ? readOwner(path) : undefined };
}
