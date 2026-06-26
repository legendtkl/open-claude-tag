import { randomUUID } from 'crypto';
import { TaskStatus } from '@open-tag/core-types';
import { eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../db.js';
import { agentProfiles, agents, sessions, tasks, waitingContracts } from '../schema.js';
import * as schema from '../schema.js';
import {
  bindWaitingContractsToPrimaryTask,
  createWaitingContract,
  listStaleWaitingContracts,
  listWaitingContractsForPrimaryTask,
  setWaitingContractAckMessageId,
  transitionWaitingContract,
} from '../waiting-contract-repository.js';

const describePg =
  process.env.OPEN_TAG_STORAGE_PG_INTEGRATION === '1' ? describe : describe.skip;

describePg('waiting contract repository integration', () => {
  let client: postgres.Sql;
  let db: Database;
  let profileId: string;
  const cleanupAgentIds: string[] = [];
  const cleanupTaskIds: string[] = [];
  const cleanupSessionIds: string[] = [];
  const cleanupContractIds: string[] = [];

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL is required for storage Postgres integration tests');
    }
    client = postgres(process.env.DATABASE_URL, {
      max: 4,
      idle_timeout: 5,
      connect_timeout: 5,
    });
    db = drizzle(client, { schema }) as unknown as Database;
    profileId = randomUUID();
    await db.insert(agentProfiles).values({
      id: profileId,
      name: `wc-test-profile-${profileId.slice(0, 8)}`,
      displayName: `WC Test Profile`,
    });
  });

  afterEach(async () => {
    if (cleanupContractIds.length > 0) {
      await db
        .delete(waitingContracts)
        .where(inArray(waitingContracts.id, cleanupContractIds.splice(0)));
    }
    for (const taskId of cleanupTaskIds.splice(0)) {
      await db.delete(tasks).where(eq(tasks.id, taskId));
    }
    for (const sessionId of cleanupSessionIds.splice(0)) {
      await db.delete(sessions).where(eq(sessions.id, sessionId));
    }
    if (cleanupAgentIds.length > 0) {
      await db.delete(agents).where(inArray(agents.id, cleanupAgentIds.splice(0)));
    }
  });

  afterAll(async () => {
    await db.delete(agentProfiles).where(eq(agentProfiles.id, profileId));
    await client.end({ timeout: 5 });
  });

  async function seedAgent(): Promise<string> {
    const id = randomUUID();
    cleanupAgentIds.push(id);
    await db.insert(agents).values({
      id,
      handle: `wc-test-${id.slice(0, 8)}`,
      displayName: `WC Test ${id.slice(0, 8)}`,
      profileId,
    });
    return id;
  }

  async function seedContract(input?: {
    messageId?: string;
    createdAt?: Date;
    primaryTaskId?: string | null;
  }): Promise<{
    contractId: string;
    agentId: string;
    primaryAgentId: string;
    messageId: string;
    chatId: string;
  }> {
    const agentId = await seedAgent();
    const primaryAgentId = await seedAgent();
    const messageId = input?.messageId ?? `om_wc_${randomUUID()}`;
    const chatId = `chat_wc_${randomUUID()}`;
    const { contract, created } = await createWaitingContract(db, {
      chatId,
      messageId,
      agentId,
      waitingOnAgentId: primaryAgentId,
      primaryTaskId: input?.primaryTaskId ?? null,
      goal: 'code review',
    });
    expect(created).toBe(true);
    cleanupContractIds.push(contract.id);
    if (input?.createdAt) {
      await db
        .update(waitingContracts)
        .set({ createdAt: input.createdAt })
        .where(eq(waitingContracts.id, contract.id));
    }
    return { contractId: contract.id, agentId, primaryAgentId, messageId, chatId };
  }

  it('is idempotent per (tenant, chat, message, agent)', async () => {
    const seeded = await seedContract();
    const replay = await createWaitingContract(db, {
      chatId: seeded.chatId,
      messageId: seeded.messageId,
      agentId: seeded.agentId,
      waitingOnAgentId: seeded.primaryAgentId,
      goal: 'different goal on replay',
    });
    expect(replay.created).toBe(false);
    expect(replay.contract.id).toBe(seeded.contractId);
    expect(replay.contract.goal).toBe('code review');

    // A different chat is a different scope: it gets its own contract row
    const otherChat = await createWaitingContract(db, {
      chatId: `chat_wc_${randomUUID()}`,
      messageId: seeded.messageId,
      agentId: seeded.agentId,
      waitingOnAgentId: seeded.primaryAgentId,
      goal: 'other chat',
    });
    cleanupContractIds.push(otherChat.contract.id);
    expect(otherChat.created).toBe(true);
  });

  it('CAS transition wins once and loses on replay', async () => {
    const seeded = await seedContract();
    const first = await transitionWaitingContract(db, seeded.contractId, 'woken');
    const second = await transitionWaitingContract(db, seeded.contractId, 'woken');
    expect(first).toBe(true);
    expect(second).toBe(false);
    const cancelAfterWoken = await transitionWaitingContract(db, seeded.contractId, 'cancelled');
    expect(cancelAfterWoken).toBe(false);
  });

  it('binds unbound contracts to the primary task and lists them for completion', async () => {
    const seeded = await seedContract();
    const sessionId = randomUUID();
    const taskId = randomUUID();
    cleanupSessionIds.push(sessionId);
    cleanupTaskIds.push(taskId);
    await db.insert(sessions).values({
      id: sessionId,
      sessionKey: `test:wc:${sessionId}`,
      chatId: `chat_${sessionId}`,
      scope: 'group',
      status: 'active',
    });
    await db.insert(tasks).values({
      id: taskId,
      sessionId,
      taskType: 'chat_reply',
      goal: 'primary work',
      status: TaskStatus.QUEUED,
      constraints: {},
      agentId: seeded.primaryAgentId,
    });

    // A different chat with the same messageId must NOT be bound (scope guard)
    const otherBound = await bindWaitingContractsToPrimaryTask(db, {
      chatId: `chat_other_${randomUUID()}`,
      messageId: seeded.messageId,
      waitingOnAgentId: seeded.primaryAgentId,
      primaryTaskId: taskId,
    });
    expect(otherBound).toBe(0);

    const bound = await bindWaitingContractsToPrimaryTask(db, {
      chatId: seeded.chatId,
      messageId: seeded.messageId,
      waitingOnAgentId: seeded.primaryAgentId,
      primaryTaskId: taskId,
    });
    expect(bound).toBe(1);

    const listed = await listWaitingContractsForPrimaryTask(db, taskId);
    expect(listed.map((contract) => contract.id)).toEqual([seeded.contractId]);

    await setWaitingContractAckMessageId(db, seeded.contractId, 'om_ack_1');
    const [reloaded] = await listWaitingContractsForPrimaryTask(db, taskId);
    expect(reloaded.ackMessageId).toBe('om_ack_1');
  });

  it('finds TTL-expired and orphaned contracts but not fresh ones', async () => {
    const now = Date.now();
    const fresh = await seedContract();
    const ttlExpired = await seedContract({ createdAt: new Date(now - 25 * 3600_000) });
    const orphan = await seedContract({ createdAt: new Date(now - 10 * 60_000) });

    const stale = await listStaleWaitingContracts(db, {
      ttlCutoff: new Date(now - 24 * 3600_000),
      orphanCutoff: new Date(now - 5 * 60_000),
    });
    const staleIds = new Set(stale.map((contract) => contract.id));
    expect(staleIds.has(ttlExpired.contractId)).toBe(true);
    expect(staleIds.has(orphan.contractId)).toBe(true);
    expect(staleIds.has(fresh.contractId)).toBe(false);
  });
});
