import { TaskStatus } from '@open-tag/core-types';
import type {
  HandoffDeliveryDeps,
  HandoffDeliveryResult,
  WaitingContractWakeDeps,
} from './handoff-delivery.js';
import {
  deliverAgentHandoffToolCallIfNeeded,
  deliverRelayHandoffIfNeeded,
  deliverWaitingContractWakes,
} from './handoff-delivery.js';
import {
  transitionTaskOrDeliverDiscussionTurn,
  type TaskTerminalTransitionDeps,
} from './task-terminal-transition.js';

interface CompletionLogger {
  info(meta: Record<string, unknown>, message: string): void;
}

export interface SuccessfulTaskCompletionInput {
  taskId: string;
  sessionId: string;
  agentId?: string;
  feishuAppId?: string;
  taskType: string;
  goal: string;
  runtimeHint: string | null;
  constraints: Record<string, unknown>;
  result: unknown;
  content: string;
  parentWorkspacePath?: string;
}

export type SuccessfulTaskCompletionResult =
  | { status: 'completed' }
  | { status: 'waiting_tool'; childTaskId: string; handoffStatus: HandoffDeliveryResult['status'] };

function isReturnModeWaitingHandoff(result: HandoffDeliveryResult): result is Extract<
  HandoffDeliveryResult,
  { status: 'delegated_return' | 'lease_retained' }
> {
  return (
    result.status === 'delegated_return' ||
    (result.status === 'lease_retained' && result.mode === 'return')
  );
}

export async function completeSuccessfulTaskAfterHandoffs(
  deps: {
    handoff: HandoffDeliveryDeps;
    contractWake?: WaitingContractWakeDeps;
    terminalTransition: TaskTerminalTransitionDeps;
    logger: CompletionLogger;
  },
  input: SuccessfulTaskCompletionInput,
): Promise<SuccessfulTaskCompletionResult> {
  const toolHandoff = await deliverAgentHandoffToolCallIfNeeded(deps.handoff, {
    taskId: input.taskId,
    callerAgentId: input.agentId,
    constraints: input.constraints,
    parentGoal: input.goal,
    outputText: input.content,
  });
  if (isReturnModeWaitingHandoff(toolHandoff)) {
    deps.logger.info(
      {
        taskId: input.taskId,
        childTaskId: toolHandoff.childTaskId,
        status: toolHandoff.status,
      },
      'Task completion is waiting for handoff_to_agent result',
    );
    return {
      status: 'waiting_tool',
      childTaskId: toolHandoff.childTaskId,
      handoffStatus: toolHandoff.status,
    };
  }

  await transitionTaskOrDeliverDiscussionTurn(deps.terminalTransition, {
    taskId: input.taskId,
    sessionId: input.sessionId,
    agentId: input.agentId,
    feishuAppId: input.feishuAppId,
    taskType: input.taskType,
    goal: input.goal,
    runtimeHint: input.runtimeHint,
    constraints: input.constraints,
    result: input.result,
    content: input.content,
    status: TaskStatus.COMPLETED,
  });

  const relayHandoff = await deliverRelayHandoffIfNeeded(deps.handoff, {
    taskId: input.taskId,
    callerAgentId: input.agentId,
    constraints: input.constraints,
    parentGoal: input.goal,
    outputText: input.content,
    parentWorkspacePath: input.parentWorkspacePath,
  });
  if (relayHandoff.status === 'visible_relay_notified') {
    deps.logger.info(
      {
        taskId: input.taskId,
        messageId: relayHandoff.messageId,
      },
      'Task completed and visible relay wake was posted',
    );
  }

  // Best-effort side-effect: the task is already terminal, so a wake failure
  // must not throw the completion path into the outer failure handler — the
  // claim/revert protocol plus the reconciler own the retry.
  if (deps.contractWake) {
    try {
      const wakes = await deliverWaitingContractWakes(deps.contractWake, {
        taskId: input.taskId,
        agentId: input.agentId,
        constraints: input.constraints,
        outcome: 'completed',
      });
      if (wakes.woken > 0) {
        deps.logger.info(
          { taskId: input.taskId, woken: wakes.woken },
          'Task completed and waiting-contract wakes were posted',
        );
      }
    } catch (err) {
      deps.logger.info(
        { taskId: input.taskId, err },
        'Waiting-contract wake delivery failed; contracts stay waiting for the reconciler',
      );
    }
  }

  return { status: 'completed' };
}
