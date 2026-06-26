import { describe, expect, it, vi } from 'vitest';
import { deliverDelegationBarrierWake } from '../delegation-barrier-wake.js';
import type { DelegationBarrierResult } from '@open-tag/storage';

function makeWokenBarrier(): DelegationBarrierResult {
  return {
    status: 'woken',
    treeId: 'tree_1',
    parentTaskId: 'parent_task',
    wake: {
      taskId: 'parent_task',
      sessionId: 'parent_session',
      agentId: 'agent_parent',
      feishuAppId: 'feishu_app',
      taskType: 'chat_reply',
      goal: 'resume parent',
      runtimeHint: 'codex',
      constraints: {
        delegationResume: true,
        delegationResumePackage: {
          treeId: 'tree_1',
          parentTaskId: 'parent_task',
          children: [{ childTaskId: 'child_task', delegationId: 'delegation_1' }],
        },
      },
      sdkSessionId: 'sdk_parent',
      runtimeBackend: 'codex',
    },
  };
}

function makeDeps(overrides: {
  barrier?: DelegationBarrierResult;
  enqueue?: (jobData: unknown) => Promise<string | null>;
} = {}) {
  return {
    evaluateBarrier: vi.fn().mockResolvedValue(overrides.barrier ?? makeWokenBarrier()),
    enqueue: vi.fn(overrides.enqueue ?? (async () => 'job_1')),
    deleteLease: vi.fn().mockResolvedValue(undefined),
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  };
}

describe('deliverDelegationBarrierWake', () => {
  it('deletes durable wake lease only after enqueue succeeds', async () => {
    const deps = makeDeps();

    const result = await deliverDelegationBarrierWake(deps, 'child_task');

    expect(result).toBe('enqueued');
    expect(deps.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'parent_task',
        sessionId: 'parent_session',
        goal: 'resume parent',
        constraints: expect.objectContaining({
          delegationResume: true,
          delegationResumePackage: expect.objectContaining({
            treeId: 'tree_1',
            children: [expect.objectContaining({ childTaskId: 'child_task' })],
          }),
        }),
      }),
    );
    expect(deps.deleteLease).toHaveBeenCalledWith('parent_task');
  });

  it('retains durable wake lease when enqueue throws', async () => {
    const deps = makeDeps({
      enqueue: async () => {
        throw new Error('pg-boss down');
      },
    });

    const result = await deliverDelegationBarrierWake(deps, 'child_task');

    expect(result).toBe('lease_retained');
    expect(deps.deleteLease).not.toHaveBeenCalled();
    expect(deps.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        parentTaskId: 'parent_task',
        sessionId: 'parent_session',
      }),
      'Delegation barrier parent resume enqueue failed; durable lease retained',
    );
  });

  it('retains durable wake lease when enqueue hits singleton collision', async () => {
    const deps = makeDeps({ enqueue: async () => null });

    const result = await deliverDelegationBarrierWake(deps, 'child_task');

    expect(result).toBe('lease_retained');
    expect(deps.deleteLease).not.toHaveBeenCalled();
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        parentTaskId: 'parent_task',
        sessionId: 'parent_session',
      }),
      'Delegation barrier parent resume hit singleton collision; durable lease retained',
    );
  });
});
