import type { TaskJobData } from '@open-tag/queue';
import type { DelegationBarrierResult } from '@open-tag/storage';

export interface DelegationBarrierWakeLogger {
  info(meta: Record<string, unknown>, message: string): void;
  warn(meta: Record<string, unknown>, message: string): void;
  error(meta: Record<string, unknown>, message: string): void;
}

export interface DelegationBarrierWakeDeps {
  evaluateBarrier(childTaskId: string): Promise<DelegationBarrierResult>;
  enqueue(data: TaskJobData): Promise<string | null>;
  deleteLease(taskId: string): Promise<void>;
  logger: DelegationBarrierWakeLogger;
}

export type DelegationBarrierWakeDeliveryResult =
  | 'not_delegated'
  | 'waiting'
  | 'already_woken'
  | 'enqueued'
  | 'lease_retained';

export async function deliverDelegationBarrierWake(
  deps: DelegationBarrierWakeDeps,
  childTaskId: string,
): Promise<DelegationBarrierWakeDeliveryResult> {
  const barrier = await deps.evaluateBarrier(childTaskId);
  if (barrier.status === 'not_delegated') return 'not_delegated';
  if (barrier.status === 'waiting') {
    deps.logger.info(
      {
        childTaskId,
        treeId: barrier.treeId,
        parentTaskId: barrier.parentTaskId,
        remaining: barrier.remaining,
      },
      'Delegation barrier still waiting for sibling child tasks',
    );
    return 'waiting';
  }
  if (barrier.status === 'already_woken') {
    deps.logger.info(
      { childTaskId, treeId: barrier.treeId, parentTaskId: barrier.parentTaskId },
      'Delegation barrier already woke parent task',
    );
    return 'already_woken';
  }

  const jobData: TaskJobData = {
    taskId: barrier.wake.taskId,
    sessionId: barrier.wake.sessionId,
    agentId: barrier.wake.agentId ?? undefined,
    feishuAppId: barrier.wake.feishuAppId ?? undefined,
    taskType: barrier.wake.taskType,
    goal: barrier.wake.goal,
    runtimeHint: barrier.wake.runtimeHint,
    constraints: barrier.wake.constraints,
    sdkSessionId: barrier.wake.sdkSessionId,
    runtimeBackend: barrier.wake.runtimeBackend,
  };

  try {
    const jobId = await deps.enqueue(jobData);
    if (!jobId) {
      deps.logger.warn(
        {
          childTaskId,
          treeId: barrier.treeId,
          parentTaskId: barrier.parentTaskId,
          sessionId: jobData.sessionId,
        },
        'Delegation barrier parent resume hit singleton collision; durable lease retained',
      );
      return 'lease_retained';
    }

    await deps.deleteLease(jobData.taskId);
    deps.logger.info(
      {
        childTaskId,
        treeId: barrier.treeId,
        parentTaskId: barrier.parentTaskId,
        sessionId: jobData.sessionId,
        jobId,
      },
      'Delegation barrier woke parent task',
    );
    return 'enqueued';
  } catch (err) {
    deps.logger.error(
      {
        err,
        childTaskId,
        treeId: barrier.treeId,
        parentTaskId: barrier.parentTaskId,
        sessionId: jobData.sessionId,
      },
      'Delegation barrier parent resume enqueue failed; durable lease retained',
    );
    return 'lease_retained';
  }
}
