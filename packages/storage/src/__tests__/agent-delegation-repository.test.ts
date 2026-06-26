import { randomUUID } from 'crypto';
import { TaskStatus } from '@open-tag/core-types';
import { count, eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  assertAgentDelegationTransition,
  canTransitionAgentDelegation,
  completeAgentDelegationForChildTask,
  createAgentDelegation,
  evaluateDelegationBarrierForChildTask,
  failAgentDelegationForChildTask,
  listReadyDelegationBarriers,
  reconcileTerminalChildDelegationEdges,
  reserveDelegationBudget,
} from '../agent-delegation-repository.js';
import type { Database } from '../db.js';
import {
  agentDelegations,
  agentProfiles,
  agents,
  admissionLeases,
  delegationTrees,
  sessions,
  tasks,
} from '../schema.js';
import * as schema from '../schema.js';

describe('agent delegation repository state machine', () => {
  it('allows pending delegations to complete or fail', () => {
    expect(canTransitionAgentDelegation('pending', 'running')).toBe(true);
    expect(canTransitionAgentDelegation('pending', 'completed')).toBe(true);
    expect(canTransitionAgentDelegation('pending', 'failed')).toBe(true);
  });

  it('allows running delegations to finish exactly once', () => {
    expect(canTransitionAgentDelegation('running', 'completed')).toBe(true);
    expect(canTransitionAgentDelegation('running', 'failed')).toBe(true);
    expect(canTransitionAgentDelegation('completed', 'failed')).toBe(false);
  });

  it('rejects invalid transitions', () => {
    expect(() => assertAgentDelegationTransition('completed', 'running')).toThrow(
      'Invalid agent delegation transition: completed -> running',
    );
  });
});

const describePg =
  process.env.OPEN_TAG_STORAGE_PG_INTEGRATION === '1' ? describe : describe.skip;

interface BudgetFixture {
  profileId: string;
  callerAgentId: string;
  calleeAgentId: string;
  sessionId: string;
  rootTaskId: string;
  parentTaskId: string;
  treeId: string;
  cleanupTaskIds: string[];
  childTaskIds: string[];
}

