import { TaskStatus, isObjectRecord as isRecord } from '@open-tag/core-types';
import { and, count, eq, sql } from 'drizzle-orm';
import type { Database } from './db.js';
import { admissionLeases, agentDelegations, delegationTrees, sessions, tasks } from './schema.js';

export type AgentDelegationRecord = typeof agentDelegations.$inferSelect;
export type DelegationTreeRecord = typeof delegationTrees.$inferSelect;
export type AgentDelegationStatus = 'pending' | 'running' | 'completed' | 'failed' | 'rejected';

export interface CreateAgentDelegationInput {
  id?: string;
  treeId?: string | null;
  parentDelegationId?: string | null;
  depth?: number;
  childSessionId?: string | null;
  parentTaskId: string;
  childTaskId?: string | null;
  callerAgentId: string;
  calleeAgentId: string;
  goal: string;
  inputSummary?: string | null;
  permissionScope?: Record<string, unknown>;
  status?: AgentDelegationStatus;
}

export interface ReserveDelegationBudgetInput {
  rootTaskId: string;
  parentTaskId: string;
  treeId?: string | null;
  totalBudget: number;
  fanoutBudget: number;
}

export interface ReserveDelegationBudgetResult {
  treeId: string;
  rootTaskId: string;
  tasksUsed: number;
  fanoutUsed: number;
}

export interface DelegationBarrierChildResult {
  delegationId: string;
  childTaskId: string | null;
  status: AgentDelegationStatus;
  result: unknown;
  errorMessage: string | null;
}

export interface ParentDelegationResume {
  taskId: string;
  sessionId: string;
  agentId: string | null;
  feishuAppId: string | null;
  taskType: string;
  goal: string;
  runtimeHint: string | null;
  constraints: Record<string, unknown>;
  sdkSessionId?: string;
  runtimeBackend?: string;
}

export type DelegationBarrierResult =
  | { status: 'not_delegated' }
  | { status: 'waiting'; treeId: string; parentTaskId: string; remaining: number }
  | { status: 'already_woken'; treeId: string; parentTaskId: string }
  | { status: 'woken'; treeId: string; parentTaskId: string; wake: ParentDelegationResume };

export interface ReadyDelegationBarrier {
  treeId: string;
  parentTaskId: string;
  childTaskId: string;
}

export interface TerminalChildDelegationReconciliationResult {
  inspected: number;
  reconciled: number;
}

const DELEGATION_TRANSITIONS: Record<AgentDelegationStatus, AgentDelegationStatus[]> = {
  pending: ['running', 'completed', 'failed', 'rejected'],
  running: ['completed', 'failed'],
  completed: [],
  failed: [],
  rejected: [],
};

const TERMINAL_DELEGATION_STATUSES = new Set<AgentDelegationStatus>([
  'completed',
  'failed',
  'rejected',
]);

function buildDelegationResumePackage(input: {
  treeId: string;
  parentTaskId: string;
  children: DelegationBarrierChildResult[];
}): Record<string, unknown> {
  return {
    treeId: input.treeId,
    parentTaskId: input.parentTaskId,
    completedAt: new Date().toISOString(),
    children: input.children.map((child) => ({
      delegationId: child.delegationId,
      childTaskId: child.childTaskId,
      status: child.status,
      result: child.result,
      errorMessage: child.errorMessage,
    })),
  };
}

function buildDelegationResumeGoal(originalGoal: string, resumePackage: Record<string, unknown>): string {
  return [
    'Resume the parent task after delegated child tasks finished.',
    'Use the delegation results below to synthesize the caller-facing answer or recover from child failures.',
    '',
    '<original_parent_goal>',
    originalGoal,
    '</original_parent_goal>',
    '',
    '<delegation_results>',
    JSON.stringify(resumePackage, null, 2),
    '</delegation_results>',
  ].join('\n');
}

