import { randomUUID } from 'crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { TaskStatus } from '@open-tag/core-types';
import {
  admissionLeases,
  agentDelegations,
  agentProfiles,
  agents,
  chatActiveSessions,
  delegationTrees,
  sessions,
  tasks,
  type AgentDelegationRecord,
  type Database,
} from '@open-tag/storage';
import * as schema from '@open-tag/storage';
import {
  AgentDelegationError,
  createDelegatedTask,
  createDelegatedTaskFromLoaders,
  getDelegationDepth,
} from '../agent-delegation.js';

function makeDelegation(overrides: Partial<AgentDelegationRecord> = {}): AgentDelegationRecord {
  const now = new Date('2026-01-01T00:00:00Z');
  return {
    id: 'delegation_1',
    treeId: 'tree_1',
    parentDelegationId: null,
    depth: 1,
    childSessionId: null,
    parentTaskId: 'parent_task',
    childTaskId: 'child_task',
    callerAgentId: 'agent_caller',
    calleeAgentId: 'agent_callee',
    goal: 'Review the patch',
    inputSummary: 'Only inspect the patch summary.',
    permissionScope: { mode: 'read_only' },
    status: 'pending',
    result: null,
    errorMessage: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    ...overrides,
  };
}

function createLoaders(
  parentConstraints: Record<string, unknown> = {},
  options: {
    reserveBudget?: () => Promise<{ treeId: string; tasksUsed: number; fanoutUsed: number }>;
    newId?: () => string;
    newSessionId?: () => string;
  } = {},
) {
  const createdChildSessions: unknown[] = [];
  const insertedChildTasks: unknown[] = [];
  const updatedChildConstraints: unknown[] = [];
  const parentsMarkedWaiting: string[] = [];
  const createdDelegations: unknown[] = [];
  const upsertedAdmissionLeases: unknown[] = [];

  return {
    createdChildSessions,
    insertedChildTasks,
    updatedChildConstraints,
    parentsMarkedWaiting,
    createdDelegations,
    upsertedAdmissionLeases,
    loaders: {
      loadParentTask: vi.fn().mockResolvedValue({
        id: 'parent_task',
        sessionId: 'session_1',
        agentId: 'agent_caller',
        feishuAppId: 'feishu_app_1',
        status: TaskStatus.RUNNING,
        constraints: parentConstraints,
      }),
      reserveBudget: vi
        .fn()
        .mockImplementation(
          options.reserveBudget ??
            (async () => ({ treeId: 'tree_1', tasksUsed: 1, fanoutUsed: 1 })),
        ),
      createChildSession: vi.fn().mockImplementation(async (values) => {
        createdChildSessions.push(values);
        return { id: values.id };
      }),
      insertChildTask: vi.fn().mockImplementation(async (values) => {
        insertedChildTasks.push(values);
        return { id: values.id };
      }),
      updateChildTaskConstraints: vi.fn().mockImplementation(async (_taskId, constraints) => {
        updatedChildConstraints.push(constraints);
      }),
      markParentWaitingForDelegation: vi.fn().mockImplementation(async (parentTaskId) => {
        parentsMarkedWaiting.push(parentTaskId);
      }),
      createDelegation: vi.fn().mockImplementation(async (input) => {
        createdDelegations.push(input);
        return makeDelegation(input);
      }),
      upsertAdmissionLease: vi.fn().mockImplementation(async (job) => {
        upsertedAdmissionLeases.push(job);
      }),
      newId: options.newId ?? (() => 'child_task'),
      newSessionId: options.newSessionId ?? (() => 'child_session'),
    },
  };
}

