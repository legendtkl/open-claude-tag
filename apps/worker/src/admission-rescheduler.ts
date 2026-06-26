import { TaskStatus } from '@open-tag/core-types';
import type { TaskJobData } from '@open-tag/queue';

export interface AdmissionLeaseForRescheduler {
  taskId: string;
  sessionId: string;
  jobData: TaskJobData;
}

export interface QueuedTaskForAdmission {
  status: string;
}

export interface AdmissionReschedulerLogger {
  info(meta: Record<string, unknown>, message: string): void;
  warn(meta: Record<string, unknown>, message: string): void;
  error(meta: Record<string, unknown>, message: string): void;
}

export interface AdmissionReschedulerDeps {
  listDueLeases(input: { limit: number }): Promise<AdmissionLeaseForRescheduler[]>;
  loadTask(taskId: string): Promise<QueuedTaskForAdmission | null>;
  enqueue(data: TaskJobData, options?: { startAfter?: Date }): Promise<string | null>;
  deleteLease(taskId: string): Promise<void>;
  markLeaseRescheduled(input: { taskId: string; nextNotBefore: Date }): Promise<void>;
  logger: AdmissionReschedulerLogger;
  batchSize: number;
  retryDelayMs: number;
  now?: () => number;
}

export async function runAdmissionReschedulerOnce(
  deps: AdmissionReschedulerDeps,
): Promise<{ inspected: number; enqueued: number; deleted: number; delayed: number }> {
  const now = deps.now ?? Date.now;
  const leases = await deps.listDueLeases({ limit: deps.batchSize });
  let enqueued = 0;
  let deleted = 0;
  let delayed = 0;

  for (const lease of leases) {
    const taskRow = await deps.loadTask(lease.taskId);

    if (!taskRow || taskRow.status !== TaskStatus.QUEUED) {
      await deps.deleteLease(lease.taskId);
      deleted += 1;
      deps.logger.info(
        { taskId: lease.taskId, status: taskRow?.status },
        'Deleted admission lease for non-queued task',
      );
      continue;
    }

    const startAfter = new Date(Math.max(now(), now() + 1));
    const jobId = await deps.enqueue(lease.jobData, { startAfter });

    if (jobId) {
      await deps.deleteLease(lease.taskId);
      enqueued += 1;
      deps.logger.info({ taskId: lease.taskId, jobId }, 'Rescheduled admitted lease task');
      continue;
    }

    await deps.markLeaseRescheduled({
      taskId: lease.taskId,
      nextNotBefore: new Date(now() + deps.retryDelayMs),
    });
    delayed += 1;
    deps.logger.warn(
      { taskId: lease.taskId, sessionId: lease.sessionId },
      'Admission lease reschedule hit a singleton collision; will retry later',
    );
  }

  return { inspected: leases.length, enqueued, deleted, delayed };
}
