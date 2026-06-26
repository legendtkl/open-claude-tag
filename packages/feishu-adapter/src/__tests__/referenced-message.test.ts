import { describe, expect, it } from 'vitest';
import { parseReferencedFeishuMessage } from '../referenced-message.js';

describe('parseReferencedFeishuMessage', () => {
  it('extracts an image attachment candidate from referenced image messages', () => {
    const result = parseReferencedFeishuMessage({
      messageId: 'om_image_001',
      messageType: 'image',
      content: JSON.stringify({ image_key: 'img_v2_ref_001' }),
    });

    expect(result).toMatchObject({
      messageId: 'om_image_001',
      contentType: 'image',
      imageAttachment: {
        messageId: 'om_image_001',
        imageKey: 'img_v2_ref_001',
      },
    });
    expect(result.entries).toEqual([]);
  });

  it('extracts an image attachment candidate from referenced post messages', () => {
    const result = parseReferencedFeishuMessage({
      messageId: 'om_post_001',
      messageType: 'post',
      content: JSON.stringify({
        zh_cn: {
          title: '',
          content: [
            [
              { tag: 'text', text: '请看这张图' },
              { tag: 'img', image_key: 'img_v2_post_001' },
            ],
          ],
        },
      }),
    });

    expect(result.entries).toEqual([{ author: undefined, text: '请看这张图' }]);
    expect(result.imageAttachment).toEqual({
      messageId: 'om_post_001',
      imageKey: 'img_v2_post_001',
    });
  });

  it('imports every parsable entry from a referenced chat record payload', () => {
    const result = parseReferencedFeishuMessage({
      messageId: 'om_record_001',
      messageType: 'post',
      content: JSON.stringify({
        chat_record: [
          {
            sender_name: '周俊戈',
            message_type: 'text',
            content: JSON.stringify({ text: '第一条收支差更新' }),
          },
          {
            sender_name: '周俊戈',
            message_type: 'post',
            content: JSON.stringify({
              zh_cn: {
                title: '',
                content: [[{ tag: 'text', text: '第二条包含富文本' }]],
              },
            }),
          },
          {
            sender_name: '乐露薇',
            text: '第三条来自文本字段',
          },
          {
            sender_name: 'Unsupported',
            message_type: 'sticker',
            content: JSON.stringify({ sticker_key: 'stk_001' }),
          },
        ],
      }),
    });

    expect(result.entries).toEqual([
      { author: '周俊戈', text: '第一条收支差更新' },
      { author: '周俊戈', text: '第二条包含富文本' },
      { author: '乐露薇', text: '第三条来自文本字段' },
    ]);
    expect(result.warnings).toEqual(['Skipped 1 unsupported referenced chat record entries']);
  });

  it('imports every child message returned for a referenced merge-forward message', () => {
    const result = parseReferencedFeishuMessage({
      messageId: 'om_merge_001',
      messageType: 'merge_forward',
      content: JSON.stringify({ content: 'Merged and Forwarded Message' }),
      children: [
        {
          messageId: 'om_child_text',
          messageType: 'text',
          senderName: 'Alice',
          content: JSON.stringify({ text: '第一条子消息' }),
        },
        {
          messageId: 'om_child_post',
          messageType: 'post',
          senderName: 'Bob',
          content: JSON.stringify({
            zh_cn: {
              title: '',
              content: [[{ tag: 'text', text: '第二条富文本子消息' }]],
            },
          }),
        },
        {
          messageId: 'om_child_image',
          messageType: 'image',
          senderName: 'Carol',
          content: JSON.stringify({ image_key: 'img_child_001' }),
        },
      ],
    });

    expect(result.entries).toEqual([
      { author: 'Alice', text: '第一条子消息' },
      { author: 'Bob', text: '第二条富文本子消息' },
    ]);
    expect(result.imageAttachment).toEqual({
      messageId: 'om_child_image',
      imageKey: 'img_child_001',
    });
  });
});
