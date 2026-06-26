import type { Database } from '@open-tag/storage';
import { sessions, chatActiveSessions } from '@open-tag/storage';
import { eq, and, notInArray } from 'drizzle-orm';

const INTERNAL_SESSION_SCOPES = ['delegated-child', 'discussion'];

export interface SessionInfo {
  id: string;
  sessionKey: string;
  scope: string;
  status: string;
  title: string | null;
  messageCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export async function listSessions(db: Database, chatId: string): Promise<SessionInfo[]> {
  const rows = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.chatId, chatId), notInArray(sessions.scope, INTERNAL_SESSION_SCOPES)))
    .orderBy(sessions.updatedAt);

  return rows.map((r) => ({
    id: r.id,
    sessionKey: r.sessionKey,
    scope: r.scope,
    status: r.status,
    title: r.title,
    messageCount: r.messageCount,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}

export async function useSession(
  db: Database,
  chatId: string,
  targetSessionId: string,
): Promise<{ success: boolean; error?: string }> {
  // Verify session exists and belongs to this chat
  const session = await db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.id, targetSessionId),
        eq(sessions.chatId, chatId),
        notInArray(sessions.scope, INTERNAL_SESSION_SCOPES),
      ),
    )
    .limit(1);

  if (session.length === 0) {
    return { success: false, error: 'Session not found in this chat' };
  }
  const tenantKey = parseTenantFromSessionKey(session[0].sessionKey);

  // Update active session pointer
  await db
    .insert(chatActiveSessions)
    .values({
      tenantKey,
      chatId,
      activeSessionId: targetSessionId,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    })
    .onConflictDoUpdate({
      target: [chatActiveSessions.tenantKey, chatActiveSessions.chatId],
      set: {
        activeSessionId: targetSessionId,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        updatedAt: new Date(),
      },
    });

  return { success: true };
}

function parseTenantFromSessionKey(sessionKey: string): string {
  const match = /^feishu:([^:]+):/.exec(sessionKey);
  return match?.[1] ?? 'default';
}

export async function closeSession(db: Database, sessionId: string): Promise<void> {
  await db
    .update(sessions)
    .set({ status: 'archived', updatedAt: new Date() })
    .where(eq(sessions.id, sessionId));

  await db.delete(chatActiveSessions).where(eq(chatActiveSessions.activeSessionId, sessionId));
}

export async function getSessionStatus(
  db: Database,
  sessionId: string,
): Promise<SessionInfo | null> {
  const rows = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);

  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    id: r.id,
    sessionKey: r.sessionKey,
    scope: r.scope,
    status: r.status,
    title: r.title,
    messageCount: r.messageCount,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}
