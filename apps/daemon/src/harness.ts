import { mkdir, writeFile, appendFile } from 'fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve } from 'path';
import {
  createWorkspace,
  collectArtifactsFromDir,
  ensureAgentHomeDir,
  resolveExternalProjectWorkspace,
  type RuntimeManager,
  type RuntimeAdapter,
  type WorkspaceContext,
} from '@open-tag/runtime-adapters';
import type { RuntimeEvent, ArtifactRef, TaskSpec } from '@open-tag/core-types';
import type { TaskDispatchFrame, InlineImage, WorkdirHints } from '@open-tag/daemon-protocol';
import { logger } from './logger.js';

/**
 * Per-dispatch execution harness (design §8, spec "Local execution harness").
 *
 * A minimal reimplementation of the worker's run harness
 * (`apps/worker/src/main.ts`): build a per-dispatch workspace, apply workdir
 * hints, materialize inline images, select the runtime adapter, then drive
 * `prepare`+`execute` (mode `prepare_execute`) or `resume` (mode `resume`).
 * The heavy lifting stays in `@open-tag/runtime-adapters`.
 *
 * The harness is intentionally transport-agnostic: it yields a stream of
 * `RuntimeEvent`s and exposes `collectArtifacts`. The connection manager wraps
 * those into seq-numbered `task_event` / `artifacts` frames (D12).
 */

/** Resolved workdir decision (what cwd the runtime runs in, and read-only-ness). */
export interface ResolvedWorkdir {
  /** Directory the runtime process should run in, or undefined to use scratch. */
  cwd?: string;
  /** Whether the run is read-only (no worktree, non-mutating workflow). */
  readOnly: boolean;
  /** True when a git worktree was created for an external repo write run. */
  worktreeCreated: boolean;
}

export interface PreparedDispatch {
  dispatchId: string;
  adapter: RuntimeAdapter;
  workspace: WorkspaceContext;
  spec: TaskSpec;
  imagePaths: string[];
  systemPromptAppend?: string;
  mode: 'prepare_execute' | 'resume';
  sdkSessionId?: string;
}

/**
 * Applies the workdir-hint precedence (D6): confirmedWorkDir → adhocWorkDir →
 * defaultWorkDir. Returns the chosen directory or undefined when none is set.
 */
export function pickWorkdir(hints: WorkdirHints): string | undefined {
  return hints.confirmedWorkDir ?? hints.adhocWorkDir ?? hints.defaultWorkDir ?? undefined;
}

/**
 * Materializes inline base64 images into the workspace input dir and appends
 * an `Image:` line to TASK.md, mirroring the adapters' image convention (D11).
 * Returns the local paths written. A bad base64 payload is skipped with a warn
 * (non-fatal, matching the worker's degrade-to-text behavior).
 */
export async function materializeImages(
  images: InlineImage[] | undefined,
  workspace: WorkspaceContext,
): Promise<string[]> {
  if (!images || images.length === 0) return [];
  const paths: string[] = [];
  await mkdir(workspace.inputDir, { recursive: true });
  const taskMd = join(workspace.workspacePath, 'TASK.md');
  const inputRoot = resolve(workspace.inputDir);
  const usedNames = new Set<string>();
  for (const [index, image] of images.entries()) {
    try {
      const buffer = Buffer.from(image.base64, 'base64');
      if (buffer.length === 0) {
        logger.warn({ name: image.name }, 'Skipping empty/invalid inline image');
        continue;
      }
      const safeName = safeInlineImageName(image.name, index, usedNames);
      const dest = resolve(inputRoot, safeName);
      if (!isPathInside(inputRoot, dest)) {
        logger.warn({ name: image.name }, 'Skipping inline image with unsafe path');
        continue;
      }
      await writeFile(dest, buffer);
      await appendFile(taskMd, `\nImage: ${dest}\n`);
      paths.push(dest);
    } catch (err) {
      logger.warn(
        { name: image.name, err: err instanceof Error ? err.message : String(err) },
        'Failed to materialize inline image, continuing text-only',
      );
    }
  }
  return paths;
}

