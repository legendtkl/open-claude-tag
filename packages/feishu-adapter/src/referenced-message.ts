import type { ReferencedMessage, ReferencedMessageEntry } from '@open-tag/core-types';
import { isObjectRecord } from '@open-tag/core-types';

export interface FeishuMessageDetail {
  messageId: string;
  messageType?: string;
  content?: string;
  senderName?: string;
  threadId?: string;
  rootMessageId?: string;
  parentMessageId?: string;
  referenceMessageId?: string;
  children?: FeishuMessageDetail[];
}

type ImageAttachment = NonNullable<ReferencedMessage['imageAttachment']>;

interface ParsedContent {
  entries: ReferencedMessageEntry[];
  imageKey?: string;
  skippedEntries?: number;
}

const CHAT_RECORD_KEYS = ['chat_record', 'chatRecord', 'messages', 'items', 'records'];

export function parseReferencedFeishuMessage(message: FeishuMessageDetail): ReferencedMessage {
  const messageType = message.messageType ?? 'unknown';
  const contentType = mapMessageType(messageType);

  const warnings: string[] = [];
  const parsed = message.children?.length
    ? parseReferencedChildren(message.children)
    : parseSingleReferencedMessage(message);

  if (parsed.warnings) {
    warnings.push(...parsed.warnings);
  }

  return {
    messageId: message.messageId,
    contentType,
    entries: parsed.entries,
    ...(parsed.imageAttachment ? { imageAttachment: parsed.imageAttachment } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

function parseSingleReferencedMessage(message: FeishuMessageDetail): {
  entries: ReferencedMessageEntry[];
  imageAttachment?: ImageAttachment;
  warnings?: string[];
} {
  const messageType = message.messageType ?? 'unknown';
  const parsed = parseJsonObject(message.content);
  const warnings: string[] = [];
  let entries: ReferencedMessageEntry[] = [];
  let imageAttachment: ImageAttachment | undefined;

  if (messageType === 'image') {
    const imageKey = stringValue(parsed?.image_key) ?? stringValue(parsed?.imageKey);
    if (imageKey) {
      imageAttachment = { messageId: message.messageId, imageKey };
    }
  } else if (parsed) {
    const parsedContent = parseReferencedContent(parsed, messageType);
    entries = parsedContent.entries;
    if (parsedContent.imageKey) {
      imageAttachment = { messageId: message.messageId, imageKey: parsedContent.imageKey };
    }
    if (parsedContent.skippedEntries) {
      warnings.push(
        `Skipped ${parsedContent.skippedEntries} unsupported referenced chat record entries`,
      );
    }
  }

  return {
    entries,
    ...(imageAttachment ? { imageAttachment } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

function parseReferencedChildren(children: FeishuMessageDetail[]): {
  entries: ReferencedMessageEntry[];
  imageAttachment?: ImageAttachment;
  warnings?: string[];
} {
  const entries: ReferencedMessageEntry[] = [];
  const warnings: string[] = [];
  let imageAttachment: ImageAttachment | undefined;

  for (const child of children) {
    const parsed = parseSingleReferencedMessage(child);
    entries.push(
      ...parsed.entries.map((entry) => ({
        ...entry,
        author: entry.author ?? child.senderName,
      })),
    );
    imageAttachment ??= parsed.imageAttachment;
    if (parsed.warnings) warnings.push(...parsed.warnings);
  }

  return {
    entries,
    ...(imageAttachment ? { imageAttachment } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

function mapMessageType(messageType: string): ReferencedMessage['contentType'] {
  if (messageType === 'text') return 'text';
  if (messageType === 'post') return 'rich_text';
  if (messageType === 'image') return 'image';
  if (messageType === 'file') return 'file';
  return 'unknown';
}

function parseReferencedContent(parsed: Record<string, unknown>, messageType: string): ParsedContent {
  const chatRecord = findChatRecordItems(parsed);
  if (chatRecord) {
    return parseChatRecord(chatRecord);
  }

  if (messageType === 'text') {
    const text = stringValue(parsed.text);
    return { entries: text ? [{ text }] : [] };
  }

  if (messageType === 'image') {
    const imageKey = stringValue(parsed.image_key) ?? stringValue(parsed.imageKey);
    return { entries: [], ...(imageKey ? { imageKey } : {}) };
  }

  const post = parsePostLikeContent(parsed);
  if (post.entries.length > 0 || post.imageKey) {
    return post;
  }

  const text = stringValue(parsed.text) ?? stringValue(parsed.content);
  return { entries: text ? [{ text }] : [] };
}

function parseChatRecord(items: unknown[]): ParsedContent {
  const entries: ReferencedMessageEntry[] = [];
  let imageKey: string | undefined;
  let skippedEntries = 0;

  for (const item of items) {
    if (!isObjectRecord(item)) {
      skippedEntries += 1;
      continue;
    }

    const author =
      stringValue(item.sender_name) ??
      stringValue(item.senderName) ??
      stringValue(item.name) ??
      stringValue(asObjectRecord(item.sender)?.name);
    const messageType =
      stringValue(item.message_type) ?? stringValue(item.messageType) ?? stringValue(item.msg_type);
    const parsedNestedContent =
      typeof item.content === 'string'
        ? parseJsonObject(item.content)
        : isObjectRecord(item.content)
          ? item.content
          : undefined;

    const directText = stringValue(item.text) ?? stringValue(item.plain_text);
    const parsed =
      parsedNestedContent && messageType
        ? parseReferencedContent(parsedNestedContent, messageType)
        : parsedNestedContent
          ? parseReferencedContent(parsedNestedContent, 'post')
          : { entries: directText ? [{ text: directText }] : [] };

    if (!imageKey && parsed.imageKey) {
      imageKey = parsed.imageKey;
    }

    const itemEntries =
      parsed.entries.length > 0
        ? parsed.entries
        : directText
          ? [{ text: directText }]
          : [];
    if (itemEntries.length === 0) {
      if (parsed.imageKey) continue;
      skippedEntries += 1;
      continue;
    }

    entries.push(
      ...itemEntries.map((entry) => ({
        ...entry,
        author: entry.author ?? author,
      })),
    );
  }

  return {
    entries,
    ...(imageKey ? { imageKey } : {}),
    ...(skippedEntries > 0 ? { skippedEntries } : {}),
  };
}

function parsePostLikeContent(parsed: Record<string, unknown>): ParsedContent {
  const paragraphs = getPostParagraphs(parsed);
  if (!paragraphs) return { entries: [] };

  const entries: ReferencedMessageEntry[] = [];
  let imageKey: string | undefined;

  for (const paragraph of paragraphs) {
    if (!Array.isArray(paragraph)) continue;
    let line = '';
    for (const element of paragraph) {
      if (!isObjectRecord(element)) continue;
      const tag = element.tag;
      if (tag === 'text' && typeof element.text === 'string') {
        line += element.text;
      } else if (tag === 'a' && typeof element.text === 'string') {
        line += element.text;
      } else if (tag === 'at' && typeof element.user_name === 'string') {
        line += `@${element.user_name.replace(/^@+/, '')}`;
      } else if (tag === 'at' && typeof element.user_id === 'string') {
        line += element.user_id;
      } else if (tag === 'img' && typeof element.image_key === 'string' && !imageKey) {
        imageKey = element.image_key;
      }
    }
    const text = line.trim();
    if (text) entries.push({ text });
  }

  return { entries, ...(imageKey ? { imageKey } : {}) };
}

function findChatRecordItems(parsed: Record<string, unknown>): unknown[] | null {
  for (const key of CHAT_RECORD_KEYS) {
    const value = parsed[key];
    if (Array.isArray(value)) return value;
  }

  for (const value of Object.values(parsed)) {
    if (!isObjectRecord(value)) continue;
    for (const key of CHAT_RECORD_KEYS) {
      const nested = value[key];
      if (Array.isArray(nested)) return nested;
    }
  }

  return null;
}

function getPostParagraphs(parsed: Record<string, unknown>): unknown[] | null {
  for (const locale of ['zh_cn', 'en_us']) {
    const localizedContent = asObjectRecord(parsed[locale])?.content;
    if (Array.isArray(localizedContent)) return localizedContent;
  }

  if (Array.isArray(parsed.content)) return parsed.content;

  for (const value of Object.values(parsed)) {
    const localizedContent = asObjectRecord(value)?.content;
    if (Array.isArray(localizedContent)) return localizedContent;
  }

  return null;
}

function parseJsonObject(content: string | undefined): Record<string, unknown> | undefined {
  if (!content) return undefined;
  try {
    const parsed = JSON.parse(content) as unknown;
    return isObjectRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function asObjectRecord(value: unknown): Record<string, unknown> | undefined {
  return isObjectRecord(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
