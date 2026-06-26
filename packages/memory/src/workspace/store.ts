import { mkdir, readdir, readFile, rename, rm, rmdir, stat, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { resolve as resolvePath } from 'path';
import { containsHighConfidenceSecret } from './secrets.js';
import {
  DEFAULT_RUN_TTL_MS,
  LOCK_STALE_MS,
  MAX_MEMORY_FILES,
  MAX_MEMORY_FILE_BYTES,
  MAX_MEMORY_TOTAL_BYTES,
} from './limits.js';
import {
  BASE_MANIFEST_FILE,
  CONFLICTS_DIR,
  MEMORY_INDEX_FILE,
  NOTES_DIR,
  RUNS_DIR,
  checkoutDirFor,
  isMemoryPath,
  resolveInside,
} from './paths.js';
import { threeWayMerge } from './merge.js';
import { seedMemoryTemplate } from './prompt.js';

export type MemoryFileMap = Record<string, string>;

export type MemoryRejectReason =
  | 'invalid-path'
  | 'not-regular-file'
  | 'oversize'
  | 'sensitive'
  | 'quota';

export interface RejectedMemoryFile {
  path: string;
  reason: MemoryRejectReason;
}

export interface MemoryCommitResult {
  /** Files written unchanged from the task's version (fast-forward). */
  applied: string[];
  /** Files written after a clean three-way merge with concurrent edits. */
  merged: string[];
  /** Files where the merge conflicted; canonical content kept (LWW). */
  conflicted: string[];
  /** Files deleted because the task deleted them and nothing else changed them. */
  deleted: string[];
  rejected: RejectedMemoryFile[];
}

export interface PreparedMemory {
  checkoutPath: string;
  memoryMd: string;
  noteFiles: string[];
}

interface ScanResult {
  files: MemoryFileMap;
  rejected: RejectedMemoryFile[];
}

const EMPTY_COMMIT: MemoryCommitResult = {
  applied: [],
  merged: [],
  conflicted: [],
  deleted: [],
  rejected: [],
};

/** Serialize commits per agent home within this process. */
const inProcessLocks = new Map<string, Promise<unknown>>();

let tmpCounter = 0;

async function withHomeLock<T>(homeDir: string, fn: () => Promise<T>): Promise<T> {
  const key = resolvePath(homeDir);
  const previous = inProcessLocks.get(key) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(async () => {
    await acquireDiskLock(key);
    try {
      return await fn();
    } finally {
      await releaseDiskLock(key);
    }
  });
  inProcessLocks.set(key, run);
  try {
    return await run;
  } finally {
    if (inProcessLocks.get(key) === run) inProcessLocks.delete(key);
  }
}

function diskLockPath(homeDir: string): string {
  return join(homeDir, '.memory-lock');
}

async function acquireDiskLock(homeDir: string): Promise<void> {
  const lockDir = diskLockPath(homeDir);
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      await mkdir(lockDir);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        const info = await stat(lockDir);
        if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
          await rmdir(lockDir).catch(() => undefined);
          continue;
        }
      } catch {
        continue; // lock vanished between mkdir and stat — retry immediately
      }
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for memory commit lock at ${lockDir}`, {
          cause: error,
        });
      }
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 50));
    }
  }
}

async function releaseDiskLock(homeDir: string): Promise<void> {
  await rmdir(diskLockPath(homeDir)).catch(() => undefined);
}

/**
 * Local filesystem store for agent workspace memory (Layer A, phase 0).
 *
 * The agent home directory itself is the canonical store; every task works
 * against an isolated checkout under `<home>/runs/<taskId>/` and commits back
 * through a per-file three-way merge, so parallel tasks for the same agent
 * (same or different runtimes) never share a mutable directory.
 */
export class LocalAgentMemoryStore {
  constructor(private readonly homeDir: string) {}

  /** Scan a root for memory files (MEMORY.md + notes/**.md), never following symlinks. */
  private async scan(root: string, checkSensitive: boolean): Promise<ScanResult> {
    const files: MemoryFileMap = {};
    const rejected: RejectedMemoryFile[] = [];
    const candidates: string[] = [];

    const indexEntry = await this.statEntry(root, MEMORY_INDEX_FILE);
    if (indexEntry === 'file') candidates.push(MEMORY_INDEX_FILE);
    else if (indexEntry === 'other') rejected.push({ path: MEMORY_INDEX_FILE, reason: 'not-regular-file' });

    await this.walkNotes(root, NOTES_DIR, candidates, rejected);

    candidates.sort();
    for (const relPath of candidates) {
      if (files[relPath] !== undefined) continue;
      if (Object.keys(files).length >= MAX_MEMORY_FILES) {
        rejected.push({ path: relPath, reason: 'quota' });
        continue;
      }
      const absolute = resolveInside(root, relPath);
      if (!absolute) {
        rejected.push({ path: relPath, reason: 'invalid-path' });
        continue;
      }
      const info = await stat(absolute);
      if (info.size > MAX_MEMORY_FILE_BYTES) {
        rejected.push({ path: relPath, reason: 'oversize' });
        continue;
      }
      const content = await readFile(absolute, 'utf8');
      if (checkSensitive && containsHighConfidenceSecret(content)) {
        rejected.push({ path: relPath, reason: 'sensitive' });
        continue;
      }
      files[relPath] = content;
    }
    return { files, rejected };
  }

  private async statEntry(root: string, relPath: string): Promise<'file' | 'missing' | 'other'> {
    const absolute = resolveInside(root, relPath);
    if (!absolute) return 'other';
    try {
      const entries = await readdir(dirname(absolute), { withFileTypes: true });
      const name = relPath.split('/').pop();
      const entry = entries.find((candidate) => candidate.name === name);
      if (!entry) return 'missing';
      return entry.isFile() ? 'file' : 'other';
    } catch {
      return 'missing';
    }
  }

  private async walkNotes(
    root: string,
    relDir: string,
    candidates: string[],
    rejected: RejectedMemoryFile[],
  ): Promise<void> {
    const absoluteDir = resolveInside(root, relDir);
    if (!absoluteDir) return;
    let entries;
    try {
      entries = await readdir(absoluteDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const relPath = `${relDir}/${entry.name}`;
      if (entry.isDirectory()) {
        await this.walkNotes(root, relPath, candidates, rejected);
        continue;
      }
      if (!entry.isFile()) {
        if (isMemoryPath(relPath)) rejected.push({ path: relPath, reason: 'not-regular-file' });
        continue;
      }
      if (!isMemoryPath(relPath)) continue; // non-md scratch files are simply outside the model
      candidates.push(relPath);
    }
  }

  /** Seed MEMORY.md with the default template if the home has none. */
  async seed(displayName?: string): Promise<void> {
    await mkdir(this.homeDir, { recursive: true });
    try {
      await writeFile(join(this.homeDir, MEMORY_INDEX_FILE), seedMemoryTemplate(displayName), {
        flag: 'wx',
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }

  /**
   * Materialize an isolated checkout of the current memory for one task and
   * return what the prompt section needs.
   */
  async prepare(taskId: string, displayName?: string): Promise<PreparedMemory> {
    await this.seed(displayName);
    const { files } = await this.scan(this.homeDir, false);
    const checkoutPath = checkoutDirFor(this.homeDir, taskId);
    await rm(checkoutPath, { recursive: true, force: true });
    await mkdir(checkoutPath, { recursive: true });
    for (const [relPath, content] of Object.entries(files)) {
      const absolute = resolveInside(checkoutPath, relPath);
      if (!absolute) continue;
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, content, 'utf8');
    }
    await writeFile(
      join(checkoutPath, BASE_MANIFEST_FILE),
      JSON.stringify({ files }, null, 2),
      'utf8',
    );
    return {
      checkoutPath,
      memoryMd: files[MEMORY_INDEX_FILE] ?? seedMemoryTemplate(displayName),
      noteFiles: Object.keys(files)
        .filter((path) => path !== MEMORY_INDEX_FILE)
        .sort(),
    };
  }

  /**
   * Merge a task's checkout back into the canonical home and delete the
   * checkout. Safe to call for a missing checkout (returns an empty result).
   */
  async commit(taskId: string): Promise<MemoryCommitResult> {
    const checkoutPath = checkoutDirFor(this.homeDir, taskId);
    let baseRaw: string;
    try {
      baseRaw = await readFile(join(checkoutPath, BASE_MANIFEST_FILE), 'utf8');
    } catch {
      return EMPTY_COMMIT;
    }
    const base: MemoryFileMap = JSON.parse(baseRaw).files ?? {};
    const theirsScan = await this.scan(checkoutPath, true);

    return withHomeLock(this.homeDir, async () => {
      const result: MemoryCommitResult = {
        applied: [],
        merged: [],
        conflicted: [],
        deleted: [],
        rejected: [...theirsScan.rejected],
      };
      const oursScan = await this.scan(this.homeDir, false);
      const ours = oursScan.files;
      const theirs = theirsScan.files;

      const pendingWrites: Array<{ path: string; content: string; kind: 'applied' | 'merged' }> = [];
      const pendingDeletes: string[] = [];

      const allPaths = [...new Set([...Object.keys(base), ...Object.keys(theirs)])].sort(
        (a, b) => (a === MEMORY_INDEX_FILE ? -1 : b === MEMORY_INDEX_FILE ? 1 : a.localeCompare(b)),
      );

      for (const path of allPaths) {
        const baseContent = base[path];
        const theirsContent = theirs[path];
        const oursContent = ours[path];

        if (theirsContent === undefined) {
          // Task deleted (or never had) the file.
          if (baseContent === undefined) continue;
          if (oursContent === undefined) continue; // already gone
          if (oursContent === baseContent) pendingDeletes.push(path);
          else result.conflicted.push(path); // concurrently modified — keep ours
          continue;
        }
        if (theirsContent === baseContent) continue; // task did not change it
        if (theirsContent === oursContent) continue; // identical concurrent edit

        if (oursContent === undefined) {
          // New file, or canonical copy deleted concurrently — task intent wins.
          pendingWrites.push({ path, content: theirsContent, kind: 'applied' });
          continue;
        }
        if (oursContent === baseContent) {
          pendingWrites.push({ path, content: theirsContent, kind: 'applied' });
          continue;
        }
        const mergeResult = await threeWayMerge(baseContent ?? '', oursContent, theirsContent);
        if (mergeResult.clean && mergeResult.merged !== null) {
          pendingWrites.push({ path, content: mergeResult.merged, kind: 'merged' });
        } else {
          result.conflicted.push(path);
          await this.preserveConflict(taskId, path, theirsContent);
        }
      }

      // Quota check on the post-merge canonical set (inside the lock).
      const resulting = new Map<string, number>();
      for (const [path, content] of Object.entries(ours)) {
        resulting.set(path, Buffer.byteLength(content, 'utf8'));
      }
      for (const path of pendingDeletes) resulting.delete(path);
      const acceptedWrites: typeof pendingWrites = [];
      for (const write of pendingWrites) {
        const size = Buffer.byteLength(write.content, 'utf8');
        const total =
          [...resulting.entries()].reduce(
            (sum, [path, bytes]) => (path === write.path ? sum : sum + bytes),
            0,
          ) + size;
        const count = resulting.has(write.path) ? resulting.size : resulting.size + 1;
        if (total > MAX_MEMORY_TOTAL_BYTES || count > MAX_MEMORY_FILES) {
          result.rejected.push({ path: write.path, reason: 'quota' });
          continue;
        }
        resulting.set(write.path, size);
        acceptedWrites.push(write);
      }

      for (const write of acceptedWrites) {
        await this.writeAtomic(write.path, write.content);
        result[write.kind].push(write.path);
      }
      for (const path of pendingDeletes) {
        const absolute = resolveInside(this.homeDir, path);
        if (absolute) await rm(absolute, { force: true });
        result.deleted.push(path);
      }

      await rm(checkoutPath, { recursive: true, force: true });
      return result;
    });
  }

  private async preserveConflict(taskId: string, path: string, content: string): Promise<void> {
    const flattened = path.replace(/\//g, '__');
    const target = join(this.homeDir, CONFLICTS_DIR, `${taskId}-${flattened}`);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }

  private async writeAtomic(relPath: string, content: string): Promise<void> {
    const absolute = resolveInside(this.homeDir, relPath);
    if (!absolute) return;
    await mkdir(dirname(absolute), { recursive: true });
    const tmpPath = `${absolute}.tmp-${process.pid}-${tmpCounter++}`;
    await writeFile(tmpPath, content, 'utf8');
    await rename(tmpPath, absolute);
  }

  /** Discard a task's checkout without committing (e.g. cancelled tasks). */
  async discard(taskId: string): Promise<void> {
    await rm(checkoutDirFor(this.homeDir, taskId), { recursive: true, force: true });
  }

  /** Remove stale checkouts left behind by crashed runs. */
  async sweepStaleRuns(ttlMs: number = DEFAULT_RUN_TTL_MS): Promise<string[]> {
    const runsDir = join(this.homeDir, RUNS_DIR);
    let entries;
    try {
      entries = await readdir(runsDir, { withFileTypes: true });
    } catch {
      return [];
    }
    const removed: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const target = join(runsDir, entry.name);
      try {
        const info = await stat(target);
        if (Date.now() - info.mtimeMs > ttlMs) {
          await rm(target, { recursive: true, force: true });
          removed.push(entry.name);
        }
      } catch {
        // raced with another cleaner — fine
      }
    }
    return removed;
  }
}
