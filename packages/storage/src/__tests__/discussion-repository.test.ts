import { randomUUID } from 'crypto';
import { eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  advanceDiscussion,
  appendDiscussionTurn,
  assertDiscussionStatusTransition,
  canTransitionDiscussionStatus,
  completeDiscussionTurnAndAdvance,
  completeDiscussionTaskTurnAndAdvance,
  createDiscussion,
  loadDiscussionTranscript,
  markDiscussionTurnFeishuRendered,
  setDiscussionStatusByRootThread,
  setDiscussionStatus,
} from '../discussion-repository.js';
import type { Database } from '../db.js';
import {
  agentProfiles,
  agents,
  admissionLeases,
  discussionParticipants,
  discussions,
  discussionTurns,
  feishuApps,
  sessions,
  tasks,
} from '../schema.js';
import * as schema from '../schema.js';

describe('discussion repository state machine', () => {
  it('allows active discussions to terminate', () => {
    expect(canTransitionDiscussionStatus('active', 'completed')).toBe(true);
    expect(canTransitionDiscussionStatus('active', 'cancelled')).toBe(true);
    expect(canTransitionDiscussionStatus('active', 'failed')).toBe(true);
  });

  it('rejects terminal status transitions', () => {
    expect(canTransitionDiscussionStatus('completed', 'active')).toBe(false);
    expect(() => assertDiscussionStatusTransition('completed', 'active')).toThrow(
      'Invalid discussion transition: completed -> active',
    );
  });
});

const describePg =
  process.env.OPEN_TAG_STORAGE_PG_INTEGRATION === '1' ? describe : describe.skip;

interface DiscussionFixture {
  profileId: string;
  agentIds: string[];
  feishuAppIds: string[];
  sessionId: string;
  discussionId: string;
}

