import type { DeliveryRef } from '@open-tag/channel-core';
import { createFeishuChannelSender } from '@open-tag/feishu-adapter';
import type { FeishuClient } from '@open-tag/feishu-adapter';

/**
 * Route an inbound-dispatch-path ack reaction through the neutral channel
 * contract and return the provider reaction id (for the worker to remove later).
 *
 * Byte-identical to the prior direct `client.addReaction(messageId, emoji)`:
 * `createFeishuChannelSender` wraps the same {@link FeishuClient}; the
 * single-`physicalId` {@link DeliveryRef} carries the exact target message id, so
 * `LarkChannel.react` calls `FeishuClient.addReaction(messageId, emoji)` with the
 * same arguments and surfaces the same `reaction_id` as
 * {@link import('@open-tag/channel-core').ReactionRef}.reactionId. Callers thread
 * that id into the task input exactly as before, so the worker still removes the
 * reaction on completion. The reaction TARGET stays the (native) message id,
 * which the dispatch path recovers under its existing lark guard.
 *
 * `react` is optional on the seam, but this helper is Feishu-specific and
 * byte-identity depends on actually attempting `addReaction`, so a missing `react`
 * throws (loud, never a silent skip); the caller's existing try/catch warns.
 */
export async function addDispatchReactionViaChannel(
  client: FeishuClient,
  messageId: string,
  emoji: string,
): Promise<string> {
  const sender = createFeishuChannelSender(client);
  if (!sender.react) {
    throw new Error('addDispatchReactionViaChannel: the Feishu channel sender does not implement react');
  }
  const ref: DeliveryRef = {
    kind: 'lark',
    // One ack reaction targets a single physical message; the message id doubles
    // as the logical handle here.
    logicalMessageId: messageId,
    revision: 0,
    physicalIds: [messageId],
  };
  const reaction = await sender.react(ref, emoji);
  // Keep the old empty-id semantics: a blank reaction id stays blank (the caller
  // aliases it to `undefined` with `|| undefined`) rather than throwing.
  return reaction.reactionId;
}
