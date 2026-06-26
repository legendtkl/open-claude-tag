import { randomUUID } from 'crypto';
import { TaskStatus } from '@open-tag/core-types';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  listDueAdmissionLeases,
  upsertAdmissionLease,
} from '../admission-lease-repository.js';
import type { Database } from '../db.js';
import { admissionLeases, sessions, tasks } from '../schema.js';
import * as schema from '../schema.js';

const describePg =
  process.env.OPEN_TAG_STORAGE_PG_INTEGRATION === '1' ? describe : describe.skip;

describePg('admission lease repository integration', () => {
  let client: postgres.Sql;
  let db: Database;
  const cleanupTaskIds: string[] = [];
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
    for (const taskId of cleanupTaskIds.splice(0)) {
      await db.delete(admissionLeases).where(eq(admissionLeases.taskId, taskId));
      await db.delete(tasks).where(eq(tasks.id, taskId));
    }
    for (const sessionId of cleanupSessionIds.splice(0)) {
      await db.delete(sessions).where(eq(sessions.id, sessionId));
    }
  });

  afterAll(async () => {
    await client.end({ timeout: 5 });
  });

  it('lists due leases with a real Postgres timestamp comparison', async () => {
    const sessionId = randomUUID();
    const taskId = randomUUID();
    cleanupSessionIds.push(sessionId);
    cleanupTaskIds.push(taskId);

    await db.insert(sessions).values({
      id: sessionId,
      sessionKey: `test:admission:${sessionId}`,
      chatId: `chat_${sessionId}`,
      scope: 'p2p',
      status: 'active',
    });
    await db.insert(tasks).values({
      id: taskId,
      sessionId,
      taskType: 'chat_reply',
      goal: 'replay due lease',
      status: TaskStatus.QUEUED,
      constraints: {},
    });
    await upsertAdmissionLease(db, {
      taskId,
      sessionId,
      jobData: {
        taskId,
        sessionId,
        taskType: 'chat_reply',
        goal: 'replay due lease',
        runtimeHint: null,
        constraints: { timeoutSec: 1800 },
      },
      notBefore: new Date(Date.now() - 1000),
    });

    const dueLeases = await listDueAdmissionLeases(db, { now: new Date(), limit: 10 });

    expect(dueLeases.some((lease) => lease.taskId === taskId)).toBe(true);
  });
});
