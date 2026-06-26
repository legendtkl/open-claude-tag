import { canonicalizeSessionId } from '@open-tag/session';
import { tasks, type Database } from '@open-tag/storage';
import { eq } from 'drizzle-orm';

type CanonicalizationLogger = {
  info?: (bindings: Record<string, unknown>, message: string) => void;
};

export async function refreshTaskSessionCanonicalId(input: {
  db: Database;
  taskId: string;
  sessionId: string;
  logger?: CanonicalizationLogger;
  stage: string;
}): Promise<string> {
  const canonicalSessionId = await canonicalizeSessionId(input.db, input.sessionId);
  if (canonicalSessionId === input.sessionId) return input.sessionId;

  await input.db
    .update(tasks)
    .set({ sessionId: canonicalSessionId })
    .where(eq(tasks.id, input.taskId));
  input.logger?.info?.(
    {
      taskId: input.taskId,
      from: input.sessionId,
      to: canonicalSessionId,
      stage: input.stage,
    },
    'Canonicalized task session',
  );
  return canonicalSessionId;
}
