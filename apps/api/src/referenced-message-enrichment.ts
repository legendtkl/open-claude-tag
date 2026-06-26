import type { NormalizedEvent } from '@open-tag/core-types';
import { errorMessage, isObjectRecord } from '@open-tag/core-types';
import { parseReferencedFeishuMessage, type FeishuMessageDetail } from '@open-tag/feishu-adapter';

export interface ReferencedMessageLookupClient {
  getMessage(messageId: string): Promise<FeishuMessageDetail | null>;
}

export interface ReferencedMessageEnrichmentOptions {
  hasExistingTopic?(
    event: NormalizedEvent,
    topicMessageIds: string[],
  ): Promise<boolean>;
}

export interface EnrichmentLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

const DEFAULT_REFERENCED_MESSAGE_ANCESTOR_DEPTH = 3;
const MAX_REFERENCED_MESSAGE_ANCESTOR_DEPTH = 10;
const TRACE_DEPTH_NUMBER = '[0-9]+|[零一二两俩三四五六七八九十]{1,4}';
const TRACE_DEPTH_UNIT = '层|级|level|levels|hop|hops';
const TRACE_DEPTH_TRIGGER =
  '回溯|追溯|上溯|向上|往上|溯源|引用链|quote\\s*chain|quoted\\s*chain|trace';

export async function enrichEventWithReferencedMessage(
  event: NormalizedEvent,
  client: ReferencedMessageLookupClient,
  logger?: EnrichmentLogger,
  options: ReferencedMessageEnrichmentOptions = {},
): Promise<NormalizedEvent> {
  const establishedTopicMessageIds = getEstablishedTopicMessageIds(event);
  const allowInitialTopicReference =
    establishedTopicMessageIds.length > 0 &&
    options.hasExistingTopic &&
    !(await options.hasExistingTopic(event, establishedTopicMessageIds));
  if (establishedTopicMessageIds.length > 0 && !allowInitialTopicReference) {
    return (
      (await enrichEstablishedTopicImageReference(event, client, logger)) ??
      stripReferencedContext(event)
    );
  }

  const referencedMessageId = getReferencedMessageId(event, { allowInitialTopicReference });
  const fallbackReferencedMessageId =
    referencedMessageId ?? (await lookupImplicitImageReferenceId(event, client, logger));
  if (!fallbackReferencedMessageId) return event;

  const referencedMessages = allowInitialTopicReference
    ? [...(event.content.referencedMessages ?? []).filter((message) => message.imageAttachment)]
    : [...(event.content.referencedMessages ?? [])];
  let referencedMessageWarnings = allowInitialTopicReference
    ? undefined
    : event.content.referencedMessageWarnings;
  const seenMessageIds = new Set([event.messageId]);
  const maxMessages = resolveReferenceTraceAncestorDepth(event) + 1;
  let nextMessageId: string | undefined = fallbackReferencedMessageId;

  for (let index = 0; nextMessageId && index < maxMessages; index += 1) {
    if (seenMessageIds.has(nextMessageId)) {
      referencedMessageWarnings = mergeWarnings(referencedMessageWarnings, [
        `Referenced message chain stopped before ${nextMessageId}: cycle detected`,
      ]);
      break;
    }
    seenMessageIds.add(nextMessageId);

    try {
      const message = await client.getMessage(nextMessageId);
      if (!message) {
        referencedMessageWarnings = mergeWarnings(referencedMessageWarnings, [
          `Referenced message ${nextMessageId} unavailable`,
        ]);
        break;
      }

      const referencedMessage = parseReferencedFeishuMessage(message);
      if (allowInitialTopicReference && index === 0 && !referencedMessage.imageAttachment) {
        break;
      }
      referencedMessages.push(referencedMessage);
      referencedMessageWarnings = mergeWarnings(
        referencedMessageWarnings,
        referencedMessage.warnings,
      );
      const upstreamMessageId = getReferencedMessageIdFromDetail(message);
      nextMessageId =
        !allowInitialTopicReference && upstreamMessageId && upstreamMessageId !== message.messageId
          ? upstreamMessageId
          : undefined;
    } catch (err) {
      logger?.warn(
        {
          err,
          eventId: event.eventId,
          messageId: event.messageId,
          referencedMessageId: nextMessageId,
        },
        'Failed to enrich event with referenced Feishu message',
      );
      referencedMessageWarnings = mergeWarnings(referencedMessageWarnings, [
        `Referenced message ${nextMessageId} unavailable: ${errorMessage(err)}`,
      ]);
      break;
    }
  }

  if (referencedMessages.length === 0 && !referencedMessageWarnings?.length) {
    return event;
  }

  return {
    ...event,
    content: {
      ...event.content,
      ...(referencedMessages.length > 0 ? { referencedMessages } : {}),
      ...(referencedMessageWarnings?.length ? { referencedMessageWarnings } : {}),
    },
  };
}

