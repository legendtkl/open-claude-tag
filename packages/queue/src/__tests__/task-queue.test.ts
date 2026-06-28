import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskQueue, TASK_QUEUE_NAME, REQUIRED_JOB_COLUMNS } from '../task-queue.js';
import type { TaskJobData } from '../task-queue.js';
import { randomUUID } from 'crypto';

const pgBossMock = vi.hoisted(() => {
  const instances: Array<{
    on: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
    createQueue: ReturnType<typeof vi.fn>;
    updateQueue: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
    fetch: ReturnType<typeof vi.fn>;
    complete: ReturnType<typeof vi.fn>;
    fail: ReturnType<typeof vi.fn>;
    work: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    getQueueSize: ReturnType<typeof vi.fn>;
  }> = [];

  class MockPgBoss {
    on = vi.fn();
    start = vi.fn().mockResolvedValue(undefined);
    createQueue = vi.fn().mockResolvedValue(undefined);
    updateQueue = vi.fn().mockResolvedValue(undefined);
    send = vi.fn().mockResolvedValue('job-id-1');
    fetch = vi.fn().mockResolvedValue([]);
    complete = vi.fn().mockResolvedValue(undefined);
    fail = vi.fn().mockResolvedValue(undefined);
    work = vi.fn().mockResolvedValue(undefined);
    stop = vi.fn().mockResolvedValue(undefined);
    getQueueSize = vi.fn().mockResolvedValue(0);

    constructor() {
      instances.push(this);
    }
  }

  return { instances, MockPgBoss };
});

const postgresMock = vi.hoisted(() => {
  const clients: Array<{
    unsafe: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
  }> = [];

  // Mirror of REQUIRED_JOB_COLUMNS from task-queue.ts. vi.hoisted() runs before
  // static imports are initialized, so the exported constant cannot be read in
  // here; the 'mock column list matches REQUIRED_JOB_COLUMNS' test below guards
  // against the two drifting apart.
  const layoutColumns = [
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
  ];

  // The startup layout self-check (assertPgBossLayout) runs two queries during
  // start(): an information_schema.columns probe and a zero-row type probe.
  // Teach the shared mock to answer the columns probe with the full required
  // set so start()-based tests keep working; everything else (the type probe,
  // enqueue/fetch SQL) defaults to an empty result, as before.
  const layoutAwareUnsafe = () =>
    vi.fn().mockImplementation((sql: unknown) => {
      if (typeof sql === 'string' && sql.includes('information_schema.columns')) {
        return Promise.resolve(layoutColumns.map((column_name) => ({ column_name })));
      }
      return Promise.resolve([]);
    });

  const postgres = vi.fn(() => {
    const client = {
      unsafe: layoutAwareUnsafe(),
      end: vi.fn().mockResolvedValue(undefined),
    };
    clients.push(client);
    return client;
  });

  return { clients, postgres, layoutColumns };
});

vi.mock('pg-boss', () => ({
  default: pgBossMock.MockPgBoss,
}));

vi.mock('postgres', () => ({
  default: postgresMock.postgres,
}));

