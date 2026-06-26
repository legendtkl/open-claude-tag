import { isObjectRecord as isRecord } from '@open-tag/core-types';

export interface FeishuRuntimeMention {
  openId: string;
  name: string;
  isBot: boolean;
  key?: string;
  index?: number;
}

export interface FeishuRuntimeContext {
  chatId?: string;
  replyToMessageId?: string;
  senderOpenId?: string;
  text?: string;
  mentions: FeishuRuntimeMention[];
}

export interface RuntimeFinalReplyExtraction {
  outputText: string;
  finalReplyText?: string;
}

const FINAL_REPLY_BLOCK_PATTERN =
  /<openClaudeTag_final_reply>([\s\S]*?)<\/openClaudeTag_final_reply>/gi;

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parseMentions(value: unknown): FeishuRuntimeMention[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((mention): FeishuRuntimeMention | null => {
      if (!isRecord(mention)) {
        return null;
      }
      const openId = optionalString(mention.openId);
      const name = optionalString(mention.name);
      if (!openId || !name) {
        return null;
      }

      return {
        openId,
        name,
        isBot: mention.isBot === true,
        key: optionalString(mention.key),
        index: optionalNumber(mention.index),
      };
    })
    .filter((mention): mention is FeishuRuntimeMention => mention !== null);
}

export function getFeishuRuntimeContextFromConstraints(
  constraints: unknown,
): FeishuRuntimeContext | undefined {
  if (!isRecord(constraints) || !isRecord(constraints.feishuContext)) {
    return undefined;
  }

  const context = constraints.feishuContext;
  const mentions = parseMentions(context.mentions);
  return {
    chatId: optionalString(context.chatId),
    replyToMessageId: optionalString(context.replyToMessageId),
    senderOpenId: optionalString(context.senderOpenId),
    text: optionalString(context.text),
    mentions,
  };
}

export function buildFeishuRuntimeContextGuidance(
  context: FeishuRuntimeContext | undefined,
): string | undefined {
  if (!context) {
    return undefined;
  }

  const mentionableUsers = context.mentions
    .filter((mention) => !mention.isBot)
    .map((mention) => ({ openId: mention.openId, name: mention.name }));
  const serializedContext = JSON.stringify(
    {
      chatId: context.chatId,
      replyToMessageId: context.replyToMessageId,
      text: context.text,
      mentionableUsers,
    },
    null,
    2,
  );
  return [
    'Feishu request context is available for composing the final user-facing reply.',
    '<feishu_context>',
    serializedContext,
    '</feishu_context>',
    '',
    'The system will send the final completion notification to the original chat/thread. Do not choose or request another destination chat, receive_id, or reply target.',
    'Do not mention the sender by default. Only mention someone when the user explicitly asked you to notify or address that person.',
    'If the final user-facing reply should mention someone, use placeholders in this exact form: {{mention:open_id:name}}.',
    'Only use open_id/name pairs from mentionableUsers. Do not mention bots, senderOpenId, or invented open IDs.',
    'If mentionableUsers is empty, do not use mention placeholders.',
    'Optionally include the final user-facing reply at the end of your response:',
    '<openClaudeTag_final_reply>',
    'Your final Feishu message here, optionally with {{mention:open_id:name}} placeholders.',
    '</openClaudeTag_final_reply>',
  ].join('\n');
}

export function appendFeishuRuntimeContextGuidance(
  basePrompt: string | undefined,
  context: FeishuRuntimeContext | undefined,
): string | undefined {
  const guidance = buildFeishuRuntimeContextGuidance(context);
  if (!guidance) {
    return basePrompt;
  }

  return basePrompt ? `${basePrompt}\n\n${guidance}` : guidance;
}

export function extractRuntimeFinalReply(outputText: string): RuntimeFinalReplyExtraction {
  let finalReplyMatch: RegExpExecArray | null = null;
  FINAL_REPLY_BLOCK_PATTERN.lastIndex = 0;
  for (;;) {
    const match = FINAL_REPLY_BLOCK_PATTERN.exec(outputText);
    if (!match) break;
    finalReplyMatch = match;
  }

  if (!finalReplyMatch) {
    return { outputText };
  }

  const finalReplyText = finalReplyMatch[1]?.trim() ?? '';
  const beforeFinalReply = outputText.slice(0, finalReplyMatch.index).trimEnd();
  const afterFinalReply = outputText
    .slice(finalReplyMatch.index + finalReplyMatch[0].length)
    .trimStart();
  const cleanedOutput = [beforeFinalReply, afterFinalReply].filter(Boolean).join('\n\n').trim();
  return finalReplyText
    ? { outputText: cleanedOutput, finalReplyText }
    : { outputText: cleanedOutput };
}
