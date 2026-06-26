import type { Database } from '@open-tag/storage';
import { sharedContextEntries, artifacts } from '@open-tag/storage';
import { and, desc, eq } from 'drizzle-orm';
import { containsSensitiveInfo } from '../sensitive-filter.js';
import { parseEvidenceRef, EvidenceRefError, type EvidenceRef } from './evidence-ref.js';
import type { Verifier } from './verifier.js';

/** Re-validate a persisted ref; return null for anything malformed/non-portable. */
function safeParseEvidenceRef(value: unknown): EvidenceRef | null {
  if (value == null) return null;
  try {
    return parseEvidenceRef(value);
  } catch {
    return null;
  }
}

export interface AdmitRequest {
  sessionId: string;
  scopeType?: string;
  scopeId?: string;
  /** Author identity (real agent id, or null = server/system). */
  authorAgentId?: string | null;
  authorAgentKind?: string | null;
  authorMachineId?: string | null;
  /** Optional real verifier-agent id to record on the row (FK to agents). */
  verifierAgentId?: string | null;
  memoryType?: string;
  /** The compact, runtime-neutral gist. */
  gist: string;
  /** Raw evidence the gist is verified against (not persisted). */
  evidenceText: string;
  /** Portable reference to the backing evidence (artifact / git / inline). */
  evidenceRef: unknown;
  importanceScore?: number;
}

export type AdmitResult = { admitted: true; id: string } | { admitted: false; reason: string };

export interface SharedContextQuery {
  sessionId: string;
  scopeType?: string;
  scopeId?: string;
  includeUnverified?: boolean;
  limit?: number;
}

export interface SharedContextEntry {
  id: string;
  sessionId: string;
  scopeType: string;
  scopeId: string;
  authorAgentId: string | null;
  authorAgentKind: string | null;
  authorMachineId: string | null;
  memoryType: string;
  gist: string;
  evidenceRef: EvidenceRef | null;
  verified: boolean;
  importanceScore: number;
  createdAt: Date;
}

export type UnfoldResult =
  | {
      kind: 'artifact';
      artifact: {
        id: string;
        name: string;
        storageUri: string;
        sha256: string | null;
        mimeType: string | null;
      };
    }
  | { kind: 'git'; gitBranch: string; gitCommit: string }
  | { kind: 'inline'; inline: string }
  | null;

/**
 * The shared verified context (DeLM C, arXiv 2606.10662): a runtime-neutral,
 * location-neutral store of compact verified gists that any agent of any kind
 * on any machine can read. Admission is gated by a verifier, the no-self-verify
 * rule, and a cross-boundary-portability check on the evidence reference.
 */
export class SharedContextStore {
  constructor(private readonly db: Database) {}

