import type {
  FeishuMessageDetail,
  FeishuClient,
  InteractiveCard,
  PostContent,
  SendMessageResult,
} from '@open-tag/feishu-adapter';

type DebugMessageRecorder = (
  receiveIdType: 'chat_id' | 'open_id',
  receiveId: string,
  content: unknown,
  replyToMessageId?: string,
) => void;

type DebugMessageLookup = (messageId: string) => FeishuMessageDetail | null | undefined;

function isDebugMessageId(messageId?: string): boolean {
  return typeof messageId === 'string' && messageId.startsWith('om_debug_');
}

export function createLoopbackFeishuClient(
  recordDebugSentMessage: DebugMessageRecorder,
  lookupDebugMessage: DebugMessageLookup = () => null,
): FeishuClient {
  return {
    sendMessage: async (
      receiveIdType: 'chat_id' | 'open_id',
      receiveId: string,
      content:
        | InteractiveCard
        | { msg_type: 'text'; content: { text: string } }
        | { msg_type: 'post'; content: PostContent },
      replyToMessageId?: string,
    ): Promise<SendMessageResult> => {
      recordDebugSentMessage(receiveIdType, receiveId, content, replyToMessageId);
      return { messageId: `om_debug_sent_${Date.now()}` };
    },
    updateMessage: async (_messageId: string, _card: InteractiveCard): Promise<void> => {},
    addReaction: async (): Promise<{ reactionId: string }> => ({
      reactionId: `reaction_debug_${Date.now()}`,
    }),
    removeReaction: async (): Promise<void> => {},
    downloadImage: async (): Promise<Buffer> => {
      throw new Error('downloadImage is unavailable when Feishu access is disabled');
    },
    getChat: async (chatId: string) => ({
      chatId,
      name: `Debug ${chatId}`,
    }),
    listChatMembers: async () => [
      { memberId: 'ou_debug_member_001', memberIdType: 'open_id', name: 'Debug Member 1' },
      { memberId: 'ou_debug_member_002', memberIdType: 'open_id', name: 'Debug Member 2' },
    ],
    createTasklist: async (input: { name?: string }) => ({
      guid: 'debug_tasklist_001',
      url: 'https://debug/tasklist',
      name: input.name,
    }),
    addTasklistMembers: async (): Promise<void> => {},
    listTaskCustomFields: async () => [],
    createTaskCustomField: async (input: { name: string; type: string }) => ({
      guid: 'debug_status_field_001',
      name: input.name,
      type: input.type,
      single_select_setting: { options: [] },
    }),
    createTaskCustomFieldOption: async (_fieldGuid: string, name: string) => ({
      guid: `debug_option_${name}`,
      name,
    }),
    listTaskSections: async () => [],
    createTaskSection: async (_tasklistGuid: string, name: string) => ({
      guid: `debug_section_${name}`,
      name,
    }),
    getMessageAppLink: async (messageId: string) =>
      `https://applink.feishu.cn/client/thread/open?open_thread_id=${encodeURIComponent(messageId)}`,
    getMessage: async (messageId: string) => lookupDebugMessage(messageId) ?? null,
    createTask: async (input: { clientToken?: string; summary: string }) => ({
      guid: `debug_task_${input.clientToken ?? Date.now()}`,
      url: `https://applink.feishu.cn/client/todo/detail?guid=debug_task_${input.clientToken ?? Date.now()}`,
      summary: input.summary,
    }),
    patchTaskCustomFields: async (): Promise<void> => {},
    addTaskToTasklist: async (): Promise<void> => {},
    removeTaskFromTasklist: async (): Promise<void> => {},
    listTasklistTasks: async () => [],
    completeTask: async (): Promise<void> => {},
    uncompleteTask: async (): Promise<void> => {},
  } as unknown as FeishuClient;
}

export function applyDebugFeishuOverrides(
  feishuClient: FeishuClient,
  recordDebugSentMessage: DebugMessageRecorder,
  lookupDebugMessage: DebugMessageLookup = () => null,
): void {
  const originalSendMessage = feishuClient.sendMessage.bind(feishuClient);
  const originalUpdateMessage = feishuClient.updateMessage.bind(feishuClient);
  const originalGetMessage = feishuClient.getMessage?.bind(feishuClient);

  feishuClient.sendMessage = async (
    receiveIdType: 'chat_id' | 'open_id',
    receiveId: string,
    content:
      | InteractiveCard
      | { msg_type: 'text'; content: { text: string } }
      | { msg_type: 'post'; content: PostContent },
    replyToMessageId?: string,
  ): Promise<SendMessageResult> => {
    recordDebugSentMessage(receiveIdType, receiveId, content, replyToMessageId);

    // Debug endpoints synthesize message ids locally, so reply sends should not hit
    // real Feishu validation during local/E2E runs.
    if (isDebugMessageId(replyToMessageId)) {
      return { messageId: `om_debug_sent_${Date.now()}` };
    }

    return originalSendMessage(receiveIdType, receiveId, content, replyToMessageId);
  };

  feishuClient.updateMessage = async (messageId, card): Promise<void> => {
    if (isDebugMessageId(messageId)) {
      return;
    }

    return originalUpdateMessage(messageId, card);
  };

  feishuClient.getMessage = async (messageId): Promise<FeishuMessageDetail | null> => {
    const debugMessage = lookupDebugMessage(messageId);
    if (debugMessage) return debugMessage;
    return originalGetMessage ? originalGetMessage(messageId) : null;
  };
}
