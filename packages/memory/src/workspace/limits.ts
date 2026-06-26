/**
 * Bounds for agent workspace memory (Layer A). Enforced at commit time and
 * surfaced to the agent as rejection feedback rather than silent truncation.
 */
export const MAX_MEMORY_FILE_BYTES = 64 * 1024;
export const MAX_MEMORY_TOTAL_BYTES = 256 * 1024;
export const MAX_MEMORY_FILES = 64;
/** Hard cap for the MEMORY.md content injected verbatim into the prompt. */
export const MEMORY_MD_INJECT_CAP_BYTES = 8 * 1024;
/** Stale checkout TTL for the startup janitor. */
export const DEFAULT_RUN_TTL_MS = 24 * 60 * 60 * 1000;
/** On-disk commit lock is considered stale after this long. */
export const LOCK_STALE_MS = 60 * 1000;
