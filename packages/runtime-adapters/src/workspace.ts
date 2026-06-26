import { mkdir, rm, writeFile, readdir, stat } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { createHash } from 'crypto';
import { readFile } from 'fs/promises';
import type { WorkspaceContext } from './types.js';
import type { ArtifactRef } from '@open-tag/core-types';

/**
 * Base directory for all OpenClaudeTag runtime state. Defaults to `~/.open-claude-tag`
 * and is overridable via `OPEN_TAG_HOME`. Keeping agent state under the user
 * home (instead of `/tmp`) gives agents a stable, persistent home at
 * `~/.open-claude-tag/agents/<id>`.
 */
export function openClaudeTagHome(): string {
  const configured = process.env.OPEN_TAG_HOME?.trim();
  return configured || join(homedir(), '.open-claude-tag');
}

/** Per-agent home directory: `<OpenClaudeTag home>/agents/<agentId>`. */
export function resolveAgentHomeDir(agentId: string): string {
  return join(openClaudeTagHome(), 'agents', agentId);
}

/** Create (if missing) and return the per-agent home directory. */
export async function ensureAgentHomeDir(agentId: string): Promise<string> {
  const dir = resolveAgentHomeDir(agentId);
  await mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Root for ephemeral per-run scratch workspaces. Defaults under the OpenClaudeTag
 * home (`<home>/workspaces`); `WORKSPACES_ROOT` still overrides it.
 */
export function workspacesRoot(): string {
  const configured = process.env.WORKSPACES_ROOT?.trim();
  return configured || join(openClaudeTagHome(), 'workspaces');
}

export async function createWorkspace(runId: string): Promise<WorkspaceContext> {
  const workspacePath = join(workspacesRoot(), runId);
  const dirs = {
    inputDir: join(workspacePath, 'input'),
    outputDir: join(workspacePath, 'output'),
    repoDir: join(workspacePath, 'repo'),
    artifactsDir: join(workspacePath, 'artifacts'),
    logsDir: join(workspacePath, 'logs'),
  };

  await mkdir(workspacePath, { recursive: true });
  for (const dir of Object.values(dirs)) {
    await mkdir(dir, { recursive: true });
  }

  // Write task metadata files
  await writeFile(join(workspacePath, 'TASK.md'), `# Task ${runId}\n`);
  await writeFile(join(workspacePath, 'CONTEXT.json'), JSON.stringify({ runId }, null, 2));

  return { runId, workspacePath, ...dirs };
}

export async function cleanupWorkspace(runId: string): Promise<void> {
  const workspacePath = join(workspacesRoot(), runId);
  await rm(workspacePath, { recursive: true, force: true });
}

export async function collectArtifactsFromDir(artifactsDir: string): Promise<ArtifactRef[]> {
  const artifacts: ArtifactRef[] = [];
  try {
    const files = await readdir(artifactsDir);
    for (const file of files) {
      const filePath = join(artifactsDir, file);
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) continue;

      const content = await readFile(filePath);
      const sha256 = createHash('sha256').update(content).digest('hex');
      const mimeType = guessMimeType(file);

      artifacts.push({
        name: file,
        path: filePath,
        mimeType,
        sha256,
        sizeBytes: fileStat.size,
      });
    }
  } catch {
    // Directory might not exist or be empty
  }
  return artifacts;
}

function guessMimeType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const mimeMap: Record<string, string> = {
    ts: 'text/typescript',
    js: 'text/javascript',
    json: 'application/json',
    md: 'text/markdown',
    py: 'text/x-python',
    txt: 'text/plain',
    yaml: 'text/yaml',
    yml: 'text/yaml',
    patch: 'text/x-patch',
    diff: 'text/x-diff',
  };
  return mimeMap[ext] ?? 'application/octet-stream';
}
