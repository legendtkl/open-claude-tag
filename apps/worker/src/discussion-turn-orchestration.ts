import { stableUuidFromKey } from '@open-tag/core-types';
import type { TaskJobData } from '@open-tag/queue';
import type {
  AdvanceDiscussionInput,
  AppendDiscussionTurnInput,
  DiscussionAdvanceResult,
  DiscussionParticipantRecord,
  DiscussionRecord,
  DiscussionTranscriptTurn,
  CompleteDiscussionTaskTurnInput,
} from '@open-tag/storage';

interface DiscussionTurnLogger {
  info(meta: Record<string, unknown>, message: string): void;
  warn(meta: Record<string, unknown>, message: string): void;
  error(meta: Record<string, unknown>, message: string): void;
}

export interface DiscussionTurnAdvanceDeps {
  loadDiscussion(discussionId: string): Promise<DiscussionRecord | null>;
  listParticipants(discussionId: string): Promise<DiscussionParticipantRecord[]>;
  loadTranscript(discussionId: string): Promise<DiscussionTranscriptTurn[]>;
  completeTaskAndAdvance(
    taskInput: CompleteDiscussionTaskTurnInput,
    turnInput: AppendDiscussionTurnInput,
    advanceInput: AdvanceDiscussionInput,
  ): Promise<{ task: unknown; turn: unknown; advance: DiscussionAdvanceResult }>;
  enqueue(jobData: TaskJobData): Promise<string | null>;
  deleteLease(taskId: string): Promise<void>;
  renderCommittedTurns?(input: {
    discussionId: string;
    throughTaskId: string;
    includeClosing: boolean;
  }): Promise<void>;
  logger: DiscussionTurnLogger;
}

export interface DiscussionTurnCompletionInput {
  taskId: string;
  sessionId: string;
  agentId?: string;
  feishuAppId?: string;
  taskType: string;
  goal: string;
  runtimeHint: string | null;
  constraints: Record<string, unknown>;
  content?: string | null;
  status?: 'completed' | 'failed' | 'cancelled';
  errorMessage?: string | null;
  result?: unknown;
  interactionReason?: string | null;
}

export type DiscussionTurnAdvanceDeliveryResult =
  | 'not_discussion_turn'
  | 'discussion_missing'
  | 'not_advanced'
  | 'enqueued'
  | 'lease_retained';

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}


function buildTranscriptLines(
  transcript: DiscussionTranscriptTurn[],
  current: {
    round: number;
    turnIndex: number;
    participant: DiscussionParticipantRecord | undefined;
    content?: string | null;
    errorMessage?: string | null;
    status: string;
  },
): string[] {
  const lines = transcript
    .filter((turn) => turn.status !== 'queued' && turn.content)
    .map((turn) => {
      const speaker =
        turn.agentDisplayName ?? turn.agentHandle ?? turn.agentId ?? `turn-${turn.turnIndex + 1}`;
      const role = turn.role ? ` (${turn.role})` : '';
      return `R${turn.round}.${turn.turnIndex + 1} ${speaker}${role}: ${turn.content}`;
    });

  if (current.content || current.errorMessage) {
    const speaker =
      current.participant?.displayName ??
      current.participant?.agentId ??
      `turn-${current.turnIndex + 1}`;
    const role = current.participant?.role ? ` (${current.participant.role})` : '';
    const body =
      current.status === 'completed'
        ? current.content
        : `[${current.status}] ${current.errorMessage ?? current.content ?? ''}`.trim();
    lines.push(`R${current.round}.${current.turnIndex + 1} ${speaker}${role}: ${body}`);
  }

  return lines;
}

function buildDiscussionTurnGoal(input: {
  discussion: DiscussionRecord;
  participants: DiscussionParticipantRecord[];
  transcript: DiscussionTranscriptTurn[];
  current: {
    round: number;
    turnIndex: number;
    status: string;
    content?: string | null;
    errorMessage?: string | null;
  };
  nextParticipant: DiscussionParticipantRecord;
  nextRound: number;
  nextTurnIndex: number;
}): string {
  const roster = input.participants
    .map((participant) => {
      const label = participant.displayName ?? participant.agentId;
      const role = participant.role ? ` role=${participant.role}` : '';
      return `- turn ${participant.orderIndex + 1}: ${label}${role}`;
    })
    .join('\n');
  const currentParticipant = input.participants.find(
    (participant) => participant.orderIndex === input.current.turnIndex,
  );
  const transcriptLines = buildTranscriptLines(input.transcript, {
    ...input.current,
    participant: currentParticipant,
  });
  const transcriptText =
    transcriptLines.length > 0 ? transcriptLines.join('\n') : '(No completed turns yet.)';

  return [
    'Continue the shared multi-agent discussion.',
    '',
    '<discussion>',
    `Topic: ${input.discussion.topic}`,
    '',
    '<participants>',
    roster,
    '</participants>',
    '',
    '<transcript>',
    transcriptText,
    '</transcript>',
    '',
    `It is round ${input.nextRound}, turn ${input.nextTurnIndex + 1}.`,
    input.nextParticipant.role
      ? `Your assigned role: ${input.nextParticipant.role}.`
      : 'No role was assigned.',
    'Respond only with your next discussion turn. Build on the transcript and avoid repeating earlier points.',
  ].join('\n');
}

