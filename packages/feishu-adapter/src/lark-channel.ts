/**
 * {@link LarkChannel} — the Lark implementation of the vendor-neutral
 * {@link Channel} contract. It wires the existing feishu adapter pieces (the
 * normalizer, the inbound compat adapter, the card builders, and the REST
 * client) behind the neutral surface the core speaks, so the core never names
 * a vendor. Channel-specific payloads retreat into the typed `native` hatch.
 */
import { writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type {
  AddressingSignal,
  ApprovalPrompt,
  AttachmentRef,
  Channel,
  ChannelCapabilities,
  ChannelScope,
  ChannelSession,
  ChecklistStep,
  ConversationRef,
  DeliveryRef,
  HealthStatus,
  InboundMessage,
  LocalFile,
  OutboundMessage,
  RemoteAttachmentRef,
  RunStatus,
} from '@open-tag/channel-core';
import {
  buildApprovalCard,
  buildDoneCard,
  buildFailedCard,
  buildRichCompletionReplyCard,
  buildRunningCard,
} from './card-builder.js';
import type { InteractiveCard } from './card-builder.js';
import type { FeishuClient } from './feishu-client.js';
import { adaptNormalizedEvent } from './inbound-message.js';
import { normalizeEvent } from './normalizer.js';
import type { NormalizerConfig } from './normalizer.js';

const LARK = 'lark' as const;

type ChecklistMessage = Extract<OutboundMessage, { kind: 'checklist' }>;
type ResultMessage = Extract<OutboundMessage, { kind: 'result' }>;
type FormMessage = Extract<OutboundMessage, { kind: 'form' }>;
type HandoffMessage = Extract<OutboundMessage, { kind: 'handoff' }>;
type CommentMessage = Extract<OutboundMessage, { kind: 'comment' }>;

/** The Feishu send-message content union; reused for the `native` escape hatch. */
type SendMessageContent = Parameters<FeishuClient['sendMessage']>[2];

const STEP_ICONS: Record<ChecklistStep['status'], string> = {
  pending: '⬜',
  running: '🔄',
  done: '✅',
  failed: '❌',
  skipped: '⏭️',
};

function stepLine(step: ChecklistStep): string {
  return `${STEP_ICONS[step.status]} ${step.title}`;
}

/**
 * Lark attachment names are user-controlled, so strip any directory component
 * before joining them onto a download dir — a raw `../x` or `/etc/x` must never
 * escape `destDir`. Falls back when the basename is empty or a `.`/`..` segment.
 */
function safeFileName(raw: string, fallback: string): string {
  const base = basename(raw);
  if (!base || base === '.' || base === '..') {
    return basename(fallback) || 'attachment';
  }
  return base;
}

/**
 * A stable, input-derived id (djb2). Used where Lark needs an identifier the
 * neutral model does not carry (e.g. an approval change-request id). Never use
 * a wall clock here — the same prompt must always yield the same id.
 */
function stableId(prefix: string, input: string): string {
  let hash = 5381;
  for (let index = 0; index < input.length; index += 1) {
    hash = ((hash << 5) + hash + input.charCodeAt(index)) >>> 0;
  }
  return `${prefix}_${hash.toString(16)}`;
}

function buildChecklistCard(msg: ChecklistMessage): InteractiveCard {
  const lines = msg.steps.map(stepLine);
  switch (msg.status) {
    case 'running':
      return buildRunningCard(msg.title, undefined, lines);
    case 'done':
      return buildDoneCard(msg.title, lines.join('\n'));
    case 'failed':
      return buildFailedCard(msg.title, lines.join('\n'));
    default: {
      const _exhaustive: never = msg.status;
      return buildRunningCard(msg.title, undefined, lines);
    }
  }
}

function buildResultCard(msg: ResultMessage): InteractiveCard {
  // TODO(stage-1): render `msg.artifacts` inline once outbound attachment
  // upload is wired; for now the markdown body carries the result.
  return buildRichCompletionReplyCard(msg.markdown) ?? buildDoneCard(msg.markdown);
}

function buildApprovalFromPrompt(prompt: ApprovalPrompt): InteractiveCard {
  // ApprovalPrompt carries neither a risk tier nor a stable id, so derive the
  // change-request id from the prompt text and default the tier to medium.
  // TODO(stage-1): buildApprovalCard renders fixed approve/reject buttons;
  // custom prompt.actions beyond those two are not yet surfaced.
  const changeRequestId = stableId('cr', `${prompt.title}\n${prompt.detail ?? ''}`);
  return buildApprovalCard(changeRequestId, prompt.title, prompt.detail ?? '', 'medium');
}

function renderFormAsText(msg: FormMessage): string {
  const fields = msg.fields.map((field) => `- ${field.label} (${field.type})`).join('\n');
  const actions = msg.actions.map((action) => `[${action.label}]`).join(' ');
  return [`**${msg.title}**`, fields, actions].filter((part) => part.length > 0).join('\n\n');
}

function renderHandoffAsText(msg: HandoffMessage): string {
  const name = msg.to.displayName ?? msg.to.id;
  return `↪️ Handoff to ${name}\n\n${msg.markdown}`;
}

/** A markdown projection of any outbound message, used for in-place card edits. */
function outboundToMarkdown(msg: OutboundMessage): string {
  switch (msg.kind) {
    case 'text':
    case 'result':
    case 'discussion':
    case 'comment':
      return msg.markdown;
    case 'error':
      return msg.message;
    case 'handoff':
      return renderHandoffAsText(msg);
    case 'form':
      return renderFormAsText(msg);
    case 'checklist':
      return msg.steps.map(stepLine).join('\n');
    case 'approval':
      return msg.prompt.detail ?? msg.prompt.title;
    case 'native':
      return typeof msg.payload === 'string' ? msg.payload : JSON.stringify(msg.payload);
    default: {
      const _exhaustive: never = msg;
      return '';
    }
  }
}

export class LarkChannel implements Channel {
  readonly kind = LARK;

  constructor(
    private readonly client: FeishuClient,
    private readonly normalizerConfig: NormalizerConfig,
  ) {}

  capabilities(): ChannelCapabilities {
    return {
      supportsCards: true,
      supportsStreamingEdit: true,
      supportsThreads: true,
      supportsReactions: true,
      supportsForms: true,
      supportsApprovalButtons: true,
      supportsAttachmentsIn: ['image', 'file', 'audio'],
      supportsAttachmentsOut: ['image', 'file'],
      maxOutboundChars: 30000,
      maxOutboundElements: 200,
      maxUpdateRateHz: 5,
    };
  }

  async start(sink: (msg: InboundMessage) => Promise<void>): Promise<ChannelSession> {
    // TODO(stage-1): wire inbound event source in the gateway. The WS client
    // lives in the gateway, which will call normalize() then invoke this sink;
    // the channel only holds the contract for now.
    void sink;
    return { stop: async () => {} };
  }

  normalize(raw: unknown): InboundMessage | null {
    const event = normalizeEvent(raw as Parameters<typeof normalizeEvent>[0], this.normalizerConfig);
    if (!event) return null;
    return adaptNormalizedEvent(event);
  }

  extractAddressingSignals(msg: InboundMessage): AddressingSignal[] {
    return msg.content.mentions.map((mention) => ({
      kind: mention.type === 'bot' ? 'bot' : 'user',
      id: mention.id,
      raw: mention.raw ?? mention.id,
    }));
  }

  async send(to: ConversationRef, msg: OutboundMessage): Promise<DeliveryRef> {
    switch (msg.kind) {
      case 'text':
        return this.deliverText(to, msg.markdown);
      case 'error':
        return this.deliverText(to, msg.message);
      case 'checklist':
        return this.deliverCard(to, buildChecklistCard(msg));
      case 'result':
        return this.deliverCard(to, buildResultCard(msg));
      case 'approval':
        return this.deliverCard(to, buildApprovalFromPrompt(msg.prompt));
      case 'native':
        return this.deliverNative(to, msg.payload);
      case 'comment':
        return this.deliverComment(msg);
      case 'form':
        // TODO(stage-1): render an interactive form card; summarize as text for now.
        return this.deliverText(to, renderFormAsText(msg));
      case 'discussion':
        // TODO(stage-1): dedicated discussion surface; reuse a text message for now.
        return this.deliverText(to, msg.markdown);
      case 'handoff':
        // TODO(stage-1): structured agent handoff; announce via text for now.
        return this.deliverText(to, renderHandoffAsText(msg));
      default: {
        const _exhaustive: never = msg;
        throw new Error(`Unsupported outbound message kind: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  async update(
    ref: DeliveryRef,
    msg: OutboundMessage,
    opts?: { revision?: number },
  ): Promise<DeliveryRef> {
    const card = this.renderCardForUpdate(msg);
    for (const physicalId of ref.physicalIds) {
      await this.client.updateMessage(physicalId, card);
    }
    const revision = opts?.revision ?? ref.revision + 1;
    return { ...ref, revision, native: card };
  }

  async react(ref: DeliveryRef, emoji: string): Promise<void> {
    const [physicalId] = ref.physicalIds;
    if (!physicalId) return;
    await this.client.addReaction(physicalId, emoji);
  }

  async uploadArtifact(_file: LocalFile): Promise<RemoteAttachmentRef> {
    // TODO(stage-1): FeishuClient exposes no upload-resource method yet;
    // outbound artifact upload (im/v1/images, im/v1/files) lands with the
    // gateway wiring. Fail fast so callers are not handed a bogus ref.
    throw new Error('LarkChannel.uploadArtifact is not implemented yet (stage-1)');
  }

  async fetchAttachment(att: AttachmentRef, destDir: string): Promise<LocalFile> {
    const native = (att.native ?? {}) as {
      messageId?: string;
      resourceType?: 'file' | 'audio' | 'media';
    };
    const messageId = native.messageId;
    if (!messageId) {
      throw new Error(`fetchAttachment: attachment ${att.id} is missing its owning message id`);
    }

    const buffer =
      att.type === 'image'
        ? await this.client.downloadImage(messageId, att.id)
        : await this.client.downloadFile(
            messageId,
            att.id,
            native.resourceType ?? (att.type === 'audio' ? 'audio' : 'file'),
          );

    const name = safeFileName(att.name ?? att.id, att.id);
    const path = join(destDir, name);
    await writeFile(path, buffer);
    return { path, name, ...(att.mimeType ? { mimeType: att.mimeType } : {}) };
  }

  resolveScope(msg: InboundMessage): ChannelScope {
    return msg.scope;
  }

  async healthcheck(): Promise<HealthStatus> {
    // The REST client refreshes credentials lazily, so a construction-time
    // channel is considered healthy; a deeper ping lands with the gateway.
    return { healthy: true };
  }

  private async deliverText(to: ConversationRef, text: string): Promise<DeliveryRef> {
    const result = await this.client.sendMessage(
      'chat_id',
      to.scopeId,
      { msg_type: 'text', content: { text } },
      this.replyTarget(to),
    );
    return this.toDeliveryRef(result.messageId, result);
  }

  private async deliverCard(to: ConversationRef, card: InteractiveCard): Promise<DeliveryRef> {
    const result = await this.client.sendMessage('chat_id', to.scopeId, card, this.replyTarget(to));
    return this.toDeliveryRef(result.messageId, result);
  }

  private async deliverNative(to: ConversationRef, payload: unknown): Promise<DeliveryRef> {
    // The native escape hatch: the payload is already a Feishu send-message
    // content (text/post/interactive); pass it through verbatim.
    const result = await this.client.sendMessage(
      'chat_id',
      to.scopeId,
      payload as SendMessageContent,
      this.replyTarget(to),
    );
    return this.toDeliveryRef(result.messageId, result);
  }

  private async deliverComment(msg: CommentMessage): Promise<DeliveryRef> {
    // The closest existing surface for an anchored comment is a document comment
    // keyed by the doc token; the anchor's native may carry the file type.
    const fileType = (msg.anchor.native as { fileType?: string } | undefined)?.fileType ?? 'docx';
    const result = await this.client.createDocumentComment({
      fileToken: msg.anchor.docId,
      fileType,
      content: msg.markdown,
    });
    return this.toDeliveryRef(result.commentId, result);
  }

  private renderCardForUpdate(msg: OutboundMessage): InteractiveCard {
    switch (msg.kind) {
      case 'checklist':
        return buildChecklistCard(msg);
      case 'result':
        return buildResultCard(msg);
      case 'approval':
        return buildApprovalFromPrompt(msg.prompt);
      case 'error':
        return buildFailedCard('Error', msg.message);
      case 'native':
        return msg.payload as InteractiveCard;
      default:
        // text/form/comment/discussion/handoff have no first-class card; wrap
        // their markdown projection so an in-place edit still renders.
        return buildDoneCard(outboundToMarkdown(msg));
    }
  }

  private replyTarget(to: ConversationRef): string | undefined {
    // TODO(stage-1): a thread-only conversation (threadId set, no reply ids)
    // posts a fresh message because FeishuClient.sendMessage replies by message
    // id only and has no thread_id send param. Threaded sends land with the
    // gateway wiring (and a client method to send into a thread).
    return to.reply?.parentId ?? to.reply?.rootId;
  }

  private toDeliveryRef(messageId: string, native: unknown): DeliveryRef {
    return {
      kind: this.kind,
      // One logical message maps to one physical message today; the physical id
      // doubles as the logical handle until outbound segmentation lands.
      logicalMessageId: messageId,
      revision: 0,
      physicalIds: [messageId],
      native,
    };
  }
}
