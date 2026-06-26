import { and, eq, inArray, isNull, lte, or } from 'drizzle-orm';
import type { Database } from './db.js';
import { waitingContracts } from './schema.js';

export type WaitingContractRecord = typeof waitingContracts.$inferSelect;

export type WaitingContractStatus = 'waiting' | 'woken' | 'cancelled' | 'expired';

export interface CreateWaitingContractInput {
  tenantKey?: string;
  chatId: string;
  messageId: string;
  sessionId?: string | null;
  agentId: string;
  feishuAppId?: string | null;
  waitingOnAgentId: string;
  primaryTaskId?: string | null;
  goal: string;
  ackMessageId?: string | null;
}

/**
 * Idempotent per (tenantKey, chatId, messageId, agentId): both the primary
 * delivery (source-of-truth creation) and a deferred/replayed delivery converge
 * on one row instead of inserting duplicates.
 */
export async function createWaitingContract(
  db: Database,
  input: CreateWaitingContractInput,
): Promise<{ contract: WaitingContractRecord; created: boolean }> {
  const tenantKey = input.tenantKey ?? 'default';
  const [inserted] = await db
    .insert(waitingContracts)
    .values({
      tenantKey,
      chatId: input.chatId,
      messageId: input.messageId,
      sessionId: input.sessionId ?? null,
      agentId: input.agentId,
      feishuAppId: input.feishuAppId ?? null,
      waitingOnAgentId: input.waitingOnAgentId,
      primaryTaskId: input.primaryTaskId ?? null,
      goal: input.goal,
      ackMessageId: input.ackMessageId ?? null,
    })
    .onConflictDoNothing({
      target: [
        waitingContracts.tenantKey,
        waitingContracts.chatId,
        waitingContracts.messageId,
        waitingContracts.agentId,
      ],
    })
    .returning();

  if (inserted) {
    return { contract: inserted, created: true };
  }

  const [existing] = await db
    .select()
    .from(waitingContracts)
    .where(
      and(
        eq(waitingContracts.tenantKey, tenantKey),
        eq(waitingContracts.chatId, input.chatId),
        eq(waitingContracts.messageId, input.messageId),
        eq(waitingContracts.agentId, input.agentId),
      ),
    )
    .limit(1);
  if (!existing) {
    throw new Error(
      `Waiting contract conflict for message ${input.messageId} agent ${input.agentId} but no row found`,
    );
  }
  return { contract: existing, created: false };
}

export async function setWaitingContractAckMessageId(
  db: Database,
  contractId: string,
  ackMessageId: string,
): Promise<void> {
  await db
    .update(waitingContracts)
    .set({ ackMessageId, updatedAt: new Date() })
    .where(eq(waitingContracts.id, contractId));
}

export async function bindWaitingContractsToPrimaryTask(
  db: Database,
  input: {
    tenantKey?: string;
    chatId: string;
    messageId: string;
    waitingOnAgentId: string;
    primaryTaskId: string;
  },
): Promise<number> {
  // Scope by (tenant_key, chat_id, message_id) so the WHERE stays consistent
  // with the unique index and cannot mis-bind a same-message contract from
  // another tenant/chat.
  const tenantKey = input.tenantKey ?? 'default';
  const rows = await db
    .update(waitingContracts)
    .set({ primaryTaskId: input.primaryTaskId, updatedAt: new Date() })
    .where(
      and(
        eq(waitingContracts.tenantKey, tenantKey),
        eq(waitingContracts.chatId, input.chatId),
        eq(waitingContracts.messageId, input.messageId),
        eq(waitingContracts.waitingOnAgentId, input.waitingOnAgentId),
        isNull(waitingContracts.primaryTaskId),
      ),
    )
    .returning({ id: waitingContracts.id });
  return rows.length;
}

export async function listWaitingContractsByMessage(
  db: Database,
  input: { messageId: string; waitingOnAgentId: string },
): Promise<WaitingContractRecord[]> {
  return db
    .select()
    .from(waitingContracts)
    .where(
      and(
        eq(waitingContracts.messageId, input.messageId),
        eq(waitingContracts.waitingOnAgentId, input.waitingOnAgentId),
        eq(waitingContracts.status, 'waiting'),
      ),
    )
    .orderBy(waitingContracts.createdAt);
}

export async function listWaitingContractsForPrimaryTask(
  db: Database,
  primaryTaskId: string,
): Promise<WaitingContractRecord[]> {
  return db
    .select()
    .from(waitingContracts)
    .where(
      and(
        eq(waitingContracts.primaryTaskId, primaryTaskId),
        eq(waitingContracts.status, 'waiting'),
      ),
    )
    .orderBy(waitingContracts.createdAt);
}

/**
 * Atomic CAS: only a `waiting` contract transitions, and the caller learns
 * whether THIS call won the transition. The completion hook posts the visible
 * wake only when it wins, so duplicate completions (or an agent-authored
 * mention racing the hook) can never produce a second system wake.
 */
export async function transitionWaitingContract(
  db: Database,
  contractId: string,
  toStatus: Exclude<WaitingContractStatus, 'waiting'>,
): Promise<boolean> {
  const rows = await db
    .update(waitingContracts)
    .set({ status: toStatus, updatedAt: new Date() })
    .where(and(eq(waitingContracts.id, contractId), eq(waitingContracts.status, 'waiting')))
    .returning({ id: waitingContracts.id });
  return rows.length > 0;
}

/**
 * Compensation for a claim whose visible side-effect (wake/notice send) failed:
 * put the contract back to `waiting` so the reconciler or the next terminal
 * event retries the delivery. Only reverts from the exact claimed status.
 */
export async function revertWaitingContractClaim(
  db: Database,
  contractId: string,
  fromStatus: Exclude<WaitingContractStatus, 'waiting'>,
): Promise<boolean> {
  const rows = await db
    .update(waitingContracts)
    .set({ status: 'waiting', updatedAt: new Date() })
    .where(and(eq(waitingContracts.id, contractId), eq(waitingContracts.status, fromStatus)))
    .returning({ id: waitingContracts.id });
  return rows.length > 0;
}

export interface StaleWaitingContractQuery {
  /** Contracts older than this are TTL-expired regardless of primary state. */
  ttlCutoff: Date;
  /**
   * Contracts older than this with no bound primary task are orphans (the
   * primary delivery never produced a task — misroute or lost event).
   */
  orphanCutoff: Date;
  limit?: number;
}

export async function listStaleWaitingContracts(
  db: Database,
  query: StaleWaitingContractQuery,
): Promise<WaitingContractRecord[]> {
  const limit = query.limit ?? 50;
  return db
    .select()
    .from(waitingContracts)
    .where(
      and(
        eq(waitingContracts.status, 'waiting'),
        or(
          lte(waitingContracts.createdAt, query.ttlCutoff),
          and(
            isNull(waitingContracts.primaryTaskId),
            lte(waitingContracts.createdAt, query.orphanCutoff),
          ),
        ),
      ),
    )
    .orderBy(waitingContracts.createdAt)
    .limit(limit);
}

export async function listWaitingContractsByIds(
  db: Database,
  ids: string[],
): Promise<WaitingContractRecord[]> {
  if (ids.length === 0) return [];
  return db.select().from(waitingContracts).where(inArray(waitingContracts.id, ids));
}
