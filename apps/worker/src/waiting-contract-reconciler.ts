import { stableUuidFromKey } from '@open-tag/core-types';
import type { WaitingContractRecord } from '@open-tag/storage';

export interface WaitingContractReconcilerLogger {
  info(meta: Record<string, unknown>, message: string): void;
  warn(meta: Record<string, unknown>, message: string): void;
}

export interface WaitingContractReconcilerDeps {
  listStale(input: {
    ttlCutoff: Date;
    orphanCutoff: Date;
    limit: number;
  }): Promise<WaitingContractRecord[]>;
  findTaskById(taskId: string): Promise<{ id: string } | null>;
  bindContracts(input: {
    tenantKey: string;
    chatId: string;
    messageId: string;
    waitingOnAgentId: string;
    primaryTaskId: string;
  }): Promise<number>;
  transitionContract(contractId: string, to: 'expired'): Promise<boolean>;
  /** Compensation: put a claimed contract back to waiting after a failed notice send. */
  revertContract(contractId: string, from: 'expired'): Promise<boolean>;
  sendNotice(input: {
    feishuAppId: string | null;
    chatId: string;
    replyToMessageId?: string;
    text: string;
    uuid: string;
  }): Promise<void>;
  logger: WaitingContractReconcilerLogger;
  batchSize: number;
  ttlMs: number;
  orphanMs: number;
}

/**
 * Mirror of the API's buildRelayPrimaryTaskId: the relay primary task id is
 * deterministic in (tenant, chat, message, primary agent), so the reconciler
 * can late-bind an orphaned contract whose primary delivery landed after the
 * deferred one without ever seeing the original event.
 */
export function deriveRelayPrimaryTaskId(contract: {
  tenantKey: string;
  chatId: string;
  messageId: string;
  waitingOnAgentId: string;
}): string {
  return stableUuidFromKey(
    ['relay-primary', contract.tenantKey, contract.chatId, contract.messageId, contract.waitingOnAgentId].join(
      ':',
    ),
  );
}

/**
 * Waiting contracts are never silently abandoned: orphans (no primary task
 * ever appeared) and TTL-overdue contracts are expired with a visible notice
 * asking for re-assignment. Before expiring an orphan, one late-bind attempt
 * runs against the deterministic primary task id, so a slow primary delivery
 * rescues its contracts instead of losing them.
 */
export async function runWaitingContractReconcilerOnce(
  deps: WaitingContractReconcilerDeps,
): Promise<{ inspected: number; rebound: number; expired: number }> {
  const now = Date.now();
  const stale = await deps.listStale({
    ttlCutoff: new Date(now - deps.ttlMs),
    orphanCutoff: new Date(now - deps.orphanMs),
    limit: deps.batchSize,
  });

  let rebound = 0;
  let expired = 0;

  for (const contract of stale) {
    const ttlOverdue = now - contract.createdAt.getTime() >= deps.ttlMs;

    if (!contract.primaryTaskId && !ttlOverdue) {
      const candidateTaskId = deriveRelayPrimaryTaskId(contract);
      const task = await deps.findTaskById(candidateTaskId);
      if (task) {
        await deps.bindContracts({
          tenantKey: contract.tenantKey,
          chatId: contract.chatId,
          messageId: contract.messageId,
          waitingOnAgentId: contract.waitingOnAgentId,
          primaryTaskId: candidateTaskId,
        });
        rebound += 1;
        deps.logger.info(
          { contractId: contract.id, primaryTaskId: candidateTaskId },
          'Late-bound orphaned waiting contract to its primary task',
        );
        continue;
      }
    }

    if (!(await deps.transitionContract(contract.id, 'expired'))) {
      continue;
    }
    const reason = ttlOverdue
      ? '等待超时（主任务未在期限内完成）'
      : '编排未生效（主任务未创建）';
    try {
      await deps.sendNotice({
        feishuAppId: contract.feishuAppId ?? null,
        chatId: contract.chatId,
        replyToMessageId: contract.messageId,
        text: `等待已取消：${reason}，原定后续(${contract.goal})不再自动触发，请重新指派。`,
        uuid: `wc:${contract.id}:expired`,
      });
    } catch (err) {
      // Visibility is part of the contract: revert so the next sweep retries
      // the notice instead of silently dropping the expiry.
      await deps.revertContract(contract.id, 'expired');
      deps.logger.warn(
        { err, contractId: contract.id },
        'Expiry notice failed; contract reverted to waiting for next sweep',
      );
      continue;
    }
    expired += 1;
    deps.logger.info(
      { contractId: contract.id, agentId: contract.agentId, ttlOverdue },
      'Expired waiting contract',
    );
  }

  return { inspected: stale.length, rebound, expired };
}
