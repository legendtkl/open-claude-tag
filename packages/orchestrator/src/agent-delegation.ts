import { randomUUID } from 'node:crypto';
import { IntentType, TaskStatus, isObjectRecord as isRecord, normalizeRuntimeHint } from '@open-tag/core-types';
import type { Database } from '@open-tag/storage';
import {
  admissionLeases,
  agentDelegations,
  createAgentDelegation,
  reserveDelegationBudget,
  sessions,
  tasks,
  type AgentDelegationRecord,
} from '@open-tag/storage';
import { and, eq, sql } from 'drizzle-orm';

export interface DelegationPermissionScope {
  mode?: 'read_only' | 'read_write';
  [key: string]: unknown;
}

export interface DelegatedTaskPackage {
  goal: string;
  contextSummary: string;
  constraints: Record<string, unknown>;
  expectedOutput: string;
  caller: {
    taskId: string;
    agentId: string;
  };
  permissionScope: DelegationPermissionScope;
}

export interface DelegationParentTask {
  id: string;
  sessionId: string;
  agentId: string | null;
  feishuAppId: string | null;
  status?: string | null;
  constraints: unknown;
}

export interface DelegationPolicy {
  maxDepth: number;
  maxFanout: number;
  maxTotalTasks: number;
}

export interface DelegatedTaskJobData {
  taskId: string;
  sessionId: string;
  agentId: string;
  feishuAppId?: string;
  taskType: string;
  goal: string;
  runtimeHint: string | null;
  constraints: Record<string, unknown>;
}

export interface CreateDelegatedTaskInput {
  parentTaskId: string;
  callerAgentId: string;
  calleeAgentId: string;
  calleeFeishuAppId?: string | null;
  childTaskId?: string;
  childSessionId?: string;
  mode?: 'return' | 'chain';
  goal: string;
  contextSummary: string;
  expectedOutput?: string;
  constraints?: Record<string, unknown>;
  permissionScope?: DelegationPermissionScope;
  runtimeHint?: string | null;
  timeoutSec?: number;
  policy?: Partial<DelegationPolicy>;
}

export interface CreateDelegatedTaskResult {
  childTaskId: string;
  childSessionId: string;
  delegation: AgentDelegationRecord;
  taskPackage: DelegatedTaskPackage;
  job: DelegatedTaskJobData;
}

export interface CreateDelegatedTaskLoaders {
  loadParentTask(parentTaskId: string): Promise<DelegationParentTask | null>;
  loadExistingDelegatedTask?(input: {
    parentTask: DelegationParentTask;
    childTaskId: string;
    childSessionId?: string;
    callerAgentId: string;
    calleeAgentId: string;
  }): Promise<CreateDelegatedTaskResult | null>;
  reserveBudget(input: {
    rootTaskId: string;
    parentTaskId: string;
    treeId?: string | null;
    totalBudget: number;
    fanoutBudget: number;
  }): Promise<{ treeId: string; tasksUsed: number; fanoutUsed: number }>;
  createChildSession(values: typeof sessions.$inferInsert): Promise<{ id: string }>;
  insertChildTask(values: typeof tasks.$inferInsert): Promise<{ id: string }>;
  updateChildTaskConstraints(taskId: string, constraints: Record<string, unknown>): Promise<void>;
  markParentWaitingForDelegation(parentTaskId: string): Promise<void>;
  createDelegation(input: {
    treeId: string;
    parentDelegationId?: string | null;
    depth: number;
    childSessionId?: string | null;
    parentTaskId: string;
    childTaskId: string;
    callerAgentId: string;
    calleeAgentId: string;
    goal: string;
    inputSummary: string;
    permissionScope: DelegationPermissionScope;
  }): Promise<AgentDelegationRecord>;
  upsertAdmissionLease?(job: DelegatedTaskJobData): Promise<void>;
  newId?: () => string;
  newSessionId?: () => string;
}

export class AgentDelegationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentDelegationError';
  }
}

