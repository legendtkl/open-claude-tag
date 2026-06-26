import type { DueChatMemoryConfig } from '@open-tag/storage';
import {
  DEFAULT_CHAT_MEMORY_SUMMARY_TIME,
  computeNextDailyRunAt,
  parseChatMemoryUpdateBlock,
} from '@open-tag/storage';

export const CHAT_MEMORY_SUMMARY_TASK_TYPE = 'chat_memory_summary';

type ChatMemorySummaryStatus = 'completed' | 'failed' | 'invalid_update';

interface LoggerLike {
  info?(metadata: Record<string, unknown>, message: string): void;
  warn?(metadata: Record<string, unknown>, message: string): void;
  error?(metadata: Record<string, unknown>, message: string): void;
}

export interface ChatMemoryRecentMessage {
  role: string;
  content: string;
  createdAt?: Date | string | null;
}

export interface ChatMemorySummarySchedulerDeps {
  listDueConfigs(input: { now: Date; limit: number }): Promise<DueChatMemoryConfig[]>;
  markEnqueued(input: { tenantKey: string; chatId: string; nextRunAt: Date | null }): Promise<void>;
  markResult(input: {
    tenantKey: string;
    chatId: string;
    status: ChatMemorySummaryStatus;
    error?: string | null;
    ranAt?: Date;
  }): Promise<void>;
  createSummaryTask(input: {
    config: DueChatMemoryConfig;
    now: Date;
    nextRunAt: Date | null;
  }): Promise<void>;
  logger?: LoggerLike;
}

export interface ChatMemorySummaryCompletionDeps {
  commitUpdate(input: {
    tenantKey: string;
    chatId: string;
    rawUpdate: unknown;
    sourceTaskId: string;
  }): Promise<unknown>;
  markResult(input: {
    tenantKey: string;
    chatId: string;
    status: ChatMemorySummaryStatus;
    error?: string | null;
    ranAt?: Date;
  }): Promise<void>;
  logger?: LoggerLike;
}

export async function runChatMemorySummarySchedulerOnce(
  deps: ChatMemorySummarySchedulerDeps,
  input: { now: Date; limit: number },
): Promise<{ due: number; enqueued: number; failed: number }> {
  const dueConfigs = await deps.listDueConfigs(input);
  let enqueued = 0;
  let failed = 0;

  for (const config of dueConfigs) {
    let nextRunAt: Date | null;
    const summaryTime = config.memorySummaryTime ?? DEFAULT_CHAT_MEMORY_SUMMARY_TIME;
    try {
      nextRunAt = computeNextDailyRunAt(input.now, summaryTime, config.memorySummaryTimezone);
    } catch (err) {
      await deps.markEnqueued({
        tenantKey: config.tenantKey,
        chatId: config.chatId,
        nextRunAt: null,
      });
      await deps.markResult({
        tenantKey: config.tenantKey,
        chatId: config.chatId,
        status: 'failed',
        error: errorText(err),
        ranAt: input.now,
      });
      deps.logger?.warn?.(
        { err, tenantKey: config.tenantKey, chatId: config.chatId },
        'Disabled chat memory summary after invalid schedule',
      );
      failed += 1;
      continue;
    }

    if (!nextRunAt) {
      await deps.markEnqueued({
        tenantKey: config.tenantKey,
        chatId: config.chatId,
        nextRunAt: null,
      });
      await deps.markResult({
        tenantKey: config.tenantKey,
        chatId: config.chatId,
        status: 'failed',
        error: 'Chat memory summary schedule is invalid',
        ranAt: input.now,
      });
      failed += 1;
      continue;
    }

    await deps.markEnqueued({
      tenantKey: config.tenantKey,
      chatId: config.chatId,
      nextRunAt,
    });

    const validationError = validateDueConfig(config);
    if (validationError) {
      await deps.markResult({
        tenantKey: config.tenantKey,
        chatId: config.chatId,
        status: 'failed',
        error: validationError,
        ranAt: input.now,
      });
      failed += 1;
      continue;
    }

    try {
      await deps.createSummaryTask({ config, now: input.now, nextRunAt });
      enqueued += 1;
    } catch (err) {
      await deps.markResult({
        tenantKey: config.tenantKey,
        chatId: config.chatId,
        status: 'failed',
        error: errorText(err),
        ranAt: input.now,
      });
      deps.logger?.error?.(
        { err, tenantKey: config.tenantKey, chatId: config.chatId },
        'Failed to enqueue chat memory summary task',
      );
      failed += 1;
    }
  }

  return { due: dueConfigs.length, enqueued, failed };
}

