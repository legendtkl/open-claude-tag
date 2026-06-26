import { describe, expect, it, vi } from 'vitest';
import type { NormalizedEvent } from '@open-tag/core-types';
import { enrichEventWithReferencedMessage } from '../referenced-message-enrichment.js';

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
      text: '继续补充',
      raw: {},
    },
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeRawReferenceEvent(
  referenceMessageId: string,
  overrides: Partial<NormalizedEvent> = {},
): NormalizedEvent {
  return makeEvent({
    content: {
      type: 'text',
      text: '总结这条引用',
      raw: {
        event: {
          message: {
            reference_message_id: referenceMessageId,
          },
        },
      },
    },
    ...overrides,
  });
}

describe('enrichEventWithReferencedMessage', () => {
  it('does not call Feishu when the event has no raw reference', async () => {
    const getMessage = vi.fn();

    const result = await enrichEventWithReferencedMessage(makeEvent(), { getMessage });

    expect(result.content.referencedMessages).toBeUndefined();
    expect(getMessage).not.toHaveBeenCalled();
  });

  it('adds parsed referenced message content for a non-topic raw reference', async () => {
    const getMessage = vi.fn().mockResolvedValue({
      messageId: 'om_ref_1',
      messageType: 'image',
      content: JSON.stringify({ image_key: 'img_ref_1' }),
    });

    const result = await enrichEventWithReferencedMessage(
      makeRawReferenceEvent('om_ref_1'),
      { getMessage },
    );

    expect(getMessage).toHaveBeenCalledWith('om_ref_1');
    expect(result.content.referencedMessages).toEqual([
      {
        messageId: 'om_ref_1',
        contentType: 'image',
        entries: [],
        imageAttachment: {
          messageId: 'om_ref_1',
          imageKey: 'img_ref_1',
        },
      },
    ]);
  });

  it('uses parent-only messages as referenced context for topic-start quotes', async () => {
    const getMessage = vi.fn().mockResolvedValue({
      messageId: 'om_parent_image_1',
      messageType: 'image',
      content: JSON.stringify({ image_key: 'img_parent_ref_1' }),
    });

    const result = await enrichEventWithReferencedMessage(
      makeEvent({
        parentMessageId: 'om_parent_image_1',
        content: {
          type: 'text',
          text: '分析这个图片',
          raw: {
            event: {
              message: {
                parent_id: 'om_parent_image_1',
              },
            },
          },
        },
      }),
      { getMessage },
    );

    expect(getMessage).toHaveBeenCalledWith('om_parent_image_1');
    expect(result.content.referencedMessages).toEqual([
      {
        messageId: 'om_parent_image_1',
        contentType: 'image',
        entries: [],
        imageAttachment: {
          messageId: 'om_parent_image_1',
          imageKey: 'img_parent_ref_1',
        },
      },
    ]);
  });

  it('looks up the current message when an image request omits reference fields', async () => {
    const getMessage = vi.fn(async (messageId: string) => {
      if (messageId === 'om_current_1') {
        return {
          messageId: 'om_current_1',
          messageType: 'text',
          content: JSON.stringify({ text: '解读一下这个图片' }),
          parentMessageId: 'om_parent_image_1',
        };
      }
      if (messageId === 'om_parent_image_1') {
        return {
          messageId: 'om_parent_image_1',
          messageType: 'image',
          content: JSON.stringify({ image_key: 'img_parent_ref_1' }),
        };
      }
      return null;
    });

    const result = await enrichEventWithReferencedMessage(
      makeEvent({
        content: {
          type: 'text',
          text: '解读一下这个图片',
          raw: {
            event: {
              message: {
                message_id: 'om_current_1',
              },
            },
          },
        },
      }),
      { getMessage },
    );

    expect(getMessage.mock.calls.map(([messageId]) => messageId)).toEqual([
      'om_current_1',
      'om_parent_image_1',
    ]);
    expect(result.content.referencedMessages).toEqual([
      {
        messageId: 'om_parent_image_1',
        contentType: 'image',
        entries: [],
        imageAttachment: {
          messageId: 'om_parent_image_1',
          imageKey: 'img_parent_ref_1',
        },
      },
    ]);
  });

  it('does not fetch a topic parent message as referenced context', async () => {
    const getMessage = vi.fn();

    const result = await enrichEventWithReferencedMessage(
      makeEvent({
        threadId: 'omt_topic_1',
        rootMessageId: 'om_topic_root_1',
        parentMessageId: 'om_topic_parent_1',
      }),
      { getMessage },
    );

    expect(result.content.referencedMessages).toBeUndefined();
    expect(getMessage).not.toHaveBeenCalled();
  });

  it('uses root image messages as referenced context for first-seen topic roots', async () => {
    const getMessage = vi.fn().mockResolvedValue({
      messageId: 'om_image_root_1',
      messageType: 'image',
      content: JSON.stringify({ image_key: 'img_root_ref_1' }),
    });
    const hasExistingTopic = vi.fn().mockResolvedValue(false);

    const result = await enrichEventWithReferencedMessage(
      makeEvent({
        threadId: 'omt_topic_1',
        rootMessageId: 'om_image_root_1',
        parentMessageId: 'om_image_root_1',
        content: {
          type: 'text',
          text: '解读一下这个图片',
          raw: {
            event: {
              message: {
                thread_id: 'omt_topic_1',
                root_id: 'om_image_root_1',
                parent_id: 'om_image_root_1',
              },
            },
          },
        },
      }),
      { getMessage },
      undefined,
      { hasExistingTopic },
    );

    expect(hasExistingTopic).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'om_current_1' }),
      ['omt_topic_1', 'om_image_root_1'],
    );
    expect(getMessage).toHaveBeenCalledWith('om_image_root_1');
    expect(result.content.referencedMessages).toEqual([
      {
        messageId: 'om_image_root_1',
        contentType: 'image',
        entries: [],
        imageAttachment: {
          messageId: 'om_image_root_1',
          imageKey: 'img_root_ref_1',
        },
      },
    ]);
  });

  it('does not add text referenced-message chains for first-seen topic roots', async () => {
    const getMessage = vi.fn().mockResolvedValue({
      messageId: 'om_text_quote_1',
      messageType: 'text',
      content: JSON.stringify({ text: 'quoted text' }),
      parentMessageId: 'om_text_quote_0',
    });
    const hasExistingTopic = vi.fn().mockResolvedValue(false);

    const result = await enrichEventWithReferencedMessage(
      makeRawReferenceEvent('om_text_quote_1', {
        threadId: 'omt_topic_1',
        rootMessageId: 'om_topic_root_1',
        parentMessageId: 'om_topic_parent_1',
      }),
      { getMessage },
      undefined,
      { hasExistingTopic },
    );

    expect(getMessage).toHaveBeenCalledWith('om_text_quote_1');
    expect(result.content.referencedMessages).toBeUndefined();
    expect(result.content.referencedMessageWarnings).toBeUndefined();
  });

  it('does not inherit a root image message for established topic follow-ups', async () => {
    const getMessage = vi.fn();
    const hasExistingTopic = vi.fn().mockResolvedValue(true);

    const result = await enrichEventWithReferencedMessage(
      makeEvent({
        threadId: 'omt_topic_1',
        rootMessageId: 'om_image_root_1',
        parentMessageId: 'om_image_root_1',
        content: {
          type: 'text',
          text: '继续补充',
          raw: {
            event: {
              message: {
                thread_id: 'omt_topic_1',
                root_id: 'om_image_root_1',
                parent_id: 'om_image_root_1',
              },
            },
          },
        },
      }),
      { getMessage },
      undefined,
      { hasExistingTopic },
    );

    expect(result.content.referencedMessages).toBeUndefined();
    expect(getMessage).not.toHaveBeenCalled();
  });

  it('recovers an explicitly requested image from an established topic parent', async () => {
    const getMessage = vi.fn().mockResolvedValue({
      messageId: 'om_image_root_1',
      messageType: 'image',
      content: JSON.stringify({ image_key: 'img_root_ref_1' }),
    });
    const hasExistingTopic = vi.fn().mockResolvedValue(true);

    const result = await enrichEventWithReferencedMessage(
      makeEvent({
        threadId: 'omt_topic_1',
        rootMessageId: 'om_image_root_1',
        parentMessageId: 'om_image_root_1',
        content: {
          type: 'text',
          text: '解读一下这个图片',
          raw: {
            event: {
              message: {
                thread_id: 'omt_topic_1',
                root_id: 'om_image_root_1',
                parent_id: 'om_image_root_1',
              },
            },
          },
        },
      }),
      { getMessage },
      undefined,
      { hasExistingTopic },
    );

    expect(getMessage).toHaveBeenCalledWith('om_image_root_1');
    expect(result.content.referencedMessages).toEqual([
      {
        messageId: 'om_image_root_1',
        contentType: 'image',
        entries: [],
        imageAttachment: {
          messageId: 'om_image_root_1',
          imageKey: 'img_root_ref_1',
        },
      },
    ]);
  });

  it('falls back to the current message for an established-topic image request without image parent fields', async () => {
    const getMessage = vi.fn(async (messageId: string) => {
      if (messageId === 'om_current_1') {
        return {
          messageId: 'om_current_1',
          messageType: 'text',
          content: JSON.stringify({ text: '解读一下这个图片' }),
          parentMessageId: 'om_image_root_1',
        };
      }
      if (messageId === 'om_image_root_1') {
        return {
          messageId: 'om_image_root_1',
          messageType: 'image',
          content: JSON.stringify({ image_key: 'img_root_ref_1' }),
        };
      }
      return null;
    });
    const hasExistingTopic = vi.fn().mockResolvedValue(true);

    const result = await enrichEventWithReferencedMessage(
      makeEvent({
        threadId: 'omt_topic_1',
        rootMessageId: 'om_topic_root_1',
        content: {
          type: 'text',
          text: '解读一下这个图片',
          raw: {
            event: {
              message: {
                thread_id: 'omt_topic_1',
                root_id: 'om_topic_root_1',
              },
            },
          },
        },
      }),
      { getMessage },
      undefined,
      { hasExistingTopic },
    );

    expect(getMessage.mock.calls.map(([messageId]) => messageId)).toEqual([
      'om_topic_root_1',
      'om_current_1',
      'om_image_root_1',
    ]);
    expect(result.content.referencedMessages).toEqual([
      {
        messageId: 'om_image_root_1',
        contentType: 'image',
        entries: [],
        imageAttachment: {
          messageId: 'om_image_root_1',
          imageKey: 'img_root_ref_1',
        },
      },
    ]);
  });

  it('does not add established topic text references for image-like wording', async () => {
    const getMessage = vi.fn().mockResolvedValue({
      messageId: 'om_text_parent_1',
      messageType: 'text',
      content: JSON.stringify({ text: 'not an image' }),
    });
    const hasExistingTopic = vi.fn().mockResolvedValue(true);

    const result = await enrichEventWithReferencedMessage(
      makeEvent({
        threadId: 'omt_topic_1',
        rootMessageId: 'om_text_parent_1',
        parentMessageId: 'om_text_parent_1',
        content: {
          type: 'text',
          text: '解读一下这个图片',
          raw: {
            event: {
              message: {
                thread_id: 'omt_topic_1',
                root_id: 'om_text_parent_1',
                parent_id: 'om_text_parent_1',
              },
            },
          },
        },
      }),
      { getMessage },
      undefined,
      { hasExistingTopic },
    );

    expect(getMessage).toHaveBeenCalledWith('om_text_parent_1');
    expect(result.content.referencedMessages).toBeUndefined();
  });

  it('does not fetch an explicit raw reference inside an established topic', async () => {
    const getMessage = vi.fn();

    const result = await enrichEventWithReferencedMessage(
      makeRawReferenceEvent('om_explicit_quote', {
        threadId: 'omt_topic_1',
        parentMessageId: 'om_topic_parent_1',
      }),
      { getMessage },
    );

    expect(result.content.referencedMessages).toBeUndefined();
    expect(getMessage).not.toHaveBeenCalled();
  });

  it('strips pre-existing referenced context from topic events', async () => {
    const getMessage = vi.fn();

    const result = await enrichEventWithReferencedMessage(
      makeEvent({
        rootMessageId: 'om_topic_root_1',
        content: {
          type: 'text',
          text: '只处理这一条',
          raw: {},
          referencedMessages: [
            {
              messageId: 'om_parent_1',
              contentType: 'text',
              entries: [{ text: 'parent content' }],
            },
          ],
          referencedMessageWarnings: ['old warning'],
        },
      }),
      { getMessage },
    );

    expect(result.content.text).toBe('只处理这一条');
    expect(result.content.referencedMessages).toBeUndefined();
    expect(result.content.referencedMessageWarnings).toBeUndefined();
    expect(getMessage).not.toHaveBeenCalled();
  });

  it('traces the quoted message plus three upstream quoted ancestors by default', async () => {
    const getMessage = vi.fn(async (messageId: string) => {
      const messages = new Map([
        [
          'om_4',
          {
            messageId: 'om_4',
            messageType: 'text',
            content: JSON.stringify({ text: '第四条，引用第三条' }),
            parentMessageId: 'om_3',
          },
        ],
        [
          'om_3',
          {
            messageId: 'om_3',
            messageType: 'text',
            content: JSON.stringify({ text: '第三条，引用第二条' }),
            parentMessageId: 'om_2',
          },
        ],
        [
          'om_2',
          {
            messageId: 'om_2',
            messageType: 'text',
            content: JSON.stringify({ text: '第二条，引用第一条' }),
            parentMessageId: 'om_1',
          },
        ],
        [
          'om_1',
          {
            messageId: 'om_1',
            messageType: 'text',
            content: JSON.stringify({ text: '第一条源消息' }),
          },
        ],
      ]);
      return messages.get(messageId) ?? null;
    });

    const result = await enrichEventWithReferencedMessage(makeRawReferenceEvent('om_4'), {
      getMessage,
    });

    expect(getMessage.mock.calls.map(([messageId]) => messageId)).toEqual([
      'om_4',
      'om_3',
      'om_2',
      'om_1',
    ]);
    expect(result.content.referencedMessages?.map((message) => message.messageId)).toEqual([
      'om_4',
      'om_3',
      'om_2',
      'om_1',
    ]);
    expect(result.content.referencedMessages?.map((message) => message.entries[0]?.text)).toEqual([
      '第四条，引用第三条',
      '第三条，引用第二条',
      '第二条，引用第一条',
      '第一条源消息',
    ]);
  });

  it('uses an explicit raw reference for the first lookup when no topic context exists', async () => {
    const getMessage = vi.fn(async (messageId: string) => ({
      messageId,
      messageType: 'text',
      content: JSON.stringify({ text: `${messageId} content` }),
    }));

    const result = await enrichEventWithReferencedMessage(
      makeRawReferenceEvent('om_explicit_quote'),
      { getMessage },
    );

    expect(getMessage).toHaveBeenCalledTimes(1);
    expect(getMessage).toHaveBeenCalledWith('om_explicit_quote');
    expect(result.content.referencedMessages?.map((message) => message.messageId)).toEqual([
      'om_explicit_quote',
    ]);
  });

  it('prefers an explicit upstream reference over the message parent during chain tracing', async () => {
    const getMessage = vi.fn(async (messageId: string) => {
      const messages = new Map([
        [
          'om_4',
          {
            messageId: 'om_4',
            messageType: 'text',
            content: JSON.stringify({ text: '第四条' }),
            parentMessageId: 'om_thread_parent',
            referenceMessageId: 'om_3',
          },
        ],
        [
          'om_3',
          {
            messageId: 'om_3',
            messageType: 'text',
            content: JSON.stringify({ text: '第三条' }),
          },
        ],
        [
          'om_thread_parent',
          {
            messageId: 'om_thread_parent',
            messageType: 'text',
            content: JSON.stringify({ text: '线程父消息' }),
          },
        ],
      ]);
      return messages.get(messageId) ?? null;
    });

    const result = await enrichEventWithReferencedMessage(makeRawReferenceEvent('om_4'), {
      getMessage,
    });

    expect(getMessage.mock.calls.map(([messageId]) => messageId)).toEqual(['om_4', 'om_3']);
    expect(result.content.referencedMessages?.map((message) => message.messageId)).toEqual([
      'om_4',
      'om_3',
    ]);
  });

  it('honors natural language reference trace depth', async () => {
    const getMessage = vi.fn(async (messageId: string) => {
      const messages = new Map([
        [
          'om_4',
          {
            messageId: 'om_4',
            messageType: 'text',
            content: JSON.stringify({ text: '第四条' }),
            parentMessageId: 'om_3',
          },
        ],
        [
          'om_3',
          {
            messageId: 'om_3',
            messageType: 'text',
            content: JSON.stringify({ text: '第三条' }),
            parentMessageId: 'om_2',
          },
        ],
        [
          'om_2',
          {
            messageId: 'om_2',
            messageType: 'text',
            content: JSON.stringify({ text: '第二条' }),
          },
        ],
      ]);
      return messages.get(messageId) ?? null;
    });

    const result = await enrichEventWithReferencedMessage(
      makeRawReferenceEvent('om_4', {
        content: {
          type: 'text',
          text: '帮我总结，向上回溯一层就够了',
          raw: {
            event: {
              message: {
                reference_message_id: 'om_4',
              },
            },
          },
        },
      }),
      { getMessage },
    );

    expect(getMessage.mock.calls.map(([messageId]) => messageId)).toEqual(['om_4', 'om_3']);
    expect(result.content.referencedMessages?.map((message) => message.messageId)).toEqual([
      'om_4',
      'om_3',
    ]);
  });

  it('does not treat unrelated counts near reference-chain wording as trace depth', async () => {
    const getMessage = vi.fn(async (messageId: string) => {
      const messages = new Map([
        [
          'om_6',
          {
            messageId: 'om_6',
            messageType: 'text',
            content: JSON.stringify({ text: '第六条' }),
            parentMessageId: 'om_5',
          },
        ],
        [
          'om_5',
          {
            messageId: 'om_5',
            messageType: 'text',
            content: JSON.stringify({ text: '第五条' }),
            parentMessageId: 'om_4',
          },
        ],
        [
          'om_4',
          {
            messageId: 'om_4',
            messageType: 'text',
            content: JSON.stringify({ text: '第四条' }),
            parentMessageId: 'om_3',
          },
        ],
        [
          'om_3',
          {
            messageId: 'om_3',
            messageType: 'text',
            content: JSON.stringify({ text: '第三条' }),
            parentMessageId: 'om_2',
          },
        ],
        [
          'om_2',
          {
            messageId: 'om_2',
            messageType: 'text',
            content: JSON.stringify({ text: '第二条' }),
            parentMessageId: 'om_1',
          },
        ],
        [
          'om_1',
          {
            messageId: 'om_1',
            messageType: 'text',
            content: JSON.stringify({ text: '第一条' }),
          },
        ],
      ]);
      return messages.get(messageId) ?? null;
    });

    const result = await enrichEventWithReferencedMessage(
      makeRawReferenceEvent('om_6', {
        content: {
          type: 'text',
          text: '沿引用链找 8 个风险',
          raw: {
            event: {
              message: {
                reference_message_id: 'om_6',
              },
            },
          },
        },
      }),
      { getMessage },
    );

    expect(getMessage.mock.calls.map(([messageId]) => messageId)).toEqual([
      'om_6',
      'om_5',
      'om_4',
      'om_3',
    ]);
    expect(result.content.referencedMessages?.map((message) => message.messageId)).toEqual([
      'om_6',
      'om_5',
      'om_4',
      'om_3',
    ]);
  });

  it('stops tracing when the referenced message chain cycles', async () => {
    const getMessage = vi.fn(async (messageId: string) => {
      const messages = new Map([
        [
          'om_4',
          {
            messageId: 'om_4',
            messageType: 'text',
            content: JSON.stringify({ text: '第四条' }),
            parentMessageId: 'om_3',
          },
        ],
        [
          'om_3',
          {
            messageId: 'om_3',
            messageType: 'text',
            content: JSON.stringify({ text: '第三条' }),
            parentMessageId: 'om_4',
          },
        ],
      ]);
      return messages.get(messageId) ?? null;
    });

    const result = await enrichEventWithReferencedMessage(
      makeRawReferenceEvent('om_4', {
        content: {
          type: 'text',
          text: '请回溯五层引用链',
          raw: {
            event: {
              message: {
                reference_message_id: 'om_4',
              },
            },
          },
        },
      }),
      { getMessage },
    );

    expect(getMessage.mock.calls.map(([messageId]) => messageId)).toEqual(['om_4', 'om_3']);
    expect(result.content.referencedMessages?.map((message) => message.messageId)).toEqual([
      'om_4',
      'om_3',
    ]);
    expect(result.content.referencedMessageWarnings).toEqual([
      'Referenced message chain stopped before om_4: cycle detected',
    ]);
  });

  it('records a warning and preserves the event when lookup fails', async () => {
    const getMessage = vi.fn().mockRejectedValue(new Error('missing im scope'));
    const logger = { warn: vi.fn() };

    const result = await enrichEventWithReferencedMessage(
      makeRawReferenceEvent('om_parent_1'),
      { getMessage },
      logger,
    );

    expect(result.content.text).toBe('总结这条引用');
    expect(result.content.referencedMessages).toBeUndefined();
    expect(result.content.referencedMessageWarnings).toEqual([
      'Referenced message om_parent_1 unavailable: missing im scope',
    ]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: 'evt_1', referencedMessageId: 'om_parent_1' }),
      'Failed to enrich event with referenced Feishu message',
    );
  });
});
