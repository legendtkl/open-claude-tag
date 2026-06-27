import type { ConversationRef } from '@open-tag/channel-core';
import { createFeishuChannelSender } from '@open-tag/feishu-adapter';
import type { FeishuClient } from '@open-tag/feishu-adapter';

/** The Feishu text-message content a dispatch reply carries (an object, never a JSON string). */
export type DispatchReplyPayload = { msg_type: 'text'; content: { text: string } };

/**
 * Route an inbound-dispatch-path text reply through the neutral channel sender
 * and return the delivered message id.
 *
 * Byte-identical to the prior direct
 * `client.sendMessage('chat_id', chatId, payload, replyToMessageId)`:
 * `createFeishuChannelSender` wraps the same {@link FeishuClient}; the
 * `kind:'native'` outbound carries the existing text payload through verbatim;
 * `LarkChannel` maps `scopeId -> chat id` and `reply.parentId -> the reply
 * target`; and with no {@link import('@open-tag/channel-core').SendOptions} the
 * client still mints its own dedupe uuid exactly as before (a trailing
 * `undefined` send-options arg is identical to an omitted one). Callers resolve
 * `chatId` from the neutral `InboundMessage.scope.scopeId`, which
 * `adaptNormalizedEvent` maps losslessly from the native chat id.
 */
export async function sendDispatchReplyViaChannel(
  client: FeishuClient,
  chatId: string,
  payload: DispatchReplyPayload,
  replyToMessageId?: string,
): Promise<string> {
  const to: ConversationRef = {
    kind: 'lark',
    scopeId: chatId,
    ...(replyToMessageId ? { reply: { parentId: replyToMessageId } } : {}),
  };
  const ref = await createFeishuChannelSender(client).send(to, { kind: 'native', payload });
  // Keep the old empty-message-id fallback semantics: a blank delivered id stays
  // blank (the prior code logged / aliased it as-is) rather than throwing.
  return ref.physicalIds[0];
}