function safeInlineImageName(rawName: string, index: number, usedNames: Set<string>): string {
  const rawLeaf = basename(rawName);
  const sanitized = rawLeaf
    .replace(/[<>:"/\\|?*]/g, '_')
    .split('')
    .map((char) => (char.charCodeAt(0) < 32 ? '_' : char))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  const baseName =
    sanitized && sanitized !== '.' && sanitized !== '..'
      ? truncateFileName(sanitized, 160)
      : `inline-image-${index + 1}.bin`;
  let candidate = baseName;
  let collision = 1;
  while (usedNames.has(candidate)) {
    candidate = addCollisionSuffix(baseName, collision++);
  }
  usedNames.add(candidate);
  return candidate;
}

function addCollisionSuffix(fileName: string, collision: number): string {
  const extension = extname(fileName);
  const stem = extension ? fileName.slice(0, -extension.length) : fileName;
  return truncateFileName(`${stem}-${collision}${extension}`, 180);
}

function truncateFileName(fileName: string, maxLength: number): string {
  if (fileName.length <= maxLength) return fileName;
  const extension = extname(fileName);
  const stemLength = Math.max(1, maxLength - extension.length);
  return `${fileName.slice(0, stemLength)}${extension}`;
}

function isPathInside(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel === '' || (rel !== '' && !rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Resolves the workdir for a dispatch and mutates `workspace.cwd`/`readOnly`
 * accordingly (D6). v1 behavior:
 *
 * - No hint dir, `agentId` present ⇒ run in the machine-local per-agent home
 *   `~/.open-claude-tag/agents/<agentId>` (created on demand), mirroring the
 *   worker's server-local `generic` fallback so agents keep a stable home —
 *   files and runtime sessions (keyed by cwd) survive across dispatches.
 * - No hint dir, no `agentId` ⇒ run in the scratch workspace (cwd undefined;
 *   adapter uses `workspacePath`).
 * - `readOnly` ⇒ run against the dir directly, no worktree (workspace.cwd = dir,
 *   readOnly = true).
 * - Write run against a git repo ⇒ create a worktree via
 *   `resolveExternalProjectWorkspace` and point the scratch workspace at it
 *   (matches the worker's external-write path). Non-git dirs run in place.
 *
 * `resolveExternalProjectWorkspace` itself falls back to the project path when
 * the dir is not a git repo, so the git-vs-not branch is handled inside it.
 */
export async function applyWorkdirHints(
  dispatchId: string,
  hints: WorkdirHints,
  workspace: WorkspaceContext,
): Promise<ResolvedWorkdir> {
  const dir = pickWorkdir(hints);
  if (!dir) {
    if (hints.agentId) {
      // Per-agent home is a plain directory, never a git worktree — write runs
      // execute in place, like the worker's generic mode.
      const home = await ensureAgentHomeDir(hints.agentId);
      workspace.cwd = home;
      workspace.readOnly = Boolean(hints.readOnly);
      logger.info(
        { dispatchId, agentId: hints.agentId, cwd: home },
        'Workdir resolved (per-agent home)',
      );
      return { cwd: home, readOnly: Boolean(hints.readOnly), worktreeCreated: false };
    }
    return { readOnly: Boolean(hints.readOnly), worktreeCreated: false };
  }

  if (hints.readOnly) {
    workspace.cwd = dir;
    workspace.readOnly = true;
    logger.info({ dispatchId, cwd: dir }, 'Workdir resolved (read-only, no worktree)');
    return { cwd: dir, readOnly: true, worktreeCreated: false };
  }

  // Write run: let resolveExternalProjectWorkspace create a worktree for a git
  // repo (or fall back to the dir for a non-git path). Persist is a no-op — the
  // daemon does not own session state.
  const wt = await resolveExternalProjectWorkspace(dispatchId, dir, null, async () => {});
  const worktreeCreated = wt.worktreePath !== dir;
  // Point the agent cwd at the resolved worktree/dir while adapter scratch
  // (TASK.md, images) stays under the per-dispatch workspacePath.
  workspace.cwd = wt.worktreePath;
  workspace.readOnly = false;
  logger.info(
    { dispatchId, cwd: wt.worktreePath, worktreeCreated },
    worktreeCreated ? 'Workdir resolved (worktree created)' : 'Workdir resolved (direct, no worktree)',
  );
  return { cwd: wt.worktreePath, readOnly: false, worktreeCreated };
}

/**
 * Prepares everything a dispatch needs to run: a per-dispatch workspace under
 * `~/.open-claude-tag/workspaces/<dispatchId>`, resolved workdir, materialized
 * images, and a selected adapter. Throws when no adapter is available for the
 * requested runtime (the caller turns this into a `failed` event).
 */
export async function prepareDispatch(
  frame: TaskDispatchFrame,
  runtimeManager: RuntimeManager,
): Promise<PreparedDispatch> {
  const workspace = await createWorkspace(frame.dispatchId);
  if (frame.runtimeEnv && Object.keys(frame.runtimeEnv).length > 0) {
    workspace.runtimeEnv = frame.runtimeEnv;
  }
  await applyWorkdirHints(frame.dispatchId, frame.workdirHints, workspace);
  const imagePaths = await materializeImages(frame.images, workspace);

  // The daemon must run EXACTLY the dispatched runtime (issue #8): the server
  // already chose and validated it against this machine's capabilities, so a
  // codex-less daemon must fail fast rather than silently substitute claude.
  const adapter = await runtimeManager.requireHealthy(frame.runtime);

  return {
    dispatchId: frame.dispatchId,
    adapter,
    workspace,
    spec: frame.spec,
    imagePaths,
    systemPromptAppend: frame.systemPromptAppend,
    mode: frame.mode,
    sdkSessionId: frame.sdkSessionId,
  };
}

/**
 * Runs a prepared dispatch and yields its `RuntimeEvent` stream.
 *
 * `prepare_execute` ⇒ `adapter.prepare()` then `adapter.execute()`.
 * `resume` ⇒ `adapter.resume(sdkSessionId, goal, workspace, systemPromptAppend)`.
 * A `resume` mode without an `sdkSessionId` is a protocol error from the server;
 * the caller fails the dispatch.
 */
export async function* runDispatch(prepared: PreparedDispatch): AsyncGenerator<RuntimeEvent> {
  const { adapter, workspace, spec, systemPromptAppend } = prepared;
  if (prepared.mode === 'resume') {
    if (!prepared.sdkSessionId) {
      throw new Error('resume dispatch missing sdkSessionId');
    }
    if (!adapter.supportsResume()) {
      throw new Error(`runtime "${adapter.name()}" does not support resume`);
    }
    yield* adapter.resume(prepared.sdkSessionId, spec.goal, workspace, systemPromptAppend, {
      taskId: spec.taskId,
      executionId: prepared.dispatchId,
      imagePaths: prepared.imagePaths,
      ...(spec.model ? { model: spec.model } : {}),
    });
    return;
  }

  const handle = await adapter.prepare(spec, workspace);
  if (prepared.imagePaths.length > 0) {
    handle.imagePaths = [...(handle.imagePaths ?? []), ...prepared.imagePaths];
  }
  yield* adapter.execute(handle, spec, systemPromptAppend);
}

/** Collects artifact refs from the dispatch workspace after the terminal event. */
export async function collectDispatchArtifacts(
  workspace: WorkspaceContext,
): Promise<ArtifactRef[]> {
  return collectArtifactsFromDir(workspace.artifactsDir);
}
