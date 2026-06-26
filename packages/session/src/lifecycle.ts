import type { Database } from '@open-tag/storage';
import { sessions } from '@open-tag/storage';
import { eq, lt, and } from 'drizzle-orm';

const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const ARCHIVE_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 hours
const EXPIRE_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export async function transitionSessionLifecycle(db: Database): Promise<{
  idled: number;
  archived: number;
  expired: number;
}> {
  const now = new Date();

  // active → idle (no messages for 30min)
  const idleThreshold = new Date(now.getTime() - IDLE_TIMEOUT_MS);
  const idled = await db
    .update(sessions)
    .set({ status: 'idle', updatedAt: now })
    .where(and(eq(sessions.status, 'active'), lt(sessions.updatedAt, idleThreshold)))
    .returning();

  // idle → archived (idle for 24h)
  const archiveThreshold = new Date(now.getTime() - ARCHIVE_TIMEOUT_MS);
  const archived = await db
    .update(sessions)
    .set({ status: 'archived', updatedAt: now })
    .where(and(eq(sessions.status, 'idle'), lt(sessions.updatedAt, archiveThreshold)))
    .returning();

  // archived → expired (archived for 7d)
  const expireThreshold = new Date(now.getTime() - EXPIRE_TIMEOUT_MS);
  const expired = await db
    .update(sessions)
    .set({ status: 'expired', updatedAt: now })
    .where(and(eq(sessions.status, 'archived'), lt(sessions.updatedAt, expireThreshold)))
    .returning();

  return {
    idled: idled.length,
    archived: archived.length,
    expired: expired.length,
  };
}

export async function touchSession(db: Database, sessionId: string): Promise<void> {
  await db
    .update(sessions)
    .set({
      status: 'active',
      updatedAt: new Date(),
    })
    .where(eq(sessions.id, sessionId));
}

export async function incrementMessageCount(db: Database, sessionId: string): Promise<void> {
  const current = await db
    .select({ count: sessions.messageCount })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);

  if (current.length > 0) {
    await db
      .update(sessions)
      .set({
        messageCount: current[0].count + 1,
        updatedAt: new Date(),
        status: 'active',
      })
      .where(eq(sessions.id, sessionId));
  }
}
