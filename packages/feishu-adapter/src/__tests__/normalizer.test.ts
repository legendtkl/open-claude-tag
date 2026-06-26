import { describe, it, expect } from 'vitest';
import {
  normalizeDocumentCommentEvent,
  normalizeEvent,
  normalizeEventForObservation,
} from '../normalizer.js';

const BOT_OPEN_ID = 'ou_bot_001';
const BOT_APP_ID = 'cli_bot_001';
const config = { botOpenId: BOT_OPEN_ID, appId: BOT_APP_ID };

function makePostContent(paragraphs: unknown[][], title = '') {
  return JSON.stringify({
    zh_cn: {
      title,
      content: paragraphs,
    },
  });
}

function makeEvent(overrides: Record<string, unknown> = {}) {
  const base = {
    header: {
      event_id: 'evt_001',
      event_type: 'im.message.receive_v1',
      create_time: String(Date.now()),
      token: 'test_token',
      app_id: 'app_001',
      tenant_key: 'tenant_001',
    },
    event: {
      sender: {
        sender_id: { open_id: 'ou_user_001' },
        sender_type: 'user',
        tenant_key: 'tenant_001',
      },
      message: {
        message_id: 'msg_001',
        chat_id: 'oc_chat_001',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: '@_user_1 hello world' }),
        mentions: [
          {
            key: '@_user_1',
            id: { open_id: BOT_OPEN_ID },
            name: 'Bot',
          },
        ],
        ...(overrides.message ?? {}),
      },
    },
  };

  if (overrides.header) {
    Object.assign(base.header, overrides.header);
  }
  if (overrides.event) {
    Object.assign(base.event, overrides.event);
  }

  return base;
}

function makeDocumentCommentEvent(overrides: Record<string, unknown> = {}) {
  const event = {
    event_id: 'evt_doc_comment_001',
    event_type: 'drive.notice.comment_add_v1',
    tenant_key: 'tenant_001',
    app_id: BOT_APP_ID,
    create_time: '1710000000000',
    notice_type: 'add_comment',
    file_token: 'doccnabc123',
    file_type: 'docx',
    document_url: 'https://example.feishu.cn/docx/doccnabc123',
    comment_id: 'comment_001',
    reply_id: 'reply_001',
    quote: 'Meta Harness',
    is_whole: false,
    content: '@ClaudeCode 调研一下社区 Trace 的 AI 分析能力',
    operator_id: {
      open_id: 'ou_user_001',
      union_id: 'on_user_001',
    },
    mention_list: [
      {
        key: '@ClaudeCode',
        id: { open_id: BOT_OPEN_ID, app_id: BOT_APP_ID },
        name: 'ClaudeCode',
      },
    ],
    ...overrides,
  };
  return event;
}

