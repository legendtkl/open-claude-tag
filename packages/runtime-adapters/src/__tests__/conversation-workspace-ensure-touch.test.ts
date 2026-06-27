import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { homedir } from 'os';
import { join } from 'path';

const { utimesMock } = vi.hoisted(() => ({ utimesMock: vi.fn() }));

// Mock only `utimes`; keep mkdir/stat/rm/readdir real so the workspace is
// created and inspected on a real temp dir. This lets us drive the
// touch-on-use ENOENT retry deterministically.
vi.mock('fs/promises', async (importActual) => {
  const actual = await importActual<typeof import('fs/promises')>();
  return { ...actual, utimes: utimesMock };
});

import { rm, stat } from 'fs/promises';
import {
  ensureConversationWorkspace,
  resolveConversationWorkspacePath,
  type ConversationWorkspaceKey,
} from '../conversation-workspace.js';

const ENV_KEYS = ['OPEN_TAG_HOME', 'WORKSPACES_ROOT'] as const;

function key(): ConversationWorkspaceKey {
  return {
    channelKind: 'lark',
    installationId: 'tenant-a',
    scopeId: 'oc_chat_1',
    threadId: 'omt_thread_1',
    isPrivate: false,
  };
}

function enoent(): NodeJS.ErrnoException {
  const err = new Error('ENOENT: no such file or directory') as NodeJS.ErrnoException;
  err.code = 'ENOENT';
  return err;
}

describe('ensureConversationWorkspace touch-on-use error handling', () => {
  const saved: Record<string, string | undefined> = {};
  let base: string;

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    base = join(homedir(), '.open-claude-tag-conv-enoent-' + process.pid + '-' + Math.random().toString(36).slice(2));
    process.env.WORKSPACES_ROOT = base;
    utimesMock.mockReset();
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('recreates the cwd when the dir actually vanishes before the touch (ENOENT)', async () => {
    // Simulate the reuse-time race for real: the touch finds the dir already
    // deleted (genuinely rm it, then surface ENOENT). The ENOENT recovery must
    // recreate the dir via mkdir so the caller still gets an existing cwd.
    utimesMock.mockImplementationOnce(async (p) => {
      await rm(p as string, { recursive: true, force: true });
      throw enoent();
    });

    const path = await ensureConversationWorkspace(key());

    expect(path).toBe(resolveConversationWorkspacePath(key()));
    expect(utimesMock).toHaveBeenCalledTimes(1);
    // Recovery is a mkdir (existence guarantee), not a second unverified touch.
    expect((await stat(path!)).isDirectory()).toBe(true);
  });

  it('swallows a non-ENOENT touch error without retrying and keeps the cwd', async () => {
    const eacces = new Error('EACCES') as NodeJS.ErrnoException;
    eacces.code = 'EACCES';
    utimesMock.mockRejectedValue(eacces);

    const path = await ensureConversationWorkspace(key());

    expect(path).toBe(resolveConversationWorkspacePath(key()));
    // Non-ENOENT: no retry (single attempt), cwd still exists from the initial mkdir.
    expect(utimesMock).toHaveBeenCalledTimes(1);
    expect((await stat(path!)).isDirectory()).toBe(true);
  });

  it('does not call utimes for a no-thread key (no conversation workspace)', async () => {
    utimesMock.mockResolvedValue(undefined);

    const path = await ensureConversationWorkspace({ ...key(), threadId: undefined });

    expect(path).toBeNull();
    expect(utimesMock).not.toHaveBeenCalled();
    await expect(stat(base)).rejects.toBeTruthy();
  });
});
