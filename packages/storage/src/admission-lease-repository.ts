import { and, asc, eq, isNull, lte, or, sql } from 'drizzle-orm';
import type { Database } from './db.js';
import { admissionLeases } from './schema.js';

export type AdmissionLeaseRecord = typeof admissionLeases.$inferSelect;

export interface UpsertAdmissionLeaseInput {
  taskId: string;
  agentId?: string | null;
  sessionId: string;
  jobData: Record<string, unknown>;
  notBefore: Date;
}

export async function upsertAdmissionLease(
  db: Database,
  input: UpsertAdmissionLeaseInput,
): Promise<AdmissionLeaseRecord> {
  const [lease] = await db
    .insert(admissionLeases)
    .values({
      taskId: input.taskId,
      agentId: input.agentId,
      sessionId: input.sessionId,
      jobData: input.jobData,
      notBefore: input.notBefore,
    })
    .onConflictDoUpdate({
      target: admissionLeases.taskId,
      set: {
        agentId: input.agentId,
        sessionId: input.sessionId,
        jobData: input.jobData,
        notBefore: input.notBefore,
        updatedAt: new Date(),
      },
    })
    .returning();

  if (!lease) {
    throw new Error(`Failed to upsert admission lease for task ${input.taskId}`);
  }
  return lease;
}

export async function deleteAdmissionLease(db: Database, taskId: string): Promise<void> {
  await db.delete(admissionLeases).where(eq(admissionLeases.taskId, taskId));
}

export async function listDueAdmissionLeases(
  db: Database,
  input: { now?: Date; limit?: number } = {},
): Promise<AdmissionLeaseRecord[]> {
  const now = input.now ?? new Date();
  const limit = input.limit ?? 25;
  return db
    .select()
    .from(admissionLeases)
    .where(
      and(
        lte(admissionLeases.notBefore, now),
        or(isNull(admissionLeases.leaseExpiresAt), lte(admissionLeases.leaseExpiresAt, now)),
      ),
    )
    .orderBy(asc(admissionLeases.notBefore))
    .limit(limit);
}

export async function markAdmissionLeaseRescheduled(
  db: Database,
  input: { taskId: string; nextNotBefore?: Date },
): Promise<void> {
  await db
    .update(admissionLeases)
    .set({
      attempts: sql`${admissionLeases.attempts} + 1`,
      notBefore: input.nextNotBefore,
      updatedAt: new Date(),
    })
    .where(eq(admissionLeases.taskId, input.taskId));
}
