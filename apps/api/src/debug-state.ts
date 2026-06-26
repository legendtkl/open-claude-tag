import type { FeishuMessageDetail } from '@open-tag/feishu-adapter';

export interface DebugSentMessage {
  receiveIdType: 'chat_id' | 'open_id';
  receiveId: string;
  msgType: string;
  text?: string;
  replyToMessageId?: string;
  sentAt: string;
}

const MAX_DEBUG_ENTRIES = 200;

const debugSentMessages: DebugSentMessage[] = [];
const debugReferencedMessages = new Map<string, FeishuMessageDetail>();

export function recordDebugReferencedMessage(message: FeishuMessageDetail): void {
  debugReferencedMessages.set(message.messageId, message);
  if (debugReferencedMessages.size > MAX_DEBUG_ENTRIES) {
    const oldestKey = debugReferencedMessages.keys().next().value as string | undefined;
    if (oldestKey) {
      debugReferencedMessages.delete(oldestKey);
    }
  }
}

export function lookupDebugReferencedMessage(messageId: string): FeishuMessageDetail | undefined {
  return debugReferencedMessages.get(messageId);
}

export function recordDebugSentMessage(
  receiveIdType: 'chat_id' | 'open_id',
  receiveId: string,
  content: unknown,
  replyToMessageId?: string,
): void {
  const payload = content as { msg_type?: string; content?: { text?: string } } | undefined;
  debugSentMessages.push({
    receiveIdType,
    receiveId,
    msgType: payload?.msg_type ?? 'unknown',
    text: payload?.msg_type === 'text' ? payload.content?.text : undefined,
    replyToMessageId,
    sentAt: new Date().toISOString(),
  });

  if (debugSentMessages.length > MAX_DEBUG_ENTRIES) {
    debugSentMessages.splice(0, debugSentMessages.length - MAX_DEBUG_ENTRIES);
  }
}

export function listDebugSentMessages(): DebugSentMessage[] {
  return [...debugSentMessages];
}
