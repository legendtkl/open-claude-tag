import type { ReplyLanguage } from '@open-tag/core-types';
import type { Database } from '@open-tag/storage';
import { messages } from '@open-tag/storage';
import { and, desc, eq } from 'drizzle-orm';

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function extractReplyLanguageFromMessageMetadata(
  metadata: unknown,
): ReplyLanguage | undefined {
  if (!isObjectRecord(metadata)) return undefined;

  const value = metadata.replyLanguage;
  if (value === 'zh-CN' || value === 'en-US') {
    return value;
  }

  return undefined;
}

export async function getLatestUserReplyLanguage(
  db: Database,
  sessionId: string,
): Promise<ReplyLanguage | undefined> {
  const recentMessages = await db
    .select({ metadata: messages.metadata })
    .from(messages)
    .where(and(eq(messages.sessionId, sessionId), eq(messages.role, 'user')))
    .orderBy(desc(messages.createdAt))
    .limit(50);

  for (const message of recentMessages) {
    const replyLanguage = extractReplyLanguageFromMessageMetadata(message.metadata);
    if (replyLanguage) {
      return replyLanguage;
    }
  }

  return undefined;
}

export async function resolvePreferredReplyLanguage(
  db: Database,
  sessionId: string,
  currentReplyLanguage?: ReplyLanguage,
): Promise<ReplyLanguage> {
  if (currentReplyLanguage) {
    return currentReplyLanguage;
  }

  return (await getLatestUserReplyLanguage(db, sessionId)) ?? 'en-US';
}
