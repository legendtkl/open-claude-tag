import { mkdir, readdir, rm, stat, utimes } from 'fs/promises';
import type { Dirent } from 'fs';
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

/**
 * Resolve + create the conversation workspace, bumping its mtime so the idle
 * reaper reads `mtime === last turn start`. Returns `null` for a no-thread key.
 *
 * `mkdir(recursive)` is a no-op on an existing dir and does NOT touch its mtime,
 * so a reused workspace would otherwise keep its creation time and look idle —
 * hence the explicit touch on every turn.
 */
export async function ensureConversationWorkspace(
  key: ConversationWorkspaceKey,
): Promise<string | null> {
  const path = resolveConversationWorkspacePath(key);
  if (!path) return null;
  await mkdir(path, { recursive: true });
  await refreshConversationWorkspaceMtime(path);
  return path;
}

/**
 * Bump the workspace dir mtime to "now". On `ENOENT` (the dir was reaped between
 * the caller's `mkdir` and this touch) the recovery is a `mkdir`, NOT another
 * touch: `mkdir` is the existence guarantee and, by re-creating the dir, also
 * restores a fresh mtime — so `ensure` always returns an existing, recent cwd
 * without a second unverified touch. A non-ENOENT touch error is swallowed: the
 * dir still exists from the caller's initial `mkdir`, so the cwd is valid and a
 * stale mtime only risks an early, self-healing reap. A genuine recovery `mkdir`
 * failure propagates rather than returning a missing cwd.
 */
async function refreshConversationWorkspaceMtime(path: string): Promise<void> {
  try {
    await touchConversationWorkspace(path);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return;
  }
  await mkdir(path, { recursive: true });
}

/**
 * Bump a conversation workspace's mtime so the idle reaper treats "mtime" as
 * "last used". Shares the {@link reapConversationWorkspace} path guard, so it can
 * only ever touch a real `<root>/<32hex>` directory. Exported for the worker
 * reuse seam and for tests with an explicit timestamp. `utimes` errors propagate
 * so callers (e.g. `ensureConversationWorkspace`) can react to a vanished dir.
 */
export async function touchConversationWorkspace(
  path: string,
  when: Date = new Date(),
): Promise<void> {
  assertConversationWorkspacePath(path);
  await utimes(path, when, when);
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

/** Outcome of one idle-conversation-workspace scan. */
export interface IdleConversationReapResult {
  /** Basenames of idle workspaces that were reaped. */
  reaped: string[];
  /** Basenames skipped because their mtime is within the idle threshold. */
  skippedRecent: string[];
  /** Entries skipped because they are not a `<32hex>` directory (file, symlink, foreign name). */
  skippedForeign: string[];
  /** Per-entry (or top-level) failures; the scan records and continues past each. */
  errors: string[];
}

function emptyIdleConversationReapResult(): IdleConversationReapResult {
  return { reaped: [], skippedRecent: [], skippedForeign: [], errors: [] };
}

/**
 * Reap conversation workspaces whose mtime is older than `idleMs`. Enumerates
 * `<root>/conversations/*` once, then for each entry reads its mtime *at the
 * moment it is processed* (not batched up front) so a turn that touches a dir
 * during the scan is seen as fresh before we reach it. Idle dirs are removed via
 * the existing guarded {@link reapConversationWorkspace} — never a second
 * deleter. Only real `<32hex>` directories are eligible; files, symlinks and
 * foreign names are skipped (never deleted). A missing root (fresh install) is a
 * clean no-op. Each entry is isolated: one failure is recorded and the scan
 * continues with the rest.
 *
 * The residual reap/reuse race (a turn touches a dir in the microseconds between
 * its stat and its rm) is intentionally accepted: the path is deterministic, so
 * the next `ensureConversationWorkspace` re-creates the dir (scratch reset, no DB
 * or data loss). Keep `idleMs` above the pg-boss job lifetime so an in-flight
 * turn's dir (mtime set at turn start) is never reaped mid-run.
 *
 * `reap` is injectable for tests only; the production default is the guarded
 * {@link reapConversationWorkspace}.
 */
export async function reapIdleConversationWorkspaces(options: {
  idleMs: number;
  now?: Date;
  reap?: (path: string) => Promise<unknown>;
}): Promise<IdleConversationReapResult> {
  const { idleMs, now = new Date(), reap = reapConversationWorkspace } = options;
  const result = emptyIdleConversationReapResult();
  const root = conversationWorkspacesRoot();
  const threshold = now.getTime() - idleMs;

  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return result;
    result.errors.push(`Failed to list conversation workspaces: ${error}`);
    return result;
  }

  for (const entry of entries) {
    const name = entry.name;
    // Gate on isDirectory() (false for files AND symlinks) before the basename
    // check so a `<32hex>`-named file or symlink can never be deleted.
    if (!entry.isDirectory() || !CONVERSATION_DIR_NAME.test(name)) {
      result.skippedForeign.push(name);
      continue;
    }
    const fullPath = join(root, name);
    try {
      const { mtimeMs } = await stat(fullPath);
      if (mtimeMs >= threshold) {
        result.skippedRecent.push(name);
        continue;
      }
      await reap(fullPath);
      result.reaped.push(name);
    } catch (error) {
      result.errors.push(`Failed to reap conversation workspace ${name}: ${error}`);
    }
  }

  return result;
}
