import { describe, it, expect } from 'vitest';
import {
  RuleBasedEvidenceVerifier,
  LlmGistVerifier,
  DerivedFromEvidenceVerifier,
  extractRefAnchors,
} from '../verifier.js';

describe('extractRefAnchors', () => {
  it('extracts multiple anchors', () => {
    expect(
      extractRefAnchors('foo [ref: lacks trailing comma] bar [ref: single .filter()]'),
    ).toEqual(['lacks trailing comma', 'single .filter()']);
  });

  it('returns empty when no anchor present', () => {
    expect(extractRefAnchors('a plain ungrounded gist')).toEqual([]);
  });
});

describe('RuleBasedEvidenceVerifier', () => {
  const v = new RuleBasedEvidenceVerifier();

  it('admits a gist whose anchor appears verbatim in evidence', () => {
    const r = v.verify({
      gist: 'lambdify single-element tuples need a trailing comma [ref: lacks trailing comma]',
      evidenceText: 'sympy/utilities/lambdify.py:964 lacks trailing comma for single-element tuples',
    });
    expect(r.admit).toBe(true);
    expect(r.verifierId).toBe('rule-based-evidence-verifier');
  });

  it('admits a head … tail anchor when both ends are present', () => {
    const r = v.verify({
      gist: 'the bypass is in _recursive_to_string [ref: manual join ... trailing comma]',
      evidenceText: 'manual join for tuples lacks trailing comma logic',
    });
    expect(r.admit).toBe(true);
  });

  it('rejects a gist whose anchor is absent from evidence', () => {
    const r = v.verify({
      gist: 'punitive damages reduced to USD 1 billion [ref: reduced to USD 1 billion]',
      evidenceText: 'the case involved a conditional affirmance with remittitur',
    });
    expect(r.admit).toBe(false);
    expect(r.reason).toMatch(/unsupported anchor/);
  });

  it('rejects an ungrounded gist that cites no evidence', () => {
    const r = v.verify({ gist: 'a plausible but uncited claim', evidenceText: 'anything' });
    expect(r.admit).toBe(false);
    expect(r.reason).toMatch(/no reference anchor/);
  });
});

describe('DerivedFromEvidenceVerifier', () => {
  const v = new DerivedFromEvidenceVerifier();

  it('admits a gist that is a truncation of the evidence', () => {
    const result = 'Fixed lambdify single-element tuples by adding a trailing comma in _recursive_to_string.';
    const r = v.verify({ gist: 'Fixed lambdify single-element tuples by adding a trailing comma', evidenceText: result });
    expect(r.admit).toBe(true);
    expect(r.verifierId).toBe('system-derived-verifier');
  });

  it('is whitespace-insensitive', () => {
    const r = v.verify({ gist: 'a   b\nc', evidenceText: 'x a b c y' });
    expect(r.admit).toBe(true);
  });

  it('rejects a gist not contained in the evidence', () => {
    const r = v.verify({ gist: 'invented claim not in result', evidenceText: 'the actual result text' });
    expect(r.admit).toBe(false);
  });

  it('rejects an empty gist', () => {
    expect(v.verify({ gist: '', evidenceText: 'anything' }).admit).toBe(false);
  });
});

describe('LlmGistVerifier', () => {
  it('admits when the model answers APPROVED', async () => {
    const v = new LlmGistVerifier({
      verifierId: 'agent-verifier-1',
      call: async () => 'APPROVED — the gist is supported',
    });
    const r = await v.verify({ gist: 'g', evidenceText: 'e' });
    expect(r.admit).toBe(true);
    expect(r.verifierId).toBe('agent-verifier-1');
  });

  it('fails closed on a WRONG verdict', async () => {
    const v = new LlmGistVerifier({
      verifierId: 'agent-verifier-1',
      call: async () => 'WRONG: the damages amount is not in the evidence',
    });
    const r = await v.verify({ gist: 'g', evidenceText: 'e' });
    expect(r.admit).toBe(false);
  });

  it('fails closed on an unparseable verdict', async () => {
    const v = new LlmGistVerifier({ verifierId: 'agent-verifier-1', call: async () => 'maybe?' });
    const r = await v.verify({ gist: 'g', evidenceText: 'e' });
    expect(r.admit).toBe(false);
  });

  it('fails closed on a near-miss verdict token (APPROVEDLY)', async () => {
    const v = new LlmGistVerifier({
      verifierId: 'agent-verifier-1',
      call: async () => 'APPROVEDLY yours',
    });
    const r = await v.verify({ gist: 'g', evidenceText: 'e' });
    expect(r.admit).toBe(false);
  });
});
