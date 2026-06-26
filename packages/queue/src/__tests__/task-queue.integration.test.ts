import { randomUUID } from 'crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TaskQueue, TASK_QUEUE_NAME } from '../task-queue.js';
import type { TaskJobData } from '../task-queue.js';

// Real pg-boss regression suite for the enqueue live-job invariant.
// Gated STRICTLY on the package integration flag (set by the test:integration
// script): a developer shell that merely exports DATABASE_URL must not have
// plain unit runs hit a real database.
const describePg = process.env.OPEN_TAG_QUEUE_PG_INTEGRATION === '1' ? describe : describe.skip;

const LIVE_STATES = ['created', 'retry', 'active'];

describePg('task queue pg-boss integration', () => {
  let queue: TaskQueue;
  let sql: postgres.Sql;
  const trackedTaskIds: string[] = [];

  // Far-future startAfter keeps any live worker subscribed to the same queue
  // from fetching these jobs (the fetch SQL requires start_after < now()).
  const farFuture = new Date(Date.now() + 60 * 60 * 1000);

  function makeJobData(): TaskJobData {
    const taskId = randomUUID();
    trackedTaskIds.push(taskId);
    return {
      taskId,
      sessionId: randomUUID(),
      taskType: 'chat_reply',
      goal: `integration goal ${taskId}`,
      runtimeHint: null,
      constraints: {},
    };
  }

  async function jobRowsForTask(taskId: string): Promise<Array<{ id: string; state: string }>> {
    return sql<Array<{ id: string; state: string }>>`
      SELECT id::text AS id, state::text AS state
      FROM pgboss.job
      WHERE name = ${TASK_QUEUE_NAME}
        AND data ->> 'taskId' = ${taskId}
      ORDER BY created_on
    `;
  }

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL is required for task queue Postgres integration tests');
    }
    queue = new TaskQueue(process.env.DATABASE_URL);
    await queue.start();
    sql = postgres(process.env.DATABASE_URL, {
      max: 2,
      idle_timeout: 5,
      connect_timeout: 5,
    });
  });

  afterAll(async () => {
    if (sql && trackedTaskIds.length > 0) {
      await sql`
        DELETE FROM pgboss.job
        WHERE name = ${TASK_QUEUE_NAME}
          AND data ->> 'taskId' = ANY(${trackedTaskIds})
      `;
    }
    await queue?.gracefulShutdown(5000);
    await sql?.end({ timeout: 5 });
  });

  it('re-enqueue after the previous job finished inside the archive window creates a live job', async () => {
    const jobData = makeJobData();

    const firstJobId = await queue.enqueue(jobData, { startAfter: farFuture });
    const initialRows = await jobRowsForTask(jobData.taskId);
    expect(initialRows).toHaveLength(1);
    expect(LIVE_STATES).toContain(initialRows[0].state);

    // Simulate the job finishing while the row is still inside the archive
    // window (pg-boss keeps finished rows in pgboss.job for up to an hour).
    await sql`
      UPDATE pgboss.job
      SET state = 'completed', started_on = now(), completed_on = now()
      WHERE name = ${TASK_QUEUE_NAME} AND id = ${firstJobId}::uuid
    `;

    const secondJobId = await queue.enqueue(jobData, { startAfter: farFuture });

    // The regression this guards: the old implementation returned the
    // deterministic id while no live job existed at all.
    expect(secondJobId).not.toBe(firstJobId);
    const rowsAfterReenqueue = await jobRowsForTask(jobData.taskId);
    const liveRows = rowsAfterReenqueue.filter((row) => LIVE_STATES.includes(row.state));
    expect(liveRows).toHaveLength(1);
    expect(liveRows[0].id).toBe(secondJobId);
  });

  it('replaying the same re-enqueue converges on the existing live job', async () => {
    const jobData = makeJobData();

    const firstJobId = await queue.enqueue(jobData, { startAfter: farFuture });
    await sql`
      UPDATE pgboss.job
      SET state = 'completed', started_on = now(), completed_on = now()
      WHERE name = ${TASK_QUEUE_NAME} AND id = ${firstJobId}::uuid
    `;

    const secondJobId = await queue.enqueue(jobData, { startAfter: farFuture });
    const replayJobId = await queue.enqueue(jobData, { startAfter: farFuture });

    expect(replayJobId).toBe(secondJobId);
    const rows = await jobRowsForTask(jobData.taskId);
    const liveRows = rows.filter((row) => LIVE_STATES.includes(row.state));
    expect(liveRows).toHaveLength(1);
  });

  it('benign replay of an in-flight job does not create a duplicate', async () => {
    const jobData = makeJobData();

    const firstJobId = await queue.enqueue(jobData, { startAfter: farFuture });
    const replayJobId = await queue.enqueue(jobData, { startAfter: farFuture });

    expect(replayJobId).toBe(firstJobId);
    const rows = await jobRowsForTask(jobData.taskId);
    expect(rows).toHaveLength(1);
  });
});