export function getDelegationDepth(constraints: unknown): number {
  if (!isRecord(constraints)) return 0;
  return typeof constraints.delegationDepth === 'number' ? constraints.delegationDepth : 0;
}

export function getDelegationChain(constraints: unknown): string[] {
  if (!isRecord(constraints)) return [];
  return Array.isArray(constraints.delegationChain)
    ? constraints.delegationChain.filter(
        (agentId): agentId is string => typeof agentId === 'string',
      )
    : [];
}

function getDelegationTreeId(constraints: unknown): string | null {
  if (!isRecord(constraints)) return null;
  return typeof constraints.delegationTreeId === 'string' ? constraints.delegationTreeId : null;
}

function getParentDelegationId(constraints: unknown): string | null {
  if (!isRecord(constraints)) return null;
  return typeof constraints.delegationId === 'string' ? constraints.delegationId : null;
}

function getDelegationRootTaskId(parentTask: DelegationParentTask): string {
  if (
    isRecord(parentTask.constraints) &&
    typeof parentTask.constraints.delegationRootTaskId === 'string'
  ) {
    return parentTask.constraints.delegationRootTaskId;
  }
  return parentTask.id;
}

function taskPackageFromConstraints(
  constraints: Record<string, unknown>,
  fallback: DelegatedTaskPackage,
): DelegatedTaskPackage {
  const taskPackage = constraints.delegationPackage;
  if (!isRecord(taskPackage)) return fallback;
  const caller = isRecord(taskPackage.caller) ? taskPackage.caller : {};
  const permissionScope = isRecord(taskPackage.permissionScope)
    ? taskPackage.permissionScope
    : fallback.permissionScope;
  return {
    goal: typeof taskPackage.goal === 'string' ? taskPackage.goal : fallback.goal,
    contextSummary:
      typeof taskPackage.contextSummary === 'string'
        ? taskPackage.contextSummary
        : fallback.contextSummary,
    constraints: isRecord(taskPackage.constraints) ? taskPackage.constraints : fallback.constraints,
    expectedOutput:
      typeof taskPackage.expectedOutput === 'string'
        ? taskPackage.expectedOutput
        : fallback.expectedOutput,
    caller: {
      taskId: typeof caller.taskId === 'string' ? caller.taskId : fallback.caller.taskId,
      agentId: typeof caller.agentId === 'string' ? caller.agentId : fallback.caller.agentId,
    },
    permissionScope,
  };
}

export function resolveDelegationPolicy(
  overrides: Partial<DelegationPolicy> = {},
  env: NodeJS.ProcessEnv = process.env,
): DelegationPolicy {
  const parsePositiveInt = (value: string | undefined, fallback: number): number => {
    if (value == null || value.trim() === '') return fallback;
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };

  return {
    maxDepth: overrides.maxDepth ?? parsePositiveInt(env.MAX_DELEGATION_DEPTH, 1),
    maxFanout: overrides.maxFanout ?? parsePositiveInt(env.DELEGATION_MAX_FANOUT, 3),
    maxTotalTasks: overrides.maxTotalTasks ?? parsePositiveInt(env.DELEGATION_MAX_TOTAL_TASKS, 12),
  };
}

export function buildDelegatedTaskPrompt(taskPackage: DelegatedTaskPackage): string {
  return [
    'You are executing a delegated task for another OpenClaudeTag agent.',
    'Use only the bounded task package below. Do not assume access to the caller agent SDK session or full history.',
    '',
    '<delegated_task_package>',
    JSON.stringify(taskPackage, null, 2),
    '</delegated_task_package>',
  ].join('\n');
}

function buildDelegatedChildSessionKey(input: {
  rootTaskId: string;
  parentTaskId: string;
  childTaskId: string;
  calleeAgentId: string;
}): string {
  return [
    'delegation',
    input.rootTaskId,
    input.parentTaskId,
    input.childTaskId,
    'agent',
    input.calleeAgentId,
  ].join(':');
}

