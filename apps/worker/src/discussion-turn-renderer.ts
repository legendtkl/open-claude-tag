import { stableUuidFromKey } from '@open-tag/core-types';
import { isObjectRecord } from '@open-tag/core-types';
import type {
  DiscussionParticipantRecord,
  DiscussionRecord,
  DiscussionTranscriptTurn,
  DiscussionTurnFeishuRenderKind,
} from '@open-tag/storage';
import type { FeishuClient } from '@open-tag/feishu-adapter';

interface DiscussionTurnRenderLogger {
  info(meta: Record<string, unknown>, message: string): void;
  warn(meta: Record<string, unknown>, message: string): void;
  error(meta: Record<string, unknown>, message: string): void;
}

export class DiscussionTurnRenderError extends Error {
  public readonly taskStateCommitted = true;

  constructor(
    message: string,
    public readonly cause: unknown,
  ) {
    super(message);
    this.name = 'DiscussionTurnRenderError';
  }
}

export interface DiscussionTurnRenderDeps {
  loadDiscussion(discussionId: string): Promise<DiscussionRecord | null>;
  listParticipants(discussionId: string): Promise<DiscussionParticipantRecord[]>;
  loadTranscript(discussionId: string): Promise<DiscussionTranscriptTurn[]>;
  getClient(feishuAppId?: string | null): Promise<FeishuClient | null>;
  markRendered(input: {
    turnId: string;
    kind: DiscussionTurnFeishuRenderKind;
    renderKey: string;
    messageId: string;
  }): Promise<unknown>;
  logger: DiscussionTurnRenderLogger;
}

export interface RenderDiscussionTurnsInput {
  discussionId: string;
  throughTaskId: string;
  includeClosing?: boolean;
}


function hasRender(metadata: unknown, kind: DiscussionTurnFeishuRenderKind): boolean {
  if (!isObjectRecord(metadata)) return false;
  const key = kind === 'closing' ? 'feishuClosingRender' : 'feishuRender';
  const render = metadata[key];
  return (
    isObjectRecord(render) &&
    typeof render.messageId === 'string' &&
    render.messageId.length > 0
  );
}

function isTerminalRenderableTurn(turn: DiscussionTranscriptTurn): boolean {
  return turn.status === 'completed' || turn.status === 'failed' || turn.status === 'cancelled';
}

function participantForTurn(
  participants: DiscussionParticipantRecord[],
  turn: DiscussionTranscriptTurn,
): DiscussionParticipantRecord | undefined {
  return participants.find((participant) => participant.id === turn.participantId) ??
    participants.find((participant) => participant.orderIndex === turn.turnIndex);
}

function speakerLabel(
  turn: DiscussionTranscriptTurn,
  participant: DiscussionParticipantRecord | undefined,
): string {
  return (
    participant?.displayName ??
    turn.agentDisplayName ??
    turn.agentHandle ??
    turn.agentId ??
    `Turn ${turn.turnIndex + 1}`
  );
}

function buildTurnText(
  discussion: DiscussionRecord,
  turn: DiscussionTranscriptTurn,
  participant: DiscussionParticipantRecord | undefined,
): string {
  const role = participant?.role ?? turn.role;
  const roleSuffix = role ? ` (${role})` : '';
  const prefix = `Discussion R${turn.round}.${turn.turnIndex + 1} - ${speakerLabel(
    turn,
    participant,
  )}${roleSuffix}`;
  const body =
    turn.status === 'completed'
      ? turn.content
      : `[${turn.status}] ${turn.errorMessage ?? turn.content ?? ''}`.trim();
  return [`${prefix}`, `Topic: ${discussion.topic}`, '', body ?? ''].join('\n').trim();
}

function buildClosingText(discussion: DiscussionRecord): string {
  return [`Discussion completed.`, `Topic: ${discussion.topic}`].join('\n');
}

