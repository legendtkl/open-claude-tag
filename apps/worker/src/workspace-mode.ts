/**
 * Workspace mode decision: which workspace branch + read/write variant applies.
 *
 * Pulled out of `processTask` so it can be unit-tested without mocking the
 * database / queue / runtime adapter.
 */
export type WorkspaceModeKind =
  | 'passthrough_write'
  | 'passthrough_readonly'
  | 'external_write'
  | 'external_readonly'
  | 'self_dev_write'
  | 'self_dev_readonly'
  | 'generic';

export interface WorkspaceModeInput {
  isPassthrough: boolean;
  isExternalProject: boolean;
  isSelfDev: boolean;
  isWrite: boolean;
}

/**
 * Decide which workspace branch this task takes. The three "kind" buckets
 * (passthrough / external / self_dev) are mutually exclusive in caller code;
 * within each we pick write or readonly based on the LLM intent classifier.
 */
export function decideWorkspaceMode(input: WorkspaceModeInput): WorkspaceModeKind {
  const { isPassthrough, isExternalProject, isSelfDev, isWrite } = input;
  if (isPassthrough) return isWrite ? 'passthrough_write' : 'passthrough_readonly';
  if (isExternalProject) return isWrite ? 'external_write' : 'external_readonly';
  if (isSelfDev) return isWrite ? 'self_dev_write' : 'self_dev_readonly';
  return 'generic';
}