describePg('agent delegation budget repository integration', () => {
  let client: postgres.Sql;
  let db: Database;
  const fixtures: BudgetFixture[] = [];

  beforeAll(() => {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL is required for storage Postgres integration tests');
    }
    client = postgres(process.env.DATABASE_URL, {
      max: 10,
      idle_timeout: 5,
      connect_timeout: 5,
    });
    db = drizzle(client, { schema }) as unknown as Database;
  });

  afterEach(async () => {
    for (const fixture of fixtures.splice(0)) {
      await db.delete(agentDelegations).where(eq(agentDelegations.treeId, fixture.treeId));
      await db.delete(delegationTrees).where(eq(delegationTrees.id, fixture.treeId));
      await db.delete(tasks).where(inArray(tasks.id, fixture.cleanupTaskIds));
      await db.delete(sessions).where(eq(sessions.id, fixture.sessionId));
      await db
        .delete(agents)
        .where(inArray(agents.id, [fixture.callerAgentId, fixture.calleeAgentId]));
      await db.delete(agentProfiles).where(eq(agentProfiles.id, fixture.profileId));
    }
  });

  afterAll(async () => {
    await client.end({ timeout: 5 });
  });

  it('serializes concurrent sibling reserves at the fanout boundary', async () => {
    const fixture = await createBudgetFixture({
      totalBudget: 10,
      fanoutBudget: 2,
      tasksUsed: 1,
      existingFanout: 1,
    });

    const results = await Promise.allSettled([
      createReservedChildDelegation(fixture, 'fanout-a'),
      createReservedChildDelegation(fixture, 'fanout-b'),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: expect.objectContaining({
        message: 'Delegation fanout budget exceeded',
      }),
    });

    await expectTreeUsage(fixture, { tasksUsed: 2, fanoutUsed: 2 });
  });

  it('serializes concurrent sibling reserves at the total budget boundary', async () => {
    const fixture = await createBudgetFixture({
      totalBudget: 2,
      fanoutBudget: 10,
      tasksUsed: 1,
      existingFanout: 0,
    });

    const results = await Promise.allSettled([
      createReservedChildDelegation(fixture, 'total-a'),
      createReservedChildDelegation(fixture, 'total-b'),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: expect.objectContaining({
        message: 'Delegation total task budget exceeded',
      }),
    });

    await expectTreeUsage(fixture, { tasksUsed: 2, fanoutUsed: 1 });
  });

  it('rolls back budget, child task, and delegation edge when the outer transaction aborts', async () => {
    const fixture = await createBudgetFixture({
      totalBudget: 3,
      fanoutBudget: 3,
      tasksUsed: 1,
      existingFanout: 0,
    });

    await expect(createReservedChildDelegation(fixture, 'rollback', true)).rejects.toThrow(
      'rollback after child creation',
    );

    await expectTreeUsage(fixture, { tasksUsed: 1, fanoutUsed: 0 });
    const [childRow] = await db
      .select({ value: count() })
      .from(tasks)
      .where(eq(tasks.parentTaskId, fixture.parentTaskId));
    expect(Number(childRow?.value ?? 0)).toBe(0);
  });

  it('wakes a waiting parent after a single child reaches terminal state', async () => {
    const fixture = await createBarrierFixture({ childCount: 1 });
    await completeAgentDelegationForChildTask(db, fixture.childTaskIds[0], {
      output: { text: 'child result' },
    });

    const result = await evaluateDelegationBarrierForChildTask(db, fixture.childTaskIds[0]);

    expect(result.status).toBe('woken');
    if (result.status !== 'woken') return;
    expect(result.wake.taskId).toBe(fixture.parentTaskId);
    expect(result.wake.sessionId).toBe(fixture.sessionId);
    expect(result.wake.goal).toContain('<delegation_results>');
    expect(result.wake.constraints.delegationResume).toBe(true);

    const [parent] = await db
      .select({ status: tasks.status, constraints: tasks.constraints })
      .from(tasks)
      .where(eq(tasks.id, fixture.parentTaskId))
      .limit(1);
    expect(parent?.status).toBe(TaskStatus.QUEUED);
    expect(parent?.constraints).toMatchObject({
      delegationResume: true,
      delegationResumePackage: {
        treeId: fixture.treeId,
        parentTaskId: fixture.parentTaskId,
      },
    });

    const [tree] = await db
      .select({
        resumeTaskId: delegationTrees.resumeTaskId,
        wokenAt: delegationTrees.wokenAt,
        version: delegationTrees.version,
      })
      .from(delegationTrees)
      .where(eq(delegationTrees.id, fixture.treeId))
      .limit(1);
    expect(tree?.resumeTaskId).toBe(fixture.parentTaskId);
    expect(tree?.wokenAt).toBeInstanceOf(Date);
    expect(tree?.version).toBe(1);

    const [lease] = await db
      .select()
      .from(admissionLeases)
      .where(eq(admissionLeases.taskId, fixture.parentTaskId))
      .limit(1);
    expect(lease).toMatchObject({
      taskId: fixture.parentTaskId,
      sessionId: fixture.sessionId,
    });
    expect(lease?.jobData).toMatchObject({
      taskId: fixture.parentTaskId,
      sessionId: fixture.sessionId,
      goal: expect.stringContaining('<delegation_results>'),
    });
  });

  it('finds a terminal child waiting parent for reconciliation and drops it after wake', async () => {
    const fixture = await createBarrierFixture({ childCount: 1 });
    await completeAgentDelegationForChildTask(db, fixture.childTaskIds[0], {
      output: { text: 'child result' },
    });

    const ready = await listReadyDelegationBarriers(db);

    expect(ready).toEqual([
      {
        treeId: fixture.treeId,
        parentTaskId: fixture.parentTaskId,
        childTaskId: fixture.childTaskIds[0],
      },
    ]);

    const result = await evaluateDelegationBarrierForChildTask(db, ready[0].childTaskId);
    expect(result.status).toBe('woken');

    const afterWake = await listReadyDelegationBarriers(db);
    expect(afterWake).toEqual([]);
  });

  it('repairs a completed child task with a non-terminal delegation edge before wake', async () => {
    const fixture = await createBarrierFixture({ childCount: 1 });
    await db
      .update(tasks)
      .set({
        status: TaskStatus.COMPLETED,
        result: { output: { text: 'child completed before edge update' } },
      })
      .where(eq(tasks.id, fixture.childTaskIds[0]));

    const edgeResult = await reconcileTerminalChildDelegationEdges(db);

    expect(edgeResult).toEqual({ inspected: 1, reconciled: 1 });
    const [edge] = await db
      .select({
        status: agentDelegations.status,
        result: agentDelegations.result,
      })
      .from(agentDelegations)
      .where(eq(agentDelegations.childTaskId, fixture.childTaskIds[0]))
      .limit(1);
    expect(edge).toMatchObject({
      status: 'completed',
      result: { output: { text: 'child completed before edge update' } },
    });

    const ready = await listReadyDelegationBarriers(db);
    expect(ready).toHaveLength(1);
    const wake = await evaluateDelegationBarrierForChildTask(db, ready[0].childTaskId);
    expect(wake.status).toBe('woken');
    const replay = await evaluateDelegationBarrierForChildTask(db, ready[0].childTaskId);
    expect(replay.status).toBe('already_woken');

    const [leaseCount] = await db
      .select({ value: count() })
      .from(admissionLeases)
      .where(eq(admissionLeases.taskId, fixture.parentTaskId));
    expect(leaseCount.value).toBe(1);

    const afterWake = await listReadyDelegationBarriers(db);
    expect(afterWake).toEqual([]);
  });

  it('repairs a failed child task with a non-terminal delegation edge before wake', async () => {
    const fixture = await createBarrierFixture({ childCount: 1 });
    await db
      .update(tasks)
      .set({
        status: TaskStatus.FAILED,
        errorMessage: 'child failed before edge update',
      })
      .where(eq(tasks.id, fixture.childTaskIds[0]));

    const edgeResult = await reconcileTerminalChildDelegationEdges(db);

    expect(edgeResult).toEqual({ inspected: 1, reconciled: 1 });
    const [edge] = await db
      .select({
        status: agentDelegations.status,
        errorMessage: agentDelegations.errorMessage,
      })
      .from(agentDelegations)
      .where(eq(agentDelegations.childTaskId, fixture.childTaskIds[0]))
      .limit(1);
    expect(edge).toMatchObject({
      status: 'failed',
      errorMessage: 'child failed before edge update',
    });

    const ready = await listReadyDelegationBarriers(db);
    expect(ready).toHaveLength(1);
    const wake = await evaluateDelegationBarrierForChildTask(db, ready[0].childTaskId);
    expect(wake.status).toBe('woken');
    const replay = await evaluateDelegationBarrierForChildTask(db, ready[0].childTaskId);
    expect(replay.status).toBe('already_woken');

    const [leaseCount] = await db
      .select({ value: count() })
      .from(admissionLeases)
      .where(eq(admissionLeases.taskId, fixture.parentTaskId));
    expect(leaseCount.value).toBe(1);
  });

  it('wakes exactly once when sibling child terminal updates race', async () => {
    const fixture = await createBarrierFixture({ childCount: 2 });

    const results = await Promise.all(
      fixture.childTaskIds.map(async (childTaskId, index) => {
        if (index === 0) {
          await completeAgentDelegationForChildTask(db, childTaskId, {
            output: { text: `child ${index}` },
          });
        } else {
          await failAgentDelegationForChildTask(db, childTaskId, 'child failed');
        }
        return evaluateDelegationBarrierForChildTask(db, childTaskId);
      }),
    );

    expect(results.filter((result) => result.status === 'woken')).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'waiting' || result.status === 'already_woken')
        .length,
    ).toBe(1);

    const [parent] = await db
      .select({ status: tasks.status })
      .from(tasks)
      .where(eq(tasks.id, fixture.parentTaskId))
      .limit(1);
    expect(parent?.status).toBe(TaskStatus.QUEUED);

    const [tree] = await db
      .select({ resumeTaskId: delegationTrees.resumeTaskId, wokenAt: delegationTrees.wokenAt })
      .from(delegationTrees)
      .where(eq(delegationTrees.id, fixture.treeId))
      .limit(1);
    expect(tree?.resumeTaskId).toBe(fixture.parentTaskId);
    expect(tree?.wokenAt).toBeInstanceOf(Date);

    const leases = await db
      .select()
      .from(admissionLeases)
      .where(eq(admissionLeases.taskId, fixture.parentTaskId));
    expect(leases).toHaveLength(1);
  });

  async function createBudgetFixture(input: {
    totalBudget: number;
    fanoutBudget: number;
    tasksUsed: number;
    existingFanout: number;
  }): Promise<BudgetFixture> {
    const testId = randomUUID();
    const profileId = randomUUID();
    const callerAgentId = randomUUID();
    const calleeAgentId = randomUUID();
    const sessionId = randomUUID();
    const rootTaskId = randomUUID();
    const treeId = randomUUID();
    const cleanupTaskIds = [rootTaskId];
    const childTaskIds: string[] = [];

    await db.insert(agentProfiles).values({
      id: profileId,
      name: `budget-${testId}`,
      displayName: `Budget ${testId}`,
    });
    await db.insert(agents).values([
      {
        id: callerAgentId,
        handle: `caller-${testId}`,
        displayName: `Caller ${testId}`,
        profileId,
      },
      {
        id: calleeAgentId,
        handle: `callee-${testId}`,
        displayName: `Callee ${testId}`,
        profileId,
      },
    ]);
    await db.insert(sessions).values({
      id: sessionId,
      sessionKey: `budget:${testId}`,
      chatId: `budget-chat-${testId}`,
      scope: 'test',
    });
    await db.insert(tasks).values({
      id: rootTaskId,
      sessionId,
      agentId: callerAgentId,
      taskType: 'chat_reply',
      goal: 'root',
      status: 'queued',
    });
    await db.insert(delegationTrees).values({
      id: treeId,
      rootTaskId,
      totalBudget: input.totalBudget,
      tasksUsed: input.tasksUsed,
      fanoutBudget: input.fanoutBudget,
    });

    for (let index = 0; index < input.existingFanout; index += 1) {
      const childTaskId = randomUUID();
      cleanupTaskIds.push(childTaskId);
      childTaskIds.push(childTaskId);
      await db.insert(tasks).values({
        id: childTaskId,
        sessionId,
        agentId: calleeAgentId,
        parentTaskId: rootTaskId,
        taskType: 'analysis',
        goal: `existing child ${index}`,
        status: 'queued',
      });
      await createAgentDelegation(db, {
        treeId,
        parentTaskId: rootTaskId,
        childTaskId,
        callerAgentId,
        calleeAgentId,
        goal: `existing child ${index}`,
      });
    }

    const fixture = {
      profileId,
      callerAgentId,
      calleeAgentId,
      sessionId,
      rootTaskId,
      parentTaskId: rootTaskId,
      treeId,
      cleanupTaskIds,
      childTaskIds,
    };
    fixtures.push(fixture);
    return fixture;
  }

  async function createBarrierFixture(input: { childCount: number }): Promise<BudgetFixture> {
    const fixture = await createBudgetFixture({
      totalBudget: 10,
      fanoutBudget: 10,
      tasksUsed: input.childCount,
      existingFanout: 0,
    });

    await db
      .update(tasks)
      .set({
        status: TaskStatus.WAITING_DELEGATION,
        constraints: { original: true },
      })
      .where(eq(tasks.id, fixture.parentTaskId));

    for (let index = 0; index < input.childCount; index += 1) {
      const childTaskId = randomUUID();
      fixture.cleanupTaskIds.push(childTaskId);
      fixture.childTaskIds.push(childTaskId);
      await db.insert(tasks).values({
        id: childTaskId,
        sessionId: fixture.sessionId,
        agentId: fixture.calleeAgentId,
        parentTaskId: fixture.parentTaskId,
        taskType: 'analysis',
        goal: `barrier child ${index}`,
        status: TaskStatus.COMPLETED,
      });
      await createAgentDelegation(db, {
        treeId: fixture.treeId,
        parentTaskId: fixture.parentTaskId,
        childTaskId,
        callerAgentId: fixture.callerAgentId,
        calleeAgentId: fixture.calleeAgentId,
        goal: `barrier child ${index}`,
      });
    }

    return fixture;
  }

  async function createReservedChildDelegation(
    fixture: BudgetFixture,
    label: string,
    failAfterCreate = false,
  ): Promise<void> {
    await db.transaction(async (tx) => {
      const txDb = tx as unknown as Database;
      await reserveDelegationBudget(txDb, {
        rootTaskId: fixture.rootTaskId,
        parentTaskId: fixture.parentTaskId,
        treeId: fixture.treeId,
        totalBudget: 999,
        fanoutBudget: 999,
      });

      const childTaskId = randomUUID();
      fixture.cleanupTaskIds.push(childTaskId);
      fixture.childTaskIds.push(childTaskId);
      await tx.insert(tasks).values({
        id: childTaskId,
        sessionId: fixture.sessionId,
        agentId: fixture.calleeAgentId,
        parentTaskId: fixture.parentTaskId,
        taskType: 'analysis',
        goal: `child ${label}`,
        status: 'queued',
      });
      await createAgentDelegation(txDb, {
        treeId: fixture.treeId,
        parentTaskId: fixture.parentTaskId,
        childTaskId,
        callerAgentId: fixture.callerAgentId,
        calleeAgentId: fixture.calleeAgentId,
        goal: `child ${label}`,
      });

      if (failAfterCreate) {
        throw new Error('rollback after child creation');
      }
    });
  }

  async function expectTreeUsage(
    fixture: BudgetFixture,
    expected: { tasksUsed: number; fanoutUsed: number },
  ): Promise<void> {
    const [tree] = await db
      .select({ tasksUsed: delegationTrees.tasksUsed })
      .from(delegationTrees)
      .where(eq(delegationTrees.id, fixture.treeId))
      .limit(1);
    const [fanout] = await db
      .select({ value: count() })
      .from(agentDelegations)
      .where(eq(agentDelegations.parentTaskId, fixture.parentTaskId));

    expect(tree?.tasksUsed).toBe(expected.tasksUsed);
    expect(Number(fanout?.value ?? 0)).toBe(expected.fanoutUsed);
  }
});
