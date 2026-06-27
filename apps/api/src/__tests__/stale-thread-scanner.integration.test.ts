/**
 * Integration proof (real Postgres) for the stale-thread scanner's two IO seams:
 *
 *  - buildLoadStaleThreadCandidates: only `waiting_approval` tasks load, joined to
 *    their session, with `lastActivityAt = max(task.updatedAt, session.updatedAt)`
 *    — so a recent session reply correctly masks an old parked task.
 *  - buildAlreadyHandled: the audit-log dedupe finds a `stale_thread.nudge` row
 *    for a task only when its `createdAt >= sinceMs` (one attempt per stale episode).
 *
 * Gated like the other PG-backed API tests: runs under the isolated runner /
 * OPEN_TAG_API_PG_INTEGRATION=1, skips in pure unit runs.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { findStaleThreads } from '@open-tag/ambient';
import { auditEvents, createDb, sessions, tasks } from '@open-tag/storage';
import type { Database } from '@open-tag/storage';
import {
  buildAlreadyHandled,
  buildLoadStaleThreadCandidates,
  STALE_THREAD_NUDGE_ACTION,
} from '../stale-thread-scanner.js';

const describePg =
  process.env.DATABASE_URL || process.env.OPEN_TAG_API_PG_INTEGRATION === '1'
    ? describe
    : describe.skip;

const IDLE_MS = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const OLD = new Date(NOW - IDLE_MS - 60_000); // comfortably stale
const RECENT = new Date(NOW - 1_000); // fresh

describePg('stale-thread scanner IO seams (Postgres)', () => {
  let db: Database;
  const suffix = randomUUID().slice(0, 8);
  const chatStale = `oc_stale_${suffix}`;
  const chatResolved = `oc_done_${suffix}`;
  const chatMasked = `oc_masked_${suffix}`;
  const docComment = `doc:${suffix}`;

  const sessionIds: string[] = [];
  const taskIds: string[] = [];
  let staleTaskId = '';
  let maskedTaskId = '';

  async function seedSession(chatId: string, scope: string, updatedAt: Date): Promise<string> {
    const [row] = await db
      .insert(sessions)
      .values({
        sessionKey: `feishu:${chatId}:${randomUUID()}`,
        chatId,
        scope,
        status: 'active',
        createdAt: OLD,
        updatedAt,
      })
      .returning({ id: sessions.id });
    sessionIds.push(row.id);
    return row.id;
  }

  async function seedTask(sessionId: string, status: string, updatedAt: Date): Promise<string> {
    const [row] = await db
      .insert(tasks)
      .values({
        sessionId,
        taskType: 'chat_reply',
        goal: 'SENSITIVE-GOAL-must-not-leak',
        status,
        createdAt: OLD,
        updatedAt,
      })
      .returning({ id: tasks.id });
    taskIds.push(row.id);
    return row.id;
  }

  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL);

    // 1) Stale: a waiting_approval task whose session is also idle ⇒ a candidate.
    const s1 = await seedSession(chatStale, 'group-main', OLD);
    staleTaskId = await seedTask(s1, 'waiting_approval', OLD);

    // 2) Resolved: a completed task ⇒ never loaded (status filter).
    const s2 = await seedSession(chatResolved, 'group-main', OLD);
    await seedTask(s2, 'completed', OLD);

    // 3) Masked: a waiting_approval task BUT the session was just touched (user
    //    replied) ⇒ loaded, but lastActivityAt = recent ⇒ NOT stale.
    const s3 = await seedSession(chatMasked, 'group-main', RECENT);
    maskedTaskId = await seedTask(s3, 'waiting_approval', OLD);

    // 4) Doc-comment: a waiting_approval task on a feishu:-namespaced session whose
    //    scope is NOT a directly chat-sendable scope ⇒ the detector must drop it
    //    (chatId is a doc ref, not a chat target — regression guard).
    const s4 = await seedSession(docComment, 'doc-comment', OLD);
    await seedTask(s4, 'waiting_approval', OLD);
  });

  afterAll(async () => {
    for (const id of taskIds) await db.delete(tasks).where(eq(tasks.id, id));
    for (const id of sessionIds) await db.delete(sessions).where(eq(sessions.id, id));
    await db.delete(auditEvents).where(eq(auditEvents.targetId, staleTaskId));
    await db.$client.end({ timeout: 5 });
  });

  it('loads only waiting_approval tasks with lastActivityAt = max(task, session)', async () => {
    const loaded = await buildLoadStaleThreadCandidates(db)();
    const mine = loaded.filter((c) =>
      [chatStale, chatResolved, chatMasked, docComment].includes(c.chatId),
    );

    // The completed task is filtered out by status; all three feishu-namespaced
    // waiting tasks load at the SQL level (incl. the doc-comment one).
    expect(mine.map((c) => c.chatId).sort()).toEqual([chatMasked, chatStale, docComment].sort());

    const stale = mine.find((c) => c.chatId === chatStale)!;
    const masked = mine.find((c) => c.chatId === chatMasked)!;
    expect(stale.status).toBe('waiting_approval');
    expect(stale.channelKind).toBe('lark');
    expect(stale.isPrivate).toBe(false);
    // The masked candidate's clock reflects the RECENT session reply, not OLD task.
    expect(masked.lastActivityAt).toBeGreaterThan(stale.lastActivityAt);

    // The pure detector keeps ONLY the genuinely-stale chat-scoped one: the masked
    // one is fresh, and the doc-comment one is a non-sendable scope (regression
    // guard — its chatId is a doc ref, never a chat target).
    const detected = findStaleThreads(mine, { now: NOW, idleMs: IDLE_MS });
    expect(detected.map((d) => d.chatId)).toEqual([chatStale]);
    expect(detected[0].taskId).toBe(staleTaskId);
  });

  it('dedupe: alreadyHandled is true only for a nudge audit at/after sinceMs (one attempt per episode)', async () => {
    const alreadyHandled = buildAlreadyHandled(db);
    const staleSinceMs = OLD.getTime();

    // No nudge audit yet ⇒ not handled.
    expect(await alreadyHandled(staleTaskId, staleSinceMs)).toBe(false);

    // Record one nudge audit for this episode.
    await db.insert(auditEvents).values({
      actorId: null,
      action: STALE_THREAD_NUDGE_ACTION,
      targetType: 'task',
      targetId: staleTaskId,
      severity: 'info',
      detail: { outcome: 'sent' },
      createdAt: new Date(NOW),
    });

    // Now handled for this episode (audit createdAt >= the episode's staleSince).
    expect(await alreadyHandled(staleTaskId, staleSinceMs)).toBe(true);

    // A FUTURE episode (sinceMs after the audit, e.g. user replied later) is NOT
    // suppressed by the old audit ⇒ a fresh stall could be nudged again.
    expect(await alreadyHandled(staleTaskId, NOW + 60_000)).toBe(false);

    // The dedupe never matched the masked task (no audit for it).
    expect(await alreadyHandled(maskedTaskId, staleSinceMs)).toBe(false);
  });
});