async function sendRenderMessage(input: {
  deps: DiscussionTurnRenderDeps;
  discussion: DiscussionRecord;
  participant: DiscussionParticipantRecord | undefined;
  text: string;
  renderKey: string;
}): Promise<string> {
  const feishuAppId = input.participant?.feishuAppId ?? input.discussion.feishuAppId;
  const client = await input.deps.getClient(feishuAppId);
  if (!client) {
    throw new Error(`Feishu client not found for discussion render app ${feishuAppId ?? 'default'}`);
  }
  const result = await client.sendMessage(
    'chat_id',
    input.discussion.chatId,
    { msg_type: 'text', content: { text: input.text } },
    input.discussion.rootThreadId,
    { uuid: input.renderKey },
  );
  return result.messageId;
}

export async function renderDiscussionTurnsThrough(
  deps: DiscussionTurnRenderDeps,
  input: RenderDiscussionTurnsInput,
): Promise<void> {
  try {
    const discussion = await deps.loadDiscussion(input.discussionId);
    if (!discussion) {
      deps.logger.warn(
        { discussionId: input.discussionId, taskId: input.throughTaskId },
        'Skipping discussion turn render because discussion is missing',
      );
      return;
    }

    const [participants, transcript] = await Promise.all([
      deps.listParticipants(input.discussionId),
      deps.loadTranscript(input.discussionId),
    ]);
    const throughIndex = transcript.findIndex((turn) => turn.taskId === input.throughTaskId);
    if (throughIndex < 0) {
      deps.logger.warn(
        { discussionId: input.discussionId, taskId: input.throughTaskId },
        'Skipping discussion turn render because task-bound turn is missing',
      );
      return;
    }

    const renderableTurns = transcript.slice(0, throughIndex + 1);
    for (const turn of renderableTurns) {
      if (!isTerminalRenderableTurn(turn) || hasRender(turn.metadata, 'turn')) {
        continue;
      }
      const participant = participantForTurn(participants, turn);
      const renderKey = stableUuidFromKey(`discussion-turn-render:${turn.id}`);
      const messageId = await sendRenderMessage({
        deps,
        discussion,
        participant,
        text: buildTurnText(discussion, turn, participant),
        renderKey,
      });
      await deps.markRendered({
        turnId: turn.id,
        kind: 'turn',
        renderKey,
        messageId,
      });
      deps.logger.info(
        { discussionId: discussion.id, taskId: turn.taskId, turnId: turn.id, messageId },
        'Rendered discussion turn to Feishu thread',
      );
    }

    const currentTurn = transcript[throughIndex];
    const terminalTurnIndexes = transcript
      .map((turn, index) => (isTerminalRenderableTurn(turn) ? index : -1))
      .filter((index) => index >= 0);
    const isLatestTerminalTurn =
      terminalTurnIndexes.length > 0 &&
      terminalTurnIndexes[terminalTurnIndexes.length - 1] === throughIndex;
    const shouldRenderClosing =
      (input.includeClosing || discussion.status === 'completed') &&
      isLatestTerminalTurn &&
      !hasRender(currentTurn.metadata, 'closing');
    if (!shouldRenderClosing) {
      return;
    }

    const participant = participantForTurn(participants, currentTurn);
    const renderKey = stableUuidFromKey(`discussion-closing-render:${discussion.id}:${currentTurn.id}`);
    const messageId = await sendRenderMessage({
      deps,
      discussion,
      participant,
      text: buildClosingText(discussion),
      renderKey,
    });
    await deps.markRendered({
      turnId: currentTurn.id,
      kind: 'closing',
      renderKey,
      messageId,
    });
    deps.logger.info(
      { discussionId: discussion.id, taskId: currentTurn.taskId, turnId: currentTurn.id, messageId },
      'Rendered discussion closing message to Feishu thread',
    );
  } catch (err) {
    throw new DiscussionTurnRenderError('Discussion turn render failed', err);
  }
}
