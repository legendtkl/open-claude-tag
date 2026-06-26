import { execFile } from 'child_process';
import { mkdtemp, rm, writeFile, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface ThreeWayMergeResult {
  merged: string | null;
  clean: boolean;
}

/**
 * Line-level three-way merge with `git merge-file` semantics: base is the
 * snapshot the task started from, ours is the current canonical content,
 * theirs is the task's edited content. Returns `merged: null` on conflict —
 * the caller decides the fallback (LWW in favor of ours).
 */
export async function threeWayMerge(
  base: string,
  ours: string,
  theirs: string,
): Promise<ThreeWayMergeResult> {
  if (ours === theirs) return { merged: ours, clean: true };
  if (base === ours) return { merged: theirs, clean: true };
  if (base === theirs) return { merged: ours, clean: true };

  const dir = await mkdtemp(join(tmpdir(), 'open-claude-tag-memory-merge-'));
  try {
    const basePath = join(dir, 'base');
    const oursPath = join(dir, 'ours');
    const theirsPath = join(dir, 'theirs');
    await Promise.all([
      writeFile(basePath, base, 'utf8'),
      writeFile(oursPath, ours, 'utf8'),
      writeFile(theirsPath, theirs, 'utf8'),
    ]);
    try {
      // git merge-file edits `ours` in place; exit code > 0 means conflicts,
      // < 0 means error. --quiet suppresses conflict marker output on stdout.
      await execFileAsync('git', ['merge-file', '--quiet', oursPath, basePath, theirsPath]);
      return { merged: await readFile(oursPath, 'utf8'), clean: true };
    } catch (error) {
      const code = (error as { code?: number }).code;
      if (typeof code === 'number' && code > 0) return { merged: null, clean: false };
      throw error;
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
