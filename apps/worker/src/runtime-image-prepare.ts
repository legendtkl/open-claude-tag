import type { TaskSpec } from '@open-tag/core-types';
import {
  collectTaskImageAttachments,
  type RuntimeAdapter,
  type WorkspaceContext,
} from '@open-tag/runtime-adapters';

export async function prepareResumeImagePaths(
  adapter: RuntimeAdapter,
  taskSpec: TaskSpec,
  workspace: WorkspaceContext,
): Promise<string[]> {
  if (collectTaskImageAttachments(taskSpec).length === 0) return [];

  const handle = await adapter.prepare(taskSpec, workspace);
  return handle.imagePaths ?? [];
}