vi.mock('@open-tag/observability', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

describe('TaskQueue types', () => {
  beforeEach(() => {
    pgBossMock.instances.length = 0;
    postgresMock.clients.length = 0;
    vi.clearAllMocks();
  });

  it('queue name is correct', () => {
    expect(TASK_QUEUE_NAME).toBe('open-claude-tag-tasks');
  });

  it('TaskJobData structure is valid', () => {
    const data: TaskJobData = {
      taskId: randomUUID(),
      sessionId: randomUUID(),
      taskType: 'chat_reply',
      goal: 'Write a hello world function',
      runtimeHint: 'codex',
      constraints: { timeoutSec: 1800 },
    };
    expect(data.taskId).toBeDefined();
    expect(data.taskType).toBe('chat_reply');
  });

  it('TaskJobData with null runtimeHint is valid', () => {
    const data: TaskJobData = {
      taskId: randomUUID(),
      sessionId: randomUUID(),
      taskType: 'chat_reply',
      goal: 'Hello',
      runtimeHint: null,
      constraints: {},
    };
    expect(data.runtimeHint).toBeNull();
  });

  it('serializes Date instances before sending jobs to pg-boss', async () => {
    const queue = new TaskQueue('postgresql://test');
    const startAfter = new Date('2026-06-08T11:00:00.000Z');
    const nestedDate = new Date('2026-06-08T10:59:30.000Z');
    const send = vi.fn(async () => 'job_1');
    (queue as unknown as { boss: { send: typeof send } }).boss = { send };

    const data: TaskJobData = {
      taskId: randomUUID(),
      sessionId: randomUUID(),
      taskType: 'chat_reply',
      goal: 'Replay admission lease',
      runtimeHint: null,
      constraints: {
        timeoutSec: 1800,
        nestedDate,
        nested: { values: [nestedDate] },
      },
    };

    await queue.enqueue(data, { startAfter });

    expect(send).toHaveBeenCalledWith(
      TASK_QUEUE_NAME,
      expect.objectContaining({
        constraints: expect.objectContaining({
          nestedDate: nestedDate.toISOString(),
          nested: { values: [nestedDate.toISOString()] },
        }),
      }),
      expect.objectContaining({
        startAfter: startAfter.toISOString(),
      }),
    );
    expect(data.constraints.nestedDate).toBe(nestedDate);
  });

  it('configures the task queue with pg-boss singleton policy on startup', async () => {
    const queue = new TaskQueue('postgres://test');

    await queue.start();

    const boss = pgBossMock.instances[0];
    expect(boss.createQueue).toHaveBeenCalledWith(TASK_QUEUE_NAME, { policy: 'singleton' });
    expect(boss.updateQueue).toHaveBeenCalledWith(TASK_QUEUE_NAME, { policy: 'singleton' });
  });

  it('retries queue creation when concurrent startup deadlocks in Postgres', async () => {
    // API and worker both run TaskQueue.start() against the same database;
    // pg-boss create_queue does DDL and can deadlock (40P01) when they race.
    const queue = new TaskQueue('postgres://test');
    const deadlock = Object.assign(new Error('deadlock detected'), { code: '40P01' });

    const queuePromise = queue.start();
    const boss = pgBossMock.instances[0];
    boss.createQueue.mockRejectedValueOnce(deadlock);
    await queuePromise;

    expect(boss.createQueue).toHaveBeenCalledTimes(2);
    expect(boss.updateQueue).toHaveBeenCalledTimes(1);
  });

  it('propagates non-transient queue creation errors without retrying', async () => {
    const queue = new TaskQueue('postgres://test');
    const fatal = Object.assign(new Error('permission denied'), { code: '42501' });

    const startPromise = queue.start();
    const boss = pgBossMock.instances[0];
    boss.createQueue.mockRejectedValue(fatal);

    await expect(startPromise).rejects.toThrow('permission denied');
    expect(boss.createQueue).toHaveBeenCalledTimes(1);
  });

  it('creates distinct same-session jobs while preserving the session singleton key', async () => {
    const queue = new TaskQueue('postgres://test');
    await queue.start();
    const boss = pgBossMock.instances[0];
    boss.send.mockResolvedValueOnce('job-id-1').mockResolvedValueOnce('job-id-2');

    const baseJob: TaskJobData = {
      taskId: randomUUID(),
      sessionId: 'session-1',
      taskType: 'chat_reply',
      goal: 'first',
      runtimeHint: 'codex',
      constraints: { timeoutSec: 1800 },
    };

    await expect(queue.enqueue(baseJob)).resolves.toBe('job-id-1');
    await expect(
      queue.enqueue({ ...baseJob, taskId: randomUUID(), goal: 'second' }),
    ).resolves.toBe('job-id-2');

    expect(boss.send).toHaveBeenNthCalledWith(
      1,
      TASK_QUEUE_NAME,
      baseJob,
      expect.objectContaining({ id: expect.any(String), singletonKey: 'session-1', retryLimit: 0 }),
    );
    expect(boss.send).toHaveBeenNthCalledWith(
      2,
      TASK_QUEUE_NAME,
      expect.objectContaining({ sessionId: 'session-1', goal: 'second' }),
      expect.objectContaining({ id: expect.any(String), singletonKey: 'session-1', retryLimit: 0 }),
    );
    expect(boss.send.mock.calls[0][2].id).not.toBe(boss.send.mock.calls[1][2].id);
  });

  it('uses a deterministic pg-boss job id per task for enqueue replay idempotency', async () => {
    const queue = new TaskQueue('postgres://test');
    await queue.start();
    const boss = pgBossMock.instances[0];
    boss.send.mockResolvedValueOnce('job-id-1').mockResolvedValueOnce(null);
    // Replay path: the conflicting row must be live for null to mean "already queued".
    postgresMock.clients[0].unsafe.mockResolvedValueOnce([{ state: 'created', completedOn: null }]);

    const job: TaskJobData = {
      taskId: randomUUID(),
      sessionId: 'session-1',
      taskType: 'chat_reply',
      goal: 'first',
      runtimeHint: 'codex',
      constraints: { timeoutSec: 1800 },
    };

    await expect(queue.enqueue(job)).resolves.toBe('job-id-1');
    await expect(queue.enqueue(job)).resolves.toBe(boss.send.mock.calls[0][2].id);

    expect(boss.send).toHaveBeenCalledTimes(2);
    expect(boss.send.mock.calls[0][2]).toMatchObject({
      id: boss.send.mock.calls[1][2].id,
      singletonKey: 'session-1',
      retryLimit: 0,
    });
  });

  it('uses a distinct deterministic job id for delegation parent resume', async () => {
    const queue = new TaskQueue('postgres://test');
    await queue.start();
    const boss = pgBossMock.instances[0];
    boss.send
      .mockResolvedValueOnce('job-original')
      .mockResolvedValueOnce('job-resume')
      .mockResolvedValueOnce(null);
    postgresMock.clients[0].unsafe.mockResolvedValueOnce([{ state: 'created', completedOn: null }]);

    const baseJob: TaskJobData = {
      taskId: 'parent-task-1',
      sessionId: 'session-1',
      taskType: 'chat_reply',
      goal: 'initial parent run',
      runtimeHint: 'codex',
      constraints: { timeoutSec: 1800 },
    };
    const resumeJob: TaskJobData = {
      ...baseJob,
      goal: 'resume parent with child results',
      constraints: {
        timeoutSec: 1800,
        delegationResume: true,
        delegationResumePackage: {
          treeId: 'tree-1',
          parentTaskId: 'parent-task-1',
          children: [{ childTaskId: 'child-task-1', delegationId: 'delegation-1' }],
        },
      },
    };

    await expect(queue.enqueue(baseJob)).resolves.toBe('job-original');
    await expect(queue.enqueue(resumeJob)).resolves.toBe('job-resume');
    await expect(queue.enqueue(resumeJob)).resolves.toBe(boss.send.mock.calls[1][2].id);

    expect(boss.send.mock.calls[0][2].id).not.toBe(boss.send.mock.calls[1][2].id);
    expect(boss.send.mock.calls[1][2].id).toBe(boss.send.mock.calls[2][2].id);
    expect(boss.send.mock.calls[1][2]).toMatchObject({
      singletonKey: 'session-1',
      retryLimit: 0,
    });
  });

  it('uses a distinct delegation resume job id per child barrier set', async () => {
    const queue = new TaskQueue('postgres://test');
    await queue.start();
    const boss = pgBossMock.instances[0];
    boss.send
      .mockResolvedValueOnce('job-resume-1')
      .mockResolvedValueOnce('job-resume-2')
      .mockResolvedValueOnce(null);
    postgresMock.clients[0].unsafe.mockResolvedValueOnce([{ state: 'created', completedOn: null }]);

    const baseResumeJob: TaskJobData = {
      taskId: 'parent-task-1',
      sessionId: 'session-1',
      taskType: 'chat_reply',
      goal: 'resume parent with child results',
      runtimeHint: 'codex',
      constraints: {
        timeoutSec: 1800,
        delegationResume: true,
        delegationResumePackage: {
          treeId: 'tree-1',
          parentTaskId: 'parent-task-1',
          children: [{ childTaskId: 'child-task-1', delegationId: 'delegation-1' }],
        },
      },
    };

    const nextBarrierResumeJob: TaskJobData = {
      ...baseResumeJob,
      constraints: {
        ...baseResumeJob.constraints,
        delegationResumePackage: {
          treeId: 'tree-1',
          parentTaskId: 'parent-task-1',
          children: [{ childTaskId: 'child-task-2', delegationId: 'delegation-2' }],
        },
      },
    };

    await expect(queue.enqueue(baseResumeJob)).resolves.toBe('job-resume-1');
    await expect(queue.enqueue(nextBarrierResumeJob)).resolves.toBe('job-resume-2');
    await expect(queue.enqueue(nextBarrierResumeJob)).resolves.toBe(boss.send.mock.calls[1][2].id);

    expect(boss.send.mock.calls[0][2].id).not.toBe(boss.send.mock.calls[1][2].id);
    expect(boss.send.mock.calls[1][2].id).toBe(boss.send.mock.calls[2][2].id);
  });

  it('treats pg-boss null as deterministic job replay when the existing row is live', async () => {
    const queue = new TaskQueue('postgres://test');
    await queue.start();
    const boss = pgBossMock.instances[0];
    boss.send.mockResolvedValueOnce(null);
    postgresMock.clients[0].unsafe.mockResolvedValueOnce([{ state: 'active', completedOn: null }]);

    await expect(
      queue.enqueue({
        taskId: 'task-1',
        sessionId: 'session-1',
        taskType: 'chat_reply',
        goal: 'hello',
        runtimeHint: null,
        constraints: {},
      }),
    ).resolves.toBe(boss.send.mock.calls[0][2].id);
  });

  it('fetches one available batch with configured concurrency and completes jobs independently', async () => {
    const queue = new TaskQueue('postgres://test', 1);
    await queue.start();
    const boss = pgBossMock.instances[0];
    const sql = postgresMock.clients[0];
    // Discard the start-up layout-check calls so fetch SQL is mock.calls[0].
    sql.unsafe.mockClear();
    const jobs = [
      makeJob('job-1', 'task-1', 'session-1'),
      makeJob('job-2', 'task-2', 'session-2'),
    ];
    sql.unsafe.mockResolvedValueOnce(jobs).mockResolvedValue([]);

    let activeHandlers = 0;
    let maxActiveHandlers = 0;
    const releaseHandlers: Array<() => void> = [];
    const handler = vi.fn(async () => {
      activeHandlers += 1;
      maxActiveHandlers = Math.max(maxActiveHandlers, activeHandlers);
      await new Promise<void>((resolve) => releaseHandlers.push(resolve));
      activeHandlers -= 1;
    });

    await queue.subscribe(handler, 2);
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(2));
    releaseHandlers.forEach((release) => release());
    await vi.waitFor(() => expect(boss.complete).toHaveBeenCalledTimes(2));
    await queue.gracefulShutdown(100);

    expect(sql.unsafe).toHaveBeenCalledWith(expect.any(String), [TASK_QUEUE_NAME, 2]);
    const fetchSql = String(sql.unsafe.mock.calls[0]?.[0]);
    expect(fetchSql).toContain("active_job.state = 'active'");
    expect(fetchSql).toContain('active_job.singleton_key = j.singleton_key');
    expect(fetchSql).toContain('candidate.singleton_key IS NOT NULL');
    expect(fetchSql).toContain('row_number() OVER');
    expect(fetchSql).not.toContain('active_job.policy IN');
    expect(boss.fetch).not.toHaveBeenCalled();
    expect(maxActiveHandlers).toBe(2);
    expect(boss.complete).toHaveBeenCalledWith(TASK_QUEUE_NAME, 'job-1');
    expect(boss.complete).toHaveBeenCalledWith(TASK_QUEUE_NAME, 'job-2');
    expect(boss.fail).not.toHaveBeenCalled();
    expect(boss.work).not.toHaveBeenCalled();
  });

  it('fails only the job whose handler throws in a fetched batch', async () => {
    const queue = new TaskQueue('postgres://test', 1);
    await queue.start();
    const boss = pgBossMock.instances[0];
    const sql = postgresMock.clients[0];
    const jobs = [
      makeJob('job-ok', 'task-ok', 'session-1'),
      makeJob('job-fail', 'task-fail', 'session-2'),
    ];
    sql.unsafe.mockResolvedValueOnce(jobs).mockResolvedValue([]);

    const handler = vi.fn(async (job: { id: string }) => {
      if (job.id === 'job-fail') {
        throw new Error('handler failed');
      }
    });

    await queue.subscribe(handler, 2);
    await vi.waitFor(() => expect(boss.complete).toHaveBeenCalledWith(TASK_QUEUE_NAME, 'job-ok'));
    await vi.waitFor(() =>
      expect(boss.fail).toHaveBeenCalledWith(TASK_QUEUE_NAME, 'job-fail', {
        errorMessage: 'handler failed',
      }),
    );
    await queue.gracefulShutdown(100);

    expect(boss.complete).not.toHaveBeenCalledWith(TASK_QUEUE_NAME, 'job-fail');
    expect(boss.fail).not.toHaveBeenCalledWith(
      TASK_QUEUE_NAME,
      'job-ok',
      expect.anything(),
    );
  });

  it('refills available concurrency slots while another fetched job is still running', async () => {
    const queue = new TaskQueue('postgres://test', 1);
    await queue.start();
    const boss = pgBossMock.instances[0];
    const sql = postgresMock.clients[0];
    // Discard the start-up layout-check calls so fetch SQL indices stay 1-based.
    sql.unsafe.mockClear();
    const longJob = makeJob('job-long', 'task-long', 'session-1');
    const shortJob = makeJob('job-short', 'task-short', 'session-2');
    const refillJob = makeJob('job-refill', 'task-refill', 'session-3');
    sql.unsafe
      .mockResolvedValueOnce([longJob, shortJob])
      .mockResolvedValueOnce([refillJob])
      .mockResolvedValue([]);

    let releaseLongJob: (() => void) | undefined;
    const handler = vi.fn(async (job: { id: string }) => {
      if (job.id === 'job-long') {
        await new Promise<void>((resolve) => {
          releaseLongJob = resolve;
        });
      }
    });

    await queue.subscribe(handler, 2);
    await vi.waitFor(() => expect(handler).toHaveBeenCalledWith(refillJob));

    expect(handler).toHaveBeenCalledWith(longJob);
    expect(handler).toHaveBeenCalledWith(shortJob);
    expect(sql.unsafe).toHaveBeenNthCalledWith(1, expect.any(String), [TASK_QUEUE_NAME, 2]);
    expect(sql.unsafe).toHaveBeenNthCalledWith(2, expect.any(String), [TASK_QUEUE_NAME, 1]);

    releaseLongJob?.();
    await vi.waitFor(() => expect(boss.complete).toHaveBeenCalledTimes(3));
    await queue.gracefulShutdown(100);
  });

  it('marks active jobs failed when shutdown times out before handlers finish', async () => {
    const queue = new TaskQueue('postgres://test', 1);
    await queue.start();
    const boss = pgBossMock.instances[0];
    const sql = postgresMock.clients[0];
    const stuckJob = makeJob('job-stuck', 'task-stuck', 'session-1');
    sql.unsafe.mockResolvedValueOnce([stuckJob]).mockResolvedValue([]);

    const handler = vi.fn(async () => {
      await new Promise<void>(() => undefined);
    });

    await queue.subscribe(handler, 1);
    await vi.waitFor(() => expect(handler).toHaveBeenCalledWith(stuckJob));

    await queue.gracefulShutdown(10);

    expect(boss.fail).toHaveBeenCalledWith(TASK_QUEUE_NAME, 'job-stuck', {
      errorMessage: 'Task queue shutdown timed out before job handler completed',
    });
    expect(boss.complete).not.toHaveBeenCalledWith(TASK_QUEUE_NAME, 'job-stuck');
  });

  it('requeues fetched jobs instead of running handlers when shutdown starts during fetch', async () => {
    const queue = new TaskQueue('postgres://test', 50);
    await queue.start();
    const boss = pgBossMock.instances[0];
    const sql = postgresMock.clients[0];
    // Discard the start-up layout-check calls so the fetch is call #1.
    sql.unsafe.mockClear();
    const lateJob = makeJob('job-late', 'task-late', 'session-1');
    let resolveFetch: ((jobs: unknown[]) => void) | undefined;
    sql.unsafe.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );

    const handler = vi.fn(async () => undefined);

    await queue.subscribe(handler, 1);
    await vi.waitFor(() => expect(sql.unsafe).toHaveBeenCalledTimes(1));

    const shutdown = queue.gracefulShutdown(100);
    resolveFetch?.([lateJob]);
    await shutdown;

    expect(handler).not.toHaveBeenCalled();
    expect(sql.unsafe).toHaveBeenNthCalledWith(2, expect.stringContaining("state = 'created'"), [
      TASK_QUEUE_NAME,
      ['job-late'],
    ]);
    expect(boss.fail).not.toHaveBeenCalledWith(TASK_QUEUE_NAME, 'job-late', expect.anything());
    expect(boss.complete).not.toHaveBeenCalledWith(TASK_QUEUE_NAME, 'job-late');
  });
});

