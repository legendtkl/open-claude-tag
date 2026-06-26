import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeishuClient } from '@open-tag/feishu-adapter';
import { applyDebugFeishuOverrides, createLoopbackFeishuClient } from '../debug-feishu-client.js';

function makeClient(): {
  client: FeishuClient;
  originalSendMessage: ReturnType<typeof vi.fn>;
  originalUpdateMessage: ReturnType<typeof vi.fn>;
} {
  const originalSendMessage = vi.fn().mockResolvedValue({ messageId: 'msg_real_001' });
  const originalUpdateMessage = vi.fn().mockResolvedValue(undefined);

  return {
    client: {
      sendMessage: originalSendMessage,
      updateMessage: originalUpdateMessage,
      addReaction: vi.fn().mockResolvedValue({ reactionId: 'reaction_001' }),
      removeReaction: vi.fn().mockResolvedValue(undefined),
    } as unknown as FeishuClient,
    originalSendMessage,
    originalUpdateMessage,
  };
}

describe('applyDebugFeishuOverrides', () => {
  let client: FeishuClient;
  let originalSendMessage: ReturnType<typeof vi.fn>;
  let originalUpdateMessage: ReturnType<typeof vi.fn>;
  let recordDebugSentMessage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    ({ client, originalSendMessage, originalUpdateMessage } = makeClient());
    recordDebugSentMessage = vi.fn();
    applyDebugFeishuOverrides(client, recordDebugSentMessage);
  });

  it('short-circuits reply sends for synthetic debug root message ids', async () => {
    const result = await client.sendMessage(
      'chat_id',
      'chat_debug_001',
      {
        msg_type: 'interactive',
        card: { schema: '2.0', body: { elements: [] } },
      },
      'om_debug_root_001',
    );

    expect(result.messageId).toContain('om_debug_sent_');
    expect(recordDebugSentMessage).toHaveBeenCalledOnce();
    expect(originalSendMessage).not.toHaveBeenCalled();
  });

  it('short-circuits updates for synthetic debug message ids', async () => {
    await expect(
      client.updateMessage('om_debug_sent_001', {
        msg_type: 'interactive',
        card: { schema: '2.0', body: { elements: [] } },
      }),
    ).resolves.toBeUndefined();

    expect(originalUpdateMessage).not.toHaveBeenCalled();
  });

  it('delegates non-debug message updates to the original client', async () => {
    await client.updateMessage('msg_real_001', {
      msg_type: 'interactive',
      card: { schema: '2.0', body: { elements: [] } },
    });

    expect(originalUpdateMessage).toHaveBeenCalledOnce();
  });
});

describe('createLoopbackFeishuClient', () => {
  it('records synthetic sends without hitting Feishu', async () => {
    const recordDebugSentMessage = vi.fn();
    const client = createLoopbackFeishuClient(recordDebugSentMessage);

    const result = await client.sendMessage('chat_id', 'chat_debug_001', {
      msg_type: 'text',
      content: { text: 'hello' },
    });

    expect(result.messageId).toContain('om_debug_sent_');
    expect(recordDebugSentMessage).toHaveBeenCalledWith(
      'chat_id',
      'chat_debug_001',
      { msg_type: 'text', content: { text: 'hello' } },
      undefined,
    );
  });

  it('returns synthetic reactions and rejects image download', async () => {
    const client = createLoopbackFeishuClient(vi.fn());

    await expect(client.addReaction('om_debug_001', 'EYES')).resolves.toEqual({
      reactionId: expect.stringContaining('reaction_debug_'),
    });
    await expect(client.downloadImage('om_debug_001', 'img_debug_001')).rejects.toThrow(
      'Feishu access is disabled',
    );
  });
});
