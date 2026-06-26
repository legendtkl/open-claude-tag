import { randomUUID } from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, sessions, artifacts, sharedContextEntries } from '@open-tag/storage';
import type { Database } from '@open-tag/storage';
import { eq } from 'drizzle-orm';
import { SharedContextStore } from '../store.js';
import { RuleBasedEvidenceVerifier } from '../verifier.js';

const describePg = process.env.OPEN_TAG_MEMORY_PG_INTEGRATION === '1' ? describe : describe.skip;

describePg('SharedContextStore integration (admit → list → unfold)', () => {
  let db: Database;
  let store: SharedContextStore;
  const sessionId = randomUUID();
  const verifier = new RuleBasedEvidenceVerifier();

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL is required for memory Postgres integration tests');
    }
    db = createDb(process.env.DATABASE_URL);
    store = new SharedContextStore(db);
    await db.insert(sessions).values({
      id: sessionId,
      sessionKey: `test:shared-context-store:${sessionId}`,
      chatId: `chat_${sessionId}`,
      scope: 'p2p',
    });
  });

  afterAll(async () => {
    await db.delete(sharedContextEntries).where(eq(sharedContextEntries.sessionId, sessionId));
    await db.delete(sessions).where(eq(sessions.id, sessionId));
  });

  it('admits a grounded gist and lists it across kinds; rejected gist is not listed', async () => {
    const admitted = await store.admit(
      {
        sessionId,
        authorAgentKind: 'claude_code',
        gist: 'lambdify single-element tuples need a trailing comma [ref: lacks trailing comma]',
        evidenceText: 'lambdify.py:964 lacks trailing comma for single-element tuples',
        evidenceRef: { kind: 'inline', inline: 'lambdify.py:964 lacks trailing comma' },
      },
      verifier,
    );
    expect(admitted.admitted).toBe(true);

    const rejected = await store.admit(
      {
        sessionId,
        gist: 'an ungrounded claim',
        evidenceText: 'whatever',
        evidenceRef: { kind: 'inline', inline: 'whatever' },
      },
      verifier,
    );
    expect(rejected.admitted).toBe(false);

    // A codex agent reads the same session's shared context — no SDK resume.
    const listed = await store.list({ sessionId });
    expect(listed).toHaveLength(1);
    expect(listed[0].gist).toContain('trailing comma');
    expect(listed[0].verified).toBe(true);
    expect(listed[0].authorAgentKind).toBe('claude_code');
  });

  it('unfolds an artifact-backed gist to its storage coordinates', async () => {
    const [artifact] = await db
      .insert(artifacts)
      .values({
        artifactType: 'evidence',
        name: 'trace.log',
        storageUri: 's3://bucket/trace.log',
        sha256: 'deadbeef',
        mimeType: 'text/plain',
      })
      .returning({ id: artifacts.id });

    const admitted = await store.admit(
      {
        sessionId,
        gist: 'the fix is on the tuple-building path [ref: manual join]',
        evidenceText: 'manual join for tuples lacks trailing comma logic',
        evidenceRef: { kind: 'artifact', artifactId: artifact.id },
      },
      verifier,
    );
    expect(admitted.admitted).toBe(true);
    if (!admitted.admitted) return;

    const unfolded = await store.unfold(admitted.id);
    expect(unfolded?.kind).toBe('artifact');
    if (unfolded?.kind === 'artifact') {
      expect(unfolded.artifact.storageUri).toBe('s3://bucket/trace.log');
    }

    await db.delete(artifacts).where(eq(artifacts.id, artifact.id));
  });

  it('rejects an artifact-backed gist whose artifact does not exist', async () => {
    const r = await store.admit(
      {
        sessionId,
        gist: 'claims an artifact [ref: manual join]',
        evidenceText: 'manual join for tuples',
        evidenceRef: { kind: 'artifact', artifactId: randomUUID() },
      },
      verifier,
    );
    expect(r.admitted).toBe(false);
    if (!r.admitted) expect(r.reason).toMatch(/artifact evidence not found/);
  });
});
