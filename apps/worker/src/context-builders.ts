import type { Logger } from 'pino';
import {
  buildContext,
  type ContextImageAttachment,
  type SharedContextGist,
} from '@open-tag/session';
import { SharedContextStore } from '@open-tag/memory';
import { loadChatMemoryPromptSection, type Database } from '@open-tag/storage';

/**
 * Fetch the session's verified shared context (DeLM C) as compact gists. This is
 * the runtime-neutral / location-neutral hydration channel: it is injected on
 * the fresh/hydrate path (cross-kind or cross-machine handoff), where SDK resume
 * and the shared working directory are unavailable. Degrades to [] on error.
 */
async function loadSharedContextGists(
  database: Database,
  logger: Logger,
  sessionId: string,
): Promise<SharedContextGist[]> {
  try {
    const entries = await new SharedContextStore(database).list({ sessionId });
    return entries.map((e) => ({
      memoryType: e.memoryType,
      gist: e.gist,
      authorAgentKind: e.authorAgentKind,
    }));
  } catch (err) {
    logger.warn({ sessionId, err }, 'Failed to load verified shared context');
    return [];
  }
}

export interface ContextualGoalOptions {
  agentId?: string;
  includeSessionHistory?: boolean;
  delegationContextPackage?: string;
  currentMessageId?: string;
  currentImageAttachment?: { imageKey: string; messageId: string };
  chatMemory?: { tenantKey: string; chatId: string };
}

export interface ContextualExecutionContext {
  goal: string;
  imageAttachments: Array<{ imageKey: string; messageId: string }>;
}

const MAX_CONTEXT_IMAGE_ATTACHMENTS = 8;

async function loadChatMemorySection(
  database: Database,
  logger: Logger,
  input:
    | {
        tenantKey: string;
        chatId: string;
        request: string;
      }
    | undefined,
): Promise<string> {
  if (!input) return '';
  try {
    return await loadChatMemoryPromptSection(database, input);
  } catch (err) {
    logger.warn(
      { err, tenantKey: input.tenantKey, chatId: input.chatId },
      'Failed to load chat memory context',
    );
    return '';
  }
}