describe('createDelegatedTaskFromLoaders', () => {
  it('creates a bounded delegated child task and queue job without Feishu feedback fields', async () => {
    const deps = createLoaders();

    const result = await createDelegatedTaskFromLoaders(
      {
        parentTaskId: 'parent_task',
        callerAgentId: 'agent_caller',
        calleeAgentId: 'agent_callee',
        goal: 'Review the patch',
        contextSummary: 'Patch touches auth validation only.',
        expectedOutput: 'Return risks and required fixes.',
      },
      deps.loaders,
    );

    expect(result.childTaskId).toBe('child_task');
    expect(result.childSessionId).toBe('child_session');
    expect(result.taskPackage).toMatchObject({
      goal: 'Review the patch',
      contextSummary: 'Patch touches auth validation only.',
      expectedOutput: 'Return risks and required fixes.',
      caller: { taskId: 'parent_task', agentId: 'agent_caller' },
      permissionScope: { mode: 'read_only' },
    });

    expect(deps.createdChildSessions[0]).toMatchObject({
      id: 'child_session',
      sessionKey:
        'delegation:parent_task:parent_task:child_task:agent:agent_callee',
      chatId: 'delegation:child_task',
      scope: 'delegated-child',
      status: 'active',
    });

    const childTask = deps.insertedChildTasks[0] as Record<string, unknown>;
    expect(childTask.status).toBe(TaskStatus.QUEUED);
    expect(childTask.parentTaskId).toBe('parent_task');
    expect(childTask.sessionId).toBe('child_session');
    expect(childTask.sessionId).not.toBe('session_1');
    expect(childTask.agentId).toBe('agent_callee');
    expect(childTask.feishuAppId).toBe('feishu_app_1');

    const childConstraints = childTask.constraints as Record<string, unknown>;
    expect(childConstraints.delegatedTask).toBe(true);
    expect(childConstraints.delegationMode).toBe('return');
    expect(childConstraints.delegationDepth).toBe(1);
    expect(childConstraints.delegationChain).toEqual(['agent_caller', 'agent_callee']);
    expect(childConstraints.delegationTreeId).toBe('tree_1');
    expect(childConstraints.delegationRootTaskId).toBe('parent_task');
    expect(childConstraints.delegationPackage).toEqual(result.taskPackage);
    expect(childConstraints.parentSessionId).toBe('session_1');
    expect(childConstraints.childSessionId).toBe('child_session');
    expect(childConstraints.chatId).toBeUndefined();
    expect(childConstraints.ackMessageId).toBeUndefined();
    expect(result.job.constraints).toEqual(childConstraints);
    expect(result.job.sessionId).toBe('child_session');
    expect(result.job.sessionId).not.toBe('session_1');
    expect(deps.updatedChildConstraints[0]).toMatchObject({
      delegationId: 'delegation_1',
      delegationTreeId: 'tree_1',
    });
    expect(deps.createdDelegations[0]).toMatchObject({
      treeId: 'tree_1',
      parentDelegationId: null,
      depth: 1,
      childSessionId: 'child_session',
    });
    expect(deps.upsertedAdmissionLeases).toEqual([result.job]);
    expect(deps.parentsMarkedWaiting).toEqual(['parent_task']);
  });

  it('snapshots callee Feishu app id onto delegated child task and job', async () => {
    const deps = createLoaders();

    const result = await createDelegatedTaskFromLoaders(
      {
        parentTaskId: 'parent_task',
        callerAgentId: 'agent_caller',
        calleeAgentId: 'agent_callee',
        calleeFeishuAppId: 'feishu_app_callee',
        goal: 'Review the patch',
        contextSummary: 'Patch touches auth validation only.',
      },
      deps.loaders,
    );

    const childTask = deps.insertedChildTasks[0] as Record<string, unknown>;
    const childConstraints = childTask.constraints as Record<string, unknown>;
    expect(childTask.feishuAppId).toBe('feishu_app_callee');
    expect(childConstraints.feishuAppId).toBe('feishu_app_callee');
    expect(result.job.feishuAppId).toBe('feishu_app_callee');
  });

  it('creates chain-mode children without waiting the parent', async () => {
    const deps = createLoaders();

    const result = await createDelegatedTaskFromLoaders(
      {
        parentTaskId: 'parent_task',
        callerAgentId: 'agent_caller',
        calleeAgentId: 'agent_callee',
        mode: 'chain',
        goal: 'Continue independently',
        contextSummary: 'Forward-only follow-up.',
      },
      deps.loaders,
    );

    const childTask = deps.insertedChildTasks[0] as Record<string, unknown>;
    const childConstraints = childTask.constraints as Record<string, unknown>;
    expect(childConstraints.delegationMode).toBe('chain');
    expect(result.job.constraints.delegationMode).toBe('chain');
    expect(deps.upsertedAdmissionLeases).toEqual([result.job]);
    expect(deps.parentsMarkedWaiting).toEqual([]);
  });

  it('keeps depth=1 as the default backward-compatible nested delegation limit', async () => {
    const deps = createLoaders({ delegationDepth: 1 });

    await expect(
      createDelegatedTaskFromLoaders(
        {
          parentTaskId: 'parent_task',
          callerAgentId: 'agent_caller',
          calleeAgentId: 'agent_callee',
          goal: 'Delegate again',
          contextSummary: 'Nested work',
        },
        deps.loaders,
      ),
    ).rejects.toThrow('Delegation depth budget exceeded');
  });

  it('allows bounded multi-hop delegation when maxDepth permits it', async () => {
    const deps = createLoaders({
      delegationDepth: 1,
      delegationChain: ['agent_root', 'agent_caller'],
      delegationTreeId: 'tree_existing',
      delegationRootTaskId: 'root_task',
      delegationId: 'parent_delegation',
    });

    const result = await createDelegatedTaskFromLoaders(
      {
        parentTaskId: 'parent_task',
        callerAgentId: 'agent_caller',
        calleeAgentId: 'agent_callee',
        goal: 'Delegate again',
        contextSummary: 'Nested work',
        policy: { maxDepth: 2 },
      },
      deps.loaders,
    );

    expect(result.delegation.depth).toBe(2);
    expect(deps.loaders.reserveBudget).toHaveBeenCalledWith({
      rootTaskId: 'root_task',
      parentTaskId: 'parent_task',
      treeId: 'tree_existing',
      totalBudget: 12,
      fanoutBudget: 3,
    });
    expect(deps.createdDelegations[0]).toMatchObject({
      treeId: 'tree_1',
      parentDelegationId: 'parent_delegation',
      depth: 2,
    });

    const childConstraints = (deps.insertedChildTasks[0] as Record<string, unknown>)
      .constraints as Record<string, unknown>;
    expect(childConstraints.delegationChain).toEqual([
      'agent_root',
      'agent_caller',
      'agent_callee',
    ]);
    expect(childConstraints.delegationDepth).toBe(2);
    expect(childConstraints.delegationRootTaskId).toBe('root_task');
  });

  it('assigns sibling child delegations independent session singletons', async () => {
    let childIndex = 0;
    const deps = createLoaders(
      {},
      {
        newId: () => `child_task_${(childIndex += 1)}`,
        newSessionId: () => `child_session_${childIndex}`,
      },
    );

    const first = await createDelegatedTaskFromLoaders(
      {
        parentTaskId: 'parent_task',
        callerAgentId: 'agent_caller',
        calleeAgentId: 'agent_callee',
        goal: 'Sibling one',
        contextSummary: 'First child',
      },
      deps.loaders,
    );
    const second = await createDelegatedTaskFromLoaders(
      {
        parentTaskId: 'parent_task',
        callerAgentId: 'agent_caller',
        calleeAgentId: 'agent_other',
        goal: 'Sibling two',
        contextSummary: 'Second child',
      },
      deps.loaders,
    );

    expect(first.job.sessionId).toBe('child_session_1');
    expect(second.job.sessionId).toBe('child_session_2');
    expect(first.job.sessionId).not.toBe(second.job.sessionId);
    expect(first.job.sessionId).not.toBe('session_1');
    expect(second.job.sessionId).not.toBe('session_1');
  });

  it('rejects self delegation loops', async () => {
    const deps = createLoaders();

    await expect(
      createDelegatedTaskFromLoaders(
        {
          parentTaskId: 'parent_task',
          callerAgentId: 'agent_caller',
          calleeAgentId: 'agent_caller',
          goal: 'Loop',
          contextSummary: 'No-op',
        },
        deps.loaders,
      ),
    ).rejects.toThrow('Agent cannot delegate to itself');
  });

  it('rejects delegation cycles through the existing chain', async () => {
    const deps = createLoaders({
      delegationDepth: 1,
      delegationChain: ['agent_root', 'agent_caller'],
    });

    await expect(
      createDelegatedTaskFromLoaders(
        {
          parentTaskId: 'parent_task',
          callerAgentId: 'agent_caller',
          calleeAgentId: 'agent_root',
          goal: 'Loop back',
          contextSummary: 'No-op',
          policy: { maxDepth: 2 },
        },
        deps.loaders,
      ),
    ).rejects.toThrow('Delegation cycle detected');
  });

  it('surfaces fanout budget rejection before creating a child task', async () => {
    const deps = createLoaders(
      {},
      {
        reserveBudget: async () => {
          throw new AgentDelegationError('Delegation fanout budget exceeded');
        },
      },
    );

    await expect(
      createDelegatedTaskFromLoaders(
        {
          parentTaskId: 'parent_task',
          callerAgentId: 'agent_caller',
          calleeAgentId: 'agent_callee',
          goal: 'Too many siblings',
          contextSummary: 'Budgeted work',
        },
        deps.loaders,
      ),
    ).rejects.toThrow('Delegation fanout budget exceeded');
    expect(deps.createdChildSessions).toHaveLength(0);
    expect(deps.insertedChildTasks).toHaveLength(0);
  });

  it('surfaces total task budget rejection before creating a child task', async () => {
    const deps = createLoaders(
      {},
      {
        reserveBudget: async () => {
          throw new AgentDelegationError('Delegation total task budget exceeded');
        },
      },
    );

    await expect(
      createDelegatedTaskFromLoaders(
        {
          parentTaskId: 'parent_task',
          callerAgentId: 'agent_caller',
          calleeAgentId: 'agent_callee',
          goal: 'Too many descendants',
          contextSummary: 'Budgeted work',
        },
        deps.loaders,
      ),
    ).rejects.toThrow('Delegation total task budget exceeded');
    expect(deps.createdChildSessions).toHaveLength(0);
    expect(deps.insertedChildTasks).toHaveLength(0);
  });
});

