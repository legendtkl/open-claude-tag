import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { homedir } from 'os';
import { join } from 'path';
import { mkdir, rm, stat, writeFile } from 'fs/promises';
import {
  CONVERSATION_WORKSPACES_SUBDIR,
  conversationWorkspacesRoot,
  resolveConversationWorkspacePath,
  ensureConversationWorkspace,
  reapConversationWorkspace,
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
});
