import { describe, expect, it, vi } from 'vitest';
import type { NormalizedEvent } from '@open-tag/core-types';
import { aliasGeneratedTopicWhenAvailable, isGeneratedFeishuTopicId } from '../topic-session-alias.js';

function makeEvent(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    eventId: 'evt_1',
    messageId: 'om_current_1',
    chatId: 'oc_chat_1',
    chatType: 'group',
    senderOpenId: 'ou_user_1',
    tenantKey: 'tenant_1',
    content: {
      type: 'text',
      text: '解读一下这个图片',
      raw: {},
      referencedMessages: [
        {
          messageId: 'om_quoted_image_1',
          contentType: 'image',
          entries: [],
          imageAttachment: { imageKey: 'img_quoted_1', messageId: 'om_quoted_image_1' },
        },
      ],
    },
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('topic session aliasing', () => {
  it('accepts only generated Feishu topic ids', () => {
    expect(isGeneratedFeishuTopicId('omt_topic_1')).toBe(true);
    expect(isGeneratedFeishuTopicId('om_quoted_image_1')).toBe(false);
    expect(isGeneratedFeishuTopicId(undefined)).toBe(false);
  });

  it('skips quoted source om ids and keeps polling for the generated topic id', async () => {
    const getMessage = vi
      .fn()
      .mockResolvedValueOnce({ threadId: 'om_quoted_image_1' })
      .mockResolvedValueOnce({ threadId: 'omt_generated_topic_1' });
    const aliasThreadKeys = vi.fn().mockResolvedValue(undefined);
    const logger = { info: vi.fn(), warn: vi.fn() };

    await aliasGeneratedTopicWhenAvailable({
      event: makeEvent(),
      sessionId: 'session_1',
      client: { getMessage },
      aliasThreadKeys,
      logger,
      retryDelaysMs: [0, 0],
    });

    expect(getMessage).toHaveBeenCalledTimes(2);
    expect(aliasThreadKeys).toHaveBeenCalledWith(
      'session_1',
      'omt_generated_topic_1',
      'tenant_1',
      'oc_chat_1',
    );
  });
});
