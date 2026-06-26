import { describe, it, expect, afterEach } from 'vitest';
import { createWorkspace, cleanupWorkspace, collectArtifactsFromDir } from '../workspace.js';
import { writeFile } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import { randomUUID } from 'crypto';

describe('workspace', () => {
  const runIds: string[] = [];

  afterEach(async () => {
    for (const id of runIds) {
      await cleanupWorkspace(id).catch(() => {});
    }
    runIds.length = 0;
  });

  it('creates workspace with all directories', async () => {
    const runId = `test-${randomUUID()}`;
    runIds.push(runId);
    const ws = await createWorkspace(runId);

    expect(ws.runId).toBe(runId);
    expect(existsSync(ws.inputDir)).toBe(true);
    expect(existsSync(ws.outputDir)).toBe(true);
    expect(existsSync(ws.repoDir)).toBe(true);
    expect(existsSync(ws.artifactsDir)).toBe(true);
    expect(existsSync(ws.logsDir)).toBe(true);
    expect(existsSync(join(ws.workspacePath, 'TASK.md'))).toBe(true);
    expect(existsSync(join(ws.workspacePath, 'CONTEXT.json'))).toBe(true);
  });

  it('cleans up workspace', async () => {
    const runId = `test-${randomUUID()}`;
    const ws = await createWorkspace(runId);
    expect(existsSync(ws.workspacePath)).toBe(true);

    await cleanupWorkspace(runId);
    expect(existsSync(ws.workspacePath)).toBe(false);
  });

  it('collects artifacts with sha256', async () => {
    const runId = `test-${randomUUID()}`;
    runIds.push(runId);
    const ws = await createWorkspace(runId);

    await writeFile(join(ws.artifactsDir, 'output.ts'), 'const x = 1;');
    await writeFile(join(ws.artifactsDir, 'data.json'), '{"key":"value"}');

    const artifacts = await collectArtifactsFromDir(ws.artifactsDir);
    expect(artifacts).toHaveLength(2);

    const tsArtifact = artifacts.find((a) => a.name === 'output.ts');
    expect(tsArtifact).toBeDefined();
    expect(tsArtifact!.mimeType).toBe('text/typescript');
    expect(tsArtifact!.sha256).toHaveLength(64);
    expect(tsArtifact!.sizeBytes).toBeGreaterThan(0);
  });

  it('returns empty array for non-existent artifacts dir', async () => {
    const artifacts = await collectArtifactsFromDir('/nonexistent/path');
    expect(artifacts).toEqual([]);
  });
});
