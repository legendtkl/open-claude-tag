import PgBoss from 'pg-boss';
import postgres from 'postgres';
import { createLogger } from '@open-tag/observability';
import type { TaskStatus } from '@open-tag/core-types';
import { errorMessage, stableUuidFromKey } from '@open-tag/core-types';

const logger = createLogger('task-queue');

export const TASK_QUEUE_NAME = 'open-claude-tag-tasks';
export const TASK_QUEUE_POLICY = 'singleton';
const PG_BOSS_SCHEMA = 'pgboss';
const DEFAULT_POLLING_INTERVAL_MS = 1000;
const FULL_CAPACITY_WAIT_MS = 100;
// pg-boss v10 job states. Live = a job that will still run (or is running);
// finished rows linger in pgboss.job until archival and still block id reuse.
// Any state outside these two sets means the pg-boss table layout changed —
// fail loudly instead of guessing.
const LIVE_JOB_STATES = new Set(['created', 'retry', 'active']);
const FINISHED_JOB_STATES = new Set(['completed', 'cancelled', 'failed']);
// Every column the custom pgboss.job SQL below reads or writes. The startup
// self-check (assertPgBossLayout) fails loudly when a pg-boss version bump
// renames or removes any of these, instead of letting the queue silently
// misbehave. Keep this aligned with fetchAvailableJobsSql / selectJobRowSql /
// requeueActiveJobsSql.
export const REQUIRED_JOB_COLUMNS = [
  'id',
  'name',
  'data',
  'state',
  'priority',
  'singleton_key',
  'policy',
  'start_after',
  'started_on',
  'completed_on',
  'expire_in',
  'created_on',
  'retry_count',
] as const;
// Send attempts per enqueue: tolerates a chain of (MAX - 1) finished
// generations still inside the archive window before giving up.
const MAX_ENQUEUE_SEND_ATTEMPTS = 5;

export interface TaskJobData {
  taskId: string;
  sessionId: string;
  agentId?: string;
  feishuAppId?: string;
  taskType: string;
  goal: string;
  runtimeHint: string | null;
  constraints: Record<string, unknown>;
  /** SDK session ID from a previous turn (enables multi-turn resume) */
  sdkSessionId?: string;
  /** Machine that produced the previous SDK session; undefined for legacy queued jobs. */
  sdkSessionMachineId?: string | null;
  /** Which runtime backend was used in the previous turn */
  runtimeBackend?: string;
}

export interface TaskJobResult {
  taskId: string;
  status: TaskStatus;
  output?: string;
  errorMessage?: string;
}

function toQueueJsonSafe<T>(value: T): T {
  if (value instanceof Date) {
    return value.toISOString() as T;
  }

  if (Array.isArray(value)) {
    return value.map((item) => toQueueJsonSafe(item)) as T;
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        toQueueJsonSafe(item),
      ]),
    ) as T;
  }

  return value;
}


function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function delegationResumePhaseKey(resumePackage: Record<string, unknown>): string | undefined {
  const treeId = stringValue(resumePackage.treeId);
  if (!treeId) return undefined;

  const childKeys = Array.isArray(resumePackage.children)
    ? resumePackage.children
        .map((child) => {
          const childRecord = objectValue(child);
          return (
            stringValue(childRecord?.childTaskId) ??
            stringValue(childRecord?.taskId) ??
            stringValue(childRecord?.delegationId)
          );
        })
        .filter((value): value is string => Boolean(value))
        .sort()
    : [];

  const barrierKey =
    stringValue(resumePackage.barrierId) ??
    stringValue(resumePackage.delegationId) ??
    stringValue(resumePackage.parentDelegationId);
  const phaseParts = [...(barrierKey ? [barrierKey] : []), ...childKeys];
  return phaseParts.length > 0 ? `${treeId}:${phaseParts.join(',')}` : treeId;
}

