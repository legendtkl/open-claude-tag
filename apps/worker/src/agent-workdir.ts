import { isAbsolute } from 'node:path';

/**
 * Read the `.env`-configured default working directory.
 *
 * Only absolute paths are accepted; a relative path would be ambiguous across
 * the API and worker processes (which may run from different cwds), so it is
 * treated as unset.
 */
export function readDefaultWorkDirEnv(): string | null {
  const raw = process.env.OPEN_TAG_DEFAULT_WORKDIR?.trim();
  if (!raw) return null;
  if (!isAbsolute(raw)) return null;
  return raw;
}

export interface TaskWorkDirInputs {
  /** Session-level binding (`sessions.adhocWorkDir`) — shared across agents in a session. */
  sessionWorkDir?: string | null;
  /** Chat-level binding (`chat_configs.defaultWorkDir`) — set via `/chat set-workdir`. */
  chatWorkDir?: string | null;
  /** `.env` default (`OPEN_TAG_DEFAULT_WORKDIR`). */
  envWorkDir?: string | null;
}

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  // Only absolute paths are usable as a cwd; a relative value would be ambiguous
  // across the API and worker processes, so treat it as unset.
  if (!trimmed || !isAbsolute(trimmed)) return null;
  return trimmed;
}

/**
 * Resolve a task's working directory by the precedence
 * `session → chat → env`. Returns `null` when none is set, in which case the
 * caller falls back to the per-agent home for agent runs.
 *
 * A directory confirmed for the current turn (`constraints.confirmedWorkDir`)
 * is applied by the caller and overrides this result.
 */
export function resolveTaskWorkDir(inputs: TaskWorkDirInputs): string | null {
  return clean(inputs.sessionWorkDir) ?? clean(inputs.chatWorkDir) ?? clean(inputs.envWorkDir);
}
