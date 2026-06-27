import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { homedir } from 'os';
import { join } from 'path';
import { mkdir, rm, stat, utimes, writeFile } from 'fs/promises';
import {
  CONVERSATION_WORKSPACES_SUBDIR,
  conversationWorkspacesRoot,
  resolveConversationWorkspacePath,
  ensureConversationWorkspace,
  touchConversationWorkspace,
  reapConversationWorkspace,
  reapIdleConversationWorkspaces,
  type ConversationWorkspaceKey,
} from '../conversation-workspace.js';

const ENV_KEYS = ['OPEN_TAG_HOME', 'WORKSPACES_ROOT'] as const;

function key(overrides: Partial<ConversationWorkspaceKey> = {}): ConversationWorkspaceKey {
  return {
    channelKind: 'lark',
    installationId: 'tenant-a',
    scopeId: 'oc_chat_1',
    threadId: 'omt_thread_1',
    isPrivate: false,
    ...overrides,
  };
}

describe('conversation workspace resolver', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  describe('resolveConversationWorkspacePath', () => {
    it('is deterministic: the same key resolves to the same path across calls', () => {
      const a = resolveConversationWorkspacePath(key());
      const b = resolveConversationWorkspacePath(key());
      expect(a).not.toBeNull();
      expect(a).toBe(b);
    });

    it('lives under <workspacesRoot>/conversations as a 32-hex directory', () => {
      process.env.OPEN_TAG_HOME = '/data/cc';
      const path = resolveConversationWorkspacePath(key())!;
      const root = join('/data/cc', 'workspaces', CONVERSATION_WORKSPACES_SUBDIR);
      expect(conversationWorkspacesRoot()).toBe(root);
      expect(path.startsWith(root + '/')).toBe(true);
      expect(path.slice(root.length + 1)).toMatch(/^[0-9a-f]{32}$/);
    });

    it('returns null when the key has no threadId (single-shot / no thread)', () => {
      expect(resolveConversationWorkspacePath(key({ threadId: undefined }))).toBeNull();
      expect(resolveConversationWorkspacePath(key({ threadId: null }))).toBeNull();
      expect(resolveConversationWorkspacePath(key({ threadId: '   ' }))).toBeNull();
    });

    it('maps different conversations (threadId) to different paths', () => {
      expect(resolveConversationWorkspacePath(key({ threadId: 't1' }))).not.toBe(
        resolveConversationWorkspacePath(key({ threadId: 't2' })),
      );
    });

    it('maps different chats (scopeId) to different paths', () => {
      expect(resolveConversationWorkspacePath(key({ scopeId: 'oc_a' }))).not.toBe(
        resolveConversationWorkspacePath(key({ scopeId: 'oc_b' })),
      );
    });

    it('maps different tenants (installationId) to different paths', () => {
      expect(resolveConversationWorkspacePath(key({ installationId: 't-a' }))).not.toBe(
        resolveConversationWorkspacePath(key({ installationId: 't-b' })),
      );
    });

    it('maps different channels (channelKind) to different paths', () => {
      expect(resolveConversationWorkspacePath(key({ channelKind: 'lark' }))).not.toBe(
        resolveConversationWorkspacePath(key({ channelKind: 'slack' })),
      );
    });

    it('does not let a private scope alias a public scope', () => {
      expect(resolveConversationWorkspacePath(key({ isPrivate: true }))).not.toBe(
        resolveConversationWorkspacePath(key({ isPrivate: false })),
      );
    });

    it('is collision-safe: ("a","bc") and ("ab","c") do not alias (length-prefixed hash)', () => {
      const left = resolveConversationWorkspacePath(key({ scopeId: 'a', threadId: 'bc' }));
      const right = resolveConversationWorkspacePath(key({ scopeId: 'ab', threadId: 'c' }));
      expect(left).not.toBe(right);
    });
  });

  describe('ensureConversationWorkspace', () => {
    it('creates the conversation directory and returns its path', async () => {
      const base = join(homedir(), '.open-claude-tag-conv-' + process.pid);
      process.env.WORKSPACES_ROOT = base;
      try {
        const path = await ensureConversationWorkspace(key());
        expect(path).toBe(resolveConversationWorkspacePath(key()));
        const s = await stat(path!);
        expect(s.isDirectory()).toBe(true);
      } finally {
        await rm(base, { recursive: true, force: true });
      }
    });

    it('returns null without creating anything for a no-thread key', async () => {
      const base = join(homedir(), '.open-claude-tag-conv-none-' + process.pid);
      process.env.WORKSPACES_ROOT = base;
      try {
        expect(await ensureConversationWorkspace(key({ threadId: undefined }))).toBeNull();
        await expect(stat(base)).rejects.toBeTruthy();
      } finally {
        await rm(base, { recursive: true, force: true });
      }
    });
  });

  describe('reapConversationWorkspace', () => {
    it('reaps the directory for a key and reports it existed', async () => {
      const base = join(homedir(), '.open-claude-tag-conv-reap-' + process.pid);
      process.env.WORKSPACES_ROOT = base;
      try {
        const path = (await ensureConversationWorkspace(key()))!;
        await writeFile(join(path, 'scratch.txt'), 'state');
        expect(await reapConversationWorkspace(key())).toBe(true);
        await expect(stat(path)).rejects.toBeTruthy();
      } finally {
        await rm(base, { recursive: true, force: true });
      }
    });

    it('returns false when the conversation workspace does not exist', async () => {
      const base = join(homedir(), '.open-claude-tag-conv-absent-' + process.pid);
      process.env.WORKSPACES_ROOT = base;
      try {
        expect(await reapConversationWorkspace(key())).toBe(false);
      } finally {
        await rm(base, { recursive: true, force: true });
      }
    });

    it('returns false for a no-thread key (nothing to reap)', async () => {
      expect(await reapConversationWorkspace(key({ threadId: undefined }))).toBe(false);
    });

    it('refuses a raw path outside the conversation workspace root', async () => {
      const base = join(homedir(), '.open-claude-tag-conv-guard-' + process.pid);
      process.env.WORKSPACES_ROOT = base;
      const outside = join(base, 'not-conversations', 'a'.repeat(32));
      await mkdir(outside, { recursive: true });
      try {
        await expect(reapConversationWorkspace(outside)).rejects.toThrow(/Refusing to reap/);
        // Guard must not have deleted it.
        const s = await stat(outside);
        expect(s.isDirectory()).toBe(true);
      } finally {
        await rm(base, { recursive: true, force: true });
      }
    });

    it('refuses a conversations-root child whose name is not a hash dir', async () => {
      const base = join(homedir(), '.open-claude-tag-conv-guard2-' + process.pid);
      process.env.WORKSPACES_ROOT = base;
      const notHash = join(conversationWorkspacesRoot(), 'definitely-not-a-hash');
      await mkdir(notHash, { recursive: true });
      try {
        await expect(reapConversationWorkspace(notHash)).rejects.toThrow(/Refusing to reap/);
        const s = await stat(notHash);
        expect(s.isDirectory()).toBe(true);
      } finally {
        await rm(base, { recursive: true, force: true });
      }
    });
  });

  describe('touchConversationWorkspace', () => {
    it('bumps the dir mtime to the explicit timestamp', async () => {
      const base = join(homedir(), '.open-claude-tag-conv-touch-' + process.pid);
      process.env.WORKSPACES_ROOT = base;
      try {
        const path = (await ensureConversationWorkspace(key()))!;
        const when = new Date(Date.now() + 60_000);
        await touchConversationWorkspace(path, when);
        const s = await stat(path);
        // Filesystems can round sub-second precision, so compare at second grain.
        expect(Math.round(s.mtimeMs / 1000)).toBe(Math.round(when.getTime() / 1000));
      } finally {
        await rm(base, { recursive: true, force: true });
      }
    });

    it('refuses a path outside the conversation workspace root (shared guard)', async () => {
      const base = join(homedir(), '.open-claude-tag-conv-touch-guard-' + process.pid);
      process.env.WORKSPACES_ROOT = base;
      const outside = join(base, 'not-conversations', 'a'.repeat(32));
      await mkdir(outside, { recursive: true });
      try {
        await expect(touchConversationWorkspace(outside)).rejects.toThrow(/Refusing to reap/);
      } finally {
        await rm(base, { recursive: true, force: true });
      }
    });
  });

  describe('ensureConversationWorkspace touch-on-use', () => {
    it('refreshes the dir mtime on reuse so an idle workspace looks recent', async () => {
      const base = join(homedir(), '.open-claude-tag-conv-reuse-' + process.pid);
      process.env.WORKSPACES_ROOT = base;
      try {
        const path = (await ensureConversationWorkspace(key()))!;
        // Age the dir well into the past, as if it had been idle for an hour.
        const past = new Date(Date.now() - 60 * 60 * 1000);
        await utimes(path, past, past);
        expect((await stat(path)).mtimeMs).toBeLessThan(Date.now() - 30 * 60 * 1000);

        // A new turn reuses the workspace; mkdir is a no-op, but the touch must
        // bump mtime back to ~now.
        const again = await ensureConversationWorkspace(key());
        expect(again).toBe(path);
        expect((await stat(path)).mtimeMs).toBeGreaterThan(past.getTime());
      } finally {
        await rm(base, { recursive: true, force: true });
      }
    });
  });

  describe('reapIdleConversationWorkspaces', () => {
    const NOW = new Date('2026-06-27T12:00:00.000Z');
    const IDLE_MS = 60 * 60 * 1000; // 1h

    async function makeHashDir(name: string, mtime: Date): Promise<string> {
      const path = join(conversationWorkspacesRoot(), name);
      await mkdir(path, { recursive: true });
      await utimes(path, mtime, mtime);
      return path;
    }

    it('is a clean no-op when the conversations root is missing (fresh install)', async () => {
      const base = join(homedir(), '.open-claude-tag-conv-scan-fresh-' + process.pid);
      process.env.WORKSPACES_ROOT = base;
      try {
        const result = await reapIdleConversationWorkspaces({ idleMs: IDLE_MS, now: NOW });
        expect(result).toEqual({ reaped: [], skippedRecent: [], skippedForeign: [], errors: [] });
        await expect(stat(base)).rejects.toBeTruthy();
      } finally {
        await rm(base, { recursive: true, force: true });
      }
    });

    it('reaps dirs older than the threshold and keeps recent ones', async () => {
      const base = join(homedir(), '.open-claude-tag-conv-scan-age-' + process.pid);
      process.env.WORKSPACES_ROOT = base;
      const idleName = 'a'.repeat(32);
      const recentName = 'b'.repeat(32);
      try {
        const idle = await makeHashDir(idleName, new Date(NOW.getTime() - 2 * IDLE_MS));
        const recent = await makeHashDir(recentName, new Date(NOW.getTime() - IDLE_MS / 2));

        const result = await reapIdleConversationWorkspaces({ idleMs: IDLE_MS, now: NOW });

        expect(result.reaped).toEqual([idleName]);
        expect(result.skippedRecent).toEqual([recentName]);
        expect(result.errors).toEqual([]);
        await expect(stat(idle)).rejects.toBeTruthy();
        expect((await stat(recent)).isDirectory()).toBe(true);
      } finally {
        await rm(base, { recursive: true, force: true });
      }
    });

    it('skips foreign names and never deletes them', async () => {
      const base = join(homedir(), '.open-claude-tag-conv-scan-foreign-' + process.pid);
      process.env.WORKSPACES_ROOT = base;
      const foreign = join(conversationWorkspacesRoot(), 'definitely-not-a-hash');
      try {
        await mkdir(foreign, { recursive: true });
        await utimes(foreign, new Date(NOW.getTime() - 2 * IDLE_MS), new Date(NOW.getTime() - 2 * IDLE_MS));

        const result = await reapIdleConversationWorkspaces({ idleMs: IDLE_MS, now: NOW });

        expect(result.reaped).toEqual([]);
        expect(result.skippedForeign).toContain('definitely-not-a-hash');
        expect((await stat(foreign)).isDirectory()).toBe(true);
      } finally {
        await rm(base, { recursive: true, force: true });
      }
    });

    it('skips a 32-hex-named file (not a directory) and never deletes it', async () => {
      const base = join(homedir(), '.open-claude-tag-conv-scan-file-' + process.pid);
      process.env.WORKSPACES_ROOT = base;
      const root = conversationWorkspacesRoot();
      const hexFile = join(root, 'c'.repeat(32));
      try {
        await mkdir(root, { recursive: true });
        await writeFile(hexFile, 'not a workspace');
        await utimes(hexFile, new Date(NOW.getTime() - 2 * IDLE_MS), new Date(NOW.getTime() - 2 * IDLE_MS));

        const result = await reapIdleConversationWorkspaces({ idleMs: IDLE_MS, now: NOW });

        expect(result.reaped).toEqual([]);
        expect(result.skippedForeign).toContain('c'.repeat(32));
        expect((await stat(hexFile)).isFile()).toBe(true);
      } finally {
        await rm(base, { recursive: true, force: true });
      }
    });

    it('isolates per-entry failures: one bad dir does not abort the rest', async () => {
      const base = join(homedir(), '.open-claude-tag-conv-scan-err-' + process.pid);
      process.env.WORKSPACES_ROOT = base;
      const badName = 'a'.repeat(32);
      const goodName = 'd'.repeat(32);
      try {
        const bad = await makeHashDir(badName, new Date(NOW.getTime() - 2 * IDLE_MS));
        const good = await makeHashDir(goodName, new Date(NOW.getTime() - 2 * IDLE_MS));

        const result = await reapIdleConversationWorkspaces({
          idleMs: IDLE_MS,
          now: NOW,
          reap: async (path) => {
            if (path === bad) throw new Error('boom');
            return reapConversationWorkspace(path);
          },
        });

        expect(result.reaped).toEqual([goodName]);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toContain(badName);
        // The good dir was still reaped despite the bad one throwing.
        await expect(stat(good)).rejects.toBeTruthy();
        expect((await stat(bad)).isDirectory()).toBe(true);
      } finally {
        await rm(base, { recursive: true, force: true });
      }
    });
  });
});