function buildDelegatedChildChatId(childTaskId: string): string {
  return `delegation:${childTaskId}`;
}

export async function createDelegatedTaskFromLoaders(
  input: CreateDelegatedTaskInput,
  loaders: CreateDelegatedTaskLoaders,
): Promise<CreateDelegatedTaskResult> {
  const parentTask = await loaders.loadParentTask(input.parentTaskId);
  if (!parentTask) {
    throw new AgentDelegationError(`Parent task not found: ${input.parentTaskId}`);
  }
  if (!parentTask.agentId) {
    throw new AgentDelegationError('Parent task has no caller agent identity');
  }
  if (parentTask.agentId !== input.callerAgentId) {
    throw new AgentDelegationError('Caller agent does not own the parent task');
  }
  if (
    parentTask.status &&
    parentTask.status !== TaskStatus.RUNNING &&
    parentTask.status !== TaskStatus.WAITING_DELEGATION
  ) {
    throw new AgentDelegationError('Parent task is not running or waiting for delegation');
  }
  if (input.callerAgentId === input.calleeAgentId) {
    throw new AgentDelegationError('Agent cannot delegate to itself');
  }

  const policy = resolveDelegationPolicy(input.policy);
  const parentDepth = getDelegationDepth(parentTask.constraints);
  const nextDepth = parentDepth + 1;
  if (parentDepth >= policy.maxDepth) {
    throw new AgentDelegationError('Delegation depth budget exceeded');
  }

  const parentChain = getDelegationChain(parentTask.constraints);
  const delegationChain = parentChain.length > 0 ? parentChain : [input.callerAgentId];
  if (delegationChain.includes(input.calleeAgentId)) {
    throw new AgentDelegationError('Delegation cycle detected');
  }

  const childTaskId = input.childTaskId ?? loaders.newId?.() ?? randomUUID();
  const childSessionId = input.childSessionId ?? loaders.newSessionId?.() ?? randomUUID();
  const permissionScope = input.permissionScope ?? { mode: 'read_only' };
  const mode = input.mode ?? 'return';
  const fallbackTaskPackage: DelegatedTaskPackage = {
    goal: input.goal,
    contextSummary: input.contextSummary,
    constraints: input.constraints ?? {},
    expectedOutput: input.expectedOutput ?? 'Return a concise result for the caller agent.',
    caller: {
      taskId: parentTask.id,
      agentId: input.callerAgentId,
    },
    permissionScope,
  };
  const existingDelegatedTask = input.childTaskId
    ? await loaders.loadExistingDelegatedTask?.({
        parentTask,
        childTaskId,
        childSessionId: input.childSessionId,
        callerAgentId: input.callerAgentId,
        calleeAgentId: input.calleeAgentId,
      })
    : null;
  if (existingDelegatedTask) {
    return {
      ...existingDelegatedTask,
      taskPackage: taskPackageFromConstraints(
        existingDelegatedTask.job.constraints,
        fallbackTaskPackage,
      ),
    };
  }

  const rootTaskId = getDelegationRootTaskId(parentTask);
  const parentDelegationId = getParentDelegationId(parentTask.constraints);
  const budget = await loaders.reserveBudget({
    rootTaskId,
    parentTaskId: parentTask.id,
    treeId: getDelegationTreeId(parentTask.constraints),
    totalBudget: policy.maxTotalTasks,
    fanoutBudget: policy.maxFanout,
  });
  const taskPackage = fallbackTaskPackage;
  const goal = buildDelegatedTaskPrompt(taskPackage);
  const childSessionKey = buildDelegatedChildSessionKey({
    rootTaskId,
    parentTaskId: parentTask.id,
    childTaskId,
    calleeAgentId: input.calleeAgentId,
  });
  const childSession = await loaders.createChildSession({
    id: childSessionId,
    sessionKey: childSessionKey,
    chatId: buildDelegatedChildChatId(childTaskId),
    scope: 'delegated-child',
    status: 'active',
    title: `Delegated task ${childTaskId.slice(0, 8)}`,
  });
  const childConstraints: Record<string, unknown> = {
    timeoutSec: input.timeoutSec ?? 1800,
    approvalRequired: false,
    agentId: input.calleeAgentId,
    feishuAppId: input.calleeFeishuAppId ?? parentTask.feishuAppId ?? undefined,
    delegatedTask: true,
    delegationMode: mode,
    delegationDepth: nextDepth,
    delegationChain: [...delegationChain, input.calleeAgentId],
    delegationTreeId: budget.treeId,
    delegationRootTaskId: rootTaskId,
    delegationPackage: taskPackage,
    parentTaskId: parentTask.id,
    parentSessionId: parentTask.sessionId,
    childSessionId: childSession.id,
    parentDelegationId: parentDelegationId ?? undefined,
    callerAgentId: input.callerAgentId,
    calleeAgentId: input.calleeAgentId,
    permissionScope,
  };

  const childTask = await loaders.insertChildTask({
    id: childTaskId,
    sessionId: childSession.id,
    agentId: input.calleeAgentId,
    feishuAppId: input.calleeFeishuAppId ?? parentTask.feishuAppId ?? undefined,
    parentTaskId: parentTask.id,
    taskType: IntentType.ANALYSIS,
    goal,
    runtimeHint: normalizeRuntimeHint(input.runtimeHint),
    status: TaskStatus.QUEUED,
    constraints: childConstraints,
  });

  const delegation = await loaders.createDelegation({
    treeId: budget.treeId,
    parentDelegationId,
    depth: nextDepth,
    childSessionId: childSession.id,
    parentTaskId: parentTask.id,
    childTaskId: childTask.id,
    callerAgentId: input.callerAgentId,
    calleeAgentId: input.calleeAgentId,
    goal: input.goal,
    inputSummary: input.contextSummary,
    permissionScope,
  });

  childConstraints.delegationId = delegation.id;
  await loaders.updateChildTaskConstraints(childTask.id, childConstraints);
  const job = {
    taskId: childTask.id,
    sessionId: childSession.id,
    agentId: input.calleeAgentId,
    feishuAppId: input.calleeFeishuAppId ?? parentTask.feishuAppId ?? undefined,
    taskType: IntentType.ANALYSIS,
    goal,
    runtimeHint: normalizeRuntimeHint(input.runtimeHint),
    constraints: childConstraints,
  };
  await loaders.upsertAdmissionLease?.(job);
  if (mode === 'return') {
    await loaders.markParentWaitingForDelegation(parentTask.id);
  }

  return {
    childTaskId: childTask.id,
    childSessionId: childSession.id,
    delegation,
    taskPackage,
    job,
  };
}

