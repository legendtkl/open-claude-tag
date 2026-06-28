import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { isObjectRecord, normalizeRuntimeHint } from '@open-tag/core-types';
import type { Database } from './db.js';
import {
  admissionLeases,
  agents,
  discussionParticipants,
  discussions,
  discussionTurns,
  tasks,
} from './schema.js';

export type DiscussionRecord = typeof discussions.$inferSelect;
export type DiscussionParticipantRecord = typeof discussionParticipants.$inferSelect;
export type DiscussionTurnRecord = typeof discussionTurns.$inferSelect;
type DiscussionTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export type DiscussionStatus = 'active' | 'completed' | 'cancelled' | 'failed';
export type DiscussionTurnStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface CreateDiscussionParticipantInput {
  id?: string;
  agentId: string;
  feishuAppId?: string | null;
  botOpenId?: string | null;
  displayName?: string | null;
  role?: string | null;
  orderIndex?: number;
}

export interface CreateDiscussionInput {
  id?: string;
  tenantKey?: string;
  chatId: string;
  rootThreadId: string;
  feishuAppId?: string | null;
  sessionId: string;
  topic: string;
  roundLimit?: number;
  participants: CreateDiscussionParticipantInput[];
}

export interface CreateDiscussionResult {
  discussion: DiscussionRecord;
  participants: DiscussionParticipantRecord[];
}

export interface AppendDiscussionTurnInput {
  id?: string;
  discussionId: string;
  participantId?: string | null;
  agentId?: string | null;
  taskId?: string | null;
  round: number;
  turnIndex: number;
  status?: DiscussionTurnStatus;
  content?: string | null;
  errorMessage?: string | null;
  metadata?: Record<string, unknown>;
  completedAt?: Date | null;
}

export interface DiscussionTranscriptTurn {
  id: string;
  discussionId: string;
  round: number;
  turnIndex: number;
  participantId: string | null;
  agentId: string | null;
  agentHandle: string | null;
  agentDisplayName: string | null;
  role: string | null;
  taskId: string | null;
  status: string;
  content: string | null;
  errorMessage: string | null;
  metadata: unknown;
  createdAt: Date;
  completedAt: Date | null;
}

export interface AdvanceDiscussionNextTurnInput {
  taskId: string;
  sessionId: string;
  agentId: string;
  feishuAppId?: string | null;
  taskType: string;
  goal: string;
  runtimeHint?: string | null;
  constraints: Record<string, unknown>;
}

export interface AdvanceDiscussionInput {
  nextTurn?: AdvanceDiscussionNextTurnInput;
}

export type DiscussionAdvanceResult =
  | { status: 'not_found'; discussionId: string }
  | { status: 'not_active'; discussionId: string; discussionStatus: string }
  | { status: 'waiting_for_turn'; discussionId: string; round: number; turnIndex: number }
  | {
      status: 'advanced';
      discussionId: string;
      round: number;
      turnIndex: number;
      participantId: string;
      agentId: string;
      role: string | null;
      taskId: string;
      version: number;
    }
  | { status: 'completed'; discussionId: string; version: number };

export interface CompleteDiscussionTurnAndAdvanceResult {
  turn: DiscussionTurnRecord;
  advance: DiscussionAdvanceResult;
}

export interface CompleteDiscussionTaskTurnInput {
  taskId: string;
  status: string;
  errorMessage?: string | null;
  result?: unknown;
  interactionReason?: string | null;
}

export interface CompleteDiscussionTaskTurnAndAdvanceResult
  extends CompleteDiscussionTurnAndAdvanceResult {
  task: typeof tasks.$inferSelect;
}

export type DiscussionTurnFeishuRenderKind = 'turn' | 'closing';

export interface MarkDiscussionTurnFeishuRenderedInput {
  turnId: string;
  kind: DiscussionTurnFeishuRenderKind;
  renderKey: string;
  messageId: string;
  renderedAt?: Date;
}

export interface SetDiscussionStatusByRootInput {
  tenantKey?: string;
  chatId: string;
  rootThreadId: string;
  status: DiscussionStatus;
}

const DISCUSSION_TRANSITIONS: Record<DiscussionStatus, DiscussionStatus[]> = {
  active: ['completed', 'cancelled', 'failed'],
  completed: [],
  cancelled: [],
  failed: [],
};