describe('normalizeEvent', () => {
  it('normalizes a group text message with @bot mention', () => {
    const raw = makeEvent();
    const result = normalizeEvent(raw, config);
    expect(result).not.toBeNull();
    expect(result!.eventId).toBe('evt_001');
    expect(result!.chatType).toBe('group');
    expect(result!.content.type).toBe('text');
    expect(result!.content.text).toBe('hello world');
    expect(result!.replyLanguage).toBe('en-US');
    expect(result!.senderOpenId).toBe('ou_user_001');
    expect(result!.senderType).toBe('user');
  });

  it('treats app_id mentions as bot mentions for the current app', () => {
    const raw = makeEvent();
    raw.event.message.mentions = [
      {
        key: '@_user_1',
        id: { app_id: 'cli_current_app' },
        name: 'codex-mac',
      },
    ] as never;

    const result = normalizeEvent(raw, { botOpenId: BOT_OPEN_ID, appId: 'cli_current_app' });

    expect(result).not.toBeNull();
    expect(result!.content.text).toBe('hello world');
    expect(result!.content.mentions).toContainEqual(
      expect.objectContaining({
        id: 'cli_current_app',
        isBot: true,
      }),
    );
  });

  it('preserves sender union id for cross-app user identity mapping', () => {
    const raw = makeEvent();
    Object.assign(raw.event.sender.sender_id, { union_id: 'on_user_001' });

    const result = normalizeEvent(raw, config);

    expect(result).not.toBeNull();
    expect(result!.senderOpenId).toBe('ou_user_001');
    expect(result!.senderUnionId).toBe('on_user_001');
  });

  it('renders non-bot mentions in text messages instead of dropping them', () => {
    const raw = makeEvent();
    raw.event.message.content = JSON.stringify({
      text: '@_user_1 创建一个文件 2.txt，完成之后把 @_user_2 叫起来干活',
    });
    raw.event.message.mentions = [
      {
        key: '@_user_1',
        id: { open_id: BOT_OPEN_ID },
        name: 'OpenClaudeTag',
      },
      {
        key: '@_user_2',
        id: { open_id: 'ou_tao' },
        name: '陶克路',
      },
    ];

    const result = normalizeEvent(raw, config);

    expect(result).not.toBeNull();
    expect(result!.content.text).toBe('创建一个文件 2.txt，完成之后把 @陶克路 叫起来干活');
    expect(result!.content.mentions).toContainEqual(
      expect.objectContaining({
        id: 'ou_tao',
        name: '陶克路',
        key: '@_user_2',
        index: 28,
      }),
    );
  });

  it('detects zh-CN reply language from Chinese text', () => {
    const raw = makeEvent();
    raw.event.message.content = JSON.stringify({ text: '@_user_1 请帮我实现这个功能' });
    const result = normalizeEvent(raw, config);
    expect(result).not.toBeNull();
    expect(result!.replyLanguage).toBe('zh-CN');
  });

  it('detects en-US reply language from English text', () => {
    const raw = makeEvent();
    raw.event.message.content = JSON.stringify({ text: '@_user_1 please implement this feature' });
    const result = normalizeEvent(raw, config);
    expect(result).not.toBeNull();
    expect(result!.replyLanguage).toBe('en-US');
  });

  it('ignores group message without @bot mention', () => {
    const raw = makeEvent({
      message: {
        message_id: 'msg_002',
        chat_id: 'oc_chat_001',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: 'hello' }),
        mentions: [],
      },
    });
    // Override the entire message
    raw.event.message = {
      message_id: 'msg_002',
      chat_id: 'oc_chat_001',
      chat_type: 'group',
      message_type: 'text',
      content: JSON.stringify({ text: 'hello' }),
      mentions: [],
    };
    const result = normalizeEvent(raw, config);
    expect(result).toBeNull();
  });

  it('ignores @all messages', () => {
    const raw = makeEvent();
    raw.event.message.content = JSON.stringify({ text: '@_all hello everyone' });
    raw.event.message.mentions = [
      {
        key: '@_user_1',
        id: { open_id: BOT_OPEN_ID },
        name: 'Bot',
      },
    ];
    const result = normalizeEvent(raw, config);
    expect(result).toBeNull();
  });

  it('processes p2p messages without requiring @bot', () => {
    const raw = makeEvent();
    raw.event.message.chat_type = 'p2p';
    raw.event.message.content = JSON.stringify({ text: 'hello' });
    raw.event.message.mentions = [];
    const result = normalizeEvent(raw, config);
    expect(result).not.toBeNull();
    expect(result!.chatType).toBe('p2p');
    expect(result!.content.text).toBe('hello');
  });

  it('recognizes slash commands with @bot', () => {
    const raw = makeEvent();
    raw.event.message.content = JSON.stringify({ text: '@_user_1 /new my project' });
    const result = normalizeEvent(raw, config);
    expect(result).not.toBeNull();
    expect(result!.content.type).toBe('command');
    expect(result!.content.command).toBe('/new');
    expect(result!.content.args).toBe('my project');
  });

  it('recognizes bot mentions by app id when Feishu omits bot open id', () => {
    const raw = makeEvent();
    raw.event.message.content = JSON.stringify({ text: '@_user_1 /new my project' });
    raw.event.message.mentions = [
      {
        key: '@_user_1',
        id: { open_id: 'cli_debug_bot_app' },
        name: 'Bot',
      },
    ];

    const result = normalizeEvent(raw, { botOpenId: BOT_OPEN_ID, appId: 'cli_debug_bot_app' });

    expect(result).not.toBeNull();
    expect(result!.content.type).toBe('command');
    expect(result!.content.command).toBe('/new');
    expect(result!.content.args).toBe('my project');
    expect(result!.content.mentions).toHaveLength(1);
    expect(result!.content.mentions![0]).toMatchObject({
      id: 'cli_debug_bot_app',
      isBot: true,
    });
  });

  it('ignores slash commands without @bot in group', () => {
    const raw = makeEvent();
    raw.event.message.content = JSON.stringify({ text: '/new my project' });
    raw.event.message.mentions = [];
    const result = normalizeEvent(raw, config);
    expect(result).toBeNull();
  });

  it('recognizes /status command', () => {
    const raw = makeEvent();
    raw.event.message.content = JSON.stringify({ text: '@_user_1 /status' });
    const result = normalizeEvent(raw, config);
    expect(result!.content.type).toBe('command');
    expect(result!.content.command).toBe('/status');
  });

  it('leaves /discuss as plain text so the gated API intake can route it', () => {
    const raw = makeEvent();
    raw.event.message.content = JSON.stringify({
      text: '@_user_1 /discuss @_user_2 你是反方，讨论生产环境引入 AI Coding',
    });
    raw.event.message.mentions = [
      {
        key: '@_user_1',
        id: { open_id: BOT_OPEN_ID },
        name: 'R2D2',
      },
      {
        key: '@_user_2',
        id: { open_id: 'ou_cost_bot' },
        name: '性能成本小助手',
      },
    ];

    const result = normalizeEvent(raw, config);

    expect(result!.content.type).toBe('text');
    expect(result!.content.command).toBeUndefined();
    expect(result!.content.text).toBe(
      '/discuss @性能成本小助手 你是反方，讨论生产环境引入 AI Coding',
    );
  });

  it('accepts /discuss before bot mentions as a mentioned group text message', () => {
    const raw = makeEvent();
    raw.event.message.content = JSON.stringify({
      text: '/discuss @_user_1 你是正方，@_user_2 你是反方，讨论生产环境引入 AI Coding',
    });
    raw.event.message.mentions = [
      {
        key: '@_user_1',
        id: { open_id: BOT_OPEN_ID },
        name: 'R2D2',
      },
      {
        key: '@_user_2',
        id: { open_id: 'ou_cost_bot' },
        name: '性能成本小助手',
      },
    ];

    const result = normalizeEvent(raw, config);

    expect(result!.content.type).toBe('text');
    expect(result!.content.command).toBeUndefined();
    expect(result!.content.text).toBe(
      '/discuss  你是正方，@性能成本小助手 你是反方，讨论生产环境引入 AI Coding',
    );
  });

  it('recognizes /reset command', () => {
    const raw = makeEvent();
    raw.event.message.content = JSON.stringify({ text: '@_user_1 /reset' });
    const result = normalizeEvent(raw, config);
    expect(result!.content.type).toBe('command');
    expect(result!.content.command).toBe('/reset');
  });

  it('handles image message type', () => {
    const raw = makeEvent();
    raw.event.message.message_type = 'image';
    raw.event.message.content = JSON.stringify({ image_key: 'img_001' });
    const result = normalizeEvent(raw, config);
    expect(result!.content.type).toBe('image');
  });

  it('extracts imageKey and imageMessageId from image message', () => {
    const raw = makeEvent();
    raw.event.message.message_type = 'image';
    raw.event.message.content = JSON.stringify({ image_key: 'img_v2_abc123' });
    const result = normalizeEvent(raw, config);
    expect(result).not.toBeNull();
    expect(result!.content.imageKey).toBe('img_v2_abc123');
    expect(result!.content.imageMessageId).toBe('msg_001');
  });

  it('does not set imageKey for text messages', () => {
    const raw = makeEvent();
    const result = normalizeEvent(raw, config);
    expect(result!.content.imageKey).toBeUndefined();
    expect(result!.content.imageMessageId).toBeUndefined();
  });

  it('processes group image message with @bot mention', () => {
    const raw = makeEvent();
    raw.event.message.message_type = 'image';
    raw.event.message.content = JSON.stringify({ image_key: 'img_v2_xyz' });
    // mentions already includes bot from makeEvent
    const result = normalizeEvent(raw, config);
    expect(result).not.toBeNull();
    expect(result!.content.type).toBe('image');
    expect(result!.content.imageKey).toBe('img_v2_xyz');
  });

  it('handles file message type', () => {
    const raw = makeEvent();
    raw.event.message.message_type = 'file';
    raw.event.message.content = JSON.stringify({
      file_key: 'file_001',
      file_name: 'report.pdf',
      mime_type: 'application/pdf',
    });
    const result = normalizeEvent(raw, config);
    expect(result!.content.type).toBe('file');
    expect(result!.content.text).toBe('[Feishu file: report.pdf]');
    expect(result!.content.fileAttachment).toEqual({
      resourceKey: 'file_001',
      messageId: 'msg_001',
      resourceType: 'file',
      fileName: 'report.pdf',
      mimeType: 'application/pdf',
    });
  });

  it('extracts media attachments from media messages', () => {
    const raw = makeEvent();
    raw.event.message.message_type = 'media';
    raw.event.message.content = JSON.stringify({
      file_key: 'media_001',
      file_name: 'demo.mp4',
    });
    const result = normalizeEvent(raw, config);
    expect(result!.content.type).toBe('file');
    expect(result!.content.fileAttachment).toEqual({
      resourceKey: 'media_001',
      messageId: 'msg_001',
      resourceType: 'media',
      fileName: 'demo.mp4',
    });
  });

  it('handles rich_text (post) message type with realistic content', () => {
    const raw = makeEvent();
    raw.event.message.message_type = 'post';
    raw.event.message.content = makePostContent([
      [
        { tag: 'at', user_id: '@_user_1', user_name: 'Bot' },
        { tag: 'text', text: ' some rich text' },
      ],
    ]);
    const result = normalizeEvent(raw, config);
    expect(result!.content.type).toBe('rich_text');
    expect(result!.content.text).toBe('some rich text');
  });

  it('renders non-bot mentions in post messages instead of dropping them', () => {
    const raw = makeEvent();
    raw.event.message.message_type = 'post';
    raw.event.message.content = makePostContent([
      [
        { tag: 'at', user_id: '@_user_1', user_name: 'OpenClaudeTag' },
        { tag: 'text', text: ' 创建一个文件 2.txt，完成之后把 ' },
        { tag: 'at', user_id: '@_user_2', user_name: '陶克路' },
        { tag: 'text', text: ' 叫起来干活' },
      ],
    ]);
    raw.event.message.mentions = [
      {
        key: '@_user_1',
        id: { open_id: BOT_OPEN_ID },
        name: 'OpenClaudeTag',
      },
      {
        key: '@_user_2',
        id: { open_id: 'ou_tao' },
        name: '陶克路',
      },
    ];

    const result = normalizeEvent(raw, config);

    expect(result).not.toBeNull();
    expect(result!.content.type).toBe('rich_text');
    expect(result!.content.text).toBe('创建一个文件 2.txt，完成之后把 @陶克路 叫起来干活');
  });

  it('uses en_us locale wrapper to resolve reply language for post messages', () => {
    const raw = makeEvent();
    raw.event.message.message_type = 'post';
    raw.event.message.content = JSON.stringify({
      en_us: {
        title: '',
        content: [[{ tag: 'text', text: 'Please summarize this issue' }]],
      },
    });
    const result = normalizeEvent(raw, config);
    expect(result).not.toBeNull();
    expect(result!.replyLanguage).toBe('en-US');
  });

  it('prefers Chinese when mixed text is Chinese-dominant', () => {
    const raw = makeEvent();
    raw.event.message.content = JSON.stringify({
      text: '@_user_1 请帮我修复 login bug，并顺便 update tests',
    });
    const result = normalizeEvent(raw, config);
    expect(result).not.toBeNull();
    expect(result!.replyLanguage).toBe('zh-CN');
  });

  it('extracts imageKey from post message with inline image', () => {
    const raw = makeEvent();
    raw.event.message.message_type = 'post';
    raw.event.message.content = makePostContent([
      [
        { tag: 'at', user_id: '@_user_1', user_name: 'Bot' },
        { tag: 'text', text: ' analyze this image' },
      ],
      [{ tag: 'img', image_key: 'img_v3_abc123', width: 800, height: 600 }],
    ]);
    const result = normalizeEvent(raw, config);
    expect(result).not.toBeNull();
    expect(result!.content.text).toBe('analyze this image');
    expect(result!.content.imageKey).toBe('img_v3_abc123');
    expect(result!.content.imageMessageId).toBe('msg_001');
  });

  it('extracts text from post message locale wrappers other than zh_cn', () => {
    const raw = makeEvent();
    raw.event.message.message_type = 'post';
    raw.event.message.content = JSON.stringify({
      en_us: {
        title: '',
        content: [[{ tag: 'text', text: ' /status' }]],
      },
    });
    raw.event.message.chat_type = 'p2p';
    raw.event.message.mentions = [];

    const result = normalizeEvent(raw, config);

    expect(result).not.toBeNull();
    expect(result!.content.type).toBe('command');
    expect(result!.content.command).toBe('/status');
  });

  it('prefers zh_cn content when multiple post locales are present', () => {
    const raw = makeEvent();
    raw.event.message.message_type = 'post';
    raw.event.message.content = JSON.stringify({
      en_us: {
        title: '',
        content: [[{ tag: 'text', text: ' /status' }]],
      },
      zh_cn: {
        title: '',
        content: [[{ tag: 'text', text: ' /help' }]],
      },
    });
    raw.event.message.chat_type = 'p2p';
    raw.event.message.mentions = [];

    const result = normalizeEvent(raw, config);

    expect(result).not.toBeNull();
    expect(result!.content.type).toBe('command');
    expect(result!.content.command).toBe('/help');
  });

  it('falls back to other locale wrappers when zh_cn and en_us are absent', () => {
    const raw = makeEvent();
    raw.event.message.message_type = 'post';
    raw.event.message.content = JSON.stringify({
      ja_jp: {
        title: '',
        content: [[{ tag: 'text', text: ' /status' }]],
      },
    });
    raw.event.message.chat_type = 'p2p';
    raw.event.message.mentions = [];

    const result = normalizeEvent(raw, config);

    expect(result).not.toBeNull();
    expect(result!.content.type).toBe('command');
    expect(result!.content.command).toBe('/status');
  });

  it('prefers localized post content over legacy top-level content when both exist', () => {
    const raw = makeEvent();
    raw.event.message.message_type = 'post';
    raw.event.message.content = JSON.stringify({
      content: [[{ tag: 'text', text: ' /status' }]],
      zh_cn: {
        title: '',
        content: [[{ tag: 'text', text: ' /help' }]],
      },
    });
    raw.event.message.chat_type = 'p2p';
    raw.event.message.mentions = [];

    const result = normalizeEvent(raw, config);

    expect(result).not.toBeNull();
    expect(result!.content.type).toBe('command');
    expect(result!.content.command).toBe('/help');
  });

  it('still supports legacy top-level post content without locale wrappers', () => {
    const raw = makeEvent();
    raw.event.message.message_type = 'post';
    raw.event.message.content = JSON.stringify({
      title: '',
      content: [
        [
          { tag: 'at', user_id: '@_user_1', user_name: 'Bot' },
          { tag: 'text', text: ' check ' },
          { tag: 'a', href: 'https://example.com', text: 'this link' },
          { tag: 'text', text: ' please' },
        ],
      ],
    });

    const result = normalizeEvent(raw, config);

    expect(result).not.toBeNull();
    expect(result!.content.text).toBe('check this link please');
  });

  it('includes link text from post message a tags', () => {
    const raw = makeEvent();
    raw.event.message.message_type = 'post';
    raw.event.message.content = makePostContent([
      [
        { tag: 'at', user_id: '@_user_1', user_name: 'Bot' },
        { tag: 'text', text: ' check ' },
        { tag: 'a', href: 'https://example.com', text: 'this link' },
        { tag: 'text', text: ' please' },
      ],
    ]);
    const result = normalizeEvent(raw, config);
    expect(result).not.toBeNull();
    expect(result!.content.text).toBe('check this link please');
  });

  it('joins multiple paragraphs in post message with newline', () => {
    const raw = makeEvent();
    raw.event.message.message_type = 'post';
    raw.event.message.content = makePostContent([
      [
        { tag: 'at', user_id: '@_user_1', user_name: 'Bot' },
        { tag: 'text', text: ' first paragraph' },
      ],
      [{ tag: 'text', text: 'second paragraph' }],
    ]);
    const result = normalizeEvent(raw, config);
    expect(result).not.toBeNull();
    expect(result!.content.text).toBe('first paragraph\nsecond paragraph');
  });

  it('includes thread_id when present', () => {
    const raw = makeEvent();
    (raw.event.message as Record<string, unknown>).thread_id = 'thread_001';
    const result = normalizeEvent(raw, config);
    expect(result!.threadId).toBe('thread_001');
  });

  it('includes root_id when a group topic reply mentions @bot', () => {
    const raw = makeEvent();
    (raw.event.message as Record<string, unknown>).root_id = 'om_bot_reply_001';
    const result = normalizeEvent(raw, config);
    expect(result!.rootMessageId).toBe('om_bot_reply_001');
  });

  it('ignores thread reply without @bot in group', () => {
    const raw = makeEvent();
    raw.event.message.content = JSON.stringify({ text: '还有什么特点？' });
    raw.event.message.mentions = [];
    (raw.event.message as Record<string, unknown>).thread_id = 'msg_001';
    const result = normalizeEvent(raw, config);
    expect(result).toBeNull();
  });

  it('ignores topic reply without @bot in group (via root_id)', () => {
    const raw = makeEvent();
    raw.event.message.content = JSON.stringify({ text: '继续这个话题' });
    raw.event.message.mentions = [];
    (raw.event.message as Record<string, unknown>).root_id = 'om_bot_reply_001';
    const result = normalizeEvent(raw, config);
    expect(result).toBeNull();
  });

  it('ignores first-level reply with only parent_id without @bot', () => {
    const raw = makeEvent();
    raw.event.message.content = JSON.stringify({ text: '帮我看看这个' });
    raw.event.message.mentions = [];
    (raw.event.message as Record<string, unknown>).parent_id = 'om_parent_001';
    const result = normalizeEvent(raw, config);
    expect(result).toBeNull();
  });

  it('exposes parentMessageId from parent_id', () => {
    const raw = makeEvent();
    (raw.event.message as Record<string, unknown>).parent_id = 'om_parent_002';
    const result = normalizeEvent(raw, config);
    expect(result!.parentMessageId).toBe('om_parent_002');
  });

  it('parentMessageId is undefined when parent_id absent', () => {
    const raw = makeEvent();
    const result = normalizeEvent(raw, config);
    expect(result!.parentMessageId).toBeUndefined();
  });

  it('still ignores non-thread group message without @bot', () => {
    const raw = makeEvent();
    raw.event.message.content = JSON.stringify({ text: 'random message' });
    raw.event.message.mentions = [];
    const result = normalizeEvent(raw, config);
    expect(result).toBeNull();
  });

  it('does not recognize /skill as a slash command (feature removed)', () => {
    const raw = makeEvent();
    raw.event.message.content = JSON.stringify({ text: '@_user_1 /skill list' });
    const result = normalizeEvent(raw, config);
    // /skill is no longer in the registry, so it is treated as ordinary text.
    expect(result!.content.type).not.toBe('command');
  });

  it('recognizes /schedule as slash command', () => {
    const raw = makeEvent();
    raw.event.message.content = JSON.stringify({
      text: '@_user_1 /schedule 明天9点 实现 multi-turn-conversation',
    });
    const result = normalizeEvent(raw, config);
    expect(result!.content.type).toBe('command');
    expect(result!.content.command).toBe('/schedule');
    expect(result!.content.args).toBe('明天9点 实现 multi-turn-conversation');
  });

  it('recognizes /merge-pr as slash command', () => {
    const raw = makeEvent();
    raw.event.message.content = JSON.stringify({ text: '@_user_1 /merge-pr' });
    const result = normalizeEvent(raw, config);
    expect(result!.content.type).toBe('command');
    expect(result!.content.command).toBe('/merge-pr');
    expect(result!.content.args).toBe('');
  });

  it('recognizes /help as slash command', () => {
    const raw = makeEvent();
    raw.event.message.content = JSON.stringify({ text: '@_user_1 /help' });
    const result = normalizeEvent(raw, config);
    expect(result!.content.type).toBe('command');
    expect(result!.content.command).toBe('/help');
    expect(result!.content.args).toBe('');
  });

  it('recognizes /help with --help arg', () => {
    const raw = makeEvent();
    raw.event.message.content = JSON.stringify({ text: '@_user_1 /session --help' });
    const result = normalizeEvent(raw, config);
    expect(result!.content.type).toBe('command');
    expect(result!.content.command).toBe('/session');
    expect(result!.content.args).toBe('--help');
  });

  it('treats commands removed by slim-slash-commands as plain text', () => {
    for (const removed of [
      '/init',
      '/sessions',
      '/use codex do x',
      '/approve 1',
      '/reject 1',
      '/ping',
    ]) {
      const raw = makeEvent();
      raw.event.message.content = JSON.stringify({ text: `@_user_1 ${removed}` });
      const result = normalizeEvent(raw, config);
      expect(result!.content.type).toBe('text');
      expect(result!.content.command).toBeUndefined();
    }
  });

  it('recognizes /clean-task in an existing group topic', () => {
    const raw = makeEvent();
    Object.assign(raw.event.message, { thread_id: 'omt_thread_001' });
    raw.event.message.content = JSON.stringify({ text: '@_user_1 /clean-task --dry-run' });
    const result = normalizeEvent(raw, config);
    expect(result!.threadId).toBe('omt_thread_001');
    expect(result!.content.type).toBe('command');
    expect(result!.content.command).toBe('/clean-task');
    expect(result!.content.args).toBe('--dry-run');
  });

  it('uses the closest mention before a group slash command as the command address', () => {
    const raw = makeEvent();
    raw.event.message.content = JSON.stringify({ text: '@_user_1 @_user_2 /status' });
    raw.event.message.mentions = [
      {
        key: '@_user_1',
        id: { open_id: 'ou_human' },
        name: 'Alice',
      },
      {
        key: '@_user_2',
        id: { open_id: BOT_OPEN_ID },
        name: 'Bot',
      },
    ];

    const result = normalizeEvent(raw, config);

    expect(result!.content.type).toBe('command');
    expect(result!.content.command).toBe('/status');
  });

  it('ignores group slash commands when the closest address mention is not this bot', () => {
    const raw = makeEvent();
    raw.event.message.content = JSON.stringify({ text: '@_user_1 @_user_2 /status' });
    raw.event.message.mentions = [
      {
        key: '@_user_1',
        id: { open_id: BOT_OPEN_ID },
        name: 'Bot',
      },
      {
        key: '@_user_2',
        id: { open_id: 'ou_other' },
        name: 'Other',
      },
    ];

    expect(normalizeEvent(raw, config)).toBeNull();
  });

  it('recognizes /add-bot and preserves the target mention', () => {
    const raw = makeEvent();
    raw.event.message.content = JSON.stringify({ text: '@_user_1 /add-bot @_user_2' });
    raw.event.message.mentions = [
      {
        key: '@_user_1',
        id: { open_id: BOT_OPEN_ID },
        name: 'Bot',
      },
      {
        key: '@_user_2',
        id: { open_id: 'ou_new_bot' },
        name: 'New Bot',
      },
    ];
    const result = normalizeEvent(raw, config);
    expect(result!.content.type).toBe('command');
    expect(result!.content.command).toBe('/add-bot');
    expect(result!.content.args).toBe('');
    expect(result!.content.commandIndex).toBe(9);
    expect(result!.content.mentions).toContainEqual(
      expect.objectContaining({
        id: 'ou_new_bot',
        name: 'New Bot',
        isBot: false,
        key: '@_user_2',
        index: 18,
      }),
    );
  });

  it('ignores /add-bot when this bot is only the target mention', () => {
    const raw = makeEvent();
    raw.event.message.content = JSON.stringify({ text: '@_user_1 /add-bot @_user_2' });
    raw.event.message.mentions = [
      {
        key: '@_user_1',
        id: { open_id: 'ou_old_bot' },
        name: 'Old Bot',
      },
      {
        key: '@_user_2',
        id: { open_id: BOT_OPEN_ID },
        name: 'New Bot',
      },
    ];

    expect(normalizeEvent(raw, config)).toBeNull();
  });

  it('ignores threaded slash commands addressed to another bot', () => {
    const raw = makeEvent();
    Object.assign(raw.event.message, { thread_id: 'omt_thread_001' });
    raw.event.message.content = JSON.stringify({ text: '@_user_1 /add-bot @_user_2' });
    raw.event.message.mentions = [
      {
        key: '@_user_1',
        id: { open_id: 'ou_old_bot' },
        name: 'Old Bot',
      },
      {
        key: '@_user_2',
        id: { open_id: BOT_OPEN_ID },
        name: 'New Bot',
      },
    ];

    expect(normalizeEvent(raw, config)).toBeNull();
  });

  it('ignores threaded slash commands without a current-bot address mention', () => {
    const raw = makeEvent();
    Object.assign(raw.event.message, { thread_id: 'omt_thread_001' });
    raw.event.message.content = JSON.stringify({ text: '/status' });
    raw.event.message.mentions = [];

    expect(normalizeEvent(raw, config)).toBeNull();
  });

  it('recognizes grouped /configure-tasklist messages addressed to this bot', () => {
    const raw = makeEvent();
    raw.event.sender.sender_type = 'app';
    Object.assign(raw.event.message, { thread_id: 'omt_thread_001' });
    raw.event.message.content = JSON.stringify({
      text: '@_user_1 /configure-tasklist payload_123',
    });
    raw.event.message.mentions = [
      {
        key: '@_user_1',
        id: { open_id: BOT_OPEN_ID },
        name: 'New Bot',
      },
    ];

    const result = normalizeEvent(raw, config);
    expect(result!.senderType).toBe('app');
    expect(result!.content.command).toBe('/configure-tasklist');
    expect(result!.content.args).toBe('payload_123');
  });

  it('recognizes bot-to-bot /configure-tasklist p2p messages', () => {
    const raw = makeEvent();
    raw.event.sender.sender_type = 'app';
    raw.event.message.chat_type = 'p2p';
    raw.event.message.content = JSON.stringify({ text: '/configure-tasklist payload_123' });
    raw.event.message.mentions = [];
    const result = normalizeEvent(raw, config);
    expect(result!.chatType).toBe('p2p');
    expect(result!.senderType).toBe('app');
    expect(result!.content.command).toBe('/configure-tasklist');
    expect(result!.content.args).toBe('payload_123');
  });

  it('returns null for missing header', () => {
    const result = normalizeEvent({ event: { message: {} } } as never, config);
    expect(result).toBeNull();
  });
});

