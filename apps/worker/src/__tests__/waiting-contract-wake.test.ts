import { describe, expect, it, vi } from 'vitest';
import {
  deliverWaitingContractWakes,
  type WaitingContractWakeDeps,
  type WaitingContractWakeRecord,
} from '../handoff-delivery.js';
import {
  deriveRelayPrimaryTaskId,
  runWaitingContractReconcilerOnce,
  type WaitingContractReconcilerDeps,
} from '../waiting-contract-reconciler.js';
import type { WaitingContractRecord } from '@open-tag/storage';

const noopLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function contractRecord(overrides: Partial<WaitingContractWakeRecord> = {}): WaitingContractWakeRecord {
  return {
    id: 'contract-1',
    agentId: 'id-rev',
    goal: '进行 code review',
    chatId: 'oc_chat',
    messageId: 'om_origin',
    ...overrides,
  };
}

function wakeDeps(overrides: Partial<WaitingContractWakeDeps> = {}): WaitingContractWakeDeps & {
  sent: Array<{ text: string; uuid: string }>;
  reverted: Array<{ contractId: string; from: string }>;
} {
  const sent: Array<{ text: string; uuid: string }> = [];
  const reverted: Array<{ contractId: string; from: string }> = [];
  const statuses = new Map<string, string>();
  return {
    sent,
    reverted,
    listWaitingContracts: vi.fn(async () => [contractRecord()]),
    transitionContract: vi.fn(async (contractId: string, to: 'woken' | 'cancelled') => {
      if (statuses.get(contractId)) return false;
      statuses.set(contractId, to);
      return true;
    }),
    revertContract: vi.fn(async (contractId: string, from: 'woken' | 'cancelled') => {
      if (statuses.get(contractId) !== from) return false;
      statuses.delete(contractId);
      reverted.push({ contractId, from });
      return true;
    }),
    resolveAgentMention: vi.fn(async (agentId: string) =>
      agentId === 'id-rev'
        ? { botOpenId: 'ou_reviewer', displayName: 'Reviewer' }
        : { botOpenId: 'ou_dev', displayName: 'Developer' },
    ),
    sendVisibleRelayWake: vi.fn(async (message: { text: string; uuid: string } & Record<string, unknown>) => {
      sent.push({ text: message.text, uuid: message.uuid });
      return { messageId: `om_wake_${sent.length}` };
    }),
    logger: noopLogger,
    ...overrides,
  };
}

const COMPLETED_INPUT = {
  taskId: 'task-primary',
  agentId: 'id-dev',
  constraints: { userMessageId: 'om_origin', chatId: 'oc_chat' },
  outcome: 'completed' as const,
};

describe('deliverWaitingContractWakes', () => {
  it('wins the CAS claim before posting the wake, exactly once', async () => {
    const deps = wakeDeps();
    const result = await deliverWaitingContractWakes(deps, COMPLETED_INPUT);

    expect(result).toEqual({ woken: 1, cancelled: 0 });
    expect(deps.sent).toHaveLength(1);
    expect(deps.sent[0].text).toContain('<at user_id="ou_reviewer">Reviewer</at>');
    expect(deps.sent[0].text).toContain('进行 code review');
    expect(deps.sent[0].uuid).toBe('wc:contract-1:wake');

    // Duplicate completion with a stale read: the CAS loses, so NOTHING is sent
    const replay = await deliverWaitingContractWakes(deps, COMPLETED_INPUT);
    expect(replay.woken).toBe(0);
    expect(deps.sent).toHaveLength(1);
  });

  it('two racing completion attempts produce exactly one send (DB claim is the gate)', async () => {
    const deps = wakeDeps();
    const [first, second] = await Promise.all([
      deliverWaitingContractWakes(deps, COMPLETED_INPUT),
      deliverWaitingContractWakes(deps, COMPLETED_INPUT),
    ]);
    expect(first.woken + second.woken).toBe(1);
    expect(deps.sent).toHaveLength(1);
  });

  it('cancels contracts with a plain-text notice on failure (no real mention)', async () => {
    const deps = wakeDeps();
    const result = await deliverWaitingContractWakes(deps, {
      ...COMPLETED_INPUT,
      outcome: 'failed',
    });

    expect(result).toEqual({ woken: 0, cancelled: 1 });
    expect(deps.sent).toHaveLength(1);
    expect(deps.sent[0].text).not.toContain('<at ');
    expect(deps.sent[0].text).toContain('已取消等待');
  });

  it('reverts the claim to waiting when the wake send fails, enabling a retry', async () => {
    const deps = wakeDeps({
      sendVisibleRelayWake: vi.fn(async () => {
        throw new Error('feishu down');
      }),
    });
    const result = await deliverWaitingContractWakes(deps, COMPLETED_INPUT);
    expect(result.woken).toBe(0);
    expect(deps.reverted).toEqual([{ contractId: 'contract-1', from: 'woken' }]);

    // After the revert, a retry with a healthy sender succeeds
    const sent: string[] = [];
    deps.sendVisibleRelayWake = vi.fn(async (message: { uuid: string } & Record<string, unknown>) => {
      sent.push(message.uuid);
      return { messageId: 'om_retry' };
    }) as WaitingContractWakeDeps['sendVisibleRelayWake'];
    const retry = await deliverWaitingContractWakes(deps, COMPLETED_INPUT);
    expect(retry.woken).toBe(1);
    expect(sent).toEqual(['wc:contract-1:wake']);
  });

  it('reverts a cancellation claim when the notice send fails', async () => {
    const deps = wakeDeps({
      sendVisibleRelayWake: vi.fn(async () => {
        throw new Error('feishu down');
      }),
    });
    const result = await deliverWaitingContractWakes(deps, {
      ...COMPLETED_INPUT,
      outcome: 'failed',
    });
    expect(result.cancelled).toBe(0);
    expect(deps.reverted).toEqual([{ contractId: 'contract-1', from: 'cancelled' }]);
  });

  it('leaves the contract waiting when the target bot open id is unresolvable', async () => {
    const deps = wakeDeps({
      resolveAgentMention: vi.fn(async (agentId: string) =>
        agentId === 'id-rev' ? { botOpenId: null, displayName: 'Reviewer' } : { botOpenId: 'x', displayName: 'Developer' },
      ),
    });
    const result = await deliverWaitingContractWakes(deps, COMPLETED_INPUT);
    expect(result.woken).toBe(0);
    expect(deps.sent).toHaveLength(0);
  });

  it('no-ops without agent identity or origin message id', async () => {
    const deps = wakeDeps();
    expect(
      await deliverWaitingContractWakes(deps, { ...COMPLETED_INPUT, agentId: null }),
    ).toEqual({ woken: 0, cancelled: 0 });
    expect(
      await deliverWaitingContractWakes(deps, { ...COMPLETED_INPUT, constraints: {} }),
    ).toEqual({ woken: 0, cancelled: 0 });
    expect(deps.sent).toHaveLength(0);
  });
});

