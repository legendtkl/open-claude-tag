import { describe, it, expect } from 'vitest';
import type { Database } from '@open-tag/storage';
import { SharedContextStore } from '../store.js';
import { RuleBasedEvidenceVerifier, LlmGistVerifier, type Verifier } from '../verifier.js';

// A db that fails the test if any write is attempted — proves rejected
// admissions never persist.
const noWriteDb = {
  insert() {
    throw new Error('insert must not be called on a rejected admission');
  },
} as unknown as Database;

const alwaysAdmit: Verifier = {
  verify: () => ({ admit: true, reason: 'ok', verifierId: 'stub-verifier' }),
};

const validGist = 'lambdify needs a trailing comma [ref: lacks trailing comma]';
const validEvidence = 'lambdify.py:964 lacks trailing comma for single-element tuples';
// Inline so the pre-persist gates do not hit the artifact-existence DB lookup
// (the no-write stub db has no `select`); artifact existence is covered in the
// integration test.
const validRef = { kind: 'inline', inline: 'lambdify.py:964 lacks trailing comma' };

describe('SharedContextStore.admit pre-persist gates', () => {
  const store = new SharedContextStore(noWriteDb);

  it('rejects a gist that contains sensitive information', async () => {
    const r = await store.admit(
      {
        sessionId: 's1',
        gist: 'token is sk-abcdefghijklmnopqrstuvwxyz1234567890 [ref: x]',
        evidenceText: 'x',
        evidenceRef: validRef,
      },
      alwaysAdmit,
    );
    expect(r.admitted).toBe(false);
    if (!r.admitted) expect(r.reason).toMatch(/sensitive/);
  });

  it('rejects when inline evidence contains sensitive information', async () => {
    const r = await store.admit(
      {
        sessionId: 's1',
        gist: validGist,
        evidenceText: validEvidence,
        evidenceRef: {
          kind: 'inline',
          inline: 'result log includes sk-abcdefghijklmnopqrstuvwxyz1234567890',
        },
      },
      alwaysAdmit,
    );
    expect(r.admitted).toBe(false);
    if (!r.admitted) expect(r.reason).toMatch(/sensitive/);
  });

  it('rejects a non-portable local-path evidence ref before verifying', async () => {
    const r = await store.admit(
      {
        sessionId: 's1',
        gist: validGist,
        evidenceText: validEvidence,
        evidenceRef: '/Users/me/repo/lambdify.py',
      },
      alwaysAdmit,
    );
    expect(r.admitted).toBe(false);
    if (!r.admitted) expect(r.reason).toMatch(/portable/);
  });

  it('rejects when the verifier rejects the gist', async () => {
    const r = await store.admit(
      {
        sessionId: 's1',
        gist: 'an ungrounded claim with no anchor',
        evidenceText: validEvidence,
        evidenceRef: validRef,
      },
      new RuleBasedEvidenceVerifier(),
    );
    expect(r.admitted).toBe(false);
    if (!r.admitted) expect(r.reason).toMatch(/no reference anchor/);
  });

  it('rejects self-verification (verifier id equals author id)', async () => {
    const author = 'agent-123';
    const selfVerifier = new LlmGistVerifier({
      verifierId: author, // same actor as the author
      call: async () => 'APPROVED',
    });
    const r = await store.admit(
      {
        sessionId: 's1',
        authorAgentId: author,
        gist: validGist,
        evidenceText: validEvidence,
        evidenceRef: validRef,
      },
      selfVerifier,
    );
    expect(r.admitted).toBe(false);
    if (!r.admitted) expect(r.reason).toMatch(/no-self-verify/);
  });
});
