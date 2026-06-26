import { join, normalize, resolve, sep } from 'path';

export const MEMORY_INDEX_FILE = 'MEMORY.md';
export const NOTES_DIR = 'notes';
export const RUNS_DIR = 'runs';
export const CONFLICTS_DIR = '.conflicts';
export const BASE_MANIFEST_FILE = '.base.json';

const NOTE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * A memory path is the index file or a Markdown note under `notes/`
 * (nesting allowed). Everything else in an agent home — runtime internals,
 * checkouts, scratch files — is outside the memory model.
 */
export function isMemoryPath(relativePath: string): boolean {
  if (relativePath === MEMORY_INDEX_FILE) return true;
  if (!relativePath.startsWith(`${NOTES_DIR}/`)) return false;
  if (!relativePath.endsWith('.md')) return false;
  const segments = relativePath.split('/');
  if (segments.length < 2) return false;
  return segments.slice(1).every((segment) => NOTE_SEGMENT.test(segment));
}

/**
 * Resolve a relative memory path inside a root and verify the result cannot
 * escape it (defense in depth on top of the allowlist above).
 */
export function resolveInside(root: string, relativePath: string): string | null {
  if (relativePath.includes('\0')) return null;
  const normalized = normalize(relativePath);
  if (normalized.startsWith('..') || normalized.startsWith(sep) || /^[A-Za-z]:/.test(normalized)) {
    return null;
  }
  const absolute = resolve(root, normalized);
  const rootAbsolute = resolve(root);
  if (absolute !== rootAbsolute && !absolute.startsWith(rootAbsolute + sep)) return null;
  return absolute;
}

export function checkoutDirFor(homeDir: string, taskId: string): string {
  return join(homeDir, RUNS_DIR, taskId);
}
