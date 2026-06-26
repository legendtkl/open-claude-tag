import {
  inferReplyLanguageFromText,
  isSlashCommand,
  mapFeishuLocaleToReplyLanguage,
} from '@open-tag/core-types';
import type { NormalizedEvent, ReplyLanguage } from '@open-tag/core-types';

interface FeishuMessageEvent {
  schema?: string;
  header?: {
    event_id: string;
    event_type: string;
    create_time: string;
    token: string;
    app_id: string;
    tenant_key: string;
  };
  event?: {
    sender?: {
      sender_id?: {
        open_id?: string;
        union_id?: string;
      };
      sender_type?: string;
      tenant_key?: string;
    };
    message?: {
      message_id?: string;
      root_id?: string;
      parent_id?: string;
      thread_id?: string;
      chat_id?: string;
      chat_type?: string;
      message_type?: string;
      content?: string;
      mentions?: Array<{
        key: string;
        id: { open_id?: string; union_id?: string; app_id?: string };
        name: string;
        tenant_key?: string;
      }>;
    };
  };
}

type JsonRecord = Record<string, unknown>;

export interface NormalizerConfig {
  botOpenId: string;
  appId?: string;
}

export interface NormalizedDocumentCommentMention {
  id: string;
  name: string;
  isBot: boolean;
  key?: string;
  index?: number;
}

export interface NormalizedDocumentCommentThreadReply {
  replyId: string;
  userId?: string;
  createTime?: number;
  text: string;
}

export interface NormalizedDocumentCommentEvent {
  eventId: string;
  tenantKey: string;
  appId?: string;
  noticeType?: string;
  fileToken: string;
  fileType: string;
  documentUrl: string;
  commentId: string;
  replyId?: string;
  quote?: string;
  isWhole?: boolean;
  senderOpenId: string;
  senderUnionId?: string;
  senderType?: string;
  text: string;
  mentions: NormalizedDocumentCommentMention[];
  threadReplies?: NormalizedDocumentCommentThreadReply[];
  replyLanguage?: ReplyLanguage;
  timestamp: number;
  raw: unknown;
}

interface PostContent {
  text: string;
  imageKey?: string;
  locale?: string;
}

type FileAttachment = NonNullable<NormalizedEvent['content']['fileAttachment']>;

type RawMention = NonNullable<
  NonNullable<NonNullable<FeishuMessageEvent['event']>['message']>['mentions']
>[number];

const MENTION_TOKEN_PATTERN = /@_user_\d+/g;
const COMMANDS_WITH_USER_TEXT_ARGS = new Set(['/schedule']);

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function recordValue(value: unknown): JsonRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function firstStringValue(record: JsonRecord | undefined, keys: string[]): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = stringValue(record[key]);
    if (value) return value;
  }
  return undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes'].includes(normalized)) return true;
    if (['false', '0', 'no'].includes(normalized)) return false;
  }
  return undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function normalizeResourceType(messageType: string | undefined): FileAttachment['resourceType'] {
  return messageType === 'audio' || messageType === 'media' ? messageType : 'file';
}

function extractFileAttachment(input: {
  messageType?: string;
  parsed: Record<string, unknown>;
  messageId: string;
}): FileAttachment | undefined {
  if (!['file', 'audio', 'media'].includes(input.messageType ?? '')) {
    return undefined;
  }

  const resourceKey =
    stringValue(input.parsed.file_key) ??
    stringValue(input.parsed.fileKey) ??
    stringValue(input.parsed.media_key) ??
    stringValue(input.parsed.mediaKey);
  if (!resourceKey) {
    return undefined;
  }

  return {
    resourceKey,
    messageId: input.messageId,
    resourceType: normalizeResourceType(input.messageType),
    ...(stringValue(input.parsed.file_name) ?? stringValue(input.parsed.fileName)
      ? { fileName: stringValue(input.parsed.file_name) ?? stringValue(input.parsed.fileName) }
      : {}),
    ...(stringValue(input.parsed.mime_type) ?? stringValue(input.parsed.mimeType)
      ? { mimeType: stringValue(input.parsed.mime_type) ?? stringValue(input.parsed.mimeType) }
      : {}),
  };
}

