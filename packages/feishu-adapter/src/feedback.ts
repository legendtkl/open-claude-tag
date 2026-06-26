import { escapeAtText } from './text-utils.js';
import { createLogger } from '@open-tag/observability';
import { truncateText } from '@open-tag/core-types';
import type { FeishuClient } from './feishu-client.js';
import {
  buildAckCard,
  buildRunningCard,
  buildDoneCardsFromSegments,
  buildFailedCardsFromSegments,
  buildRichCompletionReplyCard,
  splitTaskCardDetail,
  type InteractiveCard,
} from './card-builder.js';

interface UpdateDoneOptions {
  completionText?: string;
  allowedMentions?: Array<{ openId: string; name: string; isBot?: boolean }>;
}

export interface FeedbackDoneResult {
  sentMessageIds: string[];
  completionMessageId?: string;
}

const MAX_COMPLETION_NOTIFICATION_LENGTH = 2000;
const MAX_RENDERED_MENTION_COUNT = 20;
const MAX_MENTION_DISPLAY_NAME_LENGTH = 128;
const MENTION_OPEN_ID_PATTERN = /^[A-Za-z0-9_.@-]{1,128}$/;
const MENTION_PLACEHOLDER_PATTERN = /\{\{mention:([^}]*)\}\}/g;

interface PreparedCompletionNotification {
  text: string;
  richText?: string;
}

function truncateCompletionText(value: string): string {
  if (value.length <= MAX_COMPLETION_NOTIFICATION_LENGTH) {
    return value;
  }

  return truncateText(value, MAX_COMPLETION_NOTIFICATION_LENGTH - 16, {
    suffix: '... (truncated)',
    trimEnd: true,
  });
}

function renderMentionPlaceholders(
  value: string,
  allowedMentions?: Array<{ openId: string; name: string; isBot?: boolean }>,
): string {
  const allowedByOpenId =
    allowedMentions === undefined
      ? null
      : new Map(
          allowedMentions
            .filter((mention) => !mention.isBot && mention.openId && mention.name)
            .map((mention) => [mention.openId, mention.name.trim()] as const),
        );
  let renderedCount = 0;
  const rendered = value.replace(
    MENTION_PLACEHOLDER_PATTERN,
    (_placeholder, rawPlaceholderBody: string) => {
      const separatorIndex = rawPlaceholderBody.indexOf(':');
      if (separatorIndex <= 0) {
        return '';
      }

      const openId = rawPlaceholderBody.slice(0, separatorIndex).trim();
      const trimmedName = rawPlaceholderBody.slice(separatorIndex + 1).trim();
      if (
        !MENTION_OPEN_ID_PATTERN.test(openId) ||
        !trimmedName ||
        trimmedName.length > MAX_MENTION_DISPLAY_NAME_LENGTH
      ) {
        return '';
      }
      const allowedName = allowedByOpenId?.get(openId);
      if (allowedByOpenId && !allowedName) {
        return '';
      }
      if (renderedCount >= MAX_RENDERED_MENTION_COUNT) {
        return '';
      }
      renderedCount += 1;
      const displayName = allowedName ?? trimmedName;
      return `<at user_id="${openId}">${escapeAtText(displayName)}</at>`;
    },
  );
  return rendered.replace(/[ \t]{2,}/g, ' ').trim();
}

function prepareCompletionNotification(
  description: string,
  completionText?: string,
  allowedMentions?: Array<{ openId: string; name: string; isBot?: boolean }>,
): PreparedCompletionNotification {
  const trimmed = completionText?.trim();
  if (!trimmed) {
    return { text: `Task complete\nTask: ${description}` };
  }

  const renderedText = renderMentionPlaceholders(trimmed, allowedMentions);
  if (!renderedText) {
    return { text: `Task complete\nTask: ${description}` };
  }

  return {
    text: truncateCompletionText(renderedText),
    richText: renderedText,
  };
}

export class ThreePhaseFeedback {
  private ackMessageId: string | null = null;
  private readonly logger = createLogger('three-phase-feedback');

  constructor(
    private readonly client: FeishuClient,
    private readonly chatId: string,
    private readonly replyToMessageId?: string,
    initialAckMessageId?: string,
  ) {
    if (initialAckMessageId) {
      this.ackMessageId = initialAckMessageId;
    }
  }

  async sendAck(description: string): Promise<void> {
    const card = buildAckCard(description);
    const result = await this.client.sendMessage(
      'chat_id',
      this.chatId,
      card,
      this.replyToMessageId,
    );
    this.ackMessageId = result.messageId;
  }

  async updateRunning(
    description: string,
    progress?: number,
    recentActivity?: string[],
    workDir?: string,
  ): Promise<void> {
    if (!this.ackMessageId) return;
    try {
      const card = buildRunningCard(description, progress, recentActivity, workDir);
      await this.client.updateMessage(this.ackMessageId, card);
    } catch (err) {
      this.logger.warn(
        { err, ackMessageId: this.ackMessageId, description },
        'Failed to update running card',
      );
      // Swallow card update errors so they don't crash task execution
    }
  }

