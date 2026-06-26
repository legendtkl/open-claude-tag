/**
 * Compat adapter: map the Lark-shaped {@link NormalizedEvent} produced by the
 * feishu normalizer into the vendor-neutral {@link InboundMessage} the channel
 * abstraction speaks. The raw event is preserved verbatim in `channel.native`
 * so nothing is lost across the seam.
 */
import type {
  AttachmentRef,
  InboundMessage,
  Mention,
  ReferencedMessage,
} from '@open-tag/channel-core';
import type { NormalizedEvent } from '@open-tag/core-types';

const LARK: InboundMessage['channel']['kind'] = 'lark';

type NormalizedMention = NonNullable<NormalizedEvent['content']['mentions']>[number];
type NormalizedFileAttachment = NonNullable<NormalizedEvent['content']['fileAttachment']>;
type NormalizedReferenced = NonNullable<NormalizedEvent['content']['referencedMessages']>[number];

/** Lark `resourceType` is a superset of the neutral attachment kinds; fold `media` into `file`. */
function mapResourceType(resourceType: NormalizedFileAttachment['resourceType']): AttachmentRef['type'] {
  return resourceType === 'audio' ? 'audio' : 'file';
}

function mapMention(mention: NormalizedMention): Mention {
  return {
    id: mention.id,
    type: mention.isBot ? 'bot' : 'user',
    ...(mention.key ? { raw: mention.key } : {}),
  };
}

function mapAttachments(content: NormalizedEvent['content'], messageId: string): AttachmentRef[] {
  const attachments: AttachmentRef[] = [];

  if (content.imageKey) {
    attachments.push({
      type: 'image',
      id: content.imageKey,
      // The image bytes are fetched against the owning message id, not the key.
      native: { imageKey: content.imageKey, messageId: content.imageMessageId ?? messageId },
    });
  }

  const file = content.fileAttachment;
  if (file) {
    attachments.push({
      type: mapResourceType(file.resourceType),
      id: file.resourceKey,
      ...(file.fileName ? { name: file.fileName } : {}),
      ...(file.mimeType ? { mimeType: file.mimeType } : {}),
      native: file,
    });
  }

  return attachments;
}

function mapReferenced(referenced: NormalizedReferenced): ReferencedMessage {
  const text = referenced.entries
    .map((entry) => entry.text)
    .filter((value) => value.length > 0)
    .join('\n');
  const sender = referenced.entries.find((entry) => entry.author)?.author;
  return {
    messageId: referenced.messageId,
    ...(text ? { text } : {}),
    ...(sender ? { sender } : {}),
  };
}

/**
 * Faithfully project a normalized Lark message event onto the neutral
 * {@link InboundMessage}. Today the normalizer only emits chat messages, which
 * are always `created`; edit/delete/interaction semantics arrive in later stages.
 */
export function adaptNormalizedEvent(event: NormalizedEvent): InboundMessage {
  const { content } = event;
  // messageId is required by the schema, but fall back to eventId defensively.
  const messageId = event.messageId || event.eventId;

  const mentions = (content.mentions ?? []).map(mapMention);
  const attachments = mapAttachments(content, messageId);
  const referenced = (content.referencedMessages ?? []).map(mapReferenced);

  // The normalizer's content.type ('text'|'rich_text'|'image'|'file'|'command')
  // is a subset of the neutral content type union, so it passes through as-is.
  const message: InboundMessage = {
    channel: { kind: LARK, native: event },
    eventId: event.eventId,
    messageId,
    // TODO(stage-1): edit/delete/reaction/interaction events are not yet
    // normalized; every event the normalizer emits today is a new message.
    eventType: 'created',
    // `timestamp` is a required numeric field on the event. Never synthesize
    // a clock here — fall back to 0 if it is somehow absent.
    occurredAt: event.timestamp ?? 0,
    dedupeKey: `${LARK}:${messageId}`,
    conversation: {
      kind: LARK,
      scopeId: event.chatId,
      ...(event.threadId ? { threadId: event.threadId } : {}),
      reply: {
        ...(event.rootMessageId ? { rootId: event.rootMessageId } : {}),
        ...(event.parentMessageId ? { parentId: event.parentMessageId } : {}),
      },
    },
    scope: {
      kind: LARK,
      scopeId: event.chatId,
      installationId: event.tenantKey,
      ...(event.threadId ? { threadId: event.threadId } : {}),
      isPrivate: event.chatType === 'p2p',
    },
    sender: {
      id: event.senderOpenId,
      // TODO(stage-1): Lark message events carry no display name; resolve via
      // contact lookup later. sender_type is 'user' for humans, 'app' for bots.
      isBot: event.senderType === 'app' || event.senderType === 'bot',
      native: { unionId: event.senderUnionId, senderType: event.senderType },
    },
    content: {
      type: content.type,
      ...(content.text ? { text: content.text } : {}),
      ...(content.command ? { command: content.command } : {}),
      ...(content.args ? { args: content.args } : {}),
      mentions,
      attachments,
      ...(referenced.length > 0 ? { referenced } : {}),
    },
    // Lark resolves to a reply-language enum ('zh-CN'/'en-US'); use it as locale.
    ...(event.replyLanguage ? { locale: event.replyLanguage } : {}),
  };

  return message;
}