function fileAttachmentText(fileAttachment: FileAttachment | undefined): string {
  if (!fileAttachment) return '';
  const label =
    fileAttachment.resourceType === 'audio'
      ? 'audio'
      : fileAttachment.resourceType === 'media'
        ? 'media'
        : 'file';
  return `[Feishu ${label}: ${fileAttachment.fileName ?? fileAttachment.resourceKey}]`;
}

function findSlashCommandIndex(text: string): number {
  return /\/[a-z][a-z0-9-]*/i.exec(text)?.index ?? -1;
}

function findCommandAddressMention(text: string, mentions: RawMention[]): RawMention | undefined {
  const commandIndex = findSlashCommandIndex(text);
  if (commandIndex < 0) return undefined;

  return mentions
    .map((mention) => ({ mention, index: text.indexOf(mention.key) }))
    .filter(({ index }) => index >= 0 && index < commandIndex)
    .sort((a, b) => b.index - a.index)[0]?.mention;
}

function displayMentionName(mention: RawMention): string {
  const trimmedName = mention.name.trim().replace(/^@+/, '');
  return trimmedName ? `@${trimmedName}` : '';
}

function isBotMention(mention: RawMention, config: NormalizerConfig): boolean {
  const ids = [mention.id.open_id, mention.id.union_id, mention.id.app_id].filter(Boolean);
  return ids.some((id) => id === config.botOpenId || id === config.appId);
}

function isDocumentCommentBotMention(
  mention: NormalizedDocumentCommentMention,
  config: NormalizerConfig,
): boolean {
  return mention.isBot || mention.id === config.botOpenId || mention.id === config.appId;
}

function replaceMentionTokens(
  text: string,
  mentions: RawMention[],
  config: NormalizerConfig,
  mode: 'render-non-bot' | 'strip-all',
): string {
  let result = text;
  const sortedMentions = [...mentions].sort((a, b) => b.key.length - a.key.length);

  for (const mention of sortedMentions) {
    const replacement =
      mode === 'render-non-bot' && !isBotMention(mention, config)
        ? displayMentionName(mention)
        : '';
    result = result.split(mention.key).join(replacement);
  }

  return result.replace(MENTION_TOKEN_PATTERN, '').trim();
}

function parseAddressedSlashCommand(
  text: string,
  mentions: RawMention[],
  config: NormalizerConfig,
): { command: string; args: string; commandIndex: number } | null {
  const commandIndex = findSlashCommandIndex(text);
  if (commandIndex < 0) return null;

  const prefix = text.slice(0, commandIndex);
  const strippedPrefix = replaceMentionTokens(prefix, mentions, config, 'strip-all');
  if (strippedPrefix) return null;

  const commandText = text.slice(commandIndex);
  const strippedCommandText = replaceMentionTokens(commandText, mentions, config, 'strip-all');
  const strippedParsed = parseSlashCommand(strippedCommandText);
  if (!strippedParsed) return null;

  if (!COMMANDS_WITH_USER_TEXT_ARGS.has(strippedParsed.command)) {
    return { ...strippedParsed, commandIndex };
  }

  const renderedCommandText = replaceMentionTokens(
    commandText,
    mentions,
    config,
    'render-non-bot',
  );
  const renderedParsed = parseSlashCommand(renderedCommandText);
  if (renderedParsed?.command === strippedParsed.command) {
    return { ...renderedParsed, commandIndex };
  }

  return { ...strippedParsed, commandIndex };
}