async function enrichEstablishedTopicImageReference(
  event: NormalizedEvent,
  client: ReferencedMessageLookupClient,
  logger?: EnrichmentLogger,
): Promise<NormalizedEvent | undefined> {
  const directReferenceId = getEstablishedTopicImageReferenceId(event);
  if (directReferenceId) {
    const enriched = await enrichReferencedImage(event, client, logger, directReferenceId);
    if (enriched) return enriched;
  }

  const implicitReferenceId = await lookupImplicitImageReferenceId(event, client, logger);
  if (!implicitReferenceId || implicitReferenceId === directReferenceId) return undefined;
  return enrichReferencedImage(event, client, logger, implicitReferenceId);
}

async function enrichReferencedImage(
  event: NormalizedEvent,
  client: ReferencedMessageLookupClient,
  logger: EnrichmentLogger | undefined,
  referencedMessageId: string,
): Promise<NormalizedEvent | undefined> {
  try {
    const message = await client.getMessage(referencedMessageId);
    if (!message) return undefined;

    const referencedMessage = parseReferencedFeishuMessage(message);
    if (!referencedMessage.imageAttachment) return undefined;

    const referencedMessageWarnings = mergeWarnings(undefined, referencedMessage.warnings);
    const content = {
      ...event.content,
      referencedMessages: [referencedMessage],
    };
    if (referencedMessageWarnings?.length) {
      content.referencedMessageWarnings = referencedMessageWarnings;
    } else {
      delete content.referencedMessageWarnings;
    }
    return {
      ...event,
      content,
    };
  } catch (err) {
    logger?.warn(
      {
        err,
        eventId: event.eventId,
        messageId: event.messageId,
        referencedMessageId,
      },
      'Failed to enrich event with referenced Feishu image message',
    );
    return undefined;
  }
}

async function lookupImplicitImageReferenceId(
  event: NormalizedEvent,
  client: ReferencedMessageLookupClient,
  logger?: EnrichmentLogger,
): Promise<string | undefined> {
  if (!looksLikeImageReferenceRequest(event)) return undefined;

  try {
    const currentMessage = await client.getMessage(event.messageId);
    if (!currentMessage) return undefined;
    return getReferencedMessageIdFromDetail(currentMessage);
  } catch (err) {
    logger?.warn(
      { err, eventId: event.eventId, messageId: event.messageId },
      'Failed to inspect current Feishu message for implicit image reference',
    );
    return undefined;
  }
}

function hasEstablishedTopicContext(
  event: Pick<NormalizedEvent, 'threadId' | 'rootMessageId'>,
): boolean {
  return Boolean(event.threadId || event.rootMessageId);
}

function getEstablishedTopicMessageIds(
  event: Pick<NormalizedEvent, 'threadId' | 'rootMessageId'>,
): string[] {
  return uniqueValues([event.threadId, event.rootMessageId]);
}

function stripReferencedContext(event: NormalizedEvent): NormalizedEvent {
  if (
    !event.content.referencedMessages?.length &&
    !event.content.referencedMessageWarnings?.length
  ) {
    return event;
  }

  const content = { ...event.content };
  delete content.referencedMessages;
  delete content.referencedMessageWarnings;
  return {
    ...event,
    content,
  };
}

function resolveReferenceTraceAncestorDepth(event: NormalizedEvent): number {
  const candidates = [event.content.args, event.content.text].filter(
    (value): value is string => typeof value === 'string' && value.trim().length > 0,
  );

  for (const candidate of candidates) {
    const depth = extractReferenceTraceAncestorDepth(candidate);
    if (depth !== undefined) return depth;
  }

  return DEFAULT_REFERENCED_MESSAGE_ANCESTOR_DEPTH;
}