const TERMINAL_TURN_STATUSES: DiscussionTurnStatus[] = ['completed', 'failed', 'cancelled'];

function isTerminalTurnStatus(status: string): boolean {
  return TERMINAL_TURN_STATUSES.includes(status as DiscussionTurnStatus);
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function assertNonNegativeInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
}

function assertContiguousOrderIndexes(orderIndexes: Set<number>, count: number): void {
  for (let index = 0; index < count; index += 1) {
    if (!orderIndexes.has(index)) {
      throw new Error('Discussion participant order indexes must be contiguous starting at 0');
    }
  }
}

function nullableEquals(left: string | null | undefined, right: string | null | undefined): boolean {
  return (left ?? null) === (right ?? null);
}

export function canTransitionDiscussionStatus(
  from: DiscussionStatus,
  to: DiscussionStatus,
): boolean {
  return DISCUSSION_TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertDiscussionStatusTransition(
  from: DiscussionStatus,
  to: DiscussionStatus,
): void {
  if (!canTransitionDiscussionStatus(from, to)) {
    throw new Error(`Invalid discussion transition: ${from} -> ${to}`);
  }
}

export async function createDiscussion(
  db: Database,
  input: CreateDiscussionInput,
): Promise<CreateDiscussionResult> {
  if (input.participants.length < 1) {
    throw new Error('Discussion must have at least one participant');
  }
  const roundLimit = input.roundLimit ?? 3;
  assertPositiveInteger('Discussion round limit', roundLimit);

  return db.transaction(async (tx) => {
    const [discussion] = await tx
      .insert(discussions)
      .values({
        id: input.id,
        tenantKey: input.tenantKey ?? 'default',
        chatId: input.chatId,
        rootThreadId: input.rootThreadId,
        feishuAppId: input.feishuAppId,
        sessionId: input.sessionId,
        topic: input.topic,
        roundLimit,
      })
      .onConflictDoNothing({
        target: [discussions.tenantKey, discussions.chatId, discussions.rootThreadId],
      })
      .returning();

    if (!discussion) {
      const [existing] = await tx
        .select()
        .from(discussions)
        .where(
          and(
            eq(discussions.tenantKey, input.tenantKey ?? 'default'),
            eq(discussions.chatId, input.chatId),
            eq(discussions.rootThreadId, input.rootThreadId),
          ),
        )
        .limit(1);
      if (!existing) {
        throw new Error('Failed to create or resolve discussion');
      }
      return {
        discussion: existing,
        participants: await tx
          .select()
          .from(discussionParticipants)
          .where(eq(discussionParticipants.discussionId, existing.id))
          .orderBy(asc(discussionParticipants.orderIndex)),
      };
    }

    const participantValues = input.participants.map((participant, index) => ({
      id: participant.id,
      discussionId: discussion.id,
      agentId: participant.agentId,
      feishuAppId: participant.feishuAppId,
      botOpenId: participant.botOpenId,
      displayName: participant.displayName,
      role: participant.role,
      orderIndex: participant.orderIndex ?? index,
    }));

    const orderIndexes = new Set<number>();
    for (const participant of participantValues) {
      assertNonNegativeInteger('Discussion participant order index', participant.orderIndex);
      if (orderIndexes.has(participant.orderIndex)) {
        throw new Error(`Duplicate discussion participant order index: ${participant.orderIndex}`);
      }
      orderIndexes.add(participant.orderIndex);
    }
    assertContiguousOrderIndexes(orderIndexes, participantValues.length);

    const participants = await tx
      .insert(discussionParticipants)
      .values(participantValues)
      .returning();

    return { discussion, participants };
  });
}

export async function findDiscussionById(
  db: Database,
  discussionId: string,
): Promise<DiscussionRecord | null> {
  const [discussion] = await db
    .select()
    .from(discussions)
    .where(eq(discussions.id, discussionId))
    .limit(1);
  return discussion ?? null;
}

export async function listDiscussionParticipants(
  db: Database,
  discussionId: string,
): Promise<DiscussionParticipantRecord[]> {
  return db
    .select()
    .from(discussionParticipants)
    .where(eq(discussionParticipants.discussionId, discussionId))
    .orderBy(asc(discussionParticipants.orderIndex));
}

export async function appendDiscussionTurn(
  db: Database,
  input: AppendDiscussionTurnInput,
): Promise<DiscussionTurnRecord> {
  assertPositiveInteger('Discussion turn round', input.round);
  assertNonNegativeInteger('Discussion turn index', input.turnIndex);

  return db.transaction(async (tx) => appendDiscussionTurnInTransaction(tx, input));
}

async function appendDiscussionTurnInTransaction(
  tx: DiscussionTransaction,
  input: AppendDiscussionTurnInput,
): Promise<DiscussionTurnRecord> {
  assertPositiveInteger('Discussion turn round', input.round);
  assertNonNegativeInteger('Discussion turn index', input.turnIndex);

    const [participant] = await tx
      .select()
      .from(discussionParticipants)
      .where(
        and(
          eq(discussionParticipants.discussionId, input.discussionId),
          eq(discussionParticipants.orderIndex, input.turnIndex),
        ),
      )
      .limit(1);

    if (!participant) {
      throw new Error(
        `Discussion participant not found for turn ${input.discussionId}:${input.turnIndex}`,
      );
    }
    if (input.participantId && input.participantId !== participant.id) {
      throw new Error('Discussion turn participant does not match the turn index');
    }
    if (input.agentId && input.agentId !== participant.agentId) {
      throw new Error('Discussion turn agent does not match the participant');
    }

    if (input.taskId) {
      const [existingByTaskId] = await tx
        .select()
        .from(discussionTurns)
        .where(eq(discussionTurns.taskId, input.taskId))
        .limit(1);
      if (existingByTaskId) {
        if (existingByTaskId.discussionId !== input.discussionId) {
          throw new Error(`Discussion turn task id conflict: ${input.taskId}`);
        }
        if (isTerminalTurnStatus(existingByTaskId.status)) {
          return existingByTaskId;
        }

        const nextStatus = input.status ?? 'completed';
        const now = new Date();
        const [updated] = await tx
          .update(discussionTurns)
          .set({
            status: nextStatus,
            content: input.content,
            errorMessage: input.errorMessage,
            metadata: input.metadata ?? existingByTaskId.metadata ?? {},
            completedAt:
              input.completedAt === undefined
                ? nextStatus === 'queued' || nextStatus === 'running'
                  ? null
                  : now
                : input.completedAt,
          })
          .where(
            and(
              eq(discussionTurns.id, existingByTaskId.id),
              inArray(discussionTurns.status, ['queued', 'running']),
            ),
          )
          .returning();
        if (updated) {
          return updated;
        }

        const [latest] = await tx
          .select()
          .from(discussionTurns)
          .where(eq(discussionTurns.id, existingByTaskId.id))
          .limit(1);
        if (latest && isTerminalTurnStatus(latest.status)) {
          return latest;
        }
        if (!updated) {
          throw new Error(`Failed to update discussion turn for task ${input.taskId}`);
        }
      }
    }

    const now = new Date();
    const [inserted] = await tx
      .insert(discussionTurns)
      .values({
        id: input.id,
        discussionId: input.discussionId,
        participantId: participant.id,
        agentId: participant.agentId,
        taskId: input.taskId,
        round: input.round,
        turnIndex: input.turnIndex,
        status: input.status ?? 'completed',
        content: input.content,
        errorMessage: input.errorMessage,
        metadata: input.metadata ?? {},
        completedAt:
          input.completedAt === undefined
            ? input.status === 'queued' || input.status === 'running'
              ? null
              : now
            : input.completedAt,
      })
      .onConflictDoNothing()
      .returning();

    if (inserted) {
      return inserted;
    }

    const [existing] = await tx
      .select()
      .from(discussionTurns)
      .where(
        and(
          eq(discussionTurns.discussionId, input.discussionId),
          eq(discussionTurns.round, input.round),
          eq(discussionTurns.turnIndex, input.turnIndex),
        ),
      )
      .limit(1);

    if (!existing) {
      if (input.taskId) {
        const [existingByTaskId] = await tx
          .select()
          .from(discussionTurns)
          .where(eq(discussionTurns.taskId, input.taskId))
          .limit(1);
        if (existingByTaskId) {
          return existingByTaskId;
        }
      }
      throw new Error(`Failed to append discussion turn for discussion ${input.discussionId}`);
    }
    if (input.taskId && existing.taskId !== input.taskId) {
      throw new Error(`Discussion turn task id conflict: ${input.taskId}`);
    }
    if (!input.taskId && existing.taskId) {
      throw new Error(`Discussion turn task id is required for task-bound turn ${existing.taskId}`);
    }
    if (!isTerminalTurnStatus(existing.status)) {
      const nextStatus = input.status ?? 'completed';
      const now = new Date();
      const [updated] = await tx
        .update(discussionTurns)
        .set({
          status: nextStatus,
          content: input.content,
          errorMessage: input.errorMessage,
          metadata: input.metadata ?? existing.metadata ?? {},
          completedAt:
            input.completedAt === undefined
              ? nextStatus === 'queued' || nextStatus === 'running'
                ? null
                : now
              : input.completedAt,
        })
        .where(
          and(
            eq(discussionTurns.id, existing.id),
            inArray(discussionTurns.status, ['queued', 'running']),
          ),
        )
        .returning();
      if (updated) {
        return updated;
      }

      const [latest] = await tx
        .select()
        .from(discussionTurns)
        .where(eq(discussionTurns.id, existing.id))
        .limit(1);
      if (latest && isTerminalTurnStatus(latest.status)) {
        return latest;
      }
      if (!updated) {
        throw new Error(
          `Failed to update discussion turn for ${input.discussionId}:${input.round}:${input.turnIndex}`,
        );
      }
    }
    return existing;
}

export async function completeDiscussionTurnAndAdvance(
  db: Database,
  turnInput: AppendDiscussionTurnInput,
  advanceInput: AdvanceDiscussionInput = {},
): Promise<CompleteDiscussionTurnAndAdvanceResult> {
  return db.transaction(async (tx) => {
    const turn = await appendDiscussionTurnInTransaction(tx, turnInput);
    const advance = await advanceDiscussionInTransaction(tx, turnInput.discussionId, advanceInput);
    return { turn, advance };
  });
}

export async function completeDiscussionTaskTurnAndAdvance(
  db: Database,
  taskInput: CompleteDiscussionTaskTurnInput,
  turnInput: AppendDiscussionTurnInput,
  advanceInput: AdvanceDiscussionInput = {},
): Promise<CompleteDiscussionTaskTurnAndAdvanceResult> {
  return db.transaction(async (tx) => {
    const [task] = await tx
      .update(tasks)
      .set({
        status: taskInput.status,
        errorMessage: taskInput.errorMessage,
        result: taskInput.result,
        interactionReason: taskInput.interactionReason,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(tasks.id, taskInput.taskId),
          inArray(tasks.status, ['queued', 'running']),
        ),
      )
      .returning();
    if (!task) {
      const [existing] = await tx.select().from(tasks).where(eq(tasks.id, taskInput.taskId)).limit(1);
      if (!existing) {
        throw new Error(`Task not found: ${taskInput.taskId}`);
      }
      throw new Error(
        `Discussion task ${taskInput.taskId} is not retryable from status ${existing.status}`,
      );
    }

    const turn = await appendDiscussionTurnInTransaction(tx, turnInput);
    const advance = await advanceDiscussionInTransaction(tx, turnInput.discussionId, advanceInput);
    return { task, turn, advance };
  });
}

export async function loadDiscussionTranscript(
  db: Database,
  discussionId: string,
): Promise<DiscussionTranscriptTurn[]> {
  return db
    .select({
      id: discussionTurns.id,
      discussionId: discussionTurns.discussionId,
      round: discussionTurns.round,
      turnIndex: discussionTurns.turnIndex,
      participantId: discussionTurns.participantId,
      agentId: discussionTurns.agentId,
      agentHandle: agents.handle,
      agentDisplayName: agents.displayName,
      role: discussionParticipants.role,
      taskId: discussionTurns.taskId,
      status: discussionTurns.status,
      content: discussionTurns.content,
      errorMessage: discussionTurns.errorMessage,
      metadata: discussionTurns.metadata,
      createdAt: discussionTurns.createdAt,
      completedAt: discussionTurns.completedAt,
    })
    .from(discussionTurns)
    .leftJoin(discussionParticipants, eq(discussionParticipants.id, discussionTurns.participantId))
    .leftJoin(agents, eq(agents.id, discussionTurns.agentId))
    .where(eq(discussionTurns.discussionId, discussionId))
    .orderBy(
      asc(discussionTurns.round),
      asc(discussionTurns.turnIndex),
      asc(discussionTurns.createdAt),
    );
}

export async function markDiscussionTurnFeishuRendered(
  db: Database,
  input: MarkDiscussionTurnFeishuRenderedInput,
): Promise<DiscussionTurnRecord | null> {
  const metadataKey =
    input.kind === 'closing' ? 'feishuClosingRender' : 'feishuRender';
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select 1 from ${discussionTurns} where ${discussionTurns.id} = ${input.turnId} for update`,
    );

    const [current] = await tx
      .select()
      .from(discussionTurns)
      .where(eq(discussionTurns.id, input.turnId))
      .limit(1);
    if (!current) {
      return null;
    }

    const metadata = isObjectRecord(current.metadata) ? current.metadata : {};
    const existing = metadata[metadataKey];
    if (
      isObjectRecord(existing) &&
      existing.renderKey === input.renderKey &&
      typeof existing.messageId === 'string' &&
      existing.messageId.length > 0
    ) {
      return current;
    }

    const [updated] = await tx
      .update(discussionTurns)
      .set({
        metadata: {
          ...metadata,
          [metadataKey]: {
            renderKey: input.renderKey,
            messageId: input.messageId,
            renderedAt: (input.renderedAt ?? new Date()).toISOString(),
          },
        },
      })
      .where(eq(discussionTurns.id, input.turnId))
      .returning();
    return updated ?? current;
  });
}

export async function setDiscussionStatus(
  db: Database,
  discussionId: string,
  status: DiscussionStatus,
): Promise<DiscussionRecord | null> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select 1 from ${discussions} where ${discussions.id} = ${discussionId} for update`,
    );

    const [current] = await tx
      .select()
      .from(discussions)
      .where(eq(discussions.id, discussionId))
      .limit(1);
    if (!current) {
      return null;
    }

    if (current.status === status) {
      return current;
    }
    assertDiscussionStatusTransition(current.status as DiscussionStatus, status);

    const [updated] = await tx
      .update(discussions)
      .set({
        status,
        completedAt: status === 'active' ? null : new Date(),
        version: sql`${discussions.version} + 1`,
        updatedAt: new Date(),
      })
      .where(and(eq(discussions.id, discussionId), eq(discussions.version, current.version)))
      .returning();

    if (!updated) {
      throw new Error(`Failed to update discussion status for ${discussionId}`);
    }
    return updated;
  });
}

