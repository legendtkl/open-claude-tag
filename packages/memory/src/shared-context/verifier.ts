/**
 * Admission-time verification for the shared verified context (DeLM §2.3 / A.3,
 * arXiv 2606.10662). Before a gist becomes visible to other agents it is checked
 * against its cited evidence; unsupported gists are rejected so a plausible but
 * unsupported claim cannot propagate as reusable shared state.
 */

export interface VerifyInput {
  /** The compact gist being admitted. */
  gist: string;
  /** The underlying evidence the gist must be grounded in. */
  evidenceText: string;
  /** Author identity, used by the store to enforce no-self-verify. */
  authorAgentId?: string | null;
}

export interface VerifyResult {
  admit: boolean;
  reason: string;
  /** Identity of the verifying actor — MUST differ from the author. */
  verifierId: string;
}

export interface Verifier {
  verify(input: VerifyInput): VerifyResult | Promise<VerifyResult>;
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Extract DeLM-style `[ref: ...]` anchors from a gist. */
export function extractRefAnchors(gist: string): string[] {
  const anchors: string[] = [];
  const re = /\[ref:\s*([^\]]+)\]/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(gist)) !== null) {
    anchors.push(m[1].trim());
  }
  return anchors;
}

/**
 * Deterministic, offline reference-anchor verifier. Admits a gist only when
 * every `[ref: ...]` anchor it cites appears verbatim in the evidence (a
 * `head … tail` anchor requires both ends present). A gist with no anchor is
 * treated as ungrounded and rejected — admitted gists MUST cite evidence.
 */
export class RuleBasedEvidenceVerifier implements Verifier {
  readonly verifierId: string;

  constructor(verifierId = 'rule-based-evidence-verifier') {
    this.verifierId = verifierId;
  }

  verify(input: VerifyInput): VerifyResult {
    const anchors = extractRefAnchors(input.gist);
    if (anchors.length === 0) {
      return {
        admit: false,
        reason: 'no reference anchor: admitted gists must cite evidence via [ref: ...]',
        verifierId: this.verifierId,
      };
    }

    const evidence = normalize(input.evidenceText);
    for (const anchor of anchors) {
      const parts = anchor.split(/\s*(?:\.\.\.|…)\s*/);
      const spans = parts.length > 1 ? [parts[0], parts[parts.length - 1]] : [anchor];
      for (const span of spans) {
        const needle = normalize(span);
        if (needle.length > 0 && !evidence.includes(needle)) {
          return {
            admit: false,
            reason: `unsupported anchor: "${anchor}" not found in evidence`,
            verifierId: this.verifierId,
          };
        }
      }
    }

    return { admit: true, reason: 'all anchors grounded in evidence', verifierId: this.verifierId };
  }
}

/**
 * Deterministic verifier for the write-back path: admits a gist that was derived
 * from (is contained in) its evidence — true by construction for a truncation
 * gist of a turn result. No LLM needed; a swappable seam for `LlmGistVerifier`
 * later. Its id is a system constant (never an agent), so the store's
 * no-self-verify gate passes while the gist's author remains the real agent.
 */
export class DerivedFromEvidenceVerifier implements Verifier {
  readonly verifierId: string;

  constructor(verifierId = 'system-derived-verifier') {
    this.verifierId = verifierId;
  }

  verify(input: VerifyInput): VerifyResult {
    const gist = normalize(input.gist);
    const evidence = normalize(input.evidenceText);
    if (gist.length > 0 && evidence.includes(gist)) {
      return { admit: true, reason: 'gist is grounded in (derived from) the result', verifierId: this.verifierId };
    }
    return { admit: false, reason: 'gist is not contained in its evidence', verifierId: this.verifierId };
  }
}

/**
 * LLM-backed verifier (DeLM A.3) wrapping an injected cheap-model call. The
 * model is asked to answer APPROVED / WRONG; anything that is not an explicit
 * APPROVED is treated as a rejection (fail-closed).
 */
export class LlmGistVerifier implements Verifier {
  private readonly verifierId: string;
  private readonly call: (prompt: string) => Promise<string>;

  constructor(opts: { verifierId: string; call: (prompt: string) => Promise<string> }) {
    this.verifierId = opts.verifierId;
    this.call = opts.call;
  }

  async verify(input: VerifyInput): Promise<VerifyResult> {
    const prompt = [
      'You verify whether a GIST is fully supported by the EVIDENCE.',
      'Answer on the first line with exactly APPROVED or WRONG, then a brief reason.',
      '',
      `GIST:\n${input.gist}`,
      '',
      `EVIDENCE:\n${input.evidenceText}`,
    ].join('\n');

    const raw = (await this.call(prompt)) ?? '';
    // The verdict is the first whitespace-delimited token of the first line, so
    // `APPROVEDLY` or a stray sentence does not count as approval (fail-closed).
    const firstLine = raw.trim().split('\n', 1)[0] ?? '';
    const verdictToken = firstLine.trim().split(/\s+/, 1)[0]?.toUpperCase() ?? '';
    const admit = verdictToken === 'APPROVED';
    return {
      admit,
      reason: raw.trim().slice(0, 500) || (admit ? 'approved' : 'rejected'),
      verifierId: this.verifierId,
    };
  }
}