function taskJobIdempotencyKey(data: TaskJobData): string {
  const resumePackage = objectValue(data.constraints.delegationResumePackage);
  const resumePhaseKey = resumePackage ? delegationResumePhaseKey(resumePackage) : undefined;
  if (data.constraints.delegationResume === true && resumePhaseKey) {
    return `task-job:${data.taskId}:resume:${resumePhaseKey}`;
  }
  return `task-job:${data.taskId}:run`;
}

interface ActiveJob {
  job: PgBoss.Job<TaskJobData>;
  promise: Promise<void>;
}

interface TaskJobRow {
  id: string;
  name: string;
  data: TaskJobData;
  expireInSeconds: number | string;
}

export class TaskQueue {
  private boss: PgBoss | null = null;
  private sql: postgres.Sql | null = null;
  private isShuttingDown = false;
  private workerLoop: Promise<void> | null = null;
  private activeJobs = new Map<string, ActiveJob>();
  private forcedFailedJobIds = new Set<string>();

  constructor(
    private readonly connectionString: string,
    private readonly pollingIntervalMs: number = DEFAULT_POLLING_INTERVAL_MS,
  ) {}

  async start(): Promise<void> {
    this.boss = new PgBoss({
      connectionString: this.connectionString,
      retryLimit: 2,
      retryDelay: 30,
      retryBackoff: true,
      expireInHours: 23,
      archiveCompletedAfterSeconds: 3600,
      deleteAfterDays: 7,
    });

    this.boss.on('error', (err) => {
      logger.error({ err }, 'pg-boss error');
    });

    await this.boss.start();
    this.sql = postgres(this.connectionString, {
      max: 2,
      idle_timeout: 30,
      connect_timeout: 10,
    });

    // pg-boss v10 requires explicit queue creation before send/work.
    // The singleton policy accepts multiple queued jobs per key but only one
    // active job per key, which gives OpenClaudeTag per-session serial execution.
    const queueOptions = { policy: TASK_QUEUE_POLICY } as Parameters<PgBoss['createQueue']>[1];
    await this.ensureQueueWithRetry(queueOptions);
    await this.assertPgBossLayout();
    logger.info('Task queue started');
  }

  /**
   * Proactive startup guard against pg-boss internal-schema drift. The custom
   * SQL below reads and writes pgboss.job directly, so a version bump that
   * renames a column, drops a column, or changes the job-state type/enum would
   * otherwise surface only as subtle runtime misbehaviour. Fail fast at startup
   * instead, with an actionable error pointing at the version coupling.
   */
  private async assertPgBossLayout(): Promise<void> {
    if (!this.sql) throw new Error('Queue SQL client not started');

    const columnRows = await this.sql.unsafe<Array<{ column_name: string }>>(
      pgBossJobColumnsSql(),
      [PG_BOSS_SCHEMA],
    );

    if (columnRows.length === 0) {
      throw new Error(
        `${PG_BOSS_SCHEMA}.job not found — incompatible pg-boss version; this code targets 10.x`,
      );
    }

    const presentColumns = new Set(columnRows.map((row) => row.column_name));
    const missingColumns = REQUIRED_JOB_COLUMNS.filter((column) => !presentColumns.has(column));
    if (missingColumns.length > 0) {
      throw new Error(
        `${PG_BOSS_SCHEMA}.job is missing required columns [${missingColumns.join(', ')}] — ` +
          'incompatible pg-boss version; this code targets 10.x',
      );
    }

    // Zero-row type probe: exercises the job-state ordering comparison and the
    // expire_in/state/completed_on column types the custom SQL depends on,
    // without touching any data. A type or enum change makes this fail loudly.
    try {
      await this.sql.unsafe(pgBossJobTypeProbeSql());
    } catch (err) {
      throw new Error(
        `${PG_BOSS_SCHEMA}.job column types are incompatible with the pg-boss 10.x layout ` +
          `this code targets: ${errorMessage(err)}`,
        { cause: err },
      );
    }
  }

