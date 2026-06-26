import { isNull } from 'drizzle-orm';
import type { Database } from '@open-tag/storage';
import { agentProfiles, agents } from '@open-tag/storage';
import { readAgentManifests, type LoadedAgentManifest } from './agent-manifest.js';

export interface AgentManifestSyncOptions {
  repoRoot: string;
  tenantKey?: string;
  agentsDir?: string;
}

export interface SyncedAgentManifest {
  path: string;
  profileId: string;
  agentId: string;
  handle: string;
}

export interface AgentManifestSyncResult {
  scanned: number;
  synced: SyncedAgentManifest[];
}

export async function syncLoadedAgentManifest(
  db: Database,
  loaded: LoadedAgentManifest,
  tenantKey = 'default',
): Promise<SyncedAgentManifest> {
  const { manifest, relativePath } = loaded;
  const now = new Date();

  const [profile] = await db
    .insert(agentProfiles)
    .values({
      name: manifest.profile.name,
      displayName: manifest.profile.displayName,
      description: manifest.profile.description,
      systemPrompt: manifest.profile.systemPrompt,
      stylePrompt: manifest.profile.stylePrompt,
      skillRefs: manifest.profile.skillRefs,
      defaultRuntime: manifest.profile.defaultRuntime,
      defaultModel: manifest.profile.defaultModel,
      sourceType: 'manifest',
      sourceUri: relativePath,
      status: manifest.profile.status,
    })
    .onConflictDoUpdate({
      target: agentProfiles.name,
      set: {
        displayName: manifest.profile.displayName,
        description: manifest.profile.description,
        systemPrompt: manifest.profile.systemPrompt,
        stylePrompt: manifest.profile.stylePrompt,
        skillRefs: manifest.profile.skillRefs,
        defaultRuntime: manifest.profile.defaultRuntime,
        defaultModel: manifest.profile.defaultModel,
        sourceType: 'manifest',
        sourceUri: relativePath,
        status: manifest.profile.status,
        updatedAt: now,
      },
    })
    .returning({ id: agentProfiles.id });

  if (!profile) {
    throw new Error(`Failed to sync agent profile from ${relativePath}`);
  }

  const [agent] = await db
    .insert(agents)
    .values({
      tenantKey,
      scopeType: manifest.agent.scopeType,
      scopeId: manifest.agent.scopeId,
      handle: manifest.agent.handle,
      displayName: manifest.agent.displayName,
      description: manifest.agent.description,
      profileId: profile.id,
      ownerUserId: manifest.agent.ownerUserId,
      visibility: manifest.agent.visibility,
      defaultRuntime: manifest.agent.defaultRuntime,
      defaultWorkDir: manifest.agent.defaultWorkDir,
      projectId: manifest.agent.projectId,
      accessPolicy: manifest.agent.accessPolicy,
      status: manifest.agent.status,
    })
    .onConflictDoUpdate({
      // Manifest agents are ops-owned (NULL platform_owner_id); they conflict on
      // the partial `idx_agents_scope_handle` index (WHERE platform_owner_id IS
      // NULL), so the ON CONFLICT predicate must match that partial index.
      target: [agents.tenantKey, agents.scopeType, agents.scopeId, agents.handle],
      targetWhere: isNull(agents.platformOwnerId),
      set: {
        displayName: manifest.agent.displayName,
        description: manifest.agent.description,
        profileId: profile.id,
        ownerUserId: manifest.agent.ownerUserId,
        visibility: manifest.agent.visibility,
        defaultRuntime: manifest.agent.defaultRuntime,
        defaultWorkDir: manifest.agent.defaultWorkDir,
        projectId: manifest.agent.projectId,
        accessPolicy: manifest.agent.accessPolicy,
        status: manifest.agent.status,
        updatedAt: now,
      },
    })
    .returning({ id: agents.id });

  if (!agent) {
    throw new Error(`Failed to sync agent from ${relativePath}`);
  }

  return {
    path: relativePath,
    profileId: profile.id,
    agentId: agent.id,
    handle: manifest.agent.handle,
  };
}

export async function syncAgentManifests(
  db: Database,
  options: AgentManifestSyncOptions,
): Promise<AgentManifestSyncResult> {
  const manifests = await readAgentManifests(options.repoRoot, { agentsDir: options.agentsDir });
  const synced: SyncedAgentManifest[] = [];
  for (const manifest of manifests) {
    synced.push(await syncLoadedAgentManifest(db, manifest, options.tenantKey ?? 'default'));
  }
  return { scanned: manifests.length, synced };
}