  async admit(request: AdmitRequest, verifier: Verifier): Promise<AdmitResult> {
    if (containsSensitiveInfo(request.gist)) {
      return { admitted: false, reason: 'gist contains sensitive information' };
    }

    // Cross-boundary portability gate (rejects bare local paths).
    let evidenceRef: EvidenceRef;
    try {
      evidenceRef = parseEvidenceRef(request.evidenceRef);
    } catch (err) {
      if (err instanceof EvidenceRefError) {
        return { admitted: false, reason: err.message };
      }
      throw err;
    }

    // Inline evidence is persisted and exposed by unfold(), so it must pass the
    // same sensitive-content gate as the gist — a secret could sit in the result
    // body outside the (shorter) gist.
    if (evidenceRef.kind === 'inline' && containsSensitiveInfo(evidenceRef.inline)) {
      return { admitted: false, reason: 'inline evidence contains sensitive information' };
    }

    // An artifact-backed gist must reference a real artifact, otherwise a later
    // unfold() would silently return null after the gist was already admitted.
    if (evidenceRef.kind === 'artifact') {
      const [artifact] = await this.db
        .select({ id: artifacts.id })
        .from(artifacts)
        .where(eq(artifacts.id, evidenceRef.artifactId))
        .limit(1);
      if (!artifact) {
        return { admitted: false, reason: `artifact evidence not found: ${evidenceRef.artifactId}` };
      }
    }

    const verdict = await verifier.verify({
      gist: request.gist,
      evidenceText: request.evidenceText,
      authorAgentId: request.authorAgentId,
    });

    // no-self-verify: the verifying actor must differ from the author. Check both
    // the verdict's actor identity and the id that would be persisted, so a
    // mismatched `verifierAgentId` cannot smuggle a self-verified row past the gate.
    if (
      request.authorAgentId != null &&
      (verdict.verifierId === request.authorAgentId ||
        request.verifierAgentId === request.authorAgentId)
    ) {
      return { admitted: false, reason: 'no-self-verify: verifier must differ from author' };
    }

    if (!verdict.admit) {
      return { admitted: false, reason: verdict.reason };
    }

    const scopeId = request.scopeId ?? request.sessionId;
    const [row] = await this.db
      .insert(sharedContextEntries)
      .values({
        sessionId: request.sessionId,
        scopeType: request.scopeType ?? 'session',
        scopeId,
        authorAgentId: request.authorAgentId ?? null,
        authorAgentKind: request.authorAgentKind ?? null,
        authorMachineId: request.authorMachineId ?? null,
        memoryType: request.memoryType ?? 'fact',
        gist: request.gist,
        evidenceRef,
        verified: true,
        verifiedByAgentId: request.verifierAgentId ?? null,
        verifyReason: `[${verdict.verifierId}] ${verdict.reason}`.slice(0, 1000),
        importanceScore: request.importanceScore ?? 0.5,
        status: 'active',
      })
      .returning({ id: sharedContextEntries.id });

    return { admitted: true, id: row.id };
  }

  async list(query: SharedContextQuery): Promise<SharedContextEntry[]> {
    const conditions = [
      eq(sharedContextEntries.sessionId, query.sessionId),
      eq(sharedContextEntries.status, 'active'),
    ];
    if (query.scopeType) conditions.push(eq(sharedContextEntries.scopeType, query.scopeType));
    if (query.scopeId) conditions.push(eq(sharedContextEntries.scopeId, query.scopeId));
    if (!query.includeUnverified) conditions.push(eq(sharedContextEntries.verified, true));

    const rows = await this.db
      .select()
      .from(sharedContextEntries)
      .where(and(...conditions))
      .orderBy(desc(sharedContextEntries.importanceScore), desc(sharedContextEntries.createdAt))
      .limit(query.limit ?? 50);

    return rows.map((r) => ({
      id: r.id,
      sessionId: r.sessionId,
      scopeType: r.scopeType,
      scopeId: r.scopeId,
      authorAgentId: r.authorAgentId,
      authorAgentKind: r.authorAgentKind,
      authorMachineId: r.authorMachineId,
      memoryType: r.memoryType,
      gist: r.gist,
      // Defensively re-validate: a row inserted outside this store could carry a
      // malformed or non-portable ref. Never surface such a ref to a reader.
      evidenceRef: safeParseEvidenceRef(r.evidenceRef),
      verified: r.verified,
      importanceScore: r.importanceScore,
      createdAt: r.createdAt,
    }));
  }

  /** Selective unfolding: resolve a gist's backing evidence on demand (DeLM A.2). */
  async unfold(entryId: string): Promise<UnfoldResult> {
    const [entry] = await this.db
      .select()
      .from(sharedContextEntries)
      .where(eq(sharedContextEntries.id, entryId))
      .limit(1);
    if (!entry || entry.evidenceRef == null) return null;

    const ref = safeParseEvidenceRef(entry.evidenceRef);
    if (!ref) return null;
    if (ref.kind === 'inline') return { kind: 'inline', inline: ref.inline };
    if (ref.kind === 'git') {
      return { kind: 'git', gitBranch: ref.gitBranch, gitCommit: ref.gitCommit };
    }

    const [artifact] = await this.db
      .select()
      .from(artifacts)
      .where(eq(artifacts.id, ref.artifactId))
      .limit(1);
    if (!artifact) return null;
    return {
      kind: 'artifact',
      artifact: {
        id: artifact.id,
        name: artifact.name,
        storageUri: artifact.storageUri,
        sha256: artifact.sha256,
        mimeType: artifact.mimeType,
      },
    };
  }
}
