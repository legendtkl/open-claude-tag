import { eq, sql } from 'drizzle-orm';
import type { Database } from './db.js';
import { tasks } from './schema.js';

/**
 * The serializable ACK-message handle persisted into a task's existing
 * `constraints` jsonb under the `ackDelivery` key (issue #14). Reusing the column
 * avoids a migration. Stored so a recovery redelivery (a `task_duplicate` whose
 * original dispatch ACKed but failed before enqueue) can rehydrate the original
 * ACK handle into the re-enqueued job WITHOUT re-ACKing, letting the worker update
 * the first "Task queued" message in place instead of posting an orphaned second
 * terminal message. The shape is a structural mirror of the channel-neutral
 * `NeutralAckDelivery`; storage stays decoupled from channel types.
 */
export interface TaskAckDelivery {
  kind: string;
  scopeId: string;
  messageId: string;
}

/**
 * Merge an ACK-message handle into a task's existing `constraints` jsonb under the
 * `ackDelivery` key. Atomic jsonb shallow-merge (`||`) so a concurrent writer
 * never clobbers sibling constraint keys; `coalesce` guards a null `constraints`.
 */
export async function setTaskAckDelivery(
  db: Database,
  taskId: string,
  ack: TaskAckDelivery,
): Promise<void> {
  await db
    .update(tasks)
    .set({
      constraints: sql`coalesce(${tasks.constraints}, '{}'::jsonb) || ${JSON.stringify({
        ackDelivery: ack,
      })}::jsonb`,
    })
    .where(eq(tasks.id, taskId));
}

/**
 * Read back the persisted ACK handle for a task, or null when none was stored.
 * Generic in the handle type so a caller (the neutral dispatch wiring) can recover
 * its channel-typed `NeutralAckDelivery` without storage importing channel types.
 */
export async function getTaskAckDelivery<T extends TaskAckDelivery = TaskAckDelivery>(
  db: Database,
  taskId: string,
): Promise<T | null> {
  const [row] = await db
    .select({ constraints: tasks.constraints })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1);
  const constraints = row?.constraints as { ackDelivery?: T } | null | undefined;
  return constraints?.ackDelivery ?? null;
}
