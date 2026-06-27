import { mkdir, rm, stat } from 'fs/promises';
import { basename, dirname, join } from 'path';
import { createHash } from 'crypto';
import { workspacesRoot } from './workspace.js';

/**
 * Identity of a conversation/thread, used to derive a stable per-conversation
 * workspace that successive turns of the same thread reuse. Mirrors the channel
 * `ChannelScope` (kind + installationId/tenant + scopeId + threadId + isPrivate).
 *
 * A key with no `threadId` does NOT map to a conversation workspace; the caller
 * keeps its per-task behavior (single-shot / no-thread is unchanged).
 */
export interface ConversationWorkspaceKey {
  /** Channel vendor, e.g. `lark`. Mirrors `ChannelScope.kind`. */
  channelKind: string;
  /** Tenant / workspace installation (`ChannelScope.installationId`). */
  installationId: string;
  /** Channel isolation key (`ChannelScope.scopeId`), e.g. the chat id. */
  scopeId: string;
  /** Stable conversation thread discriminator. Absent: no conversation workspace. */
  threadId?: string | null;
  /** Private scope flag; private scopes never alias public ones. */
  isPrivate?: boolean;
}

/** Subdirectory under the scratch root that holds per-conversation workspaces. */
export const CONVERSATION_WORKSPACES_SUBDIR = 'conversations';

/**
 * Version marker baked into the hash input. Bumping it changes every derived
 * path, so a future key-format change can never silently alias a directory that
 * an older format produced.
 */
const CONVERSATION_KEY_VERSION = 'v1';

/** A conversation-workspace directory name is a 32-char lowercase hex digest. */
const CONVERSATION_DIR_NAME = /^[0-9a-f]{32}$/;

/**
 * Separator between hash segments. Each segment is length-prefixed, so the
 * encoding is already injective for any separator value; this is cosmetic.
 */
const SEGMENT_SEPARATOR = '|';

function hasThread(key: ConversationWorkspaceKey): boolean {
  return typeof key.threadId === 'string' && key.threadId.trim().length > 0;
}

/**
 * Collision-safe hash of the conversation key. Each segment is length-prefixed
 * before joining, so the encoding is injective: `('a','bc')` and `('ab','c')`
 * cannot produce the same digest regardless of the separator. `isPrivate` is a
 * distinct segment so a private scope never aliases a public one.
 */
function conversationWorkspaceHash(key: ConversationWorkspaceKey): string {
  const segments = [
    CONVERSATION_KEY_VERSION,
    key.channelKind,
    key.installationId,
    key.isPrivate ? '1' : '0',
    key.scopeId,
    key.threadId!.trim(),
  ];
  const canonical = segments
    .map((segment) => `${segment.length}:${segment}`)
    .join(SEGMENT_SEPARATOR);
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

/** Root holding every conversation workspace: `<workspacesRoot>/conversations`. */
export function conversationWorkspacesRoot(): string {
  return join(workspacesRoot(), CONVERSATION_WORKSPACES_SUBDIR);
}

/**
 * Resolve the stable workspace path for a conversation. Pure function of the
 * key: any worker process re-derives the same path, so a later turn (possibly
 * on a different worker process) lands in the same workspace without any
 * persisted binding row. Returns `null` when the key has no `threadId`,
 * signalling the caller to keep its per-task behavior.
 */
export function resolveConversationWorkspacePath(key: ConversationWorkspaceKey): string | null {
  if (!hasThread(key)) return null;
  return join(conversationWorkspacesRoot(), conversationWorkspaceHash(key));
}

/** Resolve + create the conversation workspace. Returns `null` for a no-thread key. */
export async function ensureConversationWorkspace(
  key: ConversationWorkspaceKey,
): Promise<string | null> {
  const path = resolveConversationWorkspacePath(key);
  if (!path) return null;
  await mkdir(path, { recursive: true });
  return path;
}

/**
 * Teardown seam: reap an idle conversation workspace. Accepts a key or a raw
 * path. A raw path is refused unless it lives directly under
 * `<workspacesRoot>/conversations` and its basename is a conversation hash dir,
 * so the seam can never `rm -rf` an arbitrary location. Returns whether a
 * directory existed (and was therefore removed).
 */
export async function reapConversationWorkspace(
  target: ConversationWorkspaceKey | string,
): Promise<boolean> {
  const path = typeof target === 'string' ? target : resolveConversationWorkspacePath(target);
  if (!path) return false;
  assertConversationWorkspacePath(path);
  let existed = false;
  try {
    await stat(path);
    existed = true;
  } catch {
    // Path is absent; nothing to reap and `existed` stays false.
  }
  await rm(path, { recursive: true, force: true });
  return existed;
}

function assertConversationWorkspacePath(path: string): void {
  const root = conversationWorkspacesRoot();
  if (dirname(path) !== root || !CONVERSATION_DIR_NAME.test(basename(path))) {
    throw new Error(`Refusing to reap a path outside the conversation workspace root: ${path}`);
  }
}
