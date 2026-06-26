import { and, eq } from 'drizzle-orm';
import type { Database } from './db.js';
import { chatConfigs } from './schema.js';

/**
 * Read the chat-level default working directory (`chat_configs.defaultWorkDir`).
 *
 * This is the chat-shared binding set by `/chat set-workdir`. The worker reads
 * it as the second tier of the `session → chat → env` workdir precedence, which
 * is what makes a chat binding apply to every agent in the chat.
 */
export async function loadChatDefaultWorkDir(
  db: Database,
  tenantKey: string,
  chatId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ defaultWorkDir: chatConfigs.defaultWorkDir })
    .from(chatConfigs)
    .where(and(eq(chatConfigs.tenantKey, tenantKey), eq(chatConfigs.chatId, chatId)))
    .limit(1);

  return row?.defaultWorkDir ?? null;
}