describePg('discussion repository integration', () => {
  let client: postgres.Sql;
  let db: Database;
  const fixtures: DiscussionFixture[] = [];

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
      await db.delete(discussionTurns).where(eq(discussionTurns.discussionId, fixture.discussionId));
      await db
        .delete(discussionParticipants)
        .where(eq(discussionParticipants.discussionId, fixture.discussionId));
      await db.delete(discussions).where(eq(discussions.id, fixture.discussionId));
      await db.delete(admissionLeases).where(eq(admissionLeases.sessionId, fixture.sessionId));
      await db.delete(tasks).where(eq(tasks.sessionId, fixture.sessionId));
      await db.delete(sessions).where(eq(sessions.id, fixture.sessionId));
      await db.delete(agents).where(inArray(agents.id, fixture.agentIds));
      if (fixture.feishuAppIds.length > 0) {
        await db.delete(feishuApps).where(inArray(feishuApps.id, fixture.feishuAppIds));
      }
      await db.delete(agentProfiles).where(eq(agentProfiles.id, fixture.profileId));
    }
  });

  afterAll(async () => {
    await client.end({ timeout: 5 });
  });

  it('loads transcript turns in round and turn order', async () => {
    const fixture = await createDiscussionFixture({ roundLimit: 2 });

    await appendDiscussionTurn(db, {
      discussionId: fixture.discussionId,
      round: 1,
      turnIndex: 1,
      content: 'second speaker',
    });
    await appendDiscussionTurn(db, {
      discussionId: fixture.discussionId,
      round: 1,
      turnIndex: 0,
      content: 'first speaker',
    });

    const transcript = await loadDiscussionTranscript(db, fixture.discussionId);

    expect(transcript.map((turn) => turn.content)).toEqual(['first speaker', 'second speaker']);
    expect(transcript.map((turn) => [turn.round, turn.turnIndex])).toEqual([
      [1, 0],
      [1, 1],
    ]);
    expect(transcript.map((turn) => turn.role)).toEqual(['affirmative', 'negative']);
  });

  it('marks turn Feishu render metadata idempotently', async () => {
    const fixture = await createDiscussionFixture({ roundLimit: 2 });
    const turn = await appendDiscussionTurn(db, {
      discussionId: fixture.discussionId,
      round: 1,
      turnIndex: 0,
      content: 'rendered opening',
    });

    const marked = await markDiscussionTurnFeishuRendered(db, {
      turnId: turn.id,
      kind: 'turn',
      renderKey: 'render-key-1',
      messageId: 'om_render_1',
      renderedAt: new Date('2026-01-01T00:00:00Z'),
    });
    expect(marked?.metadata).toMatchObject({
      feishuRender: {
        renderKey: 'render-key-1',
        messageId: 'om_render_1',
        renderedAt: '2026-01-01T00:00:00.000Z',
      },
    });

    const duplicate = await markDiscussionTurnFeishuRendered(db, {
      turnId: turn.id,
      kind: 'turn',
      renderKey: 'render-key-1',
      messageId: 'om_render_duplicate',
    });
    expect(duplicate?.metadata).toMatchObject({
      feishuRender: {
        renderKey: 'render-key-1',
        messageId: 'om_render_1',
      },
    });
  });

  it('resolves duplicate discussion creation by session id', async () => {
    const fixture = await createDiscussionFixture({ roundLimit: 2 });

    const duplicate = await createDiscussion(db, {
      chatId: `chat_${fixture.sessionId}`,
      rootThreadId: `om_${fixture.sessionId.slice(0, 16)}`,
      sessionId: fixture.sessionId,
      topic: 'Duplicate delivery should converge',
      roundLimit: 2,
      participants: [
        { agentId: fixture.agentIds[0], role: 'ignored-a' },
        { agentId: fixture.agentIds[1], role: 'ignored-b' },
      ],
    });

    expect(duplicate.discussion.id).toBe(fixture.discussionId);
    expect(duplicate.discussion.topic).toBe('Should AI coding be introduced in production?');
    expect(duplicate.participants.map((participant) => participant.role)).toEqual([
      'affirmative',
      'negative',
    ]);
    expect(duplicate.participants.map((participant) => participant.displayName)).toEqual([
      'Agent A',
      'Agent B',
    ]);
  });

  it('advances exactly once under concurrent completion calls', async () => {
    const fixture = await createDiscussionFixture({ roundLimit: 2 });
    await appendDiscussionTurn(db, {
      discussionId: fixture.discussionId,
      round: 1,
      turnIndex: 0,
      content: 'opening',
    });

    const results = await Promise.all([
      advanceDiscussion(db, fixture.discussionId, {
        nextTurn: buildNextTurnTask(fixture, { turnIndex: 1 }),
      }),
      advanceDiscussion(db, fixture.discussionId, {
        nextTurn: buildNextTurnTask(fixture, { turnIndex: 1 }),
      }),
    ]);

    expect(results.filter((result) => result.status === 'advanced')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'waiting_for_turn')).toHaveLength(1);
    expect(results.find((result) => result.status === 'advanced')).toMatchObject({
      status: 'advanced',
      round: 1,
      turnIndex: 1,
      agentId: fixture.agentIds[1],
      role: 'negative',
      taskId: stableTestTaskId(fixture.discussionId, 1, 1),
      version: 1,
    });

    const [discussion] = await db
      .select({
        currentRound: discussions.currentRound,
        currentTurnIndex: discussions.currentTurnIndex,
        status: discussions.status,
        version: discussions.version,
      })
      .from(discussions)
      .where(eq(discussions.id, fixture.discussionId))
      .limit(1);
    expect(discussion).toEqual({
      currentRound: 1,
      currentTurnIndex: 1,
      status: 'active',
      version: 1,
    });
    const [lease] = await db
      .select()
      .from(admissionLeases)
      .where(eq(admissionLeases.taskId, stableTestTaskId(fixture.discussionId, 1, 1)))
      .limit(1);
    expect(lease).toMatchObject({
      taskId: stableTestTaskId(fixture.discussionId, 1, 1),
      sessionId: fixture.sessionId,
      agentId: fixture.agentIds[1],
      jobData: expect.objectContaining({
        taskId: stableTestTaskId(fixture.discussionId, 1, 1),
        sessionId: fixture.sessionId,
        agentId: fixture.agentIds[1],
      }),
    });
    const [queuedTurn] = await db
      .select()
      .from(discussionTurns)
      .where(eq(discussionTurns.taskId, stableTestTaskId(fixture.discussionId, 1, 1)))
      .limit(1);
    expect(queuedTurn).toMatchObject({
      discussionId: fixture.discussionId,
      agentId: fixture.agentIds[1],
      round: 1,
      turnIndex: 1,
      status: 'queued',
      completedAt: null,
    });

    const completedTurn = await appendDiscussionTurn(db, {
      discussionId: fixture.discussionId,
      taskId: stableTestTaskId(fixture.discussionId, 1, 1),
      round: 1,
      turnIndex: 1,
      content: 'second speaker completed',
    });
    expect(completedTurn.id).toBe(queuedTurn.id);
    expect(completedTurn).toMatchObject({
      status: 'completed',
      content: 'second speaker completed',
    });
  });

  it('marks a discussion completed after the round budget is exhausted', async () => {
    const fixture = await createDiscussionFixture({ roundLimit: 1 });
    await appendDiscussionTurn(db, {
      discussionId: fixture.discussionId,
      round: 1,
      turnIndex: 0,
      content: 'opening',
    });
    expect(
      await advanceDiscussion(db, fixture.discussionId, {
        nextTurn: buildNextTurnTask(fixture, { turnIndex: 1 }),
      }),
    ).toMatchObject({
      status: 'advanced',
      round: 1,
      turnIndex: 1,
    });

    await appendDiscussionTurn(db, {
      discussionId: fixture.discussionId,
      taskId: stableTestTaskId(fixture.discussionId, 1, 1),
      round: 1,
      turnIndex: 1,
      content: 'response',
    });
    const result = await advanceDiscussion(db, fixture.discussionId);

    expect(result).toMatchObject({ status: 'completed', version: 2 });
    const [discussion] = await db
      .select({
        status: discussions.status,
        completedAt: discussions.completedAt,
        currentRound: discussions.currentRound,
        currentTurnIndex: discussions.currentTurnIndex,
      })
      .from(discussions)
      .where(eq(discussions.id, fixture.discussionId))
      .limit(1);
    expect(discussion?.status).toBe('completed');
    expect(discussion?.completedAt).toBeInstanceOf(Date);
    expect(discussion?.currentRound).toBe(1);
    expect(discussion?.currentTurnIndex).toBe(1);
  });

  it('reuses an existing turn when a task completion is replayed with the same task id', async () => {
    const fixture = await createDiscussionFixture({ roundLimit: 2 });
    const taskId = stableTestTaskId(fixture.discussionId, 1, 0);

    await db.insert(tasks).values({
      id: taskId,
      sessionId: fixture.sessionId,
      agentId: fixture.agentIds[0],
      taskType: 'chat_reply',
      goal: 'turn completion replay source',
      status: 'completed',
      constraints: {},
    });

    const first = await appendDiscussionTurn(db, {
      discussionId: fixture.discussionId,
      taskId,
      round: 1,
      turnIndex: 0,
      content: 'original completion',
    });
    const replay = await appendDiscussionTurn(db, {
      discussionId: fixture.discussionId,
      taskId,
      round: 1,
      turnIndex: 1,
      content: 'stale wrong-position replay',
    });

    expect(replay.id).toBe(first.id);
    const transcript = await loadDiscussionTranscript(db, fixture.discussionId);
    expect(transcript).toHaveLength(1);
    expect(transcript[0]).toMatchObject({
      taskId,
      round: 1,
      turnIndex: 0,
      content: 'original completion',
    });
  });

  it('updates a queued task-bound turn exactly once under duplicate completion replay', async () => {
    const fixture = await createDiscussionFixture({ roundLimit: 2 });
    await appendDiscussionTurn(db, {
      discussionId: fixture.discussionId,
      round: 1,
      turnIndex: 0,
      content: 'opening',
    });
    const nextTurn = buildNextTurnTask(fixture, { turnIndex: 1 });
    await advanceDiscussion(db, fixture.discussionId, { nextTurn });

    const [first, second] = await Promise.all([
      appendDiscussionTurn(db, {
        discussionId: fixture.discussionId,
        taskId: nextTurn.taskId,
        round: 1,
        turnIndex: 1,
        status: 'completed',
        content: 'first completion wins',
      }),
      appendDiscussionTurn(db, {
        discussionId: fixture.discussionId,
        taskId: nextTurn.taskId,
        round: 1,
        turnIndex: 1,
        status: 'failed',
        content: 'second completion must not overwrite',
        errorMessage: 'duplicate failed replay',
      }),
    ]);

    expect(first.id).toBe(second.id);
    expect(new Set([first.status, second.status])).toHaveLength(1);
    expect(new Set([first.content, second.content])).toHaveLength(1);

    const transcript = await loadDiscussionTranscript(db, fixture.discussionId);
    const completedTurn = transcript.find((turn) => turn.taskId === nextTurn.taskId);
    expect(completedTurn).toMatchObject({
      id: first.id,
      status: first.status,
      content: first.content,
    });
    expect(['first completion wins', 'second completion must not overwrite']).toContain(
      completedTurn?.content,
    );
  });

  it('completes a task-bound turn and advances to the next turn in one repository call', async () => {
    const fixture = await createDiscussionFixture({ roundLimit: 2 });
    const firstTaskId = stableTestTaskId(fixture.discussionId, 1, 0);
    await db.insert(tasks).values({
      id: firstTaskId,
      sessionId: fixture.sessionId,
      agentId: fixture.agentIds[0],
      taskType: 'chat_reply',
      goal: 'first discussion turn',
      status: 'queued',
      constraints: {
        discussionId: fixture.discussionId,
        discussionRound: 1,
        discussionTurnIndex: 0,
      },
    });
    const queuedTurn = await appendDiscussionTurn(db, {
      discussionId: fixture.discussionId,
      taskId: firstTaskId,
      round: 1,
      turnIndex: 0,
      status: 'queued',
      completedAt: null,
    });

    const nextTurn = buildNextTurnTask(fixture, { turnIndex: 1 });
    const result = await completeDiscussionTurnAndAdvance(
      db,
      {
        discussionId: fixture.discussionId,
        taskId: firstTaskId,
        round: 1,
        turnIndex: 0,
        status: 'completed',
        content: 'atomic opening',
      },
      { nextTurn },
    );

    expect(result.turn.id).toBe(queuedTurn.id);
    expect(result.turn).toMatchObject({
      taskId: firstTaskId,
      status: 'completed',
      content: 'atomic opening',
    });
    expect(result.advance).toMatchObject({
      status: 'advanced',
      round: 1,
      turnIndex: 1,
      taskId: nextTurn.taskId,
    });

    const transcript = await loadDiscussionTranscript(db, fixture.discussionId);
    expect(transcript.map((turn) => [turn.taskId, turn.status, turn.content])).toEqual([
      [firstTaskId, 'completed', 'atomic opening'],
      [nextTurn.taskId, 'queued', null],
    ]);
    const [lease] = await db
      .select()
      .from(admissionLeases)
      .where(eq(admissionLeases.taskId, nextTurn.taskId))
      .limit(1);
    expect(lease?.jobData).toMatchObject({
      taskId: nextTurn.taskId,
      sessionId: fixture.sessionId,
      agentId: fixture.agentIds[1],
    });
  });

  it('rolls back terminal task update when discussion append-and-advance fails', async () => {
    const fixture = await createDiscussionFixture({ roundLimit: 2 });
    const firstTaskId = stableTestTaskId(fixture.discussionId, 1, 0);
    await db.insert(tasks).values({
      id: firstTaskId,
      sessionId: fixture.sessionId,
      agentId: fixture.agentIds[0],
      taskType: 'chat_reply',
      goal: 'first discussion turn',
      status: 'running',
      constraints: {
        discussionId: fixture.discussionId,
        discussionRound: 1,
        discussionTurnIndex: 0,
      },
    });
    await appendDiscussionTurn(db, {
      discussionId: fixture.discussionId,
      taskId: firstTaskId,
      round: 1,
      turnIndex: 0,
      status: 'queued',
      completedAt: null,
    });
    const conflictingNextTurn = buildNextTurnTask(fixture, { turnIndex: 1 });
    await db.insert(tasks).values({
      id: conflictingNextTurn.taskId,
      sessionId: fixture.sessionId,
      agentId: fixture.agentIds[0],
      taskType: 'chat_reply',
      goal: 'conflicting task',
      status: 'queued',
      constraints: {
        discussionId: fixture.discussionId,
        discussionRound: 99,
        discussionTurnIndex: 99,
      },
    });

    await expect(
      completeDiscussionTaskTurnAndAdvance(
        db,
        {
          taskId: firstTaskId,
          status: 'completed',
          result: { output: { text: 'atomic opening' } },
        },
        {
          discussionId: fixture.discussionId,
          taskId: firstTaskId,
          round: 1,
          turnIndex: 0,
          status: 'completed',
          content: 'atomic opening',
        },
        { nextTurn: conflictingNextTurn },
      ),
    ).rejects.toThrow(`Discussion next task id conflict: ${conflictingNextTurn.taskId}`);

    const [task] = await db
      .select({ status: tasks.status, result: tasks.result })
      .from(tasks)
      .where(eq(tasks.id, firstTaskId))
      .limit(1);
    expect(task).toEqual({ status: 'running', result: null });
    const [turn] = await db
      .select({ status: discussionTurns.status, content: discussionTurns.content })
      .from(discussionTurns)
      .where(eq(discussionTurns.taskId, firstTaskId))
      .limit(1);
    expect(turn).toEqual({ status: 'queued', content: null });
  });

  it('rejects position-only completion for a task-bound queued turn', async () => {
    const fixture = await createDiscussionFixture({ roundLimit: 2 });
    await appendDiscussionTurn(db, {
      discussionId: fixture.discussionId,
      round: 1,
      turnIndex: 0,
      content: 'opening',
    });
    const nextTurn = buildNextTurnTask(fixture, { turnIndex: 1 });
    await advanceDiscussion(db, fixture.discussionId, { nextTurn });

    await expect(
      appendDiscussionTurn(db, {
        discussionId: fixture.discussionId,
        round: 1,
        turnIndex: 1,
        content: 'position-only should not complete a task turn',
      }),
    ).rejects.toThrow(`Discussion turn task id is required for task-bound turn ${nextTurn.taskId}`);
  });

  it('rejects conflicting next task ids without advancing pointer or writing a lease', async () => {
    const fixture = await createDiscussionFixture({ roundLimit: 2 });
    await appendDiscussionTurn(db, {
      discussionId: fixture.discussionId,
      round: 1,
      turnIndex: 0,
      content: 'opening',
    });
    const nextTurn = buildNextTurnTask(fixture, { turnIndex: 1 });
    await db.insert(tasks).values({
      id: nextTurn.taskId,
      sessionId: fixture.sessionId,
      agentId: fixture.agentIds[0],
      taskType: 'chat_reply',
      goal: 'conflicting task',
      status: 'queued',
      constraints: {
        discussionId: fixture.discussionId,
        discussionRound: 99,
        discussionTurnIndex: 99,
      },
    });

    await expect(advanceDiscussion(db, fixture.discussionId, { nextTurn })).rejects.toThrow(
      `Discussion next task id conflict: ${nextTurn.taskId}`,
    );

    const [discussion] = await db
      .select({
        currentRound: discussions.currentRound,
        currentTurnIndex: discussions.currentTurnIndex,
        version: discussions.version,
      })
      .from(discussions)
      .where(eq(discussions.id, fixture.discussionId))
      .limit(1);
    expect(discussion).toEqual({ currentRound: 1, currentTurnIndex: 0, version: 0 });
    const [lease] = await db
      .select()
      .from(admissionLeases)
      .where(eq(admissionLeases.taskId, nextTurn.taskId))
      .limit(1);
    expect(lease).toBeUndefined();
    const [turn] = await db
      .select()
      .from(discussionTurns)
      .where(eq(discussionTurns.taskId, nextTurn.taskId))
      .limit(1);
    expect(turn).toBeUndefined();
  });

  it('requires next turn Feishu app identity when the participant snapshot has one', async () => {
    const fixture = await createDiscussionFixture({ roundLimit: 2, withFeishuApps: true });
    await appendDiscussionTurn(db, {
      discussionId: fixture.discussionId,
      round: 1,
      turnIndex: 0,
      content: 'opening',
    });

    await expect(
      advanceDiscussion(db, fixture.discussionId, {
        nextTurn: buildNextTurnTask(fixture, { turnIndex: 1, omitFeishuAppId: true }),
      }),
    ).rejects.toThrow('Discussion next turn task Feishu app does not match the next participant');
  });

  it('rejects non-contiguous participant order indexes', async () => {
    const fixture = await createDiscussionFixture({ roundLimit: 2 });
    const sessionId = randomUUID();
    await db.insert(sessions).values({
      id: sessionId,
      sessionKey: `test:discussion:bad-order:${sessionId}`,
      chatId: `chat_${sessionId}`,
      scope: 'discussion',
      status: 'active',
    });
    fixtures.push({
      profileId: fixture.profileId,
      agentIds: [],
      feishuAppIds: [],
      sessionId,
      discussionId: randomUUID(),
    });

    await expect(
      createDiscussion(db, {
        chatId: `chat_${sessionId}`,
        rootThreadId: `om_bad_order_${sessionId.slice(0, 8)}`,
        sessionId,
        topic: 'Bad order',
        participants: [
          { agentId: fixture.agentIds[0], orderIndex: 0 },
          { agentId: fixture.agentIds[1], orderIndex: 2 },
        ],
      }),
    ).rejects.toThrow('Discussion participant order indexes must be contiguous starting at 0');
  });

  it('applies valid status transitions and rejects terminal reactivation', async () => {
    const fixture = await createDiscussionFixture({ roundLimit: 2 });

    const cancelled = await setDiscussionStatus(db, fixture.discussionId, 'cancelled');
    expect(cancelled?.status).toBe('cancelled');
    expect(cancelled?.completedAt).toBeInstanceOf(Date);

    await expect(setDiscussionStatus(db, fixture.discussionId, 'active')).rejects.toThrow(
      'Invalid discussion transition: cancelled -> active',
    );
  });

  it('cancels a discussion by root thread with a version bump', async () => {
    const fixture = await createDiscussionFixture({ roundLimit: 2 });
    const [before] = await db
      .select({
        chatId: discussions.chatId,
        rootThreadId: discussions.rootThreadId,
        version: discussions.version,
      })
      .from(discussions)
      .where(eq(discussions.id, fixture.discussionId))
      .limit(1);

    const cancelled = await setDiscussionStatusByRootThread(db, {
      chatId: before.chatId,
      rootThreadId: before.rootThreadId,
      status: 'cancelled',
    });

    expect(cancelled).toMatchObject({
      id: fixture.discussionId,
      status: 'cancelled',
      version: before.version + 1,
    });
    expect(cancelled?.completedAt).toBeInstanceOf(Date);
  });

  it('does not advance or enqueue another turn after a human-cancelled discussion', async () => {
    const fixture = await createDiscussionFixture({ roundLimit: 2 });
    await appendDiscussionTurn(db, {
      discussionId: fixture.discussionId,
      round: 1,
      turnIndex: 0,
      status: 'completed',
      content: 'opening after cancel',
    });
    await setDiscussionStatus(db, fixture.discussionId, 'cancelled');

    const result = await advanceDiscussion(db, fixture.discussionId, {
      nextTurn: buildNextTurnTask(fixture, { turnIndex: 1 }),
    });

    expect(result).toMatchObject({
      status: 'not_active',
      discussionStatus: 'cancelled',
    });
    const [lease] = await db
      .select()
      .from(admissionLeases)
      .where(eq(admissionLeases.taskId, stableTestTaskId(fixture.discussionId, 1, 1)))
      .limit(1);
    expect(lease).toBeUndefined();
  });

  it('serializes human cancellation against concurrent turn advance', async () => {
    const fixture = await createDiscussionFixture({ roundLimit: 2 });
    await appendDiscussionTurn(db, {
      discussionId: fixture.discussionId,
      round: 1,
      turnIndex: 0,
      status: 'completed',
      content: 'opening ready to advance',
    });
    const [root] = await db
      .select({
        chatId: discussions.chatId,
        rootThreadId: discussions.rootThreadId,
      })
      .from(discussions)
      .where(eq(discussions.id, fixture.discussionId))
      .limit(1);
    const nextTurn = buildNextTurnTask(fixture, { turnIndex: 1 });

    const [cancelResult, advanceResult] = await Promise.all([
      setDiscussionStatusByRootThread(db, {
        chatId: root.chatId,
        rootThreadId: root.rootThreadId,
        status: 'cancelled',
      }),
      advanceDiscussion(db, fixture.discussionId, { nextTurn }),
    ]);

    expect(cancelResult).toMatchObject({
      id: fixture.discussionId,
      status: 'cancelled',
    });
    const advanced = advanceResult.status === 'advanced';
    expect([advanceResult].filter((result) => result.status === 'advanced')).toHaveLength(
      advanced ? 1 : 0,
    );
    if (advanced) {
      expect(advanceResult).toMatchObject({
        status: 'advanced',
        round: 1,
        turnIndex: 1,
        taskId: nextTurn.taskId,
      });
    } else {
      expect(advanceResult).toMatchObject({
        status: 'not_active',
        discussionStatus: 'cancelled',
      });
    }

    const [finalDiscussion] = await db
      .select({
        currentRound: discussions.currentRound,
        currentTurnIndex: discussions.currentTurnIndex,
        status: discussions.status,
      })
      .from(discussions)
      .where(eq(discussions.id, fixture.discussionId))
      .limit(1);
    expect(finalDiscussion).toEqual({
      currentRound: 1,
      currentTurnIndex: advanced ? 1 : 0,
      status: 'cancelled',
    });

    const nextTasks = await db.select().from(tasks).where(eq(tasks.id, nextTurn.taskId));
    const nextTurns = await db
      .select()
      .from(discussionTurns)
      .where(eq(discussionTurns.taskId, nextTurn.taskId));
    const nextLeases = await db
      .select()
      .from(admissionLeases)
      .where(eq(admissionLeases.taskId, nextTurn.taskId));
    expect(nextTasks).toHaveLength(advanced ? 1 : 0);
    expect(nextTurns).toHaveLength(advanced ? 1 : 0);
    expect(nextLeases).toHaveLength(advanced ? 1 : 0);
    if (advanced) {
      expect(nextTasks[0]).toMatchObject({
        id: nextTurn.taskId,
        sessionId: fixture.sessionId,
        agentId: fixture.agentIds[1],
        status: 'queued',
      });
      expect(nextTurns[0]).toMatchObject({
        discussionId: fixture.discussionId,
        taskId: nextTurn.taskId,
        round: 1,
        turnIndex: 1,
        status: 'queued',
      });
      expect(nextLeases[0]).toMatchObject({
        taskId: nextTurn.taskId,
        sessionId: fixture.sessionId,
        agentId: fixture.agentIds[1],
      });
    }

    const lateAdvance = await advanceDiscussion(db, fixture.discussionId, { nextTurn });
    expect(lateAdvance).toMatchObject({
      status: 'not_active',
      discussionStatus: 'cancelled',
    });
    expect(await db.select().from(tasks).where(eq(tasks.id, nextTurn.taskId))).toHaveLength(
      advanced ? 1 : 0,
    );
    expect(
      await db.select().from(discussionTurns).where(eq(discussionTurns.taskId, nextTurn.taskId)),
    ).toHaveLength(advanced ? 1 : 0);
    expect(
      await db.select().from(admissionLeases).where(eq(admissionLeases.taskId, nextTurn.taskId)),
    ).toHaveLength(advanced ? 1 : 0);
  });

  async function createDiscussionFixture(input: {
    roundLimit: number;
    withFeishuApps?: boolean;
  }): Promise<DiscussionFixture> {
    const profileId = randomUUID();
    const sessionId = randomUUID();
    const agentIds = [randomUUID(), randomUUID()];
    const feishuAppIds = input.withFeishuApps ? [randomUUID(), randomUUID()] : [];

    await db.insert(agentProfiles).values({
      id: profileId,
      name: `discussion-profile-${profileId}`,
      displayName: 'Discussion Test Profile',
    });
    await db.insert(agents).values([
      {
        id: agentIds[0],
        profileId,
        handle: `disc_a_${agentIds[0].slice(0, 8)}`,
        displayName: 'Agent A',
      },
      {
        id: agentIds[1],
        profileId,
        handle: `disc_b_${agentIds[1].slice(0, 8)}`,
        displayName: 'Agent B',
      },
    ]);
    if (input.withFeishuApps) {
      await db.insert(feishuApps).values([
        {
          id: feishuAppIds[0],
          tenantKey: 'default',
          appId: `disc_app_a_${feishuAppIds[0].slice(0, 8)}`,
          appSecretRef: 'stored',
          appSecret: 'debug',
          botOpenId: `ou_disc_a_${feishuAppIds[0].slice(0, 8)}`,
          botName: 'Agent A Bot',
          status: 'enabled',
        },
        {
          id: feishuAppIds[1],
          tenantKey: 'default',
          appId: `disc_app_b_${feishuAppIds[1].slice(0, 8)}`,
          appSecretRef: 'stored',
          appSecret: 'debug',
          botOpenId: `ou_disc_b_${feishuAppIds[1].slice(0, 8)}`,
          botName: 'Agent B Bot',
          status: 'enabled',
        },
      ]);
    }
    await db.insert(sessions).values({
      id: sessionId,
      sessionKey: `test:discussion:${sessionId}`,
      chatId: `chat_${sessionId}`,
      scope: 'discussion',
      status: 'active',
    });

    const { discussion } = await createDiscussion(db, {
      chatId: `chat_${sessionId}`,
      rootThreadId: `om_${sessionId.slice(0, 16)}`,
      sessionId,
      topic: 'Should AI coding be introduced in production?',
      roundLimit: input.roundLimit,
      participants: [
        {
          agentId: agentIds[0],
          feishuAppId: feishuAppIds[0],
          role: 'affirmative',
          displayName: 'Agent A',
        },
        {
          agentId: agentIds[1],
          feishuAppId: feishuAppIds[1],
          role: 'negative',
          displayName: 'Agent B',
        },
      ],
    });
    fixtures.push({
      profileId,
      agentIds,
      feishuAppIds,
      sessionId,
      discussionId: discussion.id,
    });
    return fixtures[fixtures.length - 1];
  }

  function stableTestTaskId(discussionId: string, round: number, turnIndex: number): string {
    const suffix = `${round}${turnIndex}`.padStart(12, '0');
    return `${discussionId.slice(0, 24)}${suffix}`;
  }

  function buildNextTurnTask(
    fixture: DiscussionFixture,
    input: { round?: number; turnIndex: number; omitFeishuAppId?: boolean },
  ) {
    const round = input.round ?? 1;
    const agentId = fixture.agentIds[input.turnIndex];
    const feishuAppId = fixture.feishuAppIds[input.turnIndex];
    return {
      taskId: stableTestTaskId(fixture.discussionId, round, input.turnIndex),
      sessionId: fixture.sessionId,
      agentId,
      ...(input.omitFeishuAppId ? {} : { feishuAppId }),
      taskType: 'chat_reply',
      goal: `discussion turn ${round}.${input.turnIndex}`,
      runtimeHint: 'auto',
      constraints: {
        timeoutSec: 1800,
        discussionId: fixture.discussionId,
      },
    };
  }
});
