import { sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { Database } from '@open-tag/storage';
import type { TaskJobData, TaskQueue } from '@open-tag/queue';
import { errorMessage } from '@open-tag/core-types';

interface RecoverableTaskRow {
  taskId: string;
  sessionId: string;
  taskType: string;
  goal: string;
  runtimeHint: string | null;
  constraints: Record<string, unknown> | null;
  chatId: string | null;
  feedbackMessageId: string | null;
  sdkSessionId: string | null;
  runtimeBackend: string | null;
  latestJobState: string | null;
}

export interface StartupRecoveryResult {
  inspected: number;
  requeued: number;
  failed: number;
}

export async function recoverStaleRunningTasks(params: {
  db: Database;
  queue: TaskQueue;
  logger: Pick<Logger, 'info' | 'warn' | 'error'>;
  lookbackHours?: number;
}): Promise<StartupRecoveryResult> {
  const { db, queue, logger, lookbackHours = 24 } = params;
  const rows = (await db.execute(sql<RecoverableTaskRow>`
    with latest_job as (
      -- Timed-out pg-boss jobs move from pgboss.job to pgboss.archive. Recovery
      -- must inspect both tables or stale tasks will remain "running" forever.
      select distinct on (task_id)
        task_id,
        state
      from (
        select
          data->>'taskId' as task_id,
          state,
          created_on
        from pgboss.job
        where data ? 'taskId'

        union all

        select
          data->>'taskId' as task_id,
          state,
          created_on
        from pgboss.archive
        where data ? 'taskId'
      ) queue_jobs
      order by task_id, created_on desc
    )
    select
      t.id::text as "taskId",
      t.session_id::text as "sessionId",
      t.task_type as "taskType",
      t.goal as "goal",
      t.runtime_hint as "runtimeHint",
      t.constraints as "constraints",
      s.chat_id as "chatId",
      t.feedback_message_id as "feedbackMessageId",
      s.sdk_session_id as "sdkSessionId",
      s.runtime_backend as "runtimeBackend",
      lj.state as "latestJobState"
    from tasks t
    left join sessions s on s.id = t.session_id
    left join latest_job lj on lj.task_id = t.id::text
    where t.status = 'running'
      and t.updated_at >= now() - (${lookbackHours} * interval '1 hour')
      and not exists (
        select 1
        from pgboss.job active_job
        where active_job.state = 'active'
          and active_job.data->>'taskId' = t.id::text
      )
      and (lj.state = 'failed' or lj.state is null)
    order by t.updated_at desc
  `)) as unknown as RecoverableTaskRow[];

  if (rows.length === 0) {
    logger.info('No stale running tasks found during startup recovery');
    return { inspected: 0, requeued: 0, failed: 0 };
  }

  let requeued = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      logger.warn(
        {
          taskId: row.taskId,
          sessionId: row.sessionId,
          latestJobState: row.latestJobState,
        },
        'Recovering stale running task during worker startup',
      );

      await db.execute(sql`
        update tasks
        set
          status = 'queued',
          error_message = null,
          feedback_state = case
            when feedback_message_id is not null then 'queued'
            else feedback_state
          end,
          feedback_updated_at = case
            when feedback_message_id is not null then now()
            else feedback_updated_at
          end,
          updated_at = now()
        where id = ${row.taskId}
      `);

      const jobData: TaskJobData = {
        taskId: row.taskId,
        sessionId: row.sessionId,
        taskType: row.taskType,
        goal: row.goal,
        runtimeHint: row.runtimeHint,
        constraints: {
          ...(row.constraints ?? {}),
          ...(row.chatId && !row.constraints?.chatId ? { chatId: row.chatId } : {}),
          ...(row.feedbackMessageId && !row.constraints?.ackMessageId
            ? { ackMessageId: row.feedbackMessageId }
            : {}),
        },
        ...(row.sdkSessionId ? { sdkSessionId: row.sdkSessionId } : {}),
        ...(row.runtimeBackend ? { runtimeBackend: row.runtimeBackend } : {}),
      };

      const jobId = await queue.enqueue(jobData);
      requeued += 1;
      logger.info({ taskId: row.taskId, sessionId: row.sessionId, jobId }, 'Re-enqueued stale running task');
    } catch (error) {
      const failureMessage = errorMessage(error);
      await db.execute(sql`
        update tasks
        set
          status = 'failed',
          error_message = ${`Startup recovery failed: ${failureMessage}`},
          feedback_state = case
            when feedback_message_id is not null then 'failed'
            else feedback_state
          end,
          feedback_updated_at = case
            when feedback_message_id is not null then now()
            else feedback_updated_at
          end,
          updated_at = now()
        where id = ${row.taskId}
      `);
      failed += 1;
      logger.error({ taskId: row.taskId, sessionId: row.sessionId, err: error }, 'Failed to recover stale running task');
    }
  }

  return {
    inspected: rows.length,
    requeued,
    failed,
  };
}