export async function setDiscussionStatusByRootThread(
  db: Database,
  input: SetDiscussionStatusByRootInput,
): Promise<DiscussionRecord | null> {
  const tenantKey = input.tenantKey ?? 'default';
  return db.transaction(async (tx) => {
    await tx.execute(sql`
      select 1 from ${discussions}
      where ${discussions.tenantKey} = ${tenantKey}
        and ${discussions.chatId} = ${input.chatId}
        and ${discussions.rootThreadId} = ${input.rootThreadId}
      for update
    `);

    const [current] = await tx
      .select()
      .from(discussions)
      .where(
        and(
          eq(discussions.tenantKey, tenantKey),
          eq(discussions.chatId, input.chatId),
          eq(discussions.rootThreadId, input.rootThreadId),
        ),
      )
      .limit(1);
    if (!current) {
      return null;
    }

    if (current.status === input.status) {
      return current;
    }
    assertDiscussionStatusTransition(current.status as DiscussionStatus, input.status);

    const [updated] = await tx
      .update(discussions)
      .set({
        status: input.status,
        completedAt: input.status === 'active' ? null : new Date(),
        version: sql`${discussions.version} + 1`,
        updatedAt: new Date(),
      })
      .where(and(eq(discussions.id, current.id), eq(discussions.version, current.version)))
      .returning();

    if (!updated) {
      throw new Error(`Failed to update discussion status for ${current.id}`);
    }
    return updated;
  });
}

