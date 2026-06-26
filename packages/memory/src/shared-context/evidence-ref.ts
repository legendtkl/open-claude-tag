/**
 * Structured, cross-boundary-portable reference to the raw evidence backing a
 * gist (DeLM selective-unfolding `S → raw`, A.2). Only references that resolve
 * the same way on any machine are allowed:
 *   - `artifact` — a central `artifacts` row (storage URI)
 *   - `git`      — a branch + commit any machine can check out
 *   - `inline`   — self-contained text carried with the gist
 * A bare local filesystem path is NOT portable (it does not exist on another
 * machine) and is rejected at admission.
 */

export type EvidenceRef =
  | { kind: 'artifact'; artifactId: string }
  | { kind: 'git'; gitBranch: string; gitCommit: string }
  | { kind: 'inline'; inline: string };

export class EvidenceRefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvidenceRefError';
  }
}

/** Heuristic: does this value look like a bare local filesystem path? */
export function isLocalPathLike(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const s = value.trim();
  return (
    /^(\/|\.\/|\.\.\/|~\/)/.test(s) || // POSIX absolute / relative / home
    /^[A-Za-z]:[\\/]/.test(s) || // Windows drive
    /^file:\/\//i.test(s)
  );
}

/**
 * Validate an arbitrary value (e.g. a jsonb column or a caller argument) into a
 * portable `EvidenceRef`. Throws `EvidenceRefError` for a missing/invalid ref
 * or a non-portable local-path-shaped ref.
 */
export function parseEvidenceRef(value: unknown): EvidenceRef {
  if (value == null) {
    throw new EvidenceRefError('evidenceRef is required for admission');
  }
  if (isLocalPathLike(value)) {
    throw new EvidenceRefError('evidenceRef points to a bare local path — not cross-boundary portable');
  }
  if (typeof value !== 'object') {
    throw new EvidenceRefError('evidenceRef must be an object');
  }

  const ref = value as Record<string, unknown>;

  // Reject local-path-shaped objects up front.
  if (
    ref.kind === 'path' ||
    ref.kind === 'file' ||
    ref.kind === 'local' ||
    typeof ref.path === 'string' ||
    typeof ref.localPath === 'string'
  ) {
    throw new EvidenceRefError('evidenceRef points to a local path — not cross-boundary portable');
  }

  switch (ref.kind) {
    case 'artifact':
      if (typeof ref.artifactId !== 'string' || ref.artifactId.length === 0) {
        throw new EvidenceRefError('artifact evidenceRef requires a non-empty artifactId');
      }
      return { kind: 'artifact', artifactId: ref.artifactId };
    case 'git':
      if (
        typeof ref.gitBranch !== 'string' ||
        ref.gitBranch.length === 0 ||
        typeof ref.gitCommit !== 'string' ||
        ref.gitCommit.length === 0
      ) {
        throw new EvidenceRefError('git evidenceRef requires gitBranch and gitCommit');
      }
      return { kind: 'git', gitBranch: ref.gitBranch, gitCommit: ref.gitCommit };
    case 'inline':
      if (typeof ref.inline !== 'string' || ref.inline.length === 0) {
        throw new EvidenceRefError('inline evidenceRef requires non-empty inline text');
      }
      if (isLocalPathLike(ref.inline)) {
        throw new EvidenceRefError('inline evidenceRef is just a local path — not portable');
      }
      return { kind: 'inline', inline: ref.inline };
    default:
      throw new EvidenceRefError(`unknown evidenceRef kind: ${String(ref.kind)}`);
  }
}

/** Throw unless `value` is a portable EvidenceRef. */
export function assertCrossBoundaryPortable(value: unknown): EvidenceRef {
  return parseEvidenceRef(value);
}