function buildNextTurn(input: {
  currentTask: DiscussionTurnCompletionInput;
  discussion: DiscussionRecord;
  participants: DiscussionParticipantRecord[];
  transcript: DiscussionTranscriptTurn[];
  currentRound: number;
  currentTurnIndex: number;
}): AdvanceDiscussionInput {
  if (input.participants.length === 0) return {};

  let nextRound = input.currentRound;
  let nextTurnIndex = input.currentTurnIndex + 1;
  if (nextTurnIndex >= input.participants.length) {
    nextTurnIndex = 0;
    nextRound += 1;
  }
  if (nextRound > input.discussion.roundLimit) return {};

  const nextParticipant = input.participants.find(
    (participant) => participant.orderIndex === nextTurnIndex,
  );
  if (!nextParticipant) {
    throw new Error(
      `Discussion participant missing for next turn ${input.discussion.id}:${nextTurnIndex}`,
    );
  }

  const constraints = {
    ...input.currentTask.constraints,
    timeoutSec: input.currentTask.constraints.timeoutSec ?? 1800,
    approvalRequired: false,
    discussionId: input.discussion.id,
    discussionParticipantId: nextParticipant.id,
    discussionRound: nextRound,
    discussionTurnIndex: nextTurnIndex,
    discussionRole: nextParticipant.role,
  };

  return {
    nextTurn: {
      taskId: stableUuidFromKey(`${input.discussion.id}:${nextRound}:${nextTurnIndex}`),
      sessionId: input.discussion.sessionId,
      agentId: nextParticipant.agentId,
      feishuAppId: nextParticipant.feishuAppId,
      taskType: input.currentTask.taskType || 'chat_reply',
      goal: buildDiscussionTurnGoal({
        discussion: input.discussion,
        participants: input.participants,
        transcript: input.transcript,
        current: {
          round: input.currentRound,
          turnIndex: input.currentTurnIndex,
          status: input.currentTask.status ?? 'completed',
          content: input.currentTask.content,
          errorMessage: input.currentTask.errorMessage,
        },
        nextParticipant,
        nextRound,
        nextTurnIndex,
      }),
      runtimeHint: input.currentTask.runtimeHint ?? 'auto',
      constraints,
    },
  };
}

function toJobData(nextTurn: NonNullable<AdvanceDiscussionInput['nextTurn']>): TaskJobData {
  return {
    taskId: nextTurn.taskId,
    sessionId: nextTurn.sessionId,
    agentId: nextTurn.agentId,
    feishuAppId: nextTurn.feishuAppId ?? undefined,
    taskType: nextTurn.taskType,
    goal: nextTurn.goal,
    runtimeHint: nextTurn.runtimeHint ?? null,
    constraints: nextTurn.constraints,
  };
}

export async function deliverDiscussionTurnAdvance(
  deps: DiscussionTurnAdvanceDeps,
  input: DiscussionTurnCompletionInput,
): Promise<DiscussionTurnAdvanceDeliveryResult> {
  const discussionId = stringValue(input.constraints.discussionId);
  const round = numberValue(input.constraints.discussionRound);
  const turnIndex = numberValue(input.constraints.discussionTurnIndex);
  if (!discussionId || round == null || turnIndex == null) {
    return 'not_discussion_turn';
  }

  const discussion = await deps.loadDiscussion(discussionId);
  if (!discussion) {
    deps.logger.warn({ taskId: input.taskId, discussionId }, 'Discussion turn task missing discussion');
    return 'discussion_missing';
  }

  const [participants, transcript] = await Promise.all([
    deps.listParticipants(discussionId),
    deps.loadTranscript(discussionId),
  ]);
  const advanceInput = buildNextTurn({
    currentTask: input,
    discussion,
    participants,
    transcript,
    currentRound: round,
    currentTurnIndex: turnIndex,
  });

  const turnInput: AppendDiscussionTurnInput = {
    discussionId,
    participantId: stringValue(input.constraints.discussionParticipantId),
    agentId: input.agentId,
    taskId: input.taskId,
    round,
    turnIndex,
    status: input.status ?? 'completed',
    content: input.content,
    errorMessage: input.errorMessage,
    metadata: {
      source: 'worker',
    },
  };
  const result = await deps.completeTaskAndAdvance(
    {
      taskId: input.taskId,
      status: input.status ?? 'completed',
      errorMessage: input.errorMessage,
      result: input.result,
      interactionReason: input.interactionReason,
    },
    turnInput,
    advanceInput,
  );

  let deliveryResult: DiscussionTurnAdvanceDeliveryResult = 'not_advanced';
  if (result.advance.status !== 'advanced' || !advanceInput.nextTurn) {
    deps.logger.info(
      { taskId: input.taskId, discussionId, advanceStatus: result.advance.status },
      'Discussion turn completion did not enqueue a next turn',
    );
  } else {
    const jobData = toJobData(advanceInput.nextTurn);
    try {
      const jobId = await deps.enqueue(jobData);
      if (!jobId) {
        deps.logger.warn(
          { taskId: input.taskId, nextTaskId: jobData.taskId, discussionId },
          'Discussion next turn enqueue hit singleton collision; durable lease retained',
        );
        deliveryResult = 'lease_retained';
      } else {
        await deps.deleteLease(jobData.taskId);
        deps.logger.info(
          { taskId: input.taskId, nextTaskId: jobData.taskId, discussionId, jobId },
          'Discussion advanced and enqueued next turn',
        );
        deliveryResult = 'enqueued';
      }
    } catch (err) {
      deps.logger.error(
        { err, taskId: input.taskId, nextTaskId: jobData.taskId, discussionId },
        'Discussion next turn enqueue failed; durable lease retained',
      );
      deliveryResult = 'lease_retained';
    }
  }

  if (result.advance.status === 'advanced' || result.advance.status === 'completed') {
    await deps.renderCommittedTurns?.({
      discussionId,
      throughTaskId: input.taskId,
      includeClosing: result.advance.status === 'completed',
    });
  }

  return deliveryResult;
}