describe('TaskQueue enqueue id-conflict resolution', () => {
  beforeEach(() => {
    pgBossMock.instances.length = 0;
    postgresMock.clients.length = 0;
    vi.clearAllMocks();
  });

  function makeJobData(overrides: Partial<TaskJobData> = {}): TaskJobData {
    return {
      taskId: 'task-fixed-id',
      sessionId: 'session-fixed',
      taskType: 'chat_reply',
      goal: 'goal',
      runtimeHint: 'codex',
      constraints: { timeoutSec: 1800 },
      ...overrides,
    };
  }

  async function startQueue() {
    const queue = new TaskQueue('postgres://test');
    await queue.start();
    return {
      queue,
      boss: pgBossMock.instances[0],
      sql: postgresMock.clients[0],
    };
  }

  it('verifies a live row before treating a null send as a benign replay', async () => {
    const { queue, boss, sql } = await startQueue();
    boss.send.mockResolvedValueOnce(null);
    sql.unsafe.mockResolvedValueOnce([{ state: 'created', completedOn: null }]);

    const jobId = await queue.enqueue(makeJobData());

    expect(boss.send).toHaveBeenCalledTimes(1);
    expect(jobId).toBe(boss.send.mock.calls[0][2].id);
    expect(sql.unsafe).toHaveBeenCalledWith(expect.stringContaining('pgboss'), [
      TASK_QUEUE_NAME,
      jobId,
    ]);
  });

  it('re-sends under a next-generation id when a finished row occupies the deterministic id', async () => {
    const { queue, boss, sql } = await startQueue();
    boss.send.mockResolvedValueOnce(null).mockResolvedValueOnce('job-gen-1');
    sql.unsafe.mockResolvedValueOnce([
      { state: 'completed', completedOn: new Date('2026-06-12T08:00:00.000Z') },
    ]);

    const jobId = await queue.enqueue(makeJobData());

    expect(jobId).toBe('job-gen-1');
    expect(boss.send).toHaveBeenCalledTimes(2);
    const firstId = boss.send.mock.calls[0][2].id;
    const secondId = boss.send.mock.calls[1][2].id;
    expect(secondId).not.toBe(firstId);
    expect(boss.send.mock.calls[1][2]).toMatchObject({
      singletonKey: 'session-fixed',
      retryLimit: 0,
    });
  });

  it('derives the same generation id when the same finished row is seen again (crash replay)', async () => {
    const completedOn = new Date('2026-06-12T08:00:00.000Z');

    const first = await startQueue();
    first.boss.send.mockResolvedValueOnce(null).mockResolvedValueOnce('job-gen-a');
    first.sql.unsafe.mockResolvedValueOnce([{ state: 'completed', completedOn }]);
    await first.queue.enqueue(makeJobData());
    const generationIdFirstRun = first.boss.send.mock.calls[1][2].id;

    pgBossMock.instances.length = 0;
    postgresMock.clients.length = 0;
    vi.clearAllMocks();

    const second = await startQueue();
    // Replay after a crash: the generation job created by the first run now
    // exists in a live state, so the second run must converge on the SAME id
    // and resolve it as a benign replay instead of minting another job.
    second.boss.send.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    second.sql.unsafe
      .mockResolvedValueOnce([{ state: 'completed', completedOn }])
      .mockResolvedValueOnce([{ state: 'created', completedOn: null }]);

    const jobId = await second.queue.enqueue(makeJobData());

    const generationIdSecondRun = second.boss.send.mock.calls[1][2].id;
    expect(generationIdSecondRun).toBe(generationIdFirstRun);
    expect(jobId).toBe(generationIdFirstRun);
  });

  it('retries the original id when the conflicting row vanished (archived mid-flight)', async () => {
    const { queue, boss, sql } = await startQueue();
    boss.send.mockResolvedValueOnce(null).mockResolvedValueOnce('job-original');
    sql.unsafe.mockResolvedValueOnce([]);

    const jobId = await queue.enqueue(makeJobData());

    expect(jobId).toBe('job-original');
    expect(boss.send).toHaveBeenCalledTimes(2);
    expect(boss.send.mock.calls[1][2].id).toBe(boss.send.mock.calls[0][2].id);
  });

  it('walks a multi-generation chain of finished rows, even with identical finish timestamps', async () => {
    const { queue, boss, sql } = await startQueue();
    const completedOn = new Date('2026-06-12T08:00:00.000Z');
    boss.send
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('job-gen-2');
    // Base id and gen1 both finished with the SAME state + millisecond — the
    // generation salt must still produce a fresh id for gen2.
    sql.unsafe
      .mockResolvedValueOnce([{ state: 'completed', completedOn }])
      .mockResolvedValueOnce([{ state: 'completed', completedOn }]);

    const jobId = await queue.enqueue(makeJobData());

    expect(jobId).toBe('job-gen-2');
    expect(boss.send).toHaveBeenCalledTimes(3);
    const ids = boss.send.mock.calls.map((call) => call[2].id);
    expect(new Set(ids).size).toBe(3);
  });

  it('refuses to resolve conflicts against an unknown pg-boss job state', async () => {
    const { queue, boss, sql } = await startQueue();
    boss.send.mockResolvedValueOnce(null);
    sql.unsafe.mockResolvedValueOnce([{ state: 'hibernating', completedOn: null }]);

    await expect(queue.enqueue(makeJobData())).rejects.toThrow(/Unexpected pg-boss job state/);
    expect(boss.send).toHaveBeenCalledTimes(1);
  });

  it('throws loudly when no live job can be established after bounded attempts', async () => {
    const { queue, boss, sql } = await startQueue();
    boss.send.mockResolvedValue(null);
    sql.unsafe.mockResolvedValue([
      { state: 'failed', completedOn: new Date('2026-06-12T08:00:00.000Z') },
    ]);

    await expect(queue.enqueue(makeJobData())).rejects.toThrow(/live queue job/);
    expect(boss.send.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe('TaskQueue pg-boss layout self-check', () => {
  beforeEach(() => {
    pgBossMock.instances.length = 0;
    postgresMock.clients.length = 0;
    vi.clearAllMocks();
  });

  // Replace the next postgres() client so start() runs the layout check against
  // a custom unsafe() implementation.
  function stubNextClient(unsafe: ReturnType<typeof vi.fn>) {
    const client = { unsafe, end: vi.fn().mockResolvedValue(undefined) };
    postgresMock.postgres.mockImplementationOnce(() => {
      postgresMock.clients.push(client);
      return client;
    });
    return client;
  }

  function columnsAwareUnsafe(columns: readonly string[], typeProbe: () => Promise<unknown>) {
    return vi.fn().mockImplementation((sql: unknown) => {
      if (typeof sql === 'string' && sql.includes('information_schema.columns')) {
        return Promise.resolve(columns.map((column_name) => ({ column_name })));
      }
      return typeProbe();
    });
  }

  it('shared mock column list matches REQUIRED_JOB_COLUMNS', () => {
    // The mock mirrors the column list (vi.hoisted cannot read the import);
    // keep them identical so the layout-aware mock stays faithful.
    expect(postgresMock.layoutColumns).toEqual([...REQUIRED_JOB_COLUMNS]);
  });

  it('rejects start() with a clear error when pgboss.job is missing', async () => {
    // Every query (including the columns probe) returns no rows.
    stubNextClient(vi.fn().mockResolvedValue([]));
    const queue = new TaskQueue('postgres://test');

    await expect(queue.start()).rejects.toThrow(/pgboss\.job not found/);
  });

  it('rejects start() listing the missing column when one is absent', async () => {
    const withoutExpireIn = REQUIRED_JOB_COLUMNS.filter((column) => column !== 'expire_in');
    stubNextClient(columnsAwareUnsafe(withoutExpireIn, () => Promise.resolve([])));
    const queue = new TaskQueue('postgres://test');

    await expect(queue.start()).rejects.toThrow(/missing required columns \[expire_in\]/);
  });

  it('rejects start() with wrapped context when the type probe fails', async () => {
    stubNextClient(
      columnsAwareUnsafe(REQUIRED_JOB_COLUMNS, () =>
        Promise.reject(new Error('operator does not exist: job_state < unknown')),
      ),
    );
    const queue = new TaskQueue('postgres://test');

    await expect(queue.start()).rejects.toThrow(
      /column types are incompatible.*operator does not exist: job_state < unknown/,
    );
  });

  it('resolves start() when the full required column set is present', async () => {
    // Uses the shared layout-aware mock, which reports REQUIRED_JOB_COLUMNS.
    const queue = new TaskQueue('postgres://test');

    await expect(queue.start()).resolves.toBeUndefined();

    const sql = postgresMock.clients[0];
    expect(sql.unsafe).toHaveBeenCalledWith(
      expect.stringContaining('information_schema.columns'),
      ['pgboss'],
    );
    expect(sql.unsafe).toHaveBeenCalledWith(
      expect.stringContaining('EXTRACT(epoch FROM expire_in)'),
    );
  });
});

function makeJob(jobId: string, taskId: string, sessionId: string) {
  return {
    id: jobId,
    name: TASK_QUEUE_NAME,
    expireInSeconds: 1800,
    data: {
      taskId,
      sessionId,
      taskType: 'chat_reply',
      goal: `goal ${taskId}`,
      runtimeHint: 'codex',
      constraints: {},
    },
  };
}
