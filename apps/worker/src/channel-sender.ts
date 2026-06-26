/**
 * ChannelSender — a neutral seam the worker uses to send/update outbound
 * messages, decoupling task-feedback delivery from a concrete vendor client.
 *
 * {@link LarkChannelSender} backs the seam with a {@link LarkChannel} (which
 * already wraps the per-app {@link FeishuClient} the registry resolves), so the
 * actual REST calls are byte-identical to talking to the client directly.
 *
 * The neutral message/handle types are derived from the {@link LarkChannel}
 * contract on purpose: the worker stays free of a direct `@open-tag/channel-core`
 * dependency while still speaking the same vendor-neutral shapes.
 */
import {
  LarkChannel,
  buildRunningCard,
  type ConversationRef,
  type FeishuClient,
  type InteractiveCard,
  type NormalizerConfig,
} from '@open-tag/feishu-adapter';
import type { Logger } from 'pino';
import { resolveTaskFeishuClient, type TaskFeishuClientResolver } from './agent-runtime.js';

/** The vendor-neutral outbound render model the channel speaks. */
export type OutboundMessage = Parameters<LarkChannel['send']>[1];
/** A handle over the physical message(s) a logical send produced. */
export type DeliveryRef = Awaited<ReturnType<LarkChannel['send']>>;
/** Optional send controls; carries the exactly-once `idempotencyKey`. */
export type SendOptions = Parameters<LarkChannel['send']>[2];
type UpdateOptions = Parameters<LarkChannel['update']>[2];

/** The neutral conversation handle a fresh send targets. */
export type { ConversationRef };

const LARK_KIND = 'lark' as const;

/**
 * Build the conversation a task's auxiliary cards (e.g. the live checklist) are
 * posted into: the task's chat, threaded under the same reply target the
 * feedback cards use. `replyToMessageId` is only set inside topic threads, so a
 * non-threaded task posts a fresh top-level message.
 */
export function buildTaskConversationRef(
  chatId: string,
  replyToMessageId?: string,
): ConversationRef {
  return {
    kind: LARK_KIND,
    scopeId: chatId,
    ...(replyToMessageId ? { reply: { parentId: replyToMessageId } } : {}),
  };
}

/** The thin surface the worker uses to deliver/edit outbound messages. */
export interface ChannelSender {
  send(to: ConversationRef, msg: OutboundMessage, opts?: SendOptions): Promise<DeliveryRef>;
  update(ref: DeliveryRef, msg: OutboundMessage, opts?: UpdateOptions): Promise<DeliveryRef>;
}

/** A {@link ChannelSender} backed by a {@link LarkChannel}. */
export class LarkChannelSender implements ChannelSender {
  constructor(private readonly channel: LarkChannel) {}

  send(to: ConversationRef, msg: OutboundMessage, opts?: SendOptions): Promise<DeliveryRef> {
    return this.channel.send(to, msg, opts);
  }

  update(ref: DeliveryRef, msg: OutboundMessage, opts?: UpdateOptions): Promise<DeliveryRef> {
    return this.channel.update(ref, msg, opts);
  }
}

// LarkChannel.normalize() is the only consumer of NormalizerConfig; send/update
// never read it, so a send-only sender uses an empty bot identity.
const SEND_ONLY_NORMALIZER_CONFIG: NormalizerConfig = { botOpenId: '' };

export function createLarkChannelSender(
  client: FeishuClient,
  normalizerConfig: NormalizerConfig = SEND_ONLY_NORMALIZER_CONFIG,
): LarkChannelSender {
  return new LarkChannelSender(new LarkChannel(client, normalizerConfig));
}

/** Resolves a {@link ChannelSender} for a task's Feishu app, reusing the registry. */
export interface ChannelSenderResolver {
  getChannelSender(feishuAppId?: string | null): Promise<ChannelSender | null>;
}

export function createWorkerChannelSenderResolver(options: {
  feishuClientResolver: TaskFeishuClientResolver | null;
  defaultClient: FeishuClient | null;
  normalizerConfig?: NormalizerConfig;
}): ChannelSenderResolver {
  return {
    getChannelSender: async (feishuAppId) => {
      const { client } = await resolveTaskFeishuClient({
        feishuAppId,
        resolver: options.feishuClientResolver,
        defaultClient: options.defaultClient,
      });
      if (!client) return null;
      return createLarkChannelSender(client, options.normalizerConfig);
    },
  };
}

function ackCardDeliveryRef(ackMessageId: string): DeliveryRef {
  return {
    kind: LARK_KIND,
    // One ack card maps to a single physical message; the physical id doubles
    // as the logical handle here.
    logicalMessageId: ackMessageId,
    revision: 0,
    physicalIds: [ackMessageId],
  };
}

export interface RunningFeedbackCardInput {
  ackMessageId?: string | null;
  description: string;
  progress?: number;
  recentActivity?: string[];
  workDir?: string;
}

/**
 * Update the primary task-feedback "running" card through the neutral
 * {@link ChannelSender}. This is behavior-identical to
 * ThreePhaseFeedback.updateRunning: it builds the same `buildRunningCard(...)`
 * and PATCHes the same ack message — the `native` outbound carries that card so
 * LarkChannel.update calls FeishuClient.updateMessage with the same arguments.
 * Card-update failures are swallowed (warn) so they never crash task execution.
 */
export async function updateRunningFeedbackCard(
  sender: ChannelSender | null,
  input: RunningFeedbackCardInput,
  logger?: Logger,
): Promise<void> {
  if (!sender || !input.ackMessageId) return;
  try {
    const card: InteractiveCard = buildRunningCard(
      input.description,
      input.progress,
      input.recentActivity,
      input.workDir,
    );
    const msg: OutboundMessage = { kind: 'native', payload: card };
    await sender.update(ackCardDeliveryRef(input.ackMessageId), msg);
  } catch (err) {
    logger?.warn(
      { err, ackMessageId: input.ackMessageId, description: input.description },
      'Failed to update running card',
    );
  }
}
