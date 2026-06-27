/**
 * Derive the Feishu task-forward attachment payloads from a {@link NormalizedEvent}.
 *
 * ADR-0004 1a-ii: the orchestrator (a CORE package) accepts the neutral
 * `InboundMessage` and must not author or read Feishu-shaped attachment payloads.
 * These payloads (`{ imageKey, messageId }` and the full Feishu file descriptor,
 * including the load-bearing `resourceType: 'media'`) are vendor-specific and
 * destined for the Feishu downloader, so deriving them from a Feishu event belongs
 * here, in the Feishu adapter. The vendor-aware caller threads the result into
 * `handleEvent` as opaque options; the core only checks presence and forwards them
 * verbatim. This is the exact logic that previously lived inline in the
 * orchestrator, kept byte-identical (note the current-image strict guard with no
 * `imageMessageId` fallback, and current-image precedence over the first
 * referenced image).
 */
import type { NormalizedEvent } from '@open-tag/core-types';

type FeishuImageAttachment = { imageKey: string; messageId: string };
type FeishuFileAttachment = NonNullable<NormalizedEvent['content']['fileAttachment']>;

export interface FeishuTaskAttachments {
  imageAttachment?: FeishuImageAttachment;
  fileAttachment?: FeishuFileAttachment;
}

function buildCurrentImageAttachment(event: NormalizedEvent): FeishuImageAttachment | undefined {
  return event.content.type === 'image' && event.content.imageKey && event.content.imageMessageId
    ? { imageKey: event.content.imageKey, messageId: event.content.imageMessageId }
    : undefined;
}

function buildReferencedImageAttachment(event: NormalizedEvent): FeishuImageAttachment | undefined {
  return event.content.referencedMessages?.find((message) => message.imageAttachment)
    ?.imageAttachment;
}

function buildCurrentFileAttachment(event: NormalizedEvent): FeishuFileAttachment | undefined {
  return event.content.type === 'file' ? event.content.fileAttachment : undefined;
}

export function deriveFeishuTaskAttachments(event: NormalizedEvent): FeishuTaskAttachments {
  const imageAttachment =
    buildCurrentImageAttachment(event) ?? buildReferencedImageAttachment(event);
  const fileAttachment = buildCurrentFileAttachment(event);
  return {
    ...(imageAttachment ? { imageAttachment } : {}),
    ...(fileAttachment ? { fileAttachment } : {}),
  };
}