function getPostParagraphs(
  parsed: Record<string, unknown>,
): { paragraphs: unknown[]; locale?: string } | null {
  for (const locale of ['zh_cn', 'en_us']) {
    const localizedContent = (parsed[locale] as Record<string, unknown> | undefined)?.content;
    if (Array.isArray(localizedContent)) {
      return { paragraphs: localizedContent, locale };
    }
  }

  if (Array.isArray(parsed.content)) {
    return { paragraphs: parsed.content };
  }

  for (const [locale, value] of Object.entries(parsed)) {
    if (typeof value !== 'object' || value === null) continue;
    const localizedContent = (value as Record<string, unknown>).content;
    if (Array.isArray(localizedContent)) {
      return { paragraphs: localizedContent, locale };
    }
  }

  return null;
}

function extractPostContent(parsed: Record<string, unknown>): PostContent {
  const result = getPostParagraphs(parsed);
  if (!result) return { text: '' };
  const { paragraphs, locale } = result;

  let imageKey: string | undefined;
  const lines: string[] = [];

  for (const paragraph of paragraphs) {
    if (!Array.isArray(paragraph)) continue;
    let line = '';
    for (const element of paragraph) {
      if (typeof element !== 'object' || element === null) continue;
      const el = element as Record<string, unknown>;
      if (el.tag === 'text' && typeof el.text === 'string') {
        line += el.text;
      } else if (el.tag === 'at' && typeof el.user_id === 'string') {
        line += el.user_id;
      } else if (el.tag === 'a' && typeof el.text === 'string') {
        line += el.text;
      } else if (el.tag === 'img' && typeof el.image_key === 'string' && !imageKey) {
        imageKey = el.image_key;
      }
    }
    lines.push(line);
  }

  return { text: lines.join('\n'), imageKey, locale };
}

