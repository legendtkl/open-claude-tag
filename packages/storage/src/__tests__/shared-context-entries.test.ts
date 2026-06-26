import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../db.js';
import { sharedContextEntries, sessions } from '../schema.js';
import * as schema from '../schema.js';

const describePg =
  process.env.OPEN_TAG_STORAGE_PG_INTEGRATION === '1' ? describe : describe.skip;

describePg('shared_context_entries integration', () => {
  let client: postgres.Sql;
  let db: Database;
  const cleanupSessionIds: string[] = [];

  beforeAll(() => {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL is required for storage Postgres integration tests');
    }
    client = postgres(process.env.DATABASE_URL, {
      max: 4,
      idle_timeout: 5,
      connect_timeout: 5,
    });
    db = drizzle(client, { schema }) as unknown as Database;
  });

  afterEach(async () => {
    for (const sessionId of cleanupSessionIds.splice(0)) {
      await db.delete(sharedContextEntries).where(eq(sharedContextEntries.sessionId, sessionId));
      await db.delete(sessions).where(eq(sessions.id, sessionId));
    }
  });

  afterAll(async () => {
    await client.end({ timeout: 5 });
  });

  it('persists a runtime-neutral gist with a structured evidence ref', async () => {
    const sessionId = randomUUID();
    cleanupSessionIds.push(sessionId);
    await db.insert(sessions).values({
      id: sessionId,
      sessionKey: `test:shared-context:${sessionId}`,
      chatId: `chat_${sessionId}`,
      scope: 'p2p',
    });

    const [inserted] = await db
      .insert(sharedContextEntries)
      .values({
        sessionId,
        scopeId: sessionId,
        authorAgentKind: 'claude_code',
        memoryType: 'fact',
        gist: 'lambdify single-element tuples lack a trailing comma',
        evidenceRef: { kind: 'git', gitBranch: 'fix/lambdify', gitCommit: 'abc1234' },
        verified: true,
        verifyReason: 'anchor grounded',
        importanceScore: 0.7,
      })
      .returning({ id: sharedContextEntries.id });

    const rows = await db
      .select()
      .from(sharedContextEntries)
      .where(eq(sharedContextEntries.id, inserted.id));

    expect(rows).toHaveLength(1);
    expect(rows[0].gist).toContain('trailing comma');
    expect(rows[0].verified).toBe(true);
    expect(rows[0].evidenceRef).toMatchObject({ kind: 'git', gitCommit: 'abc1234' });
    expect(rows[0].authorAgentKind).toBe('claude_code');
  });
});
