import { describe, it, expect } from 'vitest';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { randomUUID } from 'crypto';
import {
  createWorkspace,
  cleanupWorkspace,
  collectArtifactsFromDir,
} from '@open-tag/runtime-adapters';

/**
 * Issue #9: the worker's local artifact persistence scans EXACTLY the scratch
 * `workspace.artifactsDir` (apps/worker/src/main.ts) — never `cwd/artifacts`.
 * This guards the scan TARGET (the part testable without a live DB); the actual
 * `artifacts`-table insert is covered by the Postgres integration suite.
 */
describe('worker artifact collection (issue #9 scan target)', () => {
  it('collects only the scratch artifactsDir, ignoring a cwd/artifacts decoy', async () => {
    const runId = `worker-artifact-${randomUUID()}`;
    const workspace = await createWorkspace(runId);
    // In every real mode the worker overrides cwd to a worktree / external repo /
    // agent home, which may already contain an unrelated `artifacts/` dir.
    workspace.cwd = workspace.repoDir;
    try {
      await mkdir(join(workspace.cwd, 'artifacts'), { recursive: true });
      await writeFile(join(workspace.cwd, 'artifacts', 'decoy.txt'), 'pre-existing repo file');
      await writeFile(join(workspace.artifactsDir, 'deliverable.txt'), 'real output');

      // Exactly the call the worker makes for a server-local run.
      const collected = await collectArtifactsFromDir(workspace.artifactsDir);

      expect(collected.map((a) => a.name)).toEqual(['deliverable.txt']);
      expect(collected.map((a) => a.path)).toEqual([
        join(workspace.artifactsDir, 'deliverable.txt'),
      ]);
    } finally {
      await cleanupWorkspace(runId).catch(() => {});
    }
  });

  it('yields no artifacts when the scratch artifactsDir is empty', async () => {
    const runId = `worker-artifact-${randomUUID()}`;
    const workspace = await createWorkspace(runId);
    workspace.cwd = workspace.repoDir;
    try {
      await mkdir(join(workspace.cwd, 'artifacts'), { recursive: true });
      await writeFile(join(workspace.cwd, 'artifacts', 'decoy.txt'), 'pre-existing repo file');

      const collected = await collectArtifactsFromDir(workspace.artifactsDir);

      expect(collected).toHaveLength(0);
    } finally {
      await cleanupWorkspace(runId).catch(() => {});
    }
  });
});