function extractReferenceTraceAncestorDepth(text: string): number | undefined {
  const patterns = [
    new RegExp(
      `(?:${TRACE_DEPTH_TRIGGER})[^0-9零一二两俩三四五六七八九十]{0,12}(${TRACE_DEPTH_NUMBER})\\s*(?:${TRACE_DEPTH_UNIT})`,
      'i',
    ),
    new RegExp(
      `(${TRACE_DEPTH_NUMBER})\\s*(?:${TRACE_DEPTH_UNIT})[^\\n]{0,12}(?:${TRACE_DEPTH_TRIGGER})`,
      'i',
    ),
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match?.[1]) continue;
    const parsed = parseNaturalNumber(match[1]);
    if (parsed !== undefined) {
      return Math.min(Math.max(parsed, 0), MAX_REFERENCED_MESSAGE_ANCESTOR_DEPTH);
    }
  }

  return undefined;
}

function parseNaturalNumber(value: string): number | undefined {
  if (/^\d+$/.test(value)) {
    return Number.parseInt(value, 10);
  }

  const normalized = value.replace(/[两俩]/g, '二');
  const digits: Record<string, number> = {
    零: 0,
    一: 1,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };

  if (normalized === '十') return 10;
  const tenIndex = normalized.indexOf('十');
  if (tenIndex >= 0) {
    const tens = tenIndex === 0 ? 1 : digits[normalized[tenIndex - 1]];
    const ones = tenIndex === normalized.length - 1 ? 0 : digits[normalized[tenIndex + 1]];
    if (tens === undefined || ones === undefined) return undefined;
    return tens * 10 + ones;
  }

  return normalized.length === 1 ? digits[normalized] : undefined;
}

function getReferencedMessageIdFromDetail(message: FeishuMessageDetail): string | undefined {
  const referenceMessageId =
    stringValue(message.referenceMessageId) ?? stringValue(message.parentMessageId);
  return referenceMessageId && referenceMessageId !== message.messageId
    ? referenceMessageId
    : undefined;
}

function getReferencedMessageId(
  event: NormalizedEvent,
  options: { allowInitialTopicReference?: boolean } = {},
): string | undefined {
  const rawMessage = getRawMessage(event);
  const rawReferenceId = getRawReferenceMessageId(rawMessage);
  const parentOrRootReferenceId =
    !hasEstablishedTopicContext(event) || options.allowInitialTopicReference
      ? (stringValue(event.parentMessageId) ??
        stringValue(rawMessage?.parent_id) ??
        stringValue(event.rootMessageId) ??
        stringValue(rawMessage?.root_id))
    : undefined;
  const referencedMessageId = rawReferenceId ?? parentOrRootReferenceId;
  return referencedMessageId && referencedMessageId !== event.messageId
    ? referencedMessageId
    : undefined;
}

function getEstablishedTopicImageReferenceId(event: NormalizedEvent): string | undefined {
  if (!looksLikeImageReferenceRequest(event)) return undefined;
  const rawMessage = getRawMessage(event);
  const explicitReferenceId = getRawReferenceMessageId(rawMessage);
  if (explicitReferenceId && explicitReferenceId !== event.messageId) return explicitReferenceId;

  const parentOrRootReferenceId =
    stringValue(event.parentMessageId) ??
    stringValue(rawMessage?.parent_id) ??
    stringValue(event.rootMessageId) ??
    stringValue(rawMessage?.root_id);
  return parentOrRootReferenceId && parentOrRootReferenceId !== event.messageId
    ? parentOrRootReferenceId
    : undefined;
}

function getRawReferenceMessageId(
  rawMessage: Record<string, unknown> | undefined,
): string | undefined {
  const rawReference = isObjectRecord(rawMessage?.reference) ? rawMessage.reference : undefined;
  return (
    stringValue(rawMessage?.reference_message_id) ??
    stringValue(rawMessage?.quote_message_id) ??
    stringValue(rawReference?.message_id)
  );
}

function looksLikeImageReferenceRequest(event: NormalizedEvent): boolean {
  const text = [event.content.args, event.content.text]
    .filter((value): value is string => typeof value === 'string')
    .join('\n');
  return /(?:图片|图像|这张图|这个图|这个图片|截图|照片|image|picture|photo|screenshot)/i.test(
    text,
  );
}

function uniqueValues(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function mergeWarnings(
  existing: string[] | undefined,
  incoming: string[] | undefined,
): string[] | undefined {
  const warnings = [...(existing ?? []), ...(incoming ?? [])].filter(Boolean);
  return warnings.length > 0 ? [...new Set(warnings)] : undefined;
}

function getRawMessage(event: NormalizedEvent): Record<string, unknown> | undefined {
  const raw = event.content.raw;
  if (!isObjectRecord(raw)) return undefined;
  const rawEvent = raw.event;
  if (!isObjectRecord(rawEvent)) return undefined;
  return isObjectRecord(rawEvent.message) ? rawEvent.message : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