describe('getDelegationDepth', () => {
  it('defaults missing depth to zero', () => {
    expect(getDelegationDepth({})).toBe(0);
    expect(getDelegationDepth(null)).toBe(0);
  });
});

describe('getDelegationChain', () => {
  it('filters invalid chain entries', async () => {
    const mod = await import('../agent-delegation.js');
    expect(mod.getDelegationChain({ delegationChain: ['agent_1', null, 42, 'agent_2'] })).toEqual([
      'agent_1',
      'agent_2',
    ]);
  });
});

const describePg =
  process.env.OPEN_TAG_ORCHESTRATOR_PG_INTEGRATION === '1' ? describe : describe.skip;

describePg('createDelegatedTask Postgres integration', () => {
  let client: postgres.Sql;
  let db: Database;
  const fixtures: Array<{
    profileId: string;
    callerAgentId: string;
    calleeAgentId: string;
    sessionId: string;
    parentTaskId: string;
    tenantKey: string;
    chatId: string;
  }> = [];

  beforeAll(() => {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL is required for orchestrator Postgres integration tests');
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
      const childSessions = await db
        .select({ id: agentDelegations.childSessionId })
        .from(agentDelegations)
        .where(eq(agentDelegations.parentTaskId, fixture.parentTaskId));
      await db
        .delete(agentDelegations)
        .where(eq(agentDelegations.parentTaskId, fixture.parentTaskId));
      await db.delete(delegationTrees).where(eq(delegationTrees.rootTaskId, fixture.parentTaskId));
      await db.delete(tasks).where(eq(tasks.parentTaskId, fixture.parentTaskId));
      await db.delete(tasks).where(eq(tasks.id, fixture.parentTaskId));
      await db
        .delete(chatActiveSessions)
        .where(
          and(
            eq(chatActiveSessions.tenantKey, fixture.tenantKey),
            eq(chatActiveSessions.chatId, fixture.chatId),
          ),
        );
      await db.delete(sessions).where(eq(sessions.id, fixture.sessionId));
      const childSessionIds = childSessions
        .map((session) => session.id)
        .filter((id): id is string => typeof id === 'string');
      if (childSessionIds.length > 0) {
        await db.delete(sessions).where(inArray(sessions.id, childSessionIds));
      }
      await db
        .delete(agents)
        .where(inArray(agents.id, [fixture.callerAgentId, fixture.calleeAgentId]));
      await db.delete(agentProfiles).where(eq(agentProfiles.id, fixture.profileId));
    }
  });

  afterAll(async () => {
    await client.end({ timeout: 5 });
  });

  it('creates a real child session without changing the chat active pointer', async () => {
    const fixture = await createDelegationFixture();

    const result = await createDelegatedTask(db, {
      parentTaskId: fixture.parentTaskId,
      callerAgentId: fixture.callerAgentId,
      calleeAgentId: fixture.calleeAgentId,
      goal: 'Summarize the research',
      contextSummary: 'Parent needs a bounded child analysis.',
    });

    const [childSession] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, result.childSessionId))
      .limit(1);
    expect(childSession).toMatchObject({
      id: result.childSessionId,
      scope: 'delegated-child',
      chatId: `delegation:${result.childTaskId}`,
    });
    expect(childSession?.sessionKey).toContain(fixture.parentTaskId);
    expect(childSession?.sessionKey).toContain(result.childTaskId);
    expect(childSession?.sessionKey).toContain(fixture.calleeAgentId);

    const [childTask] = await db
      .select({
        sessionId: tasks.sessionId,
        parentTaskId: tasks.parentTaskId,
        agentId: tasks.agentId,
        constraints: tasks.constraints,
      })
      .from(tasks)
      .where(eq(tasks.id, result.childTaskId))
      .limit(1);
    expect(childTask).toMatchObject({
      sessionId: result.childSessionId,
      parentTaskId: fixture.parentTaskId,
      agentId: fixture.calleeAgentId,
    });
    expect(result.job.sessionId).toBe(result.childSessionId);
    expect(result.job.sessionId).not.toBe(fixture.sessionId);
    expect(childTask?.constraints).toMatchObject({
      delegatedTask: true,
      parentSessionId: fixture.sessionId,
      childSessionId: result.childSessionId,
    });
    expect(result.delegation.childSessionId).toBe(result.childSessionId);

    const [activePointer] = await db
      .select()
      .from(chatActiveSessions)
      .where(
        and(
          eq(chatActiveSessions.tenantKey, fixture.tenantKey),
          eq(chatActiveSessions.chatId, fixture.chatId),
        ),
      )
      .limit(1);
    expect(activePointer?.activeSessionId).toBe(fixture.sessionId);

    const [parentTask] = await db
      .select({ status: tasks.status })
      .from(tasks)
      .where(eq(tasks.id, fixture.parentTaskId))
      .limit(1);
    expect(parentTask?.status).toBe(TaskStatus.WAITING_DELEGATION);

    const [admissionLease] = await db
      .select()
      .from(admissionLeases)
      .where(eq(admissionLeases.taskId, result.childTaskId))
      .limit(1);
    expect(admissionLease).toMatchObject({
      taskId: result.childTaskId,
      agentId: fixture.calleeAgentId,
      sessionId: result.childSessionId,
    });
    expect(admissionLease?.jobData).toMatchObject({
      taskId: result.childTaskId,
      sessionId: result.childSessionId,
      agentId: fixture.calleeAgentId,
    });

    const surfacedSessions = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.chatId, fixture.chatId));
    expect(surfacedSessions.map((session) => session.id)).not.toContain(result.childSessionId);
  });

  it('reselects deterministic duplicate children without double budget or lease', async () => {
    const fixture = await createDelegationFixture();
    const childTaskId = randomUUID();
    const childSessionId = randomUUID();

    const first = await createDelegatedTask(db, {
      parentTaskId: fixture.parentTaskId,
      callerAgentId: fixture.callerAgentId,
      calleeAgentId: fixture.calleeAgentId,
      childTaskId,
      childSessionId,
      mode: 'return',
      goal: 'Review the primary output',
      contextSummary: 'First relay completion.',
    });
    const duplicate = await createDelegatedTask(db, {
      parentTaskId: fixture.parentTaskId,
      callerAgentId: fixture.callerAgentId,
      calleeAgentId: fixture.calleeAgentId,
      childTaskId,
      childSessionId,
      mode: 'return',
      goal: 'Review the same output with retry wording',
      contextSummary: 'Duplicate parent retry.',
    });

    expect(duplicate.childTaskId).toBe(first.childTaskId);
    expect(duplicate.childSessionId).toBe(first.childSessionId);
    expect(duplicate.delegation.id).toBe(first.delegation.id);
    expect(duplicate.taskPackage.goal).toBe('Review the primary output');

    const childTasks = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(eq(tasks.parentTaskId, fixture.parentTaskId));
    expect(childTasks).toHaveLength(1);

    const childDelegations = await db
      .select({ id: agentDelegations.id })
      .from(agentDelegations)
      .where(eq(agentDelegations.childTaskId, childTaskId));
    expect(childDelegations).toHaveLength(1);

    const childLeases = await db
      .select({ taskId: admissionLeases.taskId })
      .from(admissionLeases)
      .where(eq(admissionLeases.taskId, childTaskId));
    expect(childLeases).toHaveLength(1);

    const [tree] = await db
      .select({ tasksUsed: delegationTrees.tasksUsed })
      .from(delegationTrees)
      .where(eq(delegationTrees.rootTaskId, fixture.parentTaskId))
      .limit(1);
    expect(tree?.tasksUsed).toBe(1);
  });

  async function createDelegationFixture() {
    const testId = randomUUID();
    const profileId = randomUUID();
    const callerAgentId = randomUUID();
    const calleeAgentId = randomUUID();
    const sessionId = randomUUID();
    const parentTaskId = randomUUID();
    const tenantKey = `tenant-${testId}`;
    const chatId = `chat-${testId}`;

    await db.insert(agentProfiles).values({
      id: profileId,
      name: `delegation-${testId}`,
      displayName: `Delegation ${testId}`,
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
      sessionKey: `feishu:${tenantKey}:${chatId}:thread:root-${testId}`,
      chatId,
      scope: 'thread',
      status: 'active',
    });
    await db.insert(chatActiveSessions).values({
      tenantKey,
      chatId,
      activeSessionId: sessionId,
    });
    await db.insert(tasks).values({
      id: parentTaskId,
      sessionId,
      agentId: callerAgentId,
      taskType: 'chat_reply',
      goal: 'parent',
      status: TaskStatus.RUNNING,
      constraints: {},
    });

    const fixture = {
      profileId,
      callerAgentId,
      calleeAgentId,
      sessionId,
      parentTaskId,
      tenantKey,
      chatId,
    };
    fixtures.push(fixture);
    return fixture;
  }
});
