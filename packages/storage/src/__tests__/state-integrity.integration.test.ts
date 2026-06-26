import { randomUUID } from 'crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import { inArray } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  approvals,
  changeRequests,
  inboundEvents,
  sessions,
  tasks,
  users,
} from '../schema.js';
import * as schema from '../schema.js';
import type { Database } from '../db.js';

// Database-level state-integrity guarantees from migration 0030: CHECK
// constraints on state-machine columns, vote uniqueness, parent FKs.
const describePg =
  process.env.OPEN_TAG_STORAGE_PG_INTEGRATION === '1' ? describe : describe.skip;

describePg('state integrity constraints (migration 0030)', () => {
  let client: postgres.Sql;
  let db: Database;
  const eventIds: string[] = [];
  const sessionIds: string[] = [];
  const taskIds: string[] = [];
  const userIds: string[] = [];
  const changeRequestIds: string[] = [];

  beforeAll(() => {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL is required for storage Postgres integration tests');
    }
    client = postgres(process.env.DATABASE_URL, {
      max: 5,
      idle_timeout: 5,
      connect_timeout: 5,
    });
    db = drizzle(client, { schema }) as unknown as Database;
  });

  afterAll(async () => {
    if (eventIds.length) await db.delete(inboundEvents).where(inArray(inboundEvents.eventId, eventIds));
    if (changeRequestIds.length) {
      await db.delete(approvals).where(inArray(approvals.changeRequestId, changeRequestIds));
      await db.delete(changeRequests).where(inArray(changeRequests.id, changeRequestIds));
    }
    if (taskIds.length) await db.delete(tasks).where(inArray(tasks.id, taskIds));
    if (sessionIds.length) await db.delete(sessions).where(inArray(sessions.id, sessionIds));
    if (userIds.length) await db.delete(users).where(inArray(users.id, userIds));
    await client.end({ timeout: 5 });
  });

  it('rejects unknown inbound event statuses', async () => {
    const eventId = `evt-${randomUUID()}`;
    eventIds.push(eventId);
    await expect(
      db.insert(inboundEvents).values({ eventId, status: 'exploded' }),
    ).rejects.toThrow(/chk_inbound_events_status/);
  });

  it('rejects unknown approval actions', async () => {
    await expect(
      db.insert(approvals).values({ action: 'maybe' }),
    ).rejects.toThrow(/chk_approvals_action/);
  });

  it('rejects unknown task statuses', async () => {
    const sessionId = randomUUID();
    sessionIds.push(sessionId);
    await db.insert(sessions).values({
      id: sessionId,
      sessionKey: `test:integrity:${sessionId}`,
      chatId: `chat_${sessionId}`,
      scope: 'p2p',
      status: 'active',
    });
    const taskId = randomUUID();
    taskIds.push(taskId);
    await expect(
      db.insert(tasks).values({
        id: taskId,
        sessionId,
        taskType: 'chat_reply',
        goal: 'bad status probe',
        status: 'exploded',
        constraints: {},
      }),
    ).rejects.toThrow(/chk_tasks_status/);
  });

  it('rejects an orphan parent_task_id', async () => {
    const sessionId = randomUUID();
    sessionIds.push(sessionId);
    await db.insert(sessions).values({
      id: sessionId,
      sessionKey: `test:integrity:${sessionId}`,
      chatId: `chat_${sessionId}`,
      scope: 'p2p',
      status: 'active',
    });
    const taskId = randomUUID();
    taskIds.push(taskId);
    await expect(
      db.insert(tasks).values({
        id: taskId,
        sessionId,
        taskType: 'chat_reply',
        goal: 'orphan parent probe',
        status: 'pending',
        constraints: {},
        parentTaskId: randomUUID(),
      }),
    ).rejects.toThrow(/tasks_parent_task_id_tasks_id_fk/);
  });

  it('rejects unknown change request statuses', async () => {
    const crId = randomUUID();
    changeRequestIds.push(crId);
    await expect(
      db.insert(changeRequests).values({
        id: crId,
        title: 'bad status probe',
        targetType: 'code',
        riskLevel: 'low',
        status: 'limbo',
      }),
    ).rejects.toThrow(/chk_change_requests_status/);
  });

  it('rejects a duplicate approval vote for the same (request, approver, action)', async () => {
    const userId = randomUUID();
    userIds.push(userId);
    await db.insert(users).values({ id: userId, feishuOpenId: `ou_${randomUUID()}`, role: 'admin' });
    const crId = randomUUID();
    changeRequestIds.push(crId);
    await db.insert(changeRequests).values({
      id: crId,
      title: 'integrity probe',
      targetType: 'code',
      riskLevel: 'high',
      status: 'waiting_approval',
    });

    await db.insert(approvals).values({ changeRequestId: crId, approverId: userId, action: 'approve' });
    await expect(
      db.insert(approvals).values({ changeRequestId: crId, approverId: userId, action: 'approve' }),
    ).rejects.toThrow(/idx_approvals_request_approver_action/);
  });
});
