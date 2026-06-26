import { readdir } from 'fs/promises';
import { join } from 'path';
import { buildAgentMemorySection } from './prompt.js';
import { DEFAULT_RUN_TTL_MS } from './limits.js';
import { LocalAgentMemoryStore, type MemoryCommitResult } from './store.js';

export {
  MAX_MEMORY_FILES,
  MAX_MEMORY_FILE_BYTES,
  MAX_MEMORY_TOTAL_BYTES,
  MEMORY_MD_INJECT_CAP_BYTES,
  DEFAULT_RUN_TTL_MS,
} from './limits.js';
export { isMemoryPath, MEMORY_INDEX_FILE } from './paths.js';
export { containsHighConfidenceSecret } from './secrets.js';
export { threeWayMerge } from './merge.js';
export {
  buildAgentMemorySection,
  capMemoryMdForInjection,
  seedMemoryTemplate,
  DEFAULT_MEMORY_TEMPLATE,
} from './prompt.js';
export {
  LocalAgentMemoryStore,
  type MemoryCommitResult,
  type MemoryRejectReason,
  type PreparedMemory,
  type RejectedMemoryFile,
} from './store.js';

export interface AgentTaskMemoryRef {
  /** Absolute agent home directory (e.g. `~/.open-claude-tag/agents/<agentId>`). */
  homeDir: string;
  taskId: string;
}

export interface PreparedAgentTaskMemory {
  checkoutPath: string;
  promptSection: string;
}

/**
 * Worker-facing facade: seed + checkout the agent's memory for one task and
 * build the `<agent_memory>` prompt section.
 */
export async function prepareAgentTaskMemory(
  ref: AgentTaskMemoryRef & { displayName?: string },
): Promise<PreparedAgentTaskMemory> {
  const store = new LocalAgentMemoryStore(ref.homeDir);
  const prepared = await store.prepare(ref.taskId, ref.displayName);
  return {
    checkoutPath: prepared.checkoutPath,
    promptSection: buildAgentMemorySection({
      memoryMd: prepared.memoryMd,
      noteFiles: prepared.noteFiles,
      checkoutPath: prepared.checkoutPath,
    }),
  };
}

/** Merge the task's memory checkout back into the agent home. */
export async function finalizeAgentTaskMemory(ref: AgentTaskMemoryRef): Promise<MemoryCommitResult> {
  return new LocalAgentMemoryStore(ref.homeDir).commit(ref.taskId);
}

/** Drop the task's checkout without committing (cancelled / dirty exits). */
export async function discardAgentTaskMemory(ref: AgentTaskMemoryRef): Promise<void> {
  await new LocalAgentMemoryStore(ref.homeDir).discard(ref.taskId);
}

/**
 * Startup janitor: remove stale memory checkouts across every agent home
 * under `<agentsRoot>` (e.g. `~/.open-claude-tag/agents`).
 */
export async function sweepAgentMemoryRuns(
  agentsRoot: string,
  ttlMs: number = DEFAULT_RUN_TTL_MS,
): Promise<Record<string, string[]>> {
  let entries;
  try {
    entries = await readdir(agentsRoot, { withFileTypes: true });
  } catch {
    return {};
  }
  const removedByAgent: Record<string, string[]> = {};
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const removed = await new LocalAgentMemoryStore(join(agentsRoot, entry.name)).sweepStaleRuns(
      ttlMs,
    );
    if (removed.length > 0) removedByAgent[entry.name] = removed;
  }
  return removedByAgent;
}