  /**
   * createQueue performs DDL inside pgboss.create_queue; when the API and the
   * worker start concurrently against the same database the two calls can
   * deadlock (40P01). Deadlocks and serialization failures resolve on retry.
   */
  private async ensureQueueWithRetry(
    queueOptions: Parameters<PgBoss['createQueue']>[1],
    maxAttempts = 3,
  ): Promise<void> {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await this.boss!.createQueue(TASK_QUEUE_NAME, queueOptions);
        await this.boss!.updateQueue(TASK_QUEUE_NAME, queueOptions);
        return;
      } catch (err) {
        const code = (err as { code?: string }).code;
        const transient = code === '40P01' || code === '40001';
        if (!transient || attempt >= maxAttempts) {
          throw err;
        }
        logger.warn(
          { err, attempt, maxAttempts },
          'Transient error creating task queue, retrying',
        );
        await sleep(100 * attempt);
      }
    }
  }

  /**
   * Enqueue with a hard invariant: when this resolves, a job for the task
   * exists in a live state (created/retry/active).
   *
   * pg-boss inserts with ON CONFLICT DO NOTHING, so `send` returns null when
   * the deterministic id collides with ANY existing row — including finished
   * rows (completed/cancelled/failed) that wait up to an hour for archival.
   * Treating that null as "already queued" silently loses re-enqueues (the
   * admission rescheduler would drop its lease, startup recovery would log a
   * re-queue that never happened). On conflict we inspect the row and either
   * accept a live replay or re-send under a next-generation deterministic id.
   */
  async enqueue(data: TaskJobData, options?: { startAfter?: Date }): Promise<string> {
    if (!this.boss) throw new Error('Queue not started');

    const queuedData = toQueueJsonSafe(data);
    const startAfter = options?.startAfter?.toISOString();
    const idempotencyKey = taskJobIdempotencyKey(queuedData);

    // Use sessionId as singletonKey to scope the queue singleton policy.
    // retryLimit: 0 — AI tasks are long-running and stateful; pg-boss retry
    // causes duplicate processing and state machine conflicts (running→running).
    const sendOptions = {
      singletonKey: queuedData.sessionId,
      retryLimit: 0,
      expireInSeconds: queuedData.constraints.timeoutSec
        ? Number(queuedData.constraints.timeoutSec) + 300
        : 2100,
      ...(startAfter ? { startAfter } : {}),
    };

    let candidateJobId = stableUuidFromKey(idempotencyKey);
    for (let attempt = 1; attempt <= MAX_ENQUEUE_SEND_ATTEMPTS; attempt += 1) {
      const insertedJobId = await this.boss.send(TASK_QUEUE_NAME, queuedData, {
        id: candidateJobId,
        ...sendOptions,
      });

      if (insertedJobId) {
        logger.info(
          { jobId: insertedJobId, taskId: queuedData.taskId, sessionId: queuedData.sessionId },
          'Task enqueued',
        );
        return insertedJobId;
      }

      const conflictingRow = await this.lookupJobRow(candidateJobId);

      if (conflictingRow && LIVE_JOB_STATES.has(conflictingRow.state)) {
        logger.info(
          {
            taskId: queuedData.taskId,
            sessionId: queuedData.sessionId,
            jobId: candidateJobId,
            jobState: conflictingRow.state,
          },
          'Task enqueue replay resolved to existing live job',
        );
        return candidateJobId;
      }

      if (!conflictingRow) {
        // The conflicting row was archived between send and lookup; the id is
        // free again, so retry the same id.
        logger.warn(
          { taskId: queuedData.taskId, jobId: candidateJobId, attempt },
          'Conflicting queue job vanished mid-enqueue; retrying same id',
        );
        continue;
      }

      if (!FINISHED_JOB_STATES.has(conflictingRow.state)) {
        // Unknown state: pgboss.job layout drifted from the pg-boss version
        // this code was written against. Guessing here risks silent loss.
        throw new Error(
          `Unexpected pg-boss job state '${conflictingRow.state}' for job ${candidateJobId} (task ${queuedData.taskId}); refusing to resolve enqueue conflict`,
        );
      }

      // A finished row (completed/cancelled/failed) occupies the id until
      // archival. Derive the next generation deterministically from the
      // finished row's identity (its id keeps generation chains collision-free
      // even when two generations finish in the same millisecond) so
      // crash-replays of this enqueue converge on the same id instead of
      // minting a job per retry.
      const completedOnSalt =
        conflictingRow.completedOn instanceof Date
          ? conflictingRow.completedOn.toISOString()
          : String(conflictingRow.completedOn ?? attempt);
      const nextJobId = stableUuidFromKey(
        `${idempotencyKey}:gen:${candidateJobId}:${conflictingRow.state}:${completedOnSalt}`,
      );
      logger.warn(
        {
          taskId: queuedData.taskId,
          sessionId: queuedData.sessionId,
          finishedJobId: candidateJobId,
          finishedJobState: conflictingRow.state,
          nextJobId,
          attempt,
        },
        'Finished row occupies deterministic job id; retrying with next-generation id',
      );
      candidateJobId = nextJobId;
    }

    throw new Error(
      `Failed to establish a live queue job for task ${queuedData.taskId} after ${MAX_ENQUEUE_SEND_ATTEMPTS} attempts (deterministic job id conflicts unresolved)`,
    );
  }

  private async lookupJobRow(
    jobId: string,
  ): Promise<{ state: string; completedOn: Date | string | null } | null> {
    if (!this.sql) throw new Error('Queue SQL client not started');
    const rows = await this.sql.unsafe<Array<{ state: string; completedOn: Date | string | null }>>(
      selectJobRowSql(),
      [TASK_QUEUE_NAME, jobId],
    );
    return rows[0] ?? null;
  }

  async subscribe(
    handler: (job: PgBoss.Job<TaskJobData>) => Promise<void>,
    concurrency: number = 1,
  ): Promise<void> {
    if (!this.boss) throw new Error('Queue not started');
    if (this.workerLoop) throw new Error('Queue worker already subscribed');

    const workerConcurrency = Math.max(1, Math.floor(concurrency));
    this.workerLoop = this.pollJobs(handler, workerConcurrency);

    logger.info({ concurrency: workerConcurrency }, 'Task queue worker subscribed');
  }

  private async pollJobs(
    handler: (job: PgBoss.Job<TaskJobData>) => Promise<void>,
    concurrency: number,
  ): Promise<void> {
    while (!this.isShuttingDown) {
      const boss = this.boss;
      if (!boss) return;

      const availableSlots = concurrency - this.activeJobs.size;
      if (availableSlots <= 0) {
        await sleep(FULL_CAPACITY_WAIT_MS);
        continue;
      }

      let jobs: PgBoss.Job<TaskJobData>[] = [];
      try {
        jobs = await this.fetchAvailableJobs(availableSlots);
      } catch (err) {
        logger.error({ err }, 'Task queue fetch failed');
      }

      if (jobs.length === 0) {
        await sleep(this.pollingIntervalMs);
        continue;
      }

      if (this.isShuttingDown) {
        await this.requeueFetchedJobsForShutdown(jobs);
        return;
      }

      for (const job of jobs) {
        const promise = this.processFetchedJob(boss, handler, job).finally(() => {
          this.activeJobs.delete(job.id);
          this.forcedFailedJobIds.delete(job.id);
        });
        this.activeJobs.set(job.id, { job, promise });
      }
    }
  }

  private async fetchAvailableJobs(batchSize: number): Promise<PgBoss.Job<TaskJobData>[]> {
    if (!this.sql) throw new Error('Queue SQL client not started');

    const rows = await this.sql.unsafe<TaskJobRow[]>(fetchAvailableJobsSql(), [
      TASK_QUEUE_NAME,
      batchSize,
    ]);

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      data: row.data,
      expireInSeconds: Number(row.expireInSeconds),
    }));
  }

  private async processFetchedJob(
    boss: PgBoss,
    handler: (job: PgBoss.Job<TaskJobData>) => Promise<void>,
    job: PgBoss.Job<TaskJobData>,
  ): Promise<void> {
    logger.info({ jobId: job.id, taskId: job.data.taskId }, 'Processing task');
    try {
      await handler(job);
      if (this.forcedFailedJobIds.has(job.id)) {
        return;
      }
      await boss.complete(TASK_QUEUE_NAME, job.id);
    } catch (err) {
      logger.error({ err, jobId: job.id }, 'Task processing failed');
      try {
        await boss.fail(TASK_QUEUE_NAME, job.id, { errorMessage: errorMessage(err) });
      } catch (failErr) {
        logger.error({ err: failErr, jobId: job.id }, 'Failed to mark task job failed');
      }
    }
  }

  async gracefulShutdown(timeoutMs: number = 30000): Promise<void> {
    if (!this.boss || this.isShuttingDown) return;
    this.isShuttingDown = true;

    logger.info('Graceful shutdown initiated, waiting for current tasks...');

    try {
      if (this.workerLoop) {
        await Promise.race([
          this.workerLoop.then(() => true),
          sleep(Math.min(timeoutMs, this.pollingIntervalMs)).then(() => false),
        ]);
        this.workerLoop = null;
      }

      if (this.activeJobs.size > 0) {
        const activeJobsStopped = await Promise.race([
          Promise.allSettled([...this.activeJobs.values()].map(({ promise }) => promise)).then(
            () => true,
          ),
          sleep(timeoutMs).then(() => false),
        ]);
        if (!activeJobsStopped) {
          logger.error(
            { timeoutMs, activeJobCount: this.activeJobs.size },
            'Timed out waiting for active task jobs to stop',
          );
          await this.failActiveJobsForShutdown();
        }
      }

      await this.boss.stop({ graceful: true, timeout: timeoutMs });
      logger.info('Task queue stopped gracefully');
    } catch (err) {
      logger.error({ err }, 'Forced shutdown after timeout');
    } finally {
      await this.closeSqlClient(timeoutMs);
    }
  }

  private async requeueFetchedJobsForShutdown(jobs: Array<PgBoss.Job<TaskJobData>>): Promise<void> {
    if (!this.sql || jobs.length === 0) return;
    const jobIds = jobs.map((job) => job.id);
    try {
      await this.sql.unsafe(requeueActiveJobsSql(), [TASK_QUEUE_NAME, jobIds]);
      logger.info({ jobIds }, 'Re-queued fetched task jobs before shutdown');
    } catch (err) {
      logger.error({ err, jobIds }, 'Failed to re-queue fetched task jobs before shutdown');
    }
  }

  private async failActiveJobsForShutdown(): Promise<void> {
    if (!this.boss) return;
    await Promise.allSettled(
      [...this.activeJobs.values()].map(async ({ job }) => {
        this.forcedFailedJobIds.add(job.id);
        try {
          await this.boss?.fail(TASK_QUEUE_NAME, job.id, {
            errorMessage: 'Task queue shutdown timed out before job handler completed',
          });
        } catch (err) {
          logger.error({ err, jobId: job.id }, 'Failed to mark active task job failed on shutdown');
        }
      }),
    );
  }

  private async closeSqlClient(timeoutMs: number): Promise<void> {
    if (!this.sql) return;
    const sql = this.sql;
    this.sql = null;
    try {
      await sql.end({ timeout: Math.max(1, Math.ceil(timeoutMs / 1000)) });
    } catch (err) {
      logger.error({ err }, 'Failed to close task queue SQL client');
    }
  }

  async getQueueSize(): Promise<number> {
    if (!this.boss) return 0;
    const counts = await this.boss.getQueueSize(TASK_QUEUE_NAME);
    return counts;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fetchAvailableJobsSql(): string {
  const schema = quotePgIdentifier(PG_BOSS_SCHEMA);

  return `
    WITH candidate AS (
      SELECT
        j.id,
        j.singleton_key,
        j.policy,
        j.priority,
        j.created_on
      FROM ${schema}.job j
      WHERE j.name = $1
        AND j.state < 'active'
        AND j.start_after < now()
        AND (
          j.singleton_key IS NULL
          OR NOT EXISTS (
            SELECT 1
            FROM ${schema}.job active_job
            WHERE active_job.name = j.name
              AND active_job.state = 'active'
              AND active_job.singleton_key = j.singleton_key
          )
        )
    ),
    ranked AS (
      SELECT
        candidate.id,
        candidate.singleton_key,
        candidate.policy,
        candidate.priority,
        candidate.created_on,
        row_number() OVER (
          PARTITION BY CASE
            WHEN candidate.singleton_key IS NOT NULL THEN candidate.singleton_key
            ELSE candidate.id::text
          END
          ORDER BY candidate.priority DESC, candidate.created_on, candidate.id
        ) AS row_number
      FROM candidate
    ),
    eligible AS (
      SELECT ranked.id
      FROM ranked
      WHERE (
        ranked.singleton_key IS NOT NULL
        AND ranked.row_number = 1
      )
        OR ranked.singleton_key IS NULL
      ORDER BY ranked.priority DESC, ranked.created_on, ranked.id
      LIMIT $2
    ),
    locked AS (
      SELECT j.id
      FROM ${schema}.job j
      JOIN eligible ON eligible.id = j.id
      WHERE j.name = $1
        AND j.state < 'active'
        AND j.start_after < now()
      FOR UPDATE OF j SKIP LOCKED
    )
    UPDATE ${schema}.job j SET
      state = 'active',
      started_on = now(),
      retry_count = CASE WHEN started_on IS NOT NULL THEN retry_count + 1 ELSE retry_count END
    FROM locked
    WHERE j.name = $1
      AND j.id = locked.id
      AND (
        j.singleton_key IS NULL
        OR NOT EXISTS (
          SELECT 1
          FROM ${schema}.job active_job
          WHERE active_job.name = j.name
            AND active_job.state = 'active'
            AND active_job.id <> j.id
            AND active_job.singleton_key = j.singleton_key
        )
      )
    RETURNING j.id, j.name, j.data, EXTRACT(epoch FROM j.expire_in) AS "expireInSeconds"
  `;
}

// Lists the columns present on pgboss.job for the startup layout self-check.
// The schema name is bound as a parameter ($1) rather than interpolated.
function pgBossJobColumnsSql(): string {
  return `
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = $1
      AND table_name = 'job'
  `;
}

// Zero-row probe used by assertPgBossLayout to verify the job-state ordering
// comparison and the expire_in / state / completed_on column types the custom
// SQL relies on. `AND false` guarantees no rows are scanned or returned.
function pgBossJobTypeProbeSql(): string {
  const schema = quotePgIdentifier(PG_BOSS_SCHEMA);
  return `
    SELECT
      EXTRACT(epoch FROM expire_in) AS "expireInSeconds",
      state::text AS state,
      completed_on AS "completedOn"
    FROM ${schema}.job
    WHERE state < 'active'
      AND false
    LIMIT 1
  `;
}

// NOTE: like fetchAvailableJobsSql below, this reads pg-boss internals
// (pgboss.job) and is coupled to the pg-boss 10.x table layout.
function selectJobRowSql(): string {
  const schema = quotePgIdentifier(PG_BOSS_SCHEMA);
  return `
    SELECT state::text AS state, completed_on AS "completedOn"
    FROM ${schema}.job
    WHERE name = $1
      AND id = $2
  `;
}

function requeueActiveJobsSql(): string {
  const schema = quotePgIdentifier(PG_BOSS_SCHEMA);
  return `
    UPDATE ${schema}.job
    SET
      state = 'created',
      started_on = NULL,
      completed_on = NULL
    WHERE name = $1
      AND id IN (SELECT UNNEST($2::uuid[]))
      AND state = 'active'
  `;
}

function quotePgIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(`Invalid PostgreSQL identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}