export function buildChatMemorySummaryGoal(input: {
  tenantKey: string;
  chatId: string;
  generatedAt: Date;
  recentMessages: ChatMemoryRecentMessage[];
}): string {
  const transcript = input.recentMessages.length
    ? input.recentMessages
        .map((message) => {
          const timestamp =
            message.createdAt instanceof Date
              ? message.createdAt.toISOString()
              : (message.createdAt ?? 'unknown time');
          return `- [${timestamp}] ${message.role}: ${message.content}`;
        })
        .join('\n')
    : '- No recent persisted chat messages were available.';

  return [
    `Maintain durable memory for Feishu group chat ${input.chatId} in tenant ${input.tenantKey}.`,
    `Generated at: ${input.generatedAt.toISOString()}.`,
    '',
    'Use the recent transcript below and any injected <chat_memory> context to produce the next durable group-chat memory state.',
    'Keep durable project facts, standing preferences, recurring decisions, named workstreams, and unresolved follow-ups. Drop transient chatter, one-off acknowledgements, and secrets.',
    'Preserve useful prior memory even when the recent transcript is sparse.',
    '',
    'Return a concise completion note and exactly one parseable XML block with this JSON shape:',
    '<open_claude_tag_chat_memory_update>',
    '{"index":{"content":"short map of durable group memory","keywords":["keyword"],"importanceScore":1},"details":[{"title":"topic","content":"durable detail","keywords":["keyword"],"importanceScore":1}]}',
    '</open_claude_tag_chat_memory_update>',
    '',
    'Recent group transcript:',
    transcript,
  ].join('\n');
}

export async function handleChatMemorySummaryCompletion(
  deps: ChatMemorySummaryCompletionDeps,
  input: {
    taskId: string;
    taskType: string;
    constraints: Record<string, unknown>;
    outputText: string;
    now?: Date;
  },
): Promise<'skipped' | 'completed' | 'invalid_update' | 'failed'> {
  const target = extractChatMemorySummaryTarget(input.taskType, input.constraints);
  if (!target) return 'skipped';

  const rawUpdate = parseChatMemoryUpdateBlock(input.outputText);
  if (!rawUpdate) {
    await deps.markResult({
      tenantKey: target.tenantKey,
      chatId: target.chatId,
      status: 'invalid_update',
      error: 'Missing or invalid <open_claude_tag_chat_memory_update> JSON block',
      ranAt: input.now,
    });
    return 'invalid_update';
  }

  try {
    await deps.commitUpdate({
      tenantKey: target.tenantKey,
      chatId: target.chatId,
      rawUpdate,
      sourceTaskId: input.taskId,
    });
    await deps.markResult({
      tenantKey: target.tenantKey,
      chatId: target.chatId,
      status: 'completed',
      error: null,
      ranAt: input.now,
    });
    return 'completed';
  } catch (err) {
    await deps.markResult({
      tenantKey: target.tenantKey,
      chatId: target.chatId,
      status: 'invalid_update',
      error: errorText(err),
      ranAt: input.now,
    });
    deps.logger?.warn?.(
      { err, taskId: input.taskId, tenantKey: target.tenantKey, chatId: target.chatId },
      'Rejected invalid chat memory summary update',
    );
    return 'invalid_update';
  }
}

export async function handleChatMemorySummaryFailure(
  deps: Pick<ChatMemorySummaryCompletionDeps, 'markResult' | 'logger'>,
  input: {
    taskId: string;
    taskType: string;
    constraints: Record<string, unknown>;
    errorMessage: string;
    now?: Date;
  },
): Promise<'skipped' | 'failed'> {
  const target = extractChatMemorySummaryTarget(input.taskType, input.constraints);
  if (!target) return 'skipped';

  await deps.markResult({
    tenantKey: target.tenantKey,
    chatId: target.chatId,
    status: 'failed',
    error: input.errorMessage,
    ranAt: input.now,
  });
  deps.logger?.warn?.(
    { taskId: input.taskId, tenantKey: target.tenantKey, chatId: target.chatId },
    'Recorded failed chat memory summary task',
  );
  return 'failed';
}

function extractChatMemorySummaryTarget(
  taskType: string,
  constraints: Record<string, unknown>,
): { tenantKey: string; chatId: string } | null {
  if (taskType !== CHAT_MEMORY_SUMMARY_TASK_TYPE && constraints.chatMemorySummary !== true) {
    return null;
  }
  const tenantKey = typeof constraints.tenantKey === 'string' ? constraints.tenantKey : 'default';
  const chatId = typeof constraints.chatId === 'string' ? constraints.chatId : '';
  return chatId ? { tenantKey, chatId } : null;
}

function validateDueConfig(config: DueChatMemoryConfig): string | null {
  if (!config.memorySummaryAgentId) return 'No active chat agent is available for chat memory summary';
  if (config.agentStatus !== 'active') return 'Chat memory summary agent is not active';
  return null;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