export async function advanceDiscussion(
  db: Database,
  discussionId: string,
  input: AdvanceDiscussionInput = {},
): Promise<DiscussionAdvanceResult> {
  return db.transaction(async (tx) => advanceDiscussionInTransaction(tx, discussionId, input));
}

async function advanceDiscussionInTransaction(
  tx: DiscussionTransaction,
  discussionId: string,
  input: AdvanceDiscussionInput = {},
): Promise<DiscussionAdvanceResult> {
    await tx.execute(
      sql`select 1 from ${discussions} where ${discussions.id} = ${discussionId} for update`,
    );

    const [discussion] = await tx
      .select()
      .from(discussions)
      .where(eq(discussions.id, discussionId))
      .limit(1);
    if (!discussion) {
      return { status: 'not_found', discussionId };
    }
    if (discussion.status !== 'active') {
      return {
        status: 'not_active',
        discussionId,
        discussionStatus: discussion.status,
      };
    }

    const participants = await tx
      .select()
      .from(discussionParticipants)
      .where(eq(discussionParticipants.discussionId, discussionId))
      .orderBy(asc(discussionParticipants.orderIndex));
    if (participants.length === 0) {
      const [updated] = await tx
        .update(discussions)
        .set({
          status: 'completed',
          completedAt: new Date(),
          version: sql`${discussions.version} + 1`,
          updatedAt: new Date(),
        })
        .where(and(eq(discussions.id, discussionId), eq(discussions.version, discussion.version)))
        .returning({ version: discussions.version });
      return { status: 'completed', discussionId, version: updated?.version ?? discussion.version };
    }

    const [turn] = await tx
      .select({ id: discussionTurns.id })
      .from(discussionTurns)
      .where(
        and(
          eq(discussionTurns.discussionId, discussionId),
          eq(discussionTurns.round, discussion.currentRound),
          eq(discussionTurns.turnIndex, discussion.currentTurnIndex),
          inArray(discussionTurns.status, TERMINAL_TURN_STATUSES),
        ),
      )
      .limit(1);
    if (!turn) {
      return {
        status: 'waiting_for_turn',
        discussionId,
        round: discussion.currentRound,
        turnIndex: discussion.currentTurnIndex,
      };
    }

    let nextRound = discussion.currentRound;
    let nextTurnIndex = discussion.currentTurnIndex + 1;
    if (nextTurnIndex >= participants.length) {
      nextTurnIndex = 0;
      nextRound += 1;
    }

    if (nextRound > discussion.roundLimit) {
      const [updated] = await tx
        .update(discussions)
        .set({
          status: 'completed',
          completedAt: new Date(),
          version: sql`${discussions.version} + 1`,
          updatedAt: new Date(),
        })
        .where(and(eq(discussions.id, discussionId), eq(discussions.version, discussion.version)))
        .returning({ version: discussions.version });
      if (!updated) {
        throw new Error(`Failed to complete discussion ${discussionId}`);
      }
      return { status: 'completed', discussionId, version: updated.version };
    }

    const nextParticipant = participants.find(
      (participant) => participant.orderIndex === nextTurnIndex,
    );
    if (!nextParticipant) {
      throw new Error(
        `Discussion participant missing for next turn ${discussionId}:${nextTurnIndex}`,
      );
    }
    if (!input.nextTurn) {
      throw new Error('advanceDiscussion requires nextTurn task data before advancing');
    }
    if (input.nextTurn.sessionId !== discussion.sessionId) {
      throw new Error('Discussion next turn task session does not match the discussion session');
    }
    if (input.nextTurn.agentId !== nextParticipant.agentId) {
      throw new Error('Discussion next turn task agent does not match the next participant');
    }
    if (
      nextParticipant.feishuAppId &&
      input.nextTurn.feishuAppId !== nextParticipant.feishuAppId
    ) {
      throw new Error('Discussion next turn task Feishu app does not match the next participant');
    }
    if (
      input.nextTurn.feishuAppId !== undefined &&
      !nullableEquals(input.nextTurn.feishuAppId, nextParticipant.feishuAppId)
    ) {
      throw new Error('Discussion next turn task Feishu app does not match the next participant');
    }

    const nextTurnConstraints = {
      ...input.nextTurn.constraints,
      discussionId,
      discussionParticipantId: nextParticipant.id,
      discussionRound: nextRound,
      discussionTurnIndex: nextTurnIndex,
      discussionRole: nextParticipant.role,
    };

    const [nextTask] = await tx
      .insert(tasks)
      .values({
        id: input.nextTurn.taskId,
        sessionId: input.nextTurn.sessionId,
        agentId: input.nextTurn.agentId,
        feishuAppId: input.nextTurn.feishuAppId,
        taskType: input.nextTurn.taskType,
        goal: input.nextTurn.goal,
        runtimeHint: normalizeRuntimeHint(input.nextTurn.runtimeHint),
        status: 'queued',
        constraints: nextTurnConstraints,
      })
      .onConflictDoNothing({ target: tasks.id })
      .returning();

    const taskRow =
      nextTask ??
      (
        await tx
          .select()
          .from(tasks)
          .where(eq(tasks.id, input.nextTurn.taskId))
          .limit(1)
      )[0];
    if (!taskRow) {
      throw new Error(`Failed to create or resolve discussion next task ${input.nextTurn.taskId}`);
    }

    const existingConstraints = isObjectRecord(taskRow.constraints) ? taskRow.constraints : {};
    if (
      taskRow.sessionId !== input.nextTurn.sessionId ||
      taskRow.agentId !== input.nextTurn.agentId ||
      !nullableEquals(taskRow.feishuAppId, input.nextTurn.feishuAppId) ||
      taskRow.taskType !== input.nextTurn.taskType ||
      taskRow.status !== 'queued' ||
      existingConstraints.discussionId !== discussionId ||
      existingConstraints.discussionParticipantId !== nextParticipant.id ||
      existingConstraints.discussionRound !== nextRound ||
      existingConstraints.discussionTurnIndex !== nextTurnIndex
    ) {
      throw new Error(`Discussion next task id conflict: ${input.nextTurn.taskId}`);
    }

    const [nextTurn] = await tx
      .insert(discussionTurns)
      .values({
        discussionId,
        participantId: nextParticipant.id,
        agentId: nextParticipant.agentId,
        taskId: input.nextTurn.taskId,
        round: nextRound,
        turnIndex: nextTurnIndex,
        status: 'queued',
        metadata: {},
        completedAt: null,
      })
      .onConflictDoNothing({
        target: [discussionTurns.discussionId, discussionTurns.round, discussionTurns.turnIndex],
      })
      .returning();
    if (!nextTurn) {
      const [existingTurn] = await tx
        .select()
        .from(discussionTurns)
        .where(
          and(
            eq(discussionTurns.discussionId, discussionId),
            eq(discussionTurns.round, nextRound),
            eq(discussionTurns.turnIndex, nextTurnIndex),
          ),
        )
        .limit(1);
      if (
        !existingTurn ||
        existingTurn.taskId !== input.nextTurn.taskId ||
        existingTurn.participantId !== nextParticipant.id ||
        existingTurn.agentId !== nextParticipant.agentId ||
        existingTurn.status !== 'queued'
      ) {
        throw new Error(`Discussion next turn conflict: ${discussionId}:${nextRound}:${nextTurnIndex}`);
      }
    }

    const durableJobData = {
      taskId: input.nextTurn.taskId,
      sessionId: input.nextTurn.sessionId,
      agentId: input.nextTurn.agentId,
      feishuAppId: input.nextTurn.feishuAppId,
      taskType: input.nextTurn.taskType,
      goal: input.nextTurn.goal,
      runtimeHint: normalizeRuntimeHint(input.nextTurn.runtimeHint),
      constraints: nextTurnConstraints,
    };

    await tx
      .insert(admissionLeases)
      .values({
        taskId: input.nextTurn.taskId,
        agentId: input.nextTurn.agentId,
        sessionId: input.nextTurn.sessionId,
        jobData: durableJobData,
        notBefore: new Date(),
      })
      .onConflictDoUpdate({
        target: admissionLeases.taskId,
        set: {
          agentId: input.nextTurn.agentId,
          sessionId: input.nextTurn.sessionId,
          jobData: durableJobData,
          notBefore: new Date(),
          updatedAt: new Date(),
        },
      });

    const [updated] = await tx
      .update(discussions)
      .set({
        currentRound: nextRound,
        currentTurnIndex: nextTurnIndex,
        version: sql`${discussions.version} + 1`,
        updatedAt: new Date(),
      })
      .where(and(eq(discussions.id, discussionId), eq(discussions.version, discussion.version)))
      .returning({ version: discussions.version });
    if (!updated) {
      throw new Error(`Failed to advance discussion ${discussionId}`);
    }

    return {
      status: 'advanced',
      discussionId,
      round: nextRound,
      turnIndex: nextTurnIndex,
      participantId: nextParticipant.id,
      agentId: nextParticipant.agentId,
      role: nextParticipant.role,
      taskId: taskRow.id,
      version: updated.version,
    };
}
