import { describe, it, expect } from 'vitest';
import type { NormalizedEvent } from '@open-tag/core-types';
import { adaptNormalizedEvent } from '../inbound-message.js';

function makeNormalizedEvent(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    eventId: 'evt_001',
    messageId: 'msg_001',
    chatId: 'oc_chat_001',
    chatType: 'group',
    threadId: 'thread_001',
    rootMessageId: 'root_001',
    parentMessageId: 'parent_001',
    senderOpenId: 'ou_user_001',
    senderUnionId: 'on_user_001',
    senderType: 'user',
    tenantKey: 'tenant_001',
    content: {
      type: 'text',
      text: 'hello world',
      mentions: [
        { id: 'ou_bot_001', name: 'Bot', isBot: true, key: '@_user_1' },
        { id: 'ou_user_002', name: 'Alice', isBot: false, key: '@_user_2' },
      ],
      raw: { schema: '2.0' },
    },
    replyLanguage: 'en-US',
    timestamp: 1710000000000,
    ...overrides,
  };
}

describe('adaptNormalizedEvent', () => {
  it('maps a group text message onto a neutral InboundMessage', () => {
    const event = makeNormalizedEvent();
    const inbound = adaptNormalizedEvent(event);

    expect(inbound.channel.kind).toBe('lark');
    expect(inbound.channel.native).toBe(event);
    expect(inbound.eventId).toBe('evt_001');
    expect(inbound.messageId).toBe('msg_001');
    expect(inbound.eventType).toBe('created');
    expect(inbound.occurredAt).toBe(1710000000000);
    expect(inbound.dedupeKey).toBe('lark:msg_001');
    expect(inbound.locale).toBe('en-US');
  });

  it('maps conversation and scope from chat/thread/tenant fields', () => {
    const inbound = adaptNormalizedEvent(makeNormalizedEvent());

    expect(inbound.conversation).toEqual({
      kind: 'lark',
      scopeId: 'oc_chat_001',
      threadId: 'thread_001',
      reply: { rootId: 'root_001', parentId: 'parent_001' },
    });
    expect(inbound.scope).toEqual({
      kind: 'lark',
      scopeId: 'oc_chat_001',
      installationId: 'tenant_001',
      threadId: 'thread_001',
      isPrivate: false,
    });
  });

  it('marks p2p chats as private', () => {
    const inbound = adaptNormalizedEvent(makeNormalizedEvent({ chatType: 'p2p' }));
    expect(inbound.scope.isPrivate).toBe(true);
  });

  it('maps the sender with bot detection and a native escape hatch', () => {
    const inbound = adaptNormalizedEvent(makeNormalizedEvent());
    expect(inbound.sender).toEqual({
      id: 'ou_user_001',
      isBot: false,
      native: { unionId: 'on_user_001', senderType: 'user' },
    });

    const botInbound = adaptNormalizedEvent(makeNormalizedEvent({ senderType: 'app' }));
    expect(botInbound.sender.isBot).toBe(true);
  });

  it('maps content text and mentions', () => {
    const inbound = adaptNormalizedEvent(makeNormalizedEvent());

    expect(inbound.content.type).toBe('text');
    expect(inbound.content.text).toBe('hello world');
    expect(inbound.content.mentions).toEqual([
      { id: 'ou_bot_001', type: 'bot', raw: '@_user_1' },
      { id: 'ou_user_002', type: 'user', raw: '@_user_2' },
    ]);
  });

  it('maps a slash command with args', () => {
    const inbound = adaptNormalizedEvent(
      makeNormalizedEvent({
        content: {
          type: 'command',
          text: '/schedule daily',
          command: '/schedule',
          args: 'daily',
          mentions: [],
          raw: {},
        },
      }),
    );

    expect(inbound.content.type).toBe('command');
    expect(inbound.content.command).toBe('/schedule');
    expect(inbound.content.args).toBe('daily');
  });

  it('maps image and file attachments to AttachmentRef', () => {
    const inbound = adaptNormalizedEvent(
      makeNormalizedEvent({
        content: {
          type: 'image',
          imageKey: 'img_key_001',
          imageMessageId: 'msg_001',
          fileAttachment: {
            resourceKey: 'file_key_001',
            messageId: 'msg_001',
            resourceType: 'media',
            fileName: 'clip.mp4',
            mimeType: 'video/mp4',
          },
          mentions: [],
          raw: {},
        },
      }),
    );

    expect(inbound.content.attachments).toEqual([
      {
        type: 'image',
        id: 'img_key_001',
        native: { imageKey: 'img_key_001', messageId: 'msg_001' },
      },
      {
        type: 'file',
        id: 'file_key_001',
        name: 'clip.mp4',
        mimeType: 'video/mp4',
        native: {
          resourceKey: 'file_key_001',
          messageId: 'msg_001',
          resourceType: 'media',
          fileName: 'clip.mp4',
          mimeType: 'video/mp4',
        },
      },
    ]);
  });

  it('maps referenced messages, joining entry text', () => {
    const inbound = adaptNormalizedEvent(
      makeNormalizedEvent({
        content: {
          type: 'text',
          text: 'see above',
          mentions: [],
          referencedMessages: [
            {
              messageId: 'msg_ref_001',
              contentType: 'text',
              entries: [
                { author: 'Alice', text: 'line one' },
                { text: 'line two' },
              ],
            },
          ],
          raw: {},
        },
      }),
    );

    expect(inbound.content.referenced).toEqual([
      {
        messageId: 'msg_ref_001',
        text: 'line one\nline two',
        sender: 'Alice',
        // Per-entry author/text carried verbatim for core goal assembly (ADR-0004).
        entries: [{ author: 'Alice', text: 'line one' }, { text: 'line two' }],
      },
    ]);
  });

  it('preserves an explicit empty-string entry author in the neutral entries', () => {
    const inbound = adaptNormalizedEvent(
      makeNormalizedEvent({
        content: {
          type: 'text',
          text: 'see above',
          mentions: [],
          referencedMessages: [
            {
              messageId: 'msg_ref_002',
              contentType: 'text',
              entries: [{ author: '', text: 'anon line' }],
            },
          ],
          raw: {},
        },
      }),
    );

    expect(inbound.content.referenced?.[0].entries).toEqual([{ author: '', text: 'anon line' }]);
  });

  it('falls back to eventId for the dedupe key when messageId is empty', () => {
    const inbound = adaptNormalizedEvent(makeNormalizedEvent({ messageId: '' }));
    expect(inbound.messageId).toBe('evt_001');
    expect(inbound.dedupeKey).toBe('lark:evt_001');
  });
});
