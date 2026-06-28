import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { load as loadYaml } from 'js-yaml';
import { z } from 'zod';

const RuntimeSchema = z.enum(['claude_code', 'codex']);

export const AgentManifestSchema = z.object({
  version: z.union([z.literal(1), z.string()]).optional(),
  profile: z.object({
    name: z.string().min(1),
    displayName: z.string().min(1),
    description: z.string().optional(),
    systemPrompt: z.string().optional(),
    stylePrompt: z.string().optional(),
    skillRefs: z.array(z.string()).default([]),
    defaultRuntime: RuntimeSchema.optional(),
    defaultModel: z.string().optional(),
    status: z.enum(['active', 'inactive', 'archived']).default('active'),
  }),
  agent: z.object({
    handle: z.string().min(1),
    displayName: z.string().min(1),
    description: z.string().optional(),
    scopeType: z.enum(['system', 'tenant', 'chat', 'user']).default('system'),
    scopeId: z.string().min(1).default('default'),
    ownerUserId: z.string().uuid().optional(),
    visibility: z.enum(['public', 'private', 'unlisted']).default('public'),
    defaultRuntime: RuntimeSchema.optional(),
    defaultWorkDir: z.string().optional(),
    projectId: z.string().uuid().optional(),
    accessPolicy: z.record(z.unknown()).default({}),
    status: z.enum(['active', 'inactive', 'archived']).default('active'),
  }),
});

export type AgentManifest = z.infer<typeof AgentManifestSchema>;

export interface LoadedAgentManifest {
  path: string;
  relativePath: string;
  manifest: AgentManifest;
}

export interface ReadAgentManifestsOptions {
  agentsDir?: string;
}

export async function readAgentManifests(
  repoRoot: string,
  options: ReadAgentManifestsOptions = {},
): Promise<LoadedAgentManifest[]> {
  const agentsDir = options.agentsDir ?? join(repoRoot, 'registry', 'agents');
  let entries: string[];

  try {
    entries = await readdir(agentsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const manifests: LoadedAgentManifest[] = [];
  for (const entry of entries.filter((name) => /\.ya?ml$/i.test(name)).sort()) {
    const path = join(agentsDir, entry);
    const raw = await readFile(path, 'utf8');
    const parsed = AgentManifestSchema.parse(loadYaml(raw));
    manifests.push({
      path,
      relativePath: relative(repoRoot, path),
      manifest: parsed,
    });
  }

  return manifests;
}