export async function createDelegatedTask(
  db: Database,
  input: CreateDelegatedTaskInput,
): Promise<CreateDelegatedTaskResult> {
  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Database;
    if (input.childTaskId) {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${input.childTaskId}))`);
    }
    return createDelegatedTaskFromLoaders(input, {
      async loadParentTask(parentTaskId) {
        const [parentTask] = await tx
          .select({
            id: tasks.id,
            sessionId: tasks.sessionId,
            agentId: tasks.agentId,
            feishuAppId: tasks.feishuAppId,
            status: tasks.status,
            constraints: tasks.constraints,
          })
          .from(tasks)
          .where(eq(tasks.id, parentTaskId))
          .limit(1);

        return parentTask ?? null;
      },
      async loadExistingDelegatedTask(existingInput) {
        const [childTask] = await tx
          .select({
            id: tasks.id,
            sessionId: tasks.sessionId,
            agentId: tasks.agentId,
            feishuAppId: tasks.feishuAppId,
            parentTaskId: tasks.parentTaskId,
            taskType: tasks.taskType,
            goal: tasks.goal,
            runtimeHint: tasks.runtimeHint,
            constraints: tasks.constraints,
          })
          .from(tasks)
          .where(eq(tasks.id, existingInput.childTaskId))
          .limit(1);
        if (!childTask) return null;

        if (
          childTask.parentTaskId !== existingInput.parentTask.id ||
          childTask.agentId !== existingInput.calleeAgentId ||
          (existingInput.childSessionId && childTask.sessionId !== existingInput.childSessionId)
        ) {
          throw new AgentDelegationError('Deterministic delegated child id conflicts with another task');
        }

        const [delegation] = await tx
          .select()
          .from(agentDelegations)
          .where(eq(agentDelegations.childTaskId, childTask.id))
          .limit(1);
        if (!delegation) {
          throw new AgentDelegationError('Existing delegated child task has no delegation edge');
        }
        if (
          delegation.parentTaskId !== existingInput.parentTask.id ||
          delegation.callerAgentId !== existingInput.callerAgentId ||
          delegation.calleeAgentId !== existingInput.calleeAgentId
        ) {
          throw new AgentDelegationError('Existing delegation edge does not match requested handoff');
        }

        const constraints = isRecord(childTask.constraints) ? childTask.constraints : {};
        const fallbackPackage: DelegatedTaskPackage = {
          goal: input.goal,
          contextSummary: input.contextSummary,
          constraints: input.constraints ?? {},
          expectedOutput: input.expectedOutput ?? 'Return a concise result for the caller agent.',
          caller: {
            taskId: existingInput.parentTask.id,
            agentId: existingInput.callerAgentId,
          },
          permissionScope: input.permissionScope ?? { mode: 'read_only' },
        };
        const taskPackage = taskPackageFromConstraints(constraints, fallbackPackage);

        return {
          childTaskId: childTask.id,
          childSessionId: childTask.sessionId,
          delegation,
          taskPackage,
          job: {
            taskId: childTask.id,
            sessionId: childTask.sessionId,
            agentId: childTask.agentId ?? existingInput.calleeAgentId,
            feishuAppId: childTask.feishuAppId ?? undefined,
            taskType: childTask.taskType,
            goal: childTask.goal,
            runtimeHint: childTask.runtimeHint,
            constraints,
          },
        };
      },
      reserveBudget: (budgetInput) => reserveDelegationBudget(txDb, budgetInput),
      async createChildSession(values) {
        const [childSession] = await tx.insert(sessions).values(values).returning({
          id: sessions.id,
        });
        if (!childSession) {
          throw new AgentDelegationError('Failed to create delegated child session');
        }
        return childSession;
      },
      async insertChildTask(values) {
        const [childTask] = await tx.insert(tasks).values(values).returning({ id: tasks.id });
        if (!childTask) {
          throw new AgentDelegationError('Failed to create delegated child task');
        }
        return childTask;
      },
      async updateChildTaskConstraints(taskId, constraints) {
        await tx.update(tasks).set({ constraints }).where(eq(tasks.id, taskId));
      },
      async markParentWaitingForDelegation(parentTaskId) {
        await tx
          .update(tasks)
          .set({ status: TaskStatus.WAITING_DELEGATION, updatedAt: new Date() })
          .where(and(eq(tasks.id, parentTaskId), eq(tasks.status, TaskStatus.RUNNING)));
      },
      createDelegation: (delegationInput) => createAgentDelegation(txDb, delegationInput),
      async upsertAdmissionLease(job) {
        await tx
          .insert(admissionLeases)
          .values({
            taskId: job.taskId,
            agentId: job.agentId,
            sessionId: job.sessionId,
            jobData: job,
            notBefore: new Date(),
          })
          .onConflictDoUpdate({
            target: admissionLeases.taskId,
            set: {
              agentId: job.agentId,
              sessionId: job.sessionId,
              jobData: job,
              notBefore: new Date(),
              updatedAt: new Date(),
            },
          });
      },
    });
  });
}
