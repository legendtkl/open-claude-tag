import { describe, expect, it, vi } from 'vitest';
import type { NormalizedEvent } from '@open-tag/core-types';
import { enrichEventWithCurrentMessageThread } from '../current-message-thread-enrichment.js';

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
      raw: {
        event: {
          message: {
            root_id: 'om_old_image_1',
            parent_id: 'om_old_image_1',
          },
        },
      },
    },
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('enrichEventWithCurrentMessageThread', () => {
  it('uses the current message detail thread id without replacing the quoted image root', async () => {
    const getMessage = vi.fn().mockResolvedValue({
      messageId: 'om_current_1',
      messageType: 'text',
      threadId: 'omt_generated_topic_1',
      rootMessageId: 'om_current_1',
      parentMessageId: 'om_old_image_1',
    });

    const result = await enrichEventWithCurrentMessageThread(
      makeEvent({
        rootMessageId: 'om_old_image_1',
        parentMessageId: 'om_old_image_1',
      }),
      { getMessage },
    );

    expect(getMessage).toHaveBeenCalledWith('om_current_1');
    expect(result.threadId).toBe('omt_generated_topic_1');
    expect(result.rootMessageId).toBe('om_old_image_1');
    expect(result.parentMessageId).toBe('om_old_image_1');
  });

  it('inspects image-like group requests even when the event has no root fields', async () => {
    const getMessage = vi.fn().mockResolvedValue({
      messageId: 'om_current_1',
      messageType: 'text',
      threadId: 'omt_generated_topic_2',
      parentMessageId: 'om_old_image_2',
    });

    const result = await enrichEventWithCurrentMessageThread(
      makeEvent({
        rootMessageId: undefined,
        parentMessageId: undefined,
        content: {
          type: 'text',
          text: '看下这个截图',
          raw: { event: { message: {} } },
        },
      }),
      { getMessage },
    );

    expect(getMessage).toHaveBeenCalledWith('om_current_1');
    expect(result.threadId).toBe('omt_generated_topic_2');
    expect(result.parentMessageId).toBe('om_old_image_2');
  });

  it('falls back to the current message app link when message detail omits thread id', async () => {
    const getMessage = vi.fn().mockResolvedValue({
      messageId: 'om_current_1',
      messageType: 'text',
      parentMessageId: 'om_old_image_3',
    });
    const getMessageAppLink = vi
      .fn()
      .mockResolvedValue(
        'https://applink.feishu.cn/client/thread/open?open_thread_id=omt_from_app_link',
      );

    const result = await enrichEventWithCurrentMessageThread(
      makeEvent({
        rootMessageId: 'om_old_image_3',
        parentMessageId: 'om_old_image_3',
      }),
      { getMessage, getMessageAppLink },
    );

    expect(getMessage).toHaveBeenCalledWith('om_current_1');
    expect(getMessageAppLink).toHaveBeenCalledWith('om_current_1');
    expect(result.threadId).toBe('omt_from_app_link');
    expect(result.rootMessageId).toBe('om_old_image_3');
  });

  it('uses the app-link topic when message detail reports the quoted source as thread id', async () => {
    const getMessage = vi.fn().mockResolvedValue({
      messageId: 'om_current_1',
      messageType: 'text',
      threadId: 'om_old_image_4',
      parentMessageId: 'om_old_image_4',
    });
    const getMessageAppLink = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(
        'https://applink.feishu.cn/client/thread/open?openThreadId=omt_after_retry',
      );

    const result = await enrichEventWithCurrentMessageThread(
      makeEvent({
        rootMessageId: 'om_old_image_4',
        parentMessageId: 'om_old_image_4',
      }),
      { getMessage, getMessageAppLink },
    );

    expect(getMessage).toHaveBeenCalledWith('om_current_1');
    expect(getMessageAppLink).toHaveBeenCalledTimes(2);
    expect(result.threadId).toBe('omt_after_retry');
    expect(result.rootMessageId).toBe('om_old_image_4');
  });

  it('re-inspects events whose thread id is the quoted source message id', async () => {
    const getMessage = vi.fn().mockResolvedValue({
      messageId: 'om_current_1',
      messageType: 'text',
      threadId: 'om_old_image_5',
      parentMessageId: 'om_old_image_5',
    });
    const getMessageAppLink = vi
      .fn()
      .mockResolvedValue(
        'https://applink.feishu.cn/client/thread/open?open_thread_id=omt_from_event_fix',
      );

    const result = await enrichEventWithCurrentMessageThread(
      makeEvent({
        threadId: 'om_old_image_5',
        rootMessageId: 'om_old_image_5',
        parentMessageId: 'om_old_image_5',
      }),
      { getMessage, getMessageAppLink },
    );

    expect(getMessage).toHaveBeenCalledWith('om_current_1');
    expect(result.threadId).toBe('omt_from_event_fix');
    expect(result.rootMessageId).toBe('om_old_image_5');
  });

  it('uses the app-link topic for image-like events whose only thread id is an om message id', async () => {
    const getMessage = vi.fn().mockResolvedValue({
      messageId: 'om_current_1',
      messageType: 'text',
      threadId: 'om_old_image_6',
    });
    const getMessageAppLink = vi
      .fn()
      .mockResolvedValue(
        'https://applink.feishu.cn/client/thread/open?open_thread_id=omt_image_like_event',
      );

    const result = await enrichEventWithCurrentMessageThread(
      makeEvent({
        threadId: 'om_old_image_6',
        rootMessageId: undefined,
        parentMessageId: undefined,
        content: {
          type: 'text',
          text: 'E2E_SOURCE_CONTEXT 请解读这张图',
          raw: { event: { message: {} } },
        },
      }),
      { getMessage, getMessageAppLink },
    );

    expect(getMessage).toHaveBeenCalledWith('om_current_1');
    expect(result.threadId).toBe('omt_image_like_event');
    expect(result.rootMessageId).toBeUndefined();
  });

  it('uses the app-link topic for any group event whose thread id is an om message id', async () => {
    const getMessage = vi.fn().mockResolvedValue({
      messageId: 'om_current_1',
      messageType: 'text',
      threadId: 'om_thread_from_event_1',
    });
    const getMessageAppLink = vi
      .fn()
      .mockResolvedValue(
        'https://applink.feishu.cn/client/thread/open?open_thread_id=omt_regular_group_topic',
      );

    const result = await enrichEventWithCurrentMessageThread(
      makeEvent({
        threadId: 'om_thread_from_event_1',
        rootMessageId: undefined,
        parentMessageId: undefined,
        content: {
          type: 'text',
          text: '普通话题回复',
          raw: { event: { message: {} } },
        },
      }),
      { getMessage, getMessageAppLink },
    );

    expect(getMessage).toHaveBeenCalledWith('om_current_1');
    expect(result.threadId).toBe('omt_regular_group_topic');
  });

  it('ignores app-link message ids and preserves an existing generated topic', async () => {
    const getMessage = vi.fn().mockResolvedValue({
      messageId: 'om_current_1',
      messageType: 'text',
      threadId: 'om_current_1',
    });
    const getMessageAppLink = vi
      .fn()
      .mockResolvedValue(
        'https://applink.feishu.cn/client/thread/open?open_thread_id=om_current_1',
      );

    const result = await enrichEventWithCurrentMessageThread(
      makeEvent({
        threadId: 'omt_existing_topic_2',
        rootMessageId: undefined,
        parentMessageId: undefined,
        content: {
          type: 'text',
          text: '解读一下这个图片',
          raw: { event: { message: {} } },
          referencedMessages: [
            {
              messageId: 'om_image_1',
              contentType: 'image',
              entries: [],
              imageAttachment: {
                imageKey: 'img_1',
                messageId: 'om_image_1',
              },
            },
          ],
        },
      }),
      { getMessage, getMessageAppLink },
    );

    expect(getMessage).toHaveBeenCalledWith('om_current_1');
    expect(getMessageAppLink).toHaveBeenCalledWith('om_current_1');
    expect(result.threadId).toBe('omt_existing_topic_2');
  });

  it('retries current message detail when the generated topic is not visible immediately', async () => {
    const getMessage = vi
      .fn()
      .mockResolvedValueOnce({
        messageId: 'om_current_1',
        messageType: 'text',
        threadId: 'om_old_image_7',
      })
      .mockResolvedValueOnce({
        messageId: 'om_current_1',
        messageType: 'text',
        threadId: 'omt_delayed_detail',
        rootMessageId: 'om_current_1',
        parentMessageId: 'om_old_image_7',
      });
    const getMessageAppLink = vi.fn().mockResolvedValue(null);

    const result = await enrichEventWithCurrentMessageThread(
      makeEvent({
        threadId: 'om_old_image_7',
        rootMessageId: undefined,
        parentMessageId: undefined,
      }),
      { getMessage, getMessageAppLink },
    );

    expect(getMessage).toHaveBeenCalledTimes(2);
    expect(getMessageAppLink).toHaveBeenCalledTimes(1);
    expect(result.threadId).toBe('omt_delayed_detail');
    expect(result.rootMessageId).toBe('om_current_1');
  });

  it('inspects events that already carry an enriched referenced image', async () => {
    const getMessage = vi.fn().mockResolvedValue({
      messageId: 'om_current_1',
      messageType: 'text',
      threadId: 'omt_after_reference_enrichment',
      rootMessageId: 'om_current_1',
    });

    const result = await enrichEventWithCurrentMessageThread(
      makeEvent({
        rootMessageId: undefined,
        parentMessageId: undefined,
        content: {
          type: 'text',
          text: '普通请求',
          raw: { event: { message: {} } },
          referencedMessages: [
            {
              messageId: 'om_image_after_reference',
              contentType: 'image',
              entries: [],
              imageAttachment: {
                imageKey: 'img_after_reference',
                messageId: 'om_image_after_reference',
              },
            },
          ],
        },
      }),
      { getMessage },
    );

    expect(getMessage).toHaveBeenCalledWith('om_current_1');
    expect(result.threadId).toBe('omt_after_reference_enrichment');
  });

  it('does not inspect messages that already carry a thread id', async () => {
    const getMessage = vi.fn();

    const result = await enrichEventWithCurrentMessageThread(
      makeEvent({ threadId: 'omt_existing_topic_1' }),
      { getMessage },
    );

    expect(getMessage).not.toHaveBeenCalled();
    expect(result.threadId).toBe('omt_existing_topic_1');
  });

  it('preserves the event and logs a warning when current-message lookup fails', async () => {
    const getMessage = vi.fn().mockRejectedValue(new Error('missing scope'));
    const logger = { warn: vi.fn() };
    const event = makeEvent({ rootMessageId: 'om_old_image_1' });

    const result = await enrichEventWithCurrentMessageThread(event, { getMessage }, logger);

    expect(result).toBe(event);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: 'evt_1', messageId: 'om_current_1' }),
      'Failed to inspect current Feishu message for thread context',
    );
  });
});