describe('normalizeEventForObservation', () => {
  // The observation variant must surface un-addressed group activity that
  // normalizeEvent (the task gate) drops, while never producing an event for a
  // payload that isn't a parseable human message.
  function makeUnaddressedGroupText(text: string) {
    const raw = makeEvent();
    raw.event.message = {
      message_id: 'msg_obs_unaddressed',
      chat_id: 'oc_chat_001',
      chat_type: 'group',
      message_type: 'text',
      content: JSON.stringify({ text }),
      mentions: [],
    } as never;
    return raw;
  }

  it('returns the event for an un-addressed group text message (normalizeEvent drops it)', () => {
    const raw = makeUnaddressedGroupText('the staging deploy uses region us-west-2');

    // normalizeEvent (task gate) still drops it — no task path.
    expect(normalizeEvent(raw, config)).toBeNull();

    // The observation variant surfaces it so the channel tap can follow it.
    const observed = normalizeEventForObservation(raw, config);
    expect(observed).not.toBeNull();
    expect(observed!.chatType).toBe('group');
    expect(observed!.content.type).toBe('text');
    expect(observed!.content.text).toBe('the staging deploy uses region us-west-2');
    expect(observed!.senderType).toBe('user');
  });

  it('returns the same addressed event normalizeEvent does for an @bot group message', () => {
    const raw = makeEvent();
    const addressed = normalizeEvent(raw, config);
    const observed = normalizeEventForObservation(raw, config);
    expect(addressed).not.toBeNull();
    expect(observed).not.toBeNull();
    expect(observed!.content.text).toBe('hello world');
    expect(observed).toEqual(addressed);
  });

  it('surfaces @all group messages (substantive channel content) that normalizeEvent ignores', () => {
    const raw = makeUnaddressedGroupText('@_all the prod deploy is broken');
    expect(normalizeEvent(raw, config)).toBeNull();
    const observed = normalizeEventForObservation(raw, config);
    expect(observed).not.toBeNull();
    expect(observed!.content.type).toBe('text');
    expect(observed!.content.text).toContain('the prod deploy is broken');
  });

  it('returns a command-typed event for a slash command not addressed to this bot (ingest filters it)', () => {
    const raw = makeEvent();
    raw.event.message.content = JSON.stringify({ text: '@_user_1 /new someone-elses-project' });
    // @_user_1 resolves to another user, not the bot.
    raw.event.message.mentions = [
      { key: '@_user_1', id: { open_id: 'ou_other_user' }, name: 'Someone' },
    ] as never;

    expect(normalizeEvent(raw, config)).toBeNull();
    const observed = normalizeEventForObservation(raw, config);
    expect(observed).not.toBeNull();
    // content.type 'command' is non-text, so ingestObservation rejects it — the
    // tap does not need to pre-filter commands here.
    expect(observed!.content.type).toBe('command');
  });

  it('returns the event for p2p messages (always addressed, observed too)', () => {
    const raw = makeEvent();
    raw.event.message.chat_type = 'p2p';
    raw.event.message.content = JSON.stringify({ text: 'hello' });
    raw.event.message.mentions = [];
    const observed = normalizeEventForObservation(raw, config);
    expect(observed).not.toBeNull();
    expect(observed!.chatType).toBe('p2p');
    expect(observed!.content.text).toBe('hello');
  });

  it('returns null when the payload is not a parseable human message', () => {
    expect(normalizeEventForObservation({ event: { message: {} } } as never, config)).toBeNull();
    expect(normalizeEventForObservation({} as never, config)).toBeNull();
  });
});

