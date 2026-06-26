import type { NormalizedEvent } from '@open-tag/core-types';
import { escapeRegExp, normalizeMentionName } from './discussion-mention-parser.js';

type EventMention = NonNullable<NormalizedEvent['content']['mentions']>[number];

export interface UnassignedBotIdentity {
  feishuAppId: string;
  appId?: string | null;
  botOpenId?: string | null;
  botName?: string | null;
}

function mentionMatchesBot(mention: EventMention, bot: UnassignedBotIdentity): boolean {
  const mentionId = mention.id?.trim();
  if (mentionId && (mentionId === bot.appId || mentionId === bot.botOpenId)) return true;

  const mentionName = normalizeMentionName(mention.name ?? '');
  const botName = normalizeMentionName(bot.botName ?? '');
  return Boolean(mentionName && botName && mentionName === botName);
}

function removeMentionLabels(text: string | undefined, mentions: EventMention[]): string | undefined {
  if (!text || mentions.length === 0) return text;

  let result = text;
  for (const mention of mentions) {
    const labels = [
      mention.key,
      normalizeMentionName(mention.name ?? '') ? `@${normalizeMentionName(mention.name ?? '')}` : '',
    ].filter((label): label is string => Boolean(label));
    for (const label of labels) {
      result = result.replace(
        new RegExp(`(^|\\s)${escapeRegExp(label)}(?=\\s|[，,。；;:：!?！？]|$)`, 'g'),
        ' ',
      );
    }
  }
  return result.replace(/\s+/g, ' ').trim();
}

export function stripUnassignedBotMentionsFromAgentEvent(
  event: NormalizedEvent,
  selectedFeishuAppId: string | undefined,
  unassignedBots: UnassignedBotIdentity[],
): NormalizedEvent {
  if (!selectedFeishuAppId || unassignedBots.length === 0 || !event.content.mentions?.length) {
    return event;
  }

  const strippedMentions = event.content.mentions.filter((mention) =>
    unassignedBots.some(
      (bot) => bot.feishuAppId !== selectedFeishuAppId && mentionMatchesBot(mention, bot),
    ),
  );
  if (strippedMentions.length === 0) return event;

  const nextText = removeMentionLabels(event.content.text, strippedMentions);
  const nextArgs = removeMentionLabels(event.content.args, strippedMentions);

  return {
    ...event,
    content: {
      ...event.content,
      ...(nextText !== event.content.text ? { text: nextText } : {}),
      ...(nextArgs !== event.content.args ? { args: nextArgs } : {}),
    },
  };
}