function parseSlashCommand(text: string): { command: string; args: string } | null {
  const trimmed = text.trim();
  const match = trimmed.match(/^(\/[\w-]+)(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  const cmd = match[1];
  if (!isSlashCommand(cmd)) return null;
  return { command: cmd, args: match[2]?.trim() ?? '' };
}

function getDocumentCommentEventEnvelope(raw: unknown): {
  event: JsonRecord | undefined;
  header: JsonRecord | undefined;
} {
  const root = recordValue(raw);
  if (!root) return { event: undefined, header: undefined };
  const header = recordValue(root.header);
  const nestedEvent = recordValue(root.event);
  return { event: nestedEvent ?? root, header };
}

function documentCommentOperator(event: JsonRecord): JsonRecord | undefined {
  return (
    recordValue(event.operator_id) ??
    recordValue(event.operator) ??
    recordValue(recordValue(event.sender)?.sender_id) ??
    recordValue(event.sender_id)
  );
}

function documentCommentSenderType(event: JsonRecord): string | undefined {
  return (
    firstStringValue(event, ['operator_type', 'sender_type']) ??
    firstStringValue(recordValue(event.sender), ['sender_type'])
  );
}

function documentCommentText(event: JsonRecord): string {
  const content =
    firstStringValue(event, ['content', 'comment_content', 'reply_content', 'text']) ?? '';

  try {
    const parsed = JSON.parse(content) as unknown;
    if (typeof parsed === 'string') return parsed;
    const parsedRecord = recordValue(parsed);
    if (!parsedRecord) return content;
    return (
      firstStringValue(parsedRecord, ['text', 'content', 'plain_text']) ??
      extractPostContent(parsedRecord).text ??
      content
    );
  } catch {
    return content;
  }
}

function documentCommentQuote(
  event: JsonRecord,
  noticeMeta: JsonRecord | undefined,
): string | undefined {
  return (
    firstStringValue(event, ['quote', 'quote_text', 'quoteText', 'selected_text', 'selectedText']) ??
    firstStringValue(noticeMeta, [
      'quote',
      'quote_text',
      'quoteText',
      'selected_text',
      'selectedText',
    ])
  );
}

function documentCommentIsWhole(
  event: JsonRecord,
  noticeMeta: JsonRecord | undefined,
): boolean | undefined {
  return (
    booleanValue(event.is_whole ?? event.isWhole) ??
    booleanValue(noticeMeta?.is_whole ?? noticeMeta?.isWhole)
  );
}

function normalizeDocumentCommentMentions(
  rawMentions: unknown[],
  text: string,
  config: NormalizerConfig,
): NormalizedDocumentCommentMention[] {
  return rawMentions.flatMap((rawMention) => {
    const mention = recordValue(rawMention);
    if (!mention) return [];

    const idRecord = recordValue(mention.id);
    const id =
      firstStringValue(idRecord, ['open_id', 'union_id', 'app_id']) ??
      firstStringValue(mention, ['open_id', 'union_id', 'app_id', 'id']) ??
      '';
    const name = firstStringValue(mention, ['name', 'text', 'user_name']) ?? '';
    const key = firstStringValue(mention, ['key', 'mention_key']);
    const ids = [
      firstStringValue(idRecord, ['open_id']),
      firstStringValue(idRecord, ['union_id']),
      firstStringValue(idRecord, ['app_id']),
      firstStringValue(mention, ['open_id']),
      firstStringValue(mention, ['union_id']),
      firstStringValue(mention, ['app_id']),
      id,
    ].filter(Boolean);

    return [
      {
        id,
        name,
        isBot: ids.some((candidate) => candidate === config.botOpenId || candidate === config.appId),
        ...(key ? { key } : {}),
        index: key ? text.indexOf(key) : name ? text.indexOf(`@${name.replace(/^@+/, '')}`) : -1,
      },
    ];
  });
}

function stripDocumentCommentBotMention(
  text: string,
  mentions: NormalizedDocumentCommentMention[],
  config: NormalizerConfig,
): string {
  let result = text;
  for (const mention of mentions.filter((candidate) => isDocumentCommentBotMention(candidate, config))) {
    const candidates = [
      mention.key,
      mention.name ? `@${mention.name.replace(/^@+/, '')}` : undefined,
      mention.name,
    ].filter((candidate): candidate is string => Boolean(candidate));

    for (const candidate of candidates) {
      result = result.split(candidate).join('');
    }
  }
  return result.replace(/\s+/g, ' ').trim();
}

function normalizeDocumentCommentThreadReplies(
  rawReplies: unknown[],
): NormalizedDocumentCommentThreadReply[] {
  return rawReplies.flatMap((rawReply) => {
    const reply = recordValue(rawReply);
    if (!reply) return [];

    const replyId = firstStringValue(reply, ['reply_id', 'replyId']);
    const text = firstStringValue(reply, ['text', 'content', 'plain_text'])?.trim();
    if (!replyId || !text) return [];

    return [
      {
        replyId,
        ...(firstStringValue(reply, ['user_id', 'userId'])
          ? { userId: firstStringValue(reply, ['user_id', 'userId']) }
          : {}),
        ...(numberValue(reply.create_time ?? reply.createTime) !== undefined
          ? { createTime: numberValue(reply.create_time ?? reply.createTime) }
          : {}),
        text,
      },
    ];
  });
}

export function normalizeDocumentCommentEvent(
  raw: unknown,
  config: NormalizerConfig,
): NormalizedDocumentCommentEvent | null {
  const { event, header } = getDocumentCommentEventEnvelope(raw);
  if (!event) return null;

  const eventType =
    firstStringValue(header, ['event_type']) ?? firstStringValue(event, ['event_type', 'type']);
  if (eventType && eventType !== 'drive.notice.comment_add_v1') {
    return null;
  }

  const noticeMeta = recordValue(event.notice_meta) ?? recordValue(event.noticeMeta);
  const fileToken =
    firstStringValue(event, ['file_token', 'fileToken']) ??
    firstStringValue(noticeMeta, ['file_token', 'fileToken', 'obj_token', 'objToken', 'token']);
  const fileType =
    firstStringValue(event, ['file_type', 'fileType']) ??
    firstStringValue(noticeMeta, ['file_type', 'fileType', 'obj_type', 'objType']) ??
    'docx';
  const isMentioned = booleanValue(event.is_mentioned ?? event.isMentioned) === true;
  const allowDocumentUrlFallback = Boolean(noticeMeta) || isMentioned;
  const documentUrl =
    firstStringValue(event, [
      'document_url',
      'documentUrl',
      'file_url',
      'fileUrl',
      'docs_url',
      'docsUrl',
      'doc_url',
      'docUrl',
      'url',
    ]) ??
    firstStringValue(noticeMeta, [
      'document_url',
      'documentUrl',
      'file_url',
      'fileUrl',
      'docs_url',
      'docsUrl',
      'doc_url',
      'docUrl',
      'url',
    ]) ??
    (allowDocumentUrlFallback && fileToken
      ? `https://example.com/docx/${fileToken}`
      : undefined);
  const commentId = firstStringValue(event, ['comment_id', 'commentId']);
  if (!fileToken || !documentUrl || !commentId) return null;

  const operator = documentCommentOperator(event);
  const senderOpenId = firstStringValue(operator, ['open_id', 'openId']);
  if (!senderOpenId || senderOpenId === config.botOpenId || senderOpenId === config.appId) {
    return null;
  }

  const rawText = documentCommentText(event);
  const mentions = normalizeDocumentCommentMentions(
    arrayValue(event.mention_list ?? event.mentionList ?? event.mentions),
    rawText,
    config,
  );
  if (!isMentioned && !mentions.some((mention) => isDocumentCommentBotMention(mention, config))) {
    return null;
  }
  const effectiveMentions =
    mentions.length > 0 || !isMentioned
      ? mentions
      : [{ id: config.botOpenId, name: '', isBot: true, index: -1 }];

  const cleanText = stripDocumentCommentBotMention(rawText, effectiveMentions, config);
  const threadReplies = normalizeDocumentCommentThreadReplies(
    arrayValue(event.thread_replies ?? event.threadReplies),
  );
  const createTime =
    firstStringValue(header, ['create_time']) ?? firstStringValue(event, ['create_time', 'createTime']);
  const quote = documentCommentQuote(event, noticeMeta);
  const isWhole = documentCommentIsWhole(event, noticeMeta);

  return {
    eventId:
      firstStringValue(header, ['event_id']) ??
      firstStringValue(event, ['event_id', 'eventId']) ??
      `${fileToken}:${commentId}`,
    tenantKey:
      firstStringValue(header, ['tenant_key']) ??
      firstStringValue(event, ['tenant_key', 'tenantKey']) ??
      '',
    appId:
      firstStringValue(header, ['app_id']) ?? firstStringValue(event, ['app_id', 'appId']),
    noticeType: firstStringValue(event, ['notice_type', 'noticeType']),
    fileToken,
    fileType,
    documentUrl,
    commentId,
    replyId: firstStringValue(event, ['reply_id', 'replyId']),
    quote,
    isWhole,
    senderOpenId,
    senderUnionId: firstStringValue(operator, ['union_id', 'unionId']),
    senderType: documentCommentSenderType(event),
    text: cleanText,
    mentions: effectiveMentions,
    ...(threadReplies.length > 0 ? { threadReplies } : {}),
    replyLanguage: inferReplyLanguageFromText(cleanText) as ReplyLanguage | undefined,
    timestamp: parseInt(createTime ?? '', 10) || Date.now(),
    raw,
  };
}

export function normalizeEvent(
  raw: FeishuMessageEvent,
  config: NormalizerConfig,
): NormalizedEvent | null {
  const header = raw.header;
  const event = raw.event;
  if (!header || !event?.message || !event?.sender) return null;

  const msg = event.message;
  const sender = event.sender;
  const chatType = msg.chat_type === 'p2p' ? 'p2p' : 'group';

  // Parse content JSON from feishu
  let contentType: 'text' | 'rich_text' | 'image' | 'file' | 'command' = 'text';
  const { textContent, imageKey, fileAttachment, replyLanguage } = (() => {
    try {
      const parsed = JSON.parse(msg.content ?? '{}');
      if (msg.message_type === 'post') {
        const post = extractPostContent(parsed);
        return {
          textContent: post.text,
          imageKey: post.imageKey,
          replyLanguage:
            mapFeishuLocaleToReplyLanguage(post.locale) ?? inferReplyLanguageFromText(post.text),
        };
      }
      const parsedFileAttachment = extractFileAttachment({
        messageType: msg.message_type,
        parsed,
        messageId: msg.message_id ?? header.event_id,
      });
      const text = stringValue(parsed.text) ?? fileAttachmentText(parsedFileAttachment);
      return {
        textContent: text,
        imageKey: msg.message_type === 'image' ? parsed.image_key : undefined,
        fileAttachment: parsedFileAttachment,
        replyLanguage: inferReplyLanguageFromText(text),
      };
    } catch {
      const fallbackText = msg.content ?? '';
      return {
        textContent: fallbackText,
        imageKey: undefined,
        fileAttachment: undefined,
        replyLanguage: inferReplyLanguageFromText(fallbackText),
      };
    }
  })();

  // Map message_type
  if (msg.message_type === 'image') contentType = 'image';
  else if (['file', 'audio', 'media'].includes(msg.message_type ?? '')) contentType = 'file';
  else if (msg.message_type === 'post') contentType = 'rich_text';

  // Parse mentions
  const rawMentions = msg.mentions ?? [];
  const mentions = rawMentions.map((m) => ({
    id: m.id.open_id ?? m.id.union_id ?? m.id.app_id ?? '',
    name: m.name,
    isBot: isBotMention(m, config),
    key: m.key,
    index: textContent.indexOf(m.key),
  }));

  const cleanText = replaceMentionTokens(textContent, rawMentions, config, 'render-non-bot');

  // Check for slash command
  let command: string | undefined;
  let args: string | undefined;
  let commandIndex: number | undefined;
  const parsed = parseAddressedSlashCommand(textContent, rawMentions, config);
  if (parsed) {
    contentType = 'command';
    command = parsed.command;
    args = parsed.args;
    commandIndex = parsed.commandIndex;
  }

  const commandAddressMention = parsed
    ? findCommandAddressMention(textContent, rawMentions)
    : undefined;
  if (
    chatType === 'group' &&
    parsed &&
    (!commandAddressMention || !isBotMention(commandAddressMention, config))
  ) {
    return null;
  }

  // For group chats, every inbound message must explicitly mention the bot.
  // Thread/topic metadata is still preserved for reply/session routing after the gate passes.
  if (chatType === 'group') {
    const hasBotMention = mentions.some((m) => m.isBot);
    // Check for @all - ignore
    const hasAtAll = textContent.includes('@_all');
    if (hasAtAll) return null;
    if (parsed) {
      if (!commandAddressMention || !isBotMention(commandAddressMention, config)) {
        return null;
      }
    } else if (!hasBotMention) {
      return null;
    }
  }

  return {
    eventId: header.event_id,
    messageId: msg.message_id ?? header.event_id,
    chatId: msg.chat_id ?? '',
    chatType,
    threadId: msg.thread_id,
    rootMessageId: msg.root_id,
    parentMessageId: msg.parent_id,
    senderOpenId: sender.sender_id?.open_id ?? '',
    senderUnionId: sender.sender_id?.union_id || undefined,
    senderType: sender.sender_type,
    tenantKey: header.tenant_key ?? sender.tenant_key ?? '',
    content: {
      type: contentType,
      text: cleanText || undefined,
      command,
      args,
      commandIndex,
      mentions,
      imageKey,
      imageMessageId: imageKey ? (msg.message_id ?? header.event_id) : undefined,
      fileAttachment,
      raw: raw,
    },
    replyLanguage: replyLanguage as ReplyLanguage | undefined,
    timestamp: parseInt(header.create_time, 10) || Date.now(),
  };
}