/** Build a contextualized goal and portable attachments when SDK resume is unavailable. */
export async function buildContextualExecutionContext(
  database: Database,
  logger: Logger,
  sessionId: string,
  goal: string,
  taskId: string,
  systemPromptHint: string,
  contextOptions: ContextualGoalOptions = {},
): Promise<ContextualExecutionContext> {
  try {
    const [sharedContextEntries, chatMemorySection] = await Promise.all([
      loadSharedContextGists(database, logger, sessionId),
      loadChatMemorySection(
        database,
        logger,
        contextOptions.chatMemory
          ? {
              ...contextOptions.chatMemory,
              request: goal,
            }
          : undefined,
      ),
    ]);
    const builtContext = await buildContext(database, sessionId, systemPromptHint, {
      agentId: contextOptions.agentId,
      includeSessionHistory: contextOptions.includeSessionHistory,
      delegationContextPackage: contextOptions.delegationContextPackage,
      sharedContextEntries,
    });
    const hasChatMemory = Boolean(chatMemorySection);
    const hasMemory = Boolean(builtContext.memorySection);

    // Filter out the current user message by stable Feishu id to avoid
    // dropping older messages that happen to have the same text.
    const historyTurns = builtContext.recentTurns.filter((t) => {
      if (!contextOptions.currentMessageId) return true;
      return !(t.role === 'user' && t.messageId === contextOptions.currentMessageId);
    });
    // Legacy/debug jobs may not have a message id. In that case only drop the
    // final duplicate turn, not every historical turn with identical content.
    if (historyTurns.length > 0) {
      const last = historyTurns[historyTurns.length - 1];
      if (
        !contextOptions.currentMessageId &&
        last.role === 'user' &&
        last.content.trim() === goal.trim()
      ) {
        historyTurns.pop();
      }
    }
    const hasTurns = historyTurns.length > 0;
    const imageFilterResult = filterCurrentRequestImages(builtContext.recentImageAttachments, {
      currentMessageId: contextOptions.currentMessageId,
      currentImageAttachment: contextOptions.currentImageAttachment,
      maxImages: MAX_CONTEXT_IMAGE_ATTACHMENTS,
    });
    const imageAttachments = imageFilterResult.attachments;
    const hasImages = imageAttachments.length > 0;

    if (!hasChatMemory && !hasMemory && !hasTurns && !hasImages) {
      return { goal, imageAttachments: [] };
    }

    let prefix = '';
    if (hasChatMemory) {
      prefix += `<chat_memory>\n${chatMemorySection}\n</chat_memory>\n\n`;
    }
    if (hasMemory) {
      prefix += `<session_memory>\n${builtContext.memorySection}\n</session_memory>\n\n`;
    }
    if (hasTurns) {
      const historyLines = historyTurns
        .map((t) => `<turn role="${t.role}">${t.content}</turn>`)
        .join('\n');
      prefix += `<conversation_history>\n${historyLines}\n</conversation_history>\n\n`;
    }
    if (hasImages) {
      const imageLines = imageAttachments
        .map(
          (attachment, index) =>
            `<image index="${index + 1}" role="${escapeXmlAttribute(attachment.sourceRole)}" messageId="${escapeXmlAttribute(attachment.messageId)}" imageKey="${escapeXmlAttribute(attachment.imageKey)}">${escapeXmlText(attachment.sourceContent)}</image>`,
        )
        .join('\n');
      const truncationAttrs =
        imageFilterResult.omittedCount > 0
          ? ` truncated="true" omitted="${imageFilterResult.omittedCount}"`
          : '';
      prefix += `<conversation_images${truncationAttrs}>\n${imageLines}\n</conversation_images>\n\n`;
    }

    logger.info(
      {
        taskId,
        agentId: contextOptions.agentId,
        turnCount: historyTurns.length,
        imageCount: imageAttachments.length,
        omittedImageCount: imageFilterResult.omittedCount,
        historyTokens: builtContext.totalTokens,
        compactTriggered: builtContext.compactTriggered,
      },
      'Injected conversation history into prompt',
    );

    // Log compaction pressure (actual compaction should be handled by a dedicated process)
    if (builtContext.compactTriggered !== 'none') {
      logger.warn(
        { sessionId, compactTriggered: builtContext.compactTriggered },
        'Session context budget pressure detected',
      );
    }

    return {
      goal: `${prefix}<current_request>\n${goal}\n</current_request>`,
      imageAttachments: imageAttachments.map((attachment) => ({
        imageKey: attachment.imageKey,
        messageId: attachment.messageId,
      })),
    };
  } catch (err) {
    logger.warn({ taskId, err }, 'Failed to build context, using original goal');
    return { goal, imageAttachments: [] };
  }
}

/** Build a contextualized goal by injecting conversation history from DB when SDK resume is unavailable. */
export async function buildContextualGoal(
  database: Database,
  logger: Logger,
  sessionId: string,
  goal: string,
  taskId: string,
  systemPromptHint: string,
  contextOptions: ContextualGoalOptions = {},
): Promise<string> {
  return (
    await buildContextualExecutionContext(
      database,
      logger,
      sessionId,
      goal,
      taskId,
      systemPromptHint,
      contextOptions,
    )
  ).goal;
}

function filterCurrentRequestImages(
  attachments: ContextImageAttachment[],
  options: {
    currentMessageId?: string;
    currentImageAttachment?: { imageKey: string; messageId: string };
    maxImages: number;
  },
): { attachments: ContextImageAttachment[]; omittedCount: number } {
  const currentImageKey = options.currentImageAttachment
    ? `${options.currentImageAttachment.messageId}:${options.currentImageAttachment.imageKey}`
    : undefined;
  const filtered = attachments.filter((attachment) => {
    if (
      options.currentMessageId &&
      attachment.sourceRole === 'user' &&
      attachment.messageId === options.currentMessageId
    ) {
      return false;
    }
    if (currentImageKey === `${attachment.messageId}:${attachment.imageKey}`) {
      return false;
    }
    return true;
  });
  const seen = new Set<string>();
  const deduped = filtered.filter((attachment) => {
    const key = `${attachment.messageId}:${attachment.imageKey}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (deduped.length <= options.maxImages) {
    return { attachments: deduped, omittedCount: 0 };
  }
  return {
    attachments: deduped.slice(-options.maxImages),
    omittedCount: deduped.length - options.maxImages,
  };
}

function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value).replace(/"/g, '&quot;');
}

function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
