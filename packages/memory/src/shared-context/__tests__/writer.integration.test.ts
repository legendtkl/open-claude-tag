import { randomUUID } from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, sessions, sharedContextEntries } from '@open-tag/storage';
import type { Database } from '@open-tag/storage';
import { eq } from 'drizzle-orm';
import { SharedContextStore } from '../store.js';
import { SharedContextWriter } from '../writer.js';

const describePg = process.env.OPEN_TAG_MEMORY_PG_INTEGRATION === '1' ? describe : describe.skip;

describePg('SharedContextWriter integration (recordTurnResult → list)', () => {
  let db: Database;
  let writer: SharedContextWriter;
  let store: SharedContextStore;
  const sessionId = randomUUID();

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL is required for memory Postgres integration tests');
    }
    db = createDb(process.env.DATABASE_URL);
    store = new SharedContextStore(db);
    writer = new SharedContextWriter(store);
    await db.insert(sessions).values({
      id: sessionId,
      sessionKey: `test:shared-context-writer:${sessionId}`,
      chatId: `chat_${sessionId}`,
      scope: 'p2p',
    });
  });

  afterAll(async () => {
    await db.delete(sharedContextEntries).where(eq(sharedContextEntries.sessionId, sessionId));
    await db.delete(sessions).where(eq(sessions.id, sessionId));
  });

  it('records a completed turn as a verified gist that another agent can list', async () => {
    const recorded = await writer.recordTurnResult({
      sessionId,
      authorAgentId: null,
      authorAgentKind: 'claude_code',
      resultText: 'Investigated the failing test and root-caused it to a missing trailing comma in lambdify.',
    });
    expect(recorded.admitted).toBe(true);

    // A different-kind agent reads the session's shared context — no SDK resume.
    const listed = await store.list({ sessionId });
    expect(listed.length).toBeGreaterThanOrEqual(1);
    expect(listed[0].verified).toBe(true);
    expect(listed[0].authorAgentKind).toBe('claude_code');
    expect(listed[0].gist).toContain('lambdify');
  });
});