  async updateDone(
    description: string,
    result?: string,
    options: UpdateDoneOptions = {},
  ): Promise<FeedbackDoneResult | undefined> {
    if (!this.ackMessageId) return undefined;
    const sentMessageIds: string[] = [];
    const detailSegments = splitTaskCardDetail(result);
    const cards = buildDoneCardsFromSegments(description, detailSegments);
    try {
      await this.client.updateMessage(this.ackMessageId, cards[0]);
    } catch (err) {
      this.logger.warn(
        { err, ackMessageId: this.ackMessageId, description },
        'Failed to update done card',
      );
      const fallbackMessageIds = await this.sendTextFallback(
        'Task complete',
        description,
        detailSegments,
      );
      return { sentMessageIds: fallbackMessageIds };
    }

    if (cards.length > 1) {
      sentMessageIds.push(
        ...(await this.sendOverflowCards(
          'Task complete (continued)',
          description,
          cards.slice(1),
          detailSegments.slice(1),
        )),
      );
    }

    try {
      const completionMessageId = await this.sendCompletionNotification(
        description,
        options.completionText,
        options.allowedMentions,
      );
      if (completionMessageId) {
        sentMessageIds.push(completionMessageId);
      }
      return { sentMessageIds, completionMessageId };
    } catch (err) {
      this.logger.warn(
        { err, ackMessageId: this.ackMessageId, description },
        'Failed to send completion notification',
      );
      return { sentMessageIds };
    }
  }

  async updateFailed(description: string, error: string): Promise<void> {
    if (!this.ackMessageId) return;
    const detailSegments = splitTaskCardDetail(error);
    const cards = buildFailedCardsFromSegments(description, detailSegments);
    try {
      await this.client.updateMessage(this.ackMessageId, cards[0]);
    } catch (err) {
      this.logger.warn(
        { err, ackMessageId: this.ackMessageId, description },
        'Failed to update failed card',
      );
      await this.sendTextFallback('Task failed', description, detailSegments);
      return;
    }

    if (cards.length > 1) {
      await this.sendOverflowCards(
        'Task failed (continued)',
        description,
        cards.slice(1),
        detailSegments.slice(1),
      );
    }
  }

  async notifyQuotaExceeded(description: string, error: string): Promise<void> {
    const retryMatch = error.match(/try again at (.+?)\.?$/i);
    const retryInfo = retryMatch ? ` You can retry after ${retryMatch[1]}.` : '';
    const text = [
      'Codex usage limit reached',
      `Task: ${description}`,
      '',
      `The Codex quota has been exhausted — this task could not be executed.${retryInfo}`,
      `Original error: ${error}`,
    ].join('\n');

    try {
      await this.client.sendMessage(
        'chat_id',
        this.chatId,
        { msg_type: 'text' as const, content: { text } },
        this.getFollowUpReplyTarget(),
      );
    } catch (err) {
      this.logger.error({ err, description }, 'Failed to send quota exceeded notification');
    }
  }

  getAckMessageId(): string | null {
    return this.ackMessageId;
  }

  private getFollowUpReplyTarget(): string | undefined {
    return this.replyToMessageId ?? this.ackMessageId ?? undefined;
  }

  private async sendCompletionNotification(
    description: string,
    completionText?: string,
    allowedMentions?: Array<{ openId: string; name: string; isBot?: boolean }>,
  ): Promise<string | undefined> {
    const notification = prepareCompletionNotification(description, completionText, allowedMentions);
    const richCard = notification.richText
      ? buildRichCompletionReplyCard(notification.richText)
      : undefined;
    if (richCard) {
      try {
        const result = await this.client.sendMessage(
          'chat_id',
          this.chatId,
          richCard,
          this.getFollowUpReplyTarget(),
        );
        return result.messageId;
      } catch (err) {
        this.logger.warn(
          { err, ackMessageId: this.ackMessageId, description },
          'Failed to send rich completion card, falling back to text',
        );
      }
    }

    const result = await this.client.sendMessage(
      'chat_id',
      this.chatId,
      {
        msg_type: 'text',
        content: { text: notification.text },
      },
      this.getFollowUpReplyTarget(),
    );
    return result.messageId;
  }

  private async sendOverflowCards(
    fallbackTitle: string,
    description: string,
    overflowCards: InteractiveCard[],
    overflowSegments: string[],
  ): Promise<string[]> {
    const sentMessageIds: string[] = [];
    for (const [index, card] of overflowCards.entries()) {
      try {
        const result = await this.client.sendMessage(
          'chat_id',
          this.chatId,
          card,
          this.getFollowUpReplyTarget(),
        );
        if (result.messageId) {
          sentMessageIds.push(result.messageId);
        }
      } catch (err) {
        this.logger.warn(
          { err, ackMessageId: this.ackMessageId, description, index },
          'Failed to send overflow card',
        );
        sentMessageIds.push(
          ...(await this.sendTextFallback(
            fallbackTitle,
            description,
            overflowSegments.slice(index),
          )),
        );
        return sentMessageIds;
      }
    }

    return sentMessageIds;
  }

  private async sendTextFallback(
    title: string,
    description: string,
    detail?: string | string[],
  ): Promise<string[]> {
    const sentMessageIds: string[] = [];
    try {
      const detailSegments = Array.isArray(detail) ? detail : splitTaskCardDetail(detail);
      const messages = detailSegments.length > 0 ? detailSegments : [undefined];

      for (const [index, segment] of messages.entries()) {
        const lines = [
          index === 0 || messages.length === 1
            ? title
            : `${title} (${index + 1}/${messages.length})`,
          `Task: ${description}`,
        ];
        if (segment?.trim()) {
          lines.push('', segment);
        }
        const result = await this.client.sendMessage(
          'chat_id',
          this.chatId,
          {
            msg_type: 'text',
            content: { text: lines.join('\n') },
          },
          this.getFollowUpReplyTarget(),
        );
        if (result.messageId) {
          sentMessageIds.push(result.messageId);
        }
      }
    } catch (fallbackErr) {
      this.logger.error(
        { err: fallbackErr, ackMessageId: this.ackMessageId, description, title },
        'Failed to send text fallback',
      );
    }
    return sentMessageIds;
  }
}