function reconcilerContract(
  overrides: Partial<WaitingContractRecord> = {},
): WaitingContractRecord {
  return {
    id: 'contract-1',
    tenantKey: 'default',
    chatId: 'oc_chat',
    messageId: 'om_origin',
    sessionId: null,
    agentId: 'id-rev',
    feishuAppId: 'app-rev',
    waitingOnAgentId: 'id-dev',
    primaryTaskId: null,
    goal: '进行 code review',
    ackMessageId: null,
    status: 'waiting',
    createdAt: new Date(Date.now() - 10 * 60 * 1000),
    updatedAt: new Date(),
    ...overrides,
  } as WaitingContractRecord;
}

function reconcilerDeps(
  contracts: WaitingContractRecord[],
  overrides: Partial<WaitingContractReconcilerDeps> = {},
): WaitingContractReconcilerDeps & { notices: string[]; bound: string[] } {
  const notices: string[] = [];
  const bound: string[] = [];
  return {
    notices,
    bound,
    listStale: vi.fn(async () => contracts),
    findTaskById: vi.fn(async () => null),
    bindContracts: vi.fn(async (input: { primaryTaskId: string }) => {
      bound.push(input.primaryTaskId);
      return 1;
    }),
    transitionContract: vi.fn(async () => true),
    revertContract: vi.fn(async () => true),
    sendNotice: vi.fn(async (notice: { text: string }) => {
      notices.push(notice.text);
    }),
    logger: noopLogger,
    batchSize: 25,
    ttlMs: 24 * 60 * 60 * 1000,
    orphanMs: 5 * 60 * 1000,
    ...overrides,
  };
}

describe('runWaitingContractReconcilerOnce', () => {
  it('expires an orphan visibly when no primary task can be found', async () => {
    const deps = reconcilerDeps([reconcilerContract()]);
    const result = await runWaitingContractReconcilerOnce(deps);
    expect(result).toEqual({ inspected: 1, rebound: 0, expired: 1 });
    expect(deps.notices).toHaveLength(1);
    expect(deps.notices[0]).toContain('编排未生效');
    expect(deps.notices[0]).toContain('进行 code review');
  });

  it('late-binds an orphan whose deterministic primary task exists', async () => {
    const contract = reconcilerContract();
    const expectedTaskId = deriveRelayPrimaryTaskId(contract);
    const deps = reconcilerDeps([contract], {
      findTaskById: vi.fn(async (taskId: string) =>
        taskId === expectedTaskId ? { id: taskId } : null,
      ),
    });
    const result = await runWaitingContractReconcilerOnce(deps);
    expect(result).toEqual({ inspected: 1, rebound: 1, expired: 0 });
    expect(deps.bound).toEqual([expectedTaskId]);
    expect(deps.notices).toHaveLength(0);
  });

  it('expires a TTL-overdue contract even when bound to a primary task', async () => {
    const deps = reconcilerDeps([
      reconcilerContract({
        primaryTaskId: 'task-primary',
        createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
      }),
    ]);
    const result = await runWaitingContractReconcilerOnce(deps);
    expect(result.expired).toBe(1);
    expect(deps.notices[0]).toContain('等待超时');
  });

  it('does not double-notice when the CAS loses', async () => {
    const deps = reconcilerDeps([reconcilerContract()], {
      transitionContract: vi.fn(async () => false),
    });
    const result = await runWaitingContractReconcilerOnce(deps);
    expect(result.expired).toBe(0);
    expect(deps.notices).toHaveLength(0);
  });

  it('reverts the expiry claim when the notice send fails', async () => {
    const reverts: string[] = [];
    const deps = reconcilerDeps([reconcilerContract()], {
      sendNotice: vi.fn(async () => {
        throw new Error('feishu down');
      }),
      revertContract: vi.fn(async (contractId: string) => {
        reverts.push(contractId);
        return true;
      }),
    });
    const result = await runWaitingContractReconcilerOnce(deps);
    expect(result.expired).toBe(0);
    expect(reverts).toEqual(['contract-1']);
  });
});
