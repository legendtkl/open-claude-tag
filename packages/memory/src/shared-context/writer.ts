import { SharedContextStore, type AdmitResult } from './store.js';
import { DerivedFromEvidenceVerifier, type Verifier } from './verifier.js';

/**
 * Write side of the shared verified context (DeLM "compress + admit"): on a
 * successful turn, compress the agent's result into a compact gist and admit it
 * into the shared context, so later agents (any kind / any machine) hydrate it
 * via the read path. `@`-mention coordination is unchanged — this only adds the
 * shared memory carried under it.
 */
export interface RecordTurnInput {
  sessionId: string;
  authorAgentId?: string | null;
  authorAgentKind?: string | null;
  authorMachineId?: string | null;
  taskType?: string;
  goal?: string;
  /** The agent's output text for this turn. */
  resultText: string;
  importanceScore?: number;
}

export type RecordTurnResult = AdmitResult | { admitted: false; reason: 'empty result' };

const DEFAULT_MAX_GIST_CHARS = 600; // ~100-150 tokens, per DeLM §4.3.1
const DEFAULT_MAX_EVIDENCE_CHARS = 4000;

/** Whitespace-normalize and truncate at a word boundary. */
function compressToGist(resultText: string, maxChars: number): string {
  const normalized = resultText.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  const slice = normalized.slice(0, maxChars);
  const lastSpace = slice.lastIndexOf(' ');
  return (lastSpace > maxChars * 0.6 ? slice.slice(0, lastSpace) : slice).trim();
}

export class SharedContextWriter {
  private readonly verifier: Verifier;
  private readonly maxGistChars: number;
  private readonly maxEvidenceChars: number;

  constructor(
    private readonly store: SharedContextStore,
    opts?: { verifier?: Verifier; maxGistChars?: number; maxEvidenceChars?: number },
  ) {
    this.verifier = opts?.verifier ?? new DerivedFromEvidenceVerifier();
    this.maxGistChars = opts?.maxGistChars ?? DEFAULT_MAX_GIST_CHARS;
    this.maxEvidenceChars = opts?.maxEvidenceChars ?? DEFAULT_MAX_EVIDENCE_CHARS;
  }

  async recordTurnResult(input: RecordTurnInput): Promise<RecordTurnResult> {
    const raw = input.resultText ?? '';
    if (raw.trim().length === 0) return { admitted: false, reason: 'empty result' };

    // Normalize evidence so the truncation gist is contained in it (the
    // containment verifier checks gist ⊆ evidence).
    const evidenceText = raw.replace(/\s+/g, ' ').trim();
    const gist = compressToGist(raw, this.maxGistChars);
    const inline = evidenceText.slice(0, Math.max(this.maxEvidenceChars, gist.length));

    return this.store.admit(
      {
        sessionId: input.sessionId,
        authorAgentId: input.authorAgentId ?? null,
        authorAgentKind: input.authorAgentKind ?? null,
        authorMachineId: input.authorMachineId ?? null,
        memoryType: 'summary',
        gist,
        evidenceText,
        evidenceRef: { kind: 'inline', inline },
        importanceScore: input.importanceScore ?? 0.6,
      },
      this.verifier,
    );
  }
}