export function canTransitionAgentDelegation(
  from: AgentDelegationStatus,
  to: AgentDelegationStatus,
): boolean {
  return DELEGATION_TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertAgentDelegationTransition(
  from: AgentDelegationStatus,
  to: AgentDelegationStatus,
): void {
  if (!canTransitionAgentDelegation(from, to)) {
    throw new Error(`Invalid agent delegation transition: ${from} -> ${to}`);
  }
}

export async function createAgentDelegation(
  db: Database,
  input: CreateAgentDelegationInput,
): Promise<AgentDelegationRecord> {
  const [record] = await db
    .insert(agentDelegations)
    .values({
      id: input.id,
      treeId: input.treeId,
      parentDelegationId: input.parentDelegationId,
      depth: input.depth,
      childSessionId: input.childSessionId,
      parentTaskId: input.parentTaskId,
      childTaskId: input.childTaskId,
      callerAgentId: input.callerAgentId,
      calleeAgentId: input.calleeAgentId,
      goal: input.goal,
      inputSummary: input.inputSummary,
      permissionScope: input.permissionScope ?? {},
      status: input.status ?? 'pending',
    })
    .returning();

  if (!record) {
    throw new Error('Failed to create agent delegation');
  }

  return record;
}

export async function reserveDelegationBudget(
  db: Database,
  input: ReserveDelegationBudgetInput,
): Promise<ReserveDelegationBudgetResult> {
  if (input.totalBudget < 1) {
    throw new Error('Delegation total budget must be at least 1');
  }
  if (input.fanoutBudget < 1) {
    throw new Error('Delegation fanout budget must be at least 1');
  }

  return db.transaction(async (tx) => {
    let treeId = input.treeId ?? null;

    if (!treeId) {
      const [inserted] = await tx
        .insert(delegationTrees)
        .values({
          rootTaskId: input.rootTaskId,
          totalBudget: input.totalBudget,
          fanoutBudget: input.fanoutBudget,
        })
        .onConflictDoNothing({ target: delegationTrees.rootTaskId })
        .returning({ id: delegationTrees.id });

      if (inserted) {
        treeId = inserted.id;
      } else {
        const [existing] = await tx
          .select({ id: delegationTrees.id })
          .from(delegationTrees)
          .where(eq(delegationTrees.rootTaskId, input.rootTaskId))
          .limit(1);
        treeId = existing?.id ?? null;
      }
    }

    if (!treeId) {
      throw new Error(`Failed to resolve delegation tree for task ${input.rootTaskId}`);
    }

    await tx.execute(
      sql`select 1 from ${delegationTrees} where ${delegationTrees.id} = ${treeId} for update`,
    );

    const [tree] = await tx
      .select()
      .from(delegationTrees)
      .where(eq(delegationTrees.id, treeId))
      .limit(1);

    if (!tree) {
      throw new Error(`Delegation tree not found: ${treeId}`);
    }

    const [fanoutRow] = await tx
      .select({ value: count() })
      .from(agentDelegations)
      .where(
        and(
          eq(agentDelegations.treeId, treeId),
          eq(agentDelegations.parentTaskId, input.parentTaskId),
        ),
      );
    const fanoutUsed = Number(fanoutRow?.value ?? 0);

    if (fanoutUsed >= tree.fanoutBudget) {
      throw new Error('Delegation fanout budget exceeded');
    }
    if (tree.tasksUsed >= tree.totalBudget) {
      throw new Error('Delegation total task budget exceeded');
    }

    const [updated] = await tx
      .update(delegationTrees)
      .set({
        tasksUsed: sql`${delegationTrees.tasksUsed} + 1`,
        version: sql`${delegationTrees.version} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(delegationTrees.id, treeId))
      .returning({
        id: delegationTrees.id,
        rootTaskId: delegationTrees.rootTaskId,
        tasksUsed: delegationTrees.tasksUsed,
      });

    if (!updated) {
      throw new Error(`Failed to reserve delegation budget for tree ${treeId}`);
    }

    return {
      treeId: updated.id,
      rootTaskId: updated.rootTaskId,
      tasksUsed: updated.tasksUsed,
      fanoutUsed: fanoutUsed + 1,
    };
  });
}

export async function findAgentDelegationByChildTask(
  db: Database,
  childTaskId: string,
): Promise<AgentDelegationRecord | null> {
  const [record] = await db
    .select()
    .from(agentDelegations)
    .where(eq(agentDelegations.childTaskId, childTaskId))
    .limit(1);

  return record ?? null;
}

export async function updateAgentDelegationStatus(
  db: Database,
  input: {
    delegationId: string;
    status: AgentDelegationStatus;
    result?: unknown;
    errorMessage?: string | null;
  },
): Promise<AgentDelegationRecord> {
  const [existing] = await db
    .select({ status: agentDelegations.status })
    .from(agentDelegations)
    .where(eq(agentDelegations.id, input.delegationId))
    .limit(1);

  if (!existing) {
    throw new Error(`Agent delegation not found: ${input.delegationId}`);
  }

  assertAgentDelegationTransition(existing.status as AgentDelegationStatus, input.status);

  const [updated] = await db
    .update(agentDelegations)
    .set({
      status: input.status,
      result: input.result,
      errorMessage: input.errorMessage,
      completedAt:
        input.status === 'completed' || input.status === 'failed' || input.status === 'rejected'
          ? new Date()
          : undefined,
      updatedAt: new Date(),
    })
    .where(eq(agentDelegations.id, input.delegationId))
    .returning();

  if (!updated) {
    throw new Error(`Failed to update agent delegation: ${input.delegationId}`);
  }

  return updated;
}

export async function completeAgentDelegationForChildTask(
  db: Database,
  childTaskId: string,
  result: unknown,
): Promise<AgentDelegationRecord | null> {
  const delegation = await findAgentDelegationByChildTask(db, childTaskId);
  if (!delegation) return null;

  return updateAgentDelegationStatus(db, {
    delegationId: delegation.id,
    status: 'completed',
    result,
  });
}

export async function failAgentDelegationForChildTask(
  db: Database,
  childTaskId: string,
  errorMessage: string,
): Promise<AgentDelegationRecord | null> {
  const delegation = await findAgentDelegationByChildTask(db, childTaskId);
  if (!delegation) return null;

  return updateAgentDelegationStatus(db, {
    delegationId: delegation.id,
    status: 'failed',
    errorMessage,
  });
}

export async function reconcileTerminalChildDelegationEdges(
  db: Database,
  input: { limit?: number } = {},
): Promise<TerminalChildDelegationReconciliationResult> {
  const rows = await db
    .select({
      delegationId: agentDelegations.id,
      childTaskId: agentDelegations.childTaskId,
      childStatus: tasks.status,
      result: tasks.result,
      errorMessage: tasks.errorMessage,
    })
    .from(agentDelegations)
    .innerJoin(tasks, eq(tasks.id, agentDelegations.childTaskId))
    .where(
      and(
        sql`${agentDelegations.treeId} is not null`,
        sql`${agentDelegations.childTaskId} is not null`,
        sql`${agentDelegations.status} in ('pending', 'running')`,
        sql`${tasks.status} in (${TaskStatus.COMPLETED}, ${TaskStatus.FAILED}, ${TaskStatus.CANCELLED})`,
      ),
    )
    .limit(input.limit ?? 25);

  let reconciled = 0;
  for (const row of rows) {
    const isCompleted = row.childStatus === TaskStatus.COMPLETED;
    const [updated] = await db
      .update(agentDelegations)
      .set({
        status: isCompleted ? 'completed' : 'failed',
        result: isCompleted ? row.result : undefined,
        errorMessage: isCompleted
          ? null
          : (row.errorMessage ?? `Child task ended with status ${row.childStatus}`),
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(agentDelegations.id, row.delegationId),
          sql`${agentDelegations.status} in ('pending', 'running')`,
        ),
      )
      .returning({ id: agentDelegations.id });

    if (updated) {
      reconciled += 1;
    }
  }

  return { inspected: rows.length, reconciled };
}

export async function listReadyDelegationBarriers(
  db: Database,
  input: { limit?: number } = {},
): Promise<ReadyDelegationBarrier[]> {
  const rows = await db
    .select({
      treeId: agentDelegations.treeId,
      parentTaskId: agentDelegations.parentTaskId,
      childTaskId: sql<string>`(array_agg(${agentDelegations.childTaskId}))[1]`,
    })
    .from(agentDelegations)
    .innerJoin(tasks, eq(tasks.id, agentDelegations.parentTaskId))
    .where(
      and(
        eq(tasks.status, TaskStatus.WAITING_DELEGATION),
        sql`${agentDelegations.treeId} is not null`,
        sql`${agentDelegations.childTaskId} is not null`,
      ),
    )
    .groupBy(agentDelegations.treeId, agentDelegations.parentTaskId)
    .having(
      sql`bool_and(${agentDelegations.status} in ('completed', 'failed', 'rejected'))`,
    )
    .limit(input.limit ?? 25);

  return rows.flatMap((row) =>
    row.treeId && row.childTaskId
      ? [
          {
            treeId: row.treeId,
            parentTaskId: row.parentTaskId,
            childTaskId: row.childTaskId,
          },
        ]
      : [],
  );
}

export async function evaluateDelegationBarrierForChildTask(
  db: Database,
  childTaskId: string,
): Promise<DelegationBarrierResult> {
  const delegation = await findAgentDelegationByChildTask(db, childTaskId);
  if (!delegation?.treeId) {
    return { status: 'not_delegated' };
  }
  const treeId = delegation.treeId;

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select 1 from ${delegationTrees} where ${delegationTrees.id} = ${treeId} for update`,
    );

    const [tree] = await tx
      .select()
      .from(delegationTrees)
      .where(eq(delegationTrees.id, treeId))
      .limit(1);

    if (!tree) {
      return { status: 'not_delegated' };
    }

    const [currentDelegation] = await tx
      .select()
      .from(agentDelegations)
      .where(eq(agentDelegations.id, delegation.id))
      .limit(1);

    if (!currentDelegation?.treeId) {
      return { status: 'not_delegated' };
    }

    const siblings = await tx
      .select({
        delegationId: agentDelegations.id,
        childTaskId: agentDelegations.childTaskId,
        status: agentDelegations.status,
        result: agentDelegations.result,
        errorMessage: agentDelegations.errorMessage,
      })
      .from(agentDelegations)
      .where(
        and(
          eq(agentDelegations.treeId, currentDelegation.treeId),
          eq(agentDelegations.parentTaskId, currentDelegation.parentTaskId),
        ),
      );

    const children = siblings.map((sibling) => ({
      delegationId: sibling.delegationId,
      childTaskId: sibling.childTaskId,
      status: sibling.status as AgentDelegationStatus,
      result: sibling.result,
      errorMessage: sibling.errorMessage,
    }));
    const pending = children.filter((child) => !TERMINAL_DELEGATION_STATUSES.has(child.status));
    if (pending.length > 0) {
      return {
        status: 'waiting',
        treeId: currentDelegation.treeId,
        parentTaskId: currentDelegation.parentTaskId,
        remaining: pending.length,
      };
    }

    if (currentDelegation.parentTaskId === tree.rootTaskId && tree.wokenAt) {
      return {
        status: 'already_woken',
        treeId: currentDelegation.treeId,
        parentTaskId: currentDelegation.parentTaskId,
      };
    }

    const [parent] = await tx
      .select({
        id: tasks.id,
        sessionId: tasks.sessionId,
        agentId: tasks.agentId,
        feishuAppId: tasks.feishuAppId,
        taskType: tasks.taskType,
        goal: tasks.goal,
        runtimeHint: tasks.runtimeHint,
        status: tasks.status,
        constraints: tasks.constraints,
      })
      .from(tasks)
      .where(eq(tasks.id, currentDelegation.parentTaskId))
      .limit(1);

    if (!parent || parent.status !== TaskStatus.WAITING_DELEGATION) {
      return {
        status: 'already_woken',
        treeId: currentDelegation.treeId,
        parentTaskId: currentDelegation.parentTaskId,
      };
    }

    const [session] = await tx
      .select({
        sdkSessionId: sessions.sdkSessionId,
        runtimeBackend: sessions.runtimeBackend,
      })
      .from(sessions)
      .where(eq(sessions.id, parent.sessionId))
      .limit(1);

    const resumePackage = buildDelegationResumePackage({
      treeId: currentDelegation.treeId,
      parentTaskId: currentDelegation.parentTaskId,
      children,
    });
    const parentConstraints = {
      ...(isRecord(parent.constraints) ? parent.constraints : {}),
      delegationResume: true,
      delegationResumePackage: resumePackage,
    };
    const resumeGoal = buildDelegationResumeGoal(parent.goal, resumePackage);
    const wake = {
      taskId: parent.id,
      sessionId: parent.sessionId,
      agentId: parent.agentId,
      feishuAppId: parent.feishuAppId,
      taskType: parent.taskType,
      goal: resumeGoal,
      runtimeHint: parent.runtimeHint,
      constraints: parentConstraints,
      ...(session?.sdkSessionId ? { sdkSessionId: session.sdkSessionId } : {}),
      ...(session?.runtimeBackend ? { runtimeBackend: session.runtimeBackend } : {}),
    };

    const [updatedParent] = await tx
      .update(tasks)
      .set({
        status: TaskStatus.QUEUED,
        constraints: parentConstraints,
        errorMessage: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(tasks.id, currentDelegation.parentTaskId),
          eq(tasks.status, TaskStatus.WAITING_DELEGATION),
        ),
      )
      .returning({ id: tasks.id });

    if (!updatedParent) {
      return {
        status: 'already_woken',
        treeId: currentDelegation.treeId,
        parentTaskId: currentDelegation.parentTaskId,
      };
    }

    await tx
      .update(delegationTrees)
      .set({
        resumeTaskId: currentDelegation.parentTaskId,
        wokenAt:
          currentDelegation.parentTaskId === tree.rootTaskId && !tree.wokenAt
            ? new Date()
            : tree.wokenAt,
        version: sql`${delegationTrees.version} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(delegationTrees.id, currentDelegation.treeId));

    await tx
      .insert(admissionLeases)
      .values({
        taskId: wake.taskId,
        agentId: wake.agentId,
        sessionId: wake.sessionId,
        jobData: wake,
        notBefore: new Date(),
      })
      .onConflictDoUpdate({
        target: admissionLeases.taskId,
        set: {
          agentId: wake.agentId,
          sessionId: wake.sessionId,
          jobData: wake,
          notBefore: new Date(),
          updatedAt: new Date(),
        },
      });

    return {
      status: 'woken',
      treeId: currentDelegation.treeId,
      parentTaskId: currentDelegation.parentTaskId,
      wake,
    };
  });
}