describe('normalizeDocumentCommentEvent', () => {
  it('normalizes an addressed document comment mention', () => {
    const result = normalizeDocumentCommentEvent(makeDocumentCommentEvent(), config);

    expect(result).toMatchObject({
      eventId: 'evt_doc_comment_001',
      tenantKey: 'tenant_001',
      appId: BOT_APP_ID,
      noticeType: 'add_comment',
      fileToken: 'doccnabc123',
      fileType: 'docx',
      documentUrl: 'https://example.feishu.cn/docx/doccnabc123',
      commentId: 'comment_001',
      replyId: 'reply_001',
      quote: 'Meta Harness',
      isWhole: false,
      senderOpenId: 'ou_user_001',
      senderUnionId: 'on_user_001',
      text: '调研一下社区 Trace 的 AI 分析能力',
    });
    expect(result!.mentions).toContainEqual(
      expect.objectContaining({
        id: BOT_OPEN_ID,
        name: 'ClaudeCode',
        isBot: true,
      }),
    );
  });

  it('accepts nested webhook-style document comment events', () => {
    const raw = {
      header: {
        event_id: 'evt_doc_comment_nested',
        event_type: 'drive.notice.comment_add_v1',
        app_id: BOT_APP_ID,
        tenant_key: 'tenant_nested',
        create_time: '1710000000001',
      },
      event: makeDocumentCommentEvent({
        event_id: undefined,
        app_id: undefined,
        tenant_key: undefined,
        comment_id: 'comment_nested',
      }),
    };

    const result = normalizeDocumentCommentEvent(raw, config);

    expect(result).toMatchObject({
      eventId: 'evt_doc_comment_nested',
      tenantKey: 'tenant_nested',
      commentId: 'comment_nested',
    });
  });

  it('accepts compact Feishu SDK document comment notifications after enrichment', () => {
    const result = normalizeDocumentCommentEvent(
      {
        schema: '2.0',
        event_id: 'evt_compact_comment',
        event_type: 'drive.notice.comment_add_v1',
        tenant_key: 'tenant_compact',
        app_id: BOT_APP_ID,
        create_time: '1710000000002',
        comment_id: 'comment_compact',
        reply_id: 'reply_compact',
        is_mentioned: true,
        notice_meta: {
          file_token: 'doccncompact',
          file_type: 'docx',
          url: 'https://example.feishu.cn/docx/doccncompact',
          quote: 'Meta Harness',
          is_whole: true,
        },
        operator_id: {
          open_id: 'ou_user_compact',
        },
        content: '调研社区 Trace AI 分析能力',
        thread_replies: [
          {
            reply_id: 'reply_previous',
            user_id: 'ou_previous',
            create_time: 1710000000001,
            text: 'Previous question context',
          },
        ],
      },
      config,
    );

    expect(result).toMatchObject({
      eventId: 'evt_compact_comment',
      tenantKey: 'tenant_compact',
      appId: BOT_APP_ID,
      fileToken: 'doccncompact',
      fileType: 'docx',
      documentUrl: 'https://example.feishu.cn/docx/doccncompact',
      commentId: 'comment_compact',
      replyId: 'reply_compact',
      quote: 'Meta Harness',
      isWhole: true,
      senderOpenId: 'ou_user_compact',
      text: '调研社区 Trace AI 分析能力',
    });
    expect(result!.threadReplies).toEqual([
      {
        replyId: 'reply_previous',
        userId: 'ou_previous',
        createTime: 1710000000001,
        text: 'Previous question context',
      },
    ]);
    expect(result!.mentions).toContainEqual(
      expect.objectContaining({
        id: BOT_OPEN_ID,
        isBot: true,
      }),
    );
  });

  it('ignores document comment notifications that do not mention the current bot', () => {
    const result = normalizeDocumentCommentEvent(
      makeDocumentCommentEvent({
        mention_list: [{ id: { open_id: 'ou_other_bot' }, name: 'OtherBot' }],
      }),
      config,
    );

    expect(result).toBeNull();
  });

  it('ignores document comment notifications authored by the current bot', () => {
    const result = normalizeDocumentCommentEvent(
      makeDocumentCommentEvent({
        operator_id: { open_id: BOT_OPEN_ID },
      }),
      config,
    );

    expect(result).toBeNull();
  });

  it('returns null for malformed document comment notifications', () => {
    expect(
      normalizeDocumentCommentEvent(
        makeDocumentCommentEvent({
          document_url: '',
        }),
        config,
      ),
    ).toBeNull();
    expect(
      normalizeDocumentCommentEvent(
        makeDocumentCommentEvent({
          comment_id: '',
        }),
        config,
      ),
    ).toBeNull();
  });
});
