import { describe, it, expect, vi, beforeEach } from 'vitest';

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock('@open-tag/observability', () => ({
  createLogger: vi.fn(() => loggerMock),
}));

import { ThreePhaseFeedback, createFeishuChannelSender } from '../feedback.js';
import type { FeishuClient } from '../feishu-client.js';
import { splitTaskCardDetail } from '../card-builder.js';

function makeClient(): FeishuClient {
  return {
    sendMessage: vi.fn().mockResolvedValue({ messageId: 'msg_ack_001' }),
    updateMessage: vi.fn().mockResolvedValue(undefined),
    addReaction: vi.fn().mockResolvedValue({ reactionId: 'reaction_001' }),
    removeReaction: vi.fn().mockResolvedValue(undefined),
  } as unknown as FeishuClient;
}

function extractDetailBody(payload: any): string | undefined {
  const elements = payload.card?.body?.elements as
    | Array<{ tag: string; content?: string }>
    | undefined;
  const detailElement = elements?.find(
    (element) =>
      element.tag === 'markdown' &&
      typeof element.content === 'string' &&
      (element.content.startsWith('**Result**\n') || element.content.startsWith('**Error**\n')),
  );

  return detailElement?.content?.replace(/^\*\*(Result|Error)\*\*\n/, '');
}

function extractRichReplyMarkdown(payload: any): string {
  const elements = payload.card?.body?.elements as Array<{ tag: string; content?: string }>;
  const markdown = elements.find((element) => element.tag === 'markdown');
  return markdown?.content ?? '';
}

function buildOverflowTableDetail(rowCount: number): string {
  const rows = Array.from({ length: rowCount }, (_, index) => {
    const rowId = index + 1;
    return `| ${rowId} | scenario ${rowId} ${'s'.repeat(60)} | given ${'g'.repeat(
      120,
    )} | when ${'w'.repeat(120)} | then ${'t'.repeat(120)} |`;
  });

  return [
    'Suggested verification cases:',
    '',
    '| # | Scenario | GIVEN | WHEN | THEN |',
    '|---|---|---|---|---|',
    ...rows,
  ].join('\n');
}

function buildOverflowTableMarkdown(rowCount: number): string {
  const rows = Array.from({ length: rowCount }, (_, index) => {
    const rowId = index + 1;
    return `| ${rowId} | scenario ${rowId} ${'s'.repeat(60)} | given ${'g'.repeat(
      120,
    )} | when ${'w'.repeat(120)} | then ${'t'.repeat(120)} |`;
  });

  return ['| # | Scenario | GIVEN | WHEN | THEN |', '|---|---|---|---|---|', ...rows].join('\n');
}

function buildMixedOverflowDetail(rowCount: number): string {
  return [
    `Overview paragraph ${'o'.repeat(900)}`,
    '',
    buildOverflowTableMarkdown(rowCount),
    '',
    `Closing notes ${'c'.repeat(900)}`,
  ].join('\n');
}

describe('ThreePhaseFeedback', () => {
  let client: FeishuClient;
  let feedback: ThreePhaseFeedback;

  beforeEach(() => {
    client = makeClient();
    feedback = new ThreePhaseFeedback(createFeishuChannelSender(client), 'chat_123');
  });

  it('sendAck sends interactive card and stores ackMessageId', async () => {
    await feedback.sendAck('写一个快排');
    expect(client.sendMessage).toHaveBeenCalledOnce();
    const [idType, chatId, card] = (client.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(idType).toBe('chat_id');
    expect(chatId).toBe('chat_123');
    expect((card as any).msg_type).toBe('interactive');
    expect(feedback.getAckMessageId()).toBe('msg_ack_001');
  });

  it('updateDone patches the existing card and sends a completion notification', async () => {
    const feedbackWithReply = new ThreePhaseFeedback(createFeishuChannelSender(client), 'chat_123', 'msg_user_001');
    await feedbackWithReply.sendAck('写一个快排');
    vi.mocked(client.sendMessage).mockClear();

    await feedbackWithReply.updateDone('写一个快排', '这是 AI 输出');

    expect(client.updateMessage).toHaveBeenCalledOnce();
    expect(client.sendMessage).toHaveBeenCalledOnce();
    const [, card] = (client.updateMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    expect((card as any).card.header?.template).toBe('green');
    expect((card as any).card.body.elements).toHaveLength(3);
    const [idType, chatId, payload, replyToMessageId] = (
      client.sendMessage as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    expect(idType).toBe('chat_id');
    expect(chatId).toBe('chat_123');
    expect(payload).toEqual({
      msg_type: 'text',
      content: { text: 'Task complete\nTask: 写一个快排' },
    });
    expect(replyToMessageId).toBe('msg_user_001');
  });

  it('updateDone sends a completion notification even when no result is returned', async () => {
    await feedback.sendAck('写一个快排');
    vi.mocked(client.sendMessage).mockClear();
    await feedback.updateDone('写一个快排');

    expect(client.updateMessage).toHaveBeenCalledOnce();
    expect(client.sendMessage).toHaveBeenCalledOnce();
    const [, card] = (client.updateMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    expect((card as any).card.body.elements).toHaveLength(1);
    const [, , payload, replyToMessageId] = (client.sendMessage as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(payload).toEqual({
      msg_type: 'text',
      content: { text: 'Task complete\nTask: 写一个快排' },
    });
    expect(replyToMessageId).toBe('msg_ack_001');
  });

  it('updateDone uses custom completion notification text with rendered mentions', async () => {
    const feedbackWithReply = new ThreePhaseFeedback(createFeishuChannelSender(client), 'chat_123', 'msg_user_001');
    await feedbackWithReply.sendAck('创建文件');
    vi.mocked(client.sendMessage).mockClear();

    await feedbackWithReply.updateDone('创建文件', '已创建 1.txt', {
      completionText: '{{mention:ou_chen:陈环}} {{mention:ou_li:Li & Co}} 已创建 1.txt，请看一下。',
    });

    expect(client.updateMessage).toHaveBeenCalledOnce();
    expect(client.sendMessage).toHaveBeenCalledOnce();
    const [, , payload, replyToMessageId] = (client.sendMessage as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(payload).toMatchObject({
      msg_type: 'interactive',
      card: {
        header: {
          title: { content: 'Answer' },
          text_tag_list: [{ text: { content: 'reply' } }],
        },
      },
    });
    expect(extractRichReplyMarkdown(payload)).toBe(
      '<at user_id="ou_chen">陈环</at> <at user_id="ou_li">Li &amp; Co</at> 已创建 1.txt，请看一下。',
    );
    expect(replyToMessageId).toBe('msg_user_001');
  });

  it('updateDone falls back to fixed completion text when custom text is blank', async () => {
    await feedback.sendAck('写一个快排');
    vi.mocked(client.sendMessage).mockClear();

    await feedback.updateDone('写一个快排', '这是 AI 输出', { completionText: '  ' });

    const [, , payload] = (client.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(payload).toEqual({
      msg_type: 'text',
      content: { text: 'Task complete\nTask: 写一个快排' },
    });
  });

  it('updateDone strips mention placeholders without display names', async () => {
    await feedback.sendAck('创建文件');
    vi.mocked(client.sendMessage).mockClear();

    await feedback.updateDone('创建文件', '已创建 1.txt', {
      completionText: '{{mention:ou_chen}} {{mention:ou_li:Li}} done',
    });

    const [, , payload] = (client.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(payload).toMatchObject({ msg_type: 'interactive' });
    expect(extractRichReplyMarkdown(payload)).toBe('<at user_id="ou_li">Li</at> done');
  });

  it('updateDone strips malformed mention placeholders without leaking raw text', async () => {
    await feedback.sendAck('创建文件');
    vi.mocked(client.sendMessage).mockClear();

    await feedback.updateDone('创建文件', '已创建 1.txt', {
      completionText: [
        '{{mention:ou_bad!:Bad}}',
        `{{mention:ou_long:${'A'.repeat(129)}}}`,
        '{{mention:ou_good:Good}}',
        'done',
      ].join(' '),
    });

    const [, , payload] = (client.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    const text = extractRichReplyMarkdown(payload);
    expect(text).toBe('<at user_id="ou_good">Good</at> done');
    expect(text).not.toContain('{{mention:');
  });

  it('updateDone renders only allowed non-bot mention placeholders', async () => {
    await feedback.sendAck('创建文件');
    vi.mocked(client.sendMessage).mockClear();

    await feedback.updateDone('创建文件', '已创建 1.txt', {
      completionText:
        '{{mention:ou_sender:Sender}} {{mention:ou_bot:OpenClaudeTag}} {{mention:ou_chen:Wrong Name}} done',
      allowedMentions: [
        { openId: 'ou_bot', name: 'OpenClaudeTag', isBot: true },
        { openId: 'ou_chen', name: '陈环', isBot: false },
      ],
    });

    const [, , payload] = (client.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(payload).toMatchObject({ msg_type: 'interactive' });
    expect(extractRichReplyMarkdown(payload)).toBe('<at user_id="ou_chen">陈环</at> done');
  });

  it('updateDone strips all mention placeholders when allowlist is empty', async () => {
    await feedback.sendAck('创建文件');
    vi.mocked(client.sendMessage).mockClear();

    await feedback.updateDone('创建文件', '已创建 1.txt', {
      completionText: '{{mention:ou_sender:Sender}} {{mention:ou_bot:OpenClaudeTag}} done',
      allowedMentions: [],
    });

    const [, , payload] = (client.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(payload).toMatchObject({ msg_type: 'interactive' });
    expect(extractRichReplyMarkdown(payload)).toBe('done');
  });

  it('updateDone renders at most twenty mention placeholders', async () => {
    await feedback.sendAck('创建文件');
    vi.mocked(client.sendMessage).mockClear();
    const completionText = Array.from(
      { length: 21 },
      (_, index) => `{{mention:ou_${index}:User ${index}}}`,
    ).join(' ');

    await feedback.updateDone('创建文件', '已创建 1.txt', { completionText });

    const [, , payload] = (client.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    const text = extractRichReplyMarkdown(payload);
    expect(text.match(/<at user_id="/g)).toHaveLength(20);
    expect(text).not.toContain('{{mention:ou_20:User 20}}');
  });

  it('updateDone falls back to truncated text for oversize custom completion notification text', async () => {
    await feedback.sendAck('创建文件');
    vi.mocked(client.sendMessage).mockClear();

    await feedback.updateDone('创建文件', '已创建 1.txt', {
      completionText: 'x'.repeat(3100),
    });

    const [, , payload] = (client.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(payload).toMatchObject({ msg_type: 'text' });
    const text = (payload as { content: { text: string } }).content.text;
    expect(text).toHaveLength(1999);
    expect(text.endsWith('... (truncated)')).toBe(true);
  });

  it('updateDone falls back to text when rich completion notification delivery fails', async () => {
    await feedback.sendAck('创建文件');
    vi.mocked(client.sendMessage).mockClear();
    vi.mocked(client.sendMessage)
      .mockRejectedValueOnce(new Error('rich card rejected'))
      .mockResolvedValueOnce({ messageId: 'msg_text_fallback' });

    const result = await feedback.updateDone('创建文件', '已创建 1.txt', {
      completionText: '- 已创建文件\n- 已更新测试',
    });

    expect(client.updateMessage).toHaveBeenCalledOnce();
    expect(client.sendMessage).toHaveBeenCalledTimes(2);
    const richCall = (client.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    const textFallbackCall = (client.sendMessage as ReturnType<typeof vi.fn>).mock.calls[1];
    expect(richCall[2]).toMatchObject({ msg_type: 'interactive' });
    expect(textFallbackCall[2]).toEqual({
      msg_type: 'text',
      content: { text: '- 已创建文件\n- 已更新测试' },
    });
    expect(result?.completionMessageId).toBe('msg_text_fallback');
  });

  it('updateDone sends overflow continuation cards when result exceeds the card limit', async () => {
    const feedbackWithReply = new ThreePhaseFeedback(createFeishuChannelSender(client), 'chat_123', 'msg_user_001');
    const longResult = 'x'.repeat(4500);
    await feedbackWithReply.sendAck('写一个快排');
    vi.mocked(client.sendMessage).mockClear();

    await feedbackWithReply.updateDone('写一个快排', longResult);

    expect(client.updateMessage).toHaveBeenCalledOnce();
    expect(client.sendMessage).toHaveBeenCalledTimes(3);
    const [, primaryCard] = (client.updateMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    const firstOverflowCall = (client.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    const secondOverflowCall = (client.sendMessage as ReturnType<typeof vi.fn>).mock.calls[1];
    const completionNotification = (client.sendMessage as ReturnType<typeof vi.fn>).mock.calls[2];
    expect(firstOverflowCall[2]).toMatchObject({ msg_type: 'interactive' });
    expect((firstOverflowCall[2] as any).card.header?.title.content).toContain('continued');
    expect(firstOverflowCall[3]).toBe('msg_user_001');
    expect(secondOverflowCall[2]).toMatchObject({ msg_type: 'interactive' });
    expect((secondOverflowCall[2] as any).card.header?.title.content).toContain('continued');
    expect(secondOverflowCall[3]).toBe('msg_user_001');
    expect(
      [primaryCard, firstOverflowCall[2], secondOverflowCall[2]].map(extractDetailBody).join(''),
    ).toBe(longResult);
    expect(completionNotification[2]).toEqual({
      msg_type: 'text',
      content: { text: 'Task complete\nTask: 写一个快排' },
    });
  });

  it('updateDone threads overflow cards and completion notification under the ack card when no thread exists', async () => {
    const longResult = 'x'.repeat(4500);
    await feedback.sendAck('写一个快排');
    vi.mocked(client.sendMessage).mockClear();

    await feedback.updateDone('写一个快排', longResult);

    expect(client.updateMessage).toHaveBeenCalledOnce();
    expect(client.sendMessage).toHaveBeenCalledTimes(3);
    const firstOverflowCall = (client.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    const secondOverflowCall = (client.sendMessage as ReturnType<typeof vi.fn>).mock.calls[1];
    const completionNotification = (client.sendMessage as ReturnType<typeof vi.fn>).mock.calls[2];
    expect(firstOverflowCall[3]).toBe('msg_ack_001');
    expect(secondOverflowCall[3]).toBe('msg_ack_001');
    expect(completionNotification[3]).toBe('msg_ack_001');
  });

  it('updateDone keeps single-card behavior at the detail limit', async () => {
    await feedback.sendAck('写一个快排');
    vi.mocked(client.sendMessage).mockClear();

    await feedback.updateDone('写一个快排', 'x'.repeat(2000));

    expect(client.updateMessage).toHaveBeenCalledOnce();
    expect(client.sendMessage).toHaveBeenCalledOnce();
    const [, , payload] = (client.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(payload).toEqual({
      msg_type: 'text',
      content: { text: 'Task complete\nTask: 写一个快排' },
    });
  });

  it('updateRunning patches card with running state (PATCH, not new message)', async () => {
    await feedback.sendAck('写一个快排');
    vi.mocked(client.sendMessage).mockClear();
    await feedback.updateRunning('Executing...', 60, ['Preparing task...', 'Executing...']);
    expect(client.updateMessage).toHaveBeenCalledOnce();
    expect(client.sendMessage).not.toHaveBeenCalled();
    const [, card] = (client.updateMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    expect((card as any).card.header?.template).toBe('orange');
    expect((card as any).card.header?.title.content).toContain('60%');
    expect((card as any).card.body.elements).toHaveLength(3);
    expect((card as any).card.body.elements[2].content).toContain('Preparing task...');
  });

  it('updateRunning logs and swallows patch failures', async () => {
    await feedback.sendAck('写一个快排');
    vi.mocked(client.sendMessage).mockClear();
    vi.mocked(client.updateMessage).mockRejectedValueOnce(new Error('patch failed'));

    await expect(
      feedback.updateRunning('Executing...', 60, ['Preparing task...', 'Executing...']),
    ).resolves.toBeUndefined();

    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        ackMessageId: 'msg_ack_001',
        description: 'Executing...',
        err: expect.any(Error),
      }),
      'Failed to update running card',
    );
  });

  it('updateFailed patches the existing card without sending an extra notification', async () => {
    const feedbackWithReply = new ThreePhaseFeedback(createFeishuChannelSender(client), 'chat_123', 'msg_user_001');
    await feedbackWithReply.sendAck('写一个快排');
    vi.mocked(client.sendMessage).mockClear();
    await feedbackWithReply.updateFailed('写一个快排', 'compilation error');
    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(client.updateMessage).toHaveBeenCalledOnce();
    const [, card] = (client.updateMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    expect((card as any).card.header?.template).toBe('red');
    expect((card as any).card.body.elements).toHaveLength(3);
  });

  it('updateFailed sends overflow continuation cards when error exceeds the card limit', async () => {
    const feedbackWithReply = new ThreePhaseFeedback(createFeishuChannelSender(client), 'chat_123', 'msg_user_001');
    const longError = 'e'.repeat(4500);
    await feedbackWithReply.sendAck('写一个快排');
    vi.mocked(client.sendMessage).mockClear();

    await feedbackWithReply.updateFailed('写一个快排', longError);

    expect(client.updateMessage).toHaveBeenCalledOnce();
    expect(client.sendMessage).toHaveBeenCalledTimes(2);
    const [, primaryCard] = (client.updateMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    const firstOverflowCall = (client.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    const secondOverflowCall = (client.sendMessage as ReturnType<typeof vi.fn>).mock.calls[1];
    expect(firstOverflowCall[2]).toMatchObject({ msg_type: 'interactive' });
    expect((firstOverflowCall[2] as any).card.header?.title.content).toContain('continued');
    expect(firstOverflowCall[3]).toBe('msg_user_001');
    expect(secondOverflowCall[2]).toMatchObject({ msg_type: 'interactive' });
    expect((secondOverflowCall[2] as any).card.header?.title.content).toContain('continued');
    expect(secondOverflowCall[3]).toBe('msg_user_001');
    expect(
      [primaryCard, firstOverflowCall[2], secondOverflowCall[2]].map(extractDetailBody).join(''),
    ).toBe(longError);
  });

  it('updateDone is no-op when ackMessageId is not set', async () => {
    const feedbackNoChatId = new ThreePhaseFeedback(createFeishuChannelSender(client), '');
    await feedbackNoChatId.updateDone('desc', 'result');
    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(client.updateMessage).not.toHaveBeenCalled();
  });

  it('updateRunning is no-op when ackMessageId not set', async () => {
    await feedback.updateRunning('desc');
    expect(client.updateMessage).not.toHaveBeenCalled();
  });

  it('initialAckMessageId allows updateRunning without calling sendAck first', async () => {
    const feedbackWithAck = new ThreePhaseFeedback(
      createFeishuChannelSender(client),
      'chat_123',
      undefined,
      'existing_ack_msg',
    );
    await feedbackWithAck.updateRunning('Running...', 50, ['Running...']);
    expect(client.updateMessage).toHaveBeenCalledOnce();
    const [msgId] = (client.updateMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(msgId).toBe('existing_ack_msg');
    expect(feedbackWithAck.getAckMessageId()).toBe('existing_ack_msg');
  });

  it('initialAckMessageId allows updateDone without calling sendAck first', async () => {
    const feedbackWithAck = new ThreePhaseFeedback(
      createFeishuChannelSender(client),
      'chat_123',
      undefined,
      'existing_ack_msg',
    );
    await feedbackWithAck.updateDone('Done', 'result');
    expect(client.updateMessage).toHaveBeenCalledOnce();
    const [msgId] = (client.updateMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(msgId).toBe('existing_ack_msg');
  });

  it('updateDone falls back to text when patch fails', async () => {
    await feedback.sendAck('写一个快排');
    vi.mocked(client.updateMessage).mockRejectedValueOnce(new Error('patch failed'));
    vi.mocked(client.sendMessage).mockClear();

    await feedback.updateDone('写一个快排', '这是 AI 输出');

    expect(client.updateMessage).toHaveBeenCalledOnce();
    expect(client.sendMessage).toHaveBeenCalledOnce();
    const [, , payload, replyToMessageId] = (client.sendMessage as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(payload).toEqual({
      msg_type: 'text',
      content: { text: 'Task complete\nTask: 写一个快排\n\n这是 AI 输出' },
    });
    expect(replyToMessageId).toBe('msg_ack_001');
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        ackMessageId: 'msg_ack_001',
        description: '写一个快排',
        err: expect.any(Error),
      }),
      'Failed to update done card',
    );
  });

  it('updateDone falls back to text when overflow card delivery fails', async () => {
    const feedbackWithReply = new ThreePhaseFeedback(createFeishuChannelSender(client), 'chat_123', 'msg_user_001');
    const longResult = 'x'.repeat(4500);
    await feedbackWithReply.sendAck('写一个快排');
    vi.mocked(client.sendMessage).mockClear();
    vi.mocked(client.sendMessage)
      .mockRejectedValueOnce(new Error('overflow send failed'))
      .mockResolvedValue({ messageId: 'msg_fallback_001' });

    await feedbackWithReply.updateDone('写一个快排', longResult);

    expect(client.updateMessage).toHaveBeenCalledOnce();
    expect(client.sendMessage).toHaveBeenCalledTimes(4);
    const [, , firstFallbackPayload] = (client.sendMessage as ReturnType<typeof vi.fn>).mock
      .calls[1];
    const [, , secondFallbackPayload] = (client.sendMessage as ReturnType<typeof vi.fn>).mock
      .calls[2];
    const [, , completionNotification] = (client.sendMessage as ReturnType<typeof vi.fn>).mock
      .calls[3];
    expect(firstFallbackPayload).toEqual({
      msg_type: 'text',
      content: { text: `Task complete (continued)\nTask: 写一个快排\n\n${'x'.repeat(2000)}` },
    });
    expect(secondFallbackPayload).toEqual({
      msg_type: 'text',
      content: { text: `Task complete (continued) (2/2)\nTask: 写一个快排\n\n${'x'.repeat(500)}` },
    });
    expect(completionNotification).toEqual({
      msg_type: 'text',
      content: { text: 'Task complete\nTask: 写一个快排' },
    });
  });

  it('updateDone text fallback preserves structured table continuation boundaries', async () => {
    const feedbackWithReply = new ThreePhaseFeedback(createFeishuChannelSender(client), 'chat_123', 'msg_user_001');
    const tableResult = buildOverflowTableDetail(12);
    const overflowSegments = splitTaskCardDetail(tableResult).slice(1);
    await feedbackWithReply.sendAck('写一个快排');
    vi.mocked(client.sendMessage).mockClear();
    vi.mocked(client.sendMessage)
      .mockRejectedValueOnce(new Error('overflow send failed'))
      .mockResolvedValue({ messageId: 'msg_fallback_001' });

    await feedbackWithReply.updateDone('写一个快排', tableResult);

    expect(client.updateMessage).toHaveBeenCalledOnce();
    expect(client.sendMessage).toHaveBeenCalledTimes(overflowSegments.length + 2);

    const fallbackCalls = (client.sendMessage as ReturnType<typeof vi.fn>).mock.calls.slice(
      1,
      1 + overflowSegments.length,
    );
    fallbackCalls.forEach((call, index) => {
      expect(call[2]).toEqual({
        msg_type: 'text',
        content: {
          text: [
            index === 0
              ? 'Task complete (continued)'
              : `Task complete (continued) (${index + 1}/${overflowSegments.length})`,
            'Task: 写一个快排',
            '',
            overflowSegments[index],
          ].join('\n'),
        },
      });
      expect((call[2] as any).content.text).toContain('| # | Scenario | GIVEN | WHEN | THEN |');
    });
  });

  it('updateDone keeps mixed prose aligned with overflow fallback table segments', async () => {
    const feedbackWithReply = new ThreePhaseFeedback(createFeishuChannelSender(client), 'chat_123', 'msg_user_001');
    const mixedResult = buildMixedOverflowDetail(12);
    const overflowSegments = splitTaskCardDetail(mixedResult).slice(1);
    await feedbackWithReply.sendAck('写一个快排');
    vi.mocked(client.sendMessage).mockClear();
    vi.mocked(client.sendMessage)
      .mockRejectedValueOnce(new Error('overflow send failed'))
      .mockResolvedValue({ messageId: 'msg_fallback_001' });

    await feedbackWithReply.updateDone('写一个快排', mixedResult);

    const [, updatedCard] = (client.updateMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    const updatedElements = (updatedCard as any).card.body.elements as Array<{
      tag: string;
      content?: string;
    }>;
    const introIndex = updatedElements.findIndex(
      (element) => element.tag === 'markdown' && element.content?.includes('Overview paragraph'),
    );
    const tableIndex = updatedElements.findIndex((element) => element.tag === 'table');

    expect(introIndex).toBeGreaterThan(-1);
    expect(tableIndex).toBeGreaterThan(introIndex);

    const fallbackCalls = (client.sendMessage as ReturnType<typeof vi.fn>).mock.calls.slice(
      1,
      1 + overflowSegments.length,
    );
    expect((fallbackCalls.at(-1)?.[2] as any).content.text).toContain('Closing notes');
    expect(
      fallbackCalls.some((call) =>
        ((call[2] as any).content.text as string).includes(
          '| # | Scenario | GIVEN | WHEN | THEN |',
        ),
      ),
    ).toBe(true);
  });

  it('updateFailed falls back to text when overflow card delivery fails', async () => {
    const feedbackWithReply = new ThreePhaseFeedback(createFeishuChannelSender(client), 'chat_123', 'msg_user_001');
    const longError = 'e'.repeat(4500);
    await feedbackWithReply.sendAck('写一个快排');
    vi.mocked(client.sendMessage).mockClear();
    vi.mocked(client.sendMessage)
      .mockRejectedValueOnce(new Error('overflow send failed'))
      .mockResolvedValue({ messageId: 'msg_fallback_001' });

    await feedbackWithReply.updateFailed('写一个快排', longError);

    expect(client.updateMessage).toHaveBeenCalledOnce();
    expect(client.sendMessage).toHaveBeenCalledTimes(3);
    const [, , firstFallbackPayload] = (client.sendMessage as ReturnType<typeof vi.fn>).mock
      .calls[1];
    const [, , secondFallbackPayload] = (client.sendMessage as ReturnType<typeof vi.fn>).mock
      .calls[2];
    expect(firstFallbackPayload).toEqual({
      msg_type: 'text',
      content: { text: `Task failed (continued)\nTask: 写一个快排\n\n${'e'.repeat(2000)}` },
    });
    expect(secondFallbackPayload).toEqual({
      msg_type: 'text',
      content: { text: `Task failed (continued) (2/2)\nTask: 写一个快排\n\n${'e'.repeat(500)}` },
    });
  });

  it('updateFailed text fallback preserves structured table continuation boundaries', async () => {
    const feedbackWithReply = new ThreePhaseFeedback(createFeishuChannelSender(client), 'chat_123', 'msg_user_001');
    const tableError = buildOverflowTableDetail(12);
    const overflowSegments = splitTaskCardDetail(tableError).slice(1);
    await feedbackWithReply.sendAck('写一个快排');
    vi.mocked(client.sendMessage).mockClear();
    vi.mocked(client.sendMessage)
      .mockRejectedValueOnce(new Error('overflow send failed'))
      .mockResolvedValue({ messageId: 'msg_fallback_001' });

    await feedbackWithReply.updateFailed('写一个快排', tableError);

    expect(client.updateMessage).toHaveBeenCalledOnce();
    expect(client.sendMessage).toHaveBeenCalledTimes(overflowSegments.length + 1);

    const fallbackCalls = (client.sendMessage as ReturnType<typeof vi.fn>).mock.calls.slice(
      1,
      1 + overflowSegments.length,
    );
    fallbackCalls.forEach((call, index) => {
      expect(call[2]).toEqual({
        msg_type: 'text',
        content: {
          text: [
            index === 0
              ? 'Task failed (continued)'
              : `Task failed (continued) (${index + 1}/${overflowSegments.length})`,
            'Task: 写一个快排',
            '',
            overflowSegments[index],
          ].join('\n'),
        },
      });
      expect((call[2] as any).content.text).toContain('| # | Scenario | GIVEN | WHEN | THEN |');
    });
  });

  it('updateDone swallows completion notification failures after patch succeeds', async () => {
    await feedback.sendAck('写一个快排');
    vi.mocked(client.sendMessage).mockClear();
    vi.mocked(client.sendMessage).mockRejectedValue(new Error('notification failed'));

    await expect(
      feedback.updateDone('写一个快排', '这是 AI 输出', { completionText: '这是 AI 输出' }),
    ).resolves.toEqual({ sentMessageIds: [] });

    expect(client.updateMessage).toHaveBeenCalledOnce();
    expect(client.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('updateFailed falls back to text when patch fails', async () => {
    await feedback.sendAck('写一个快排');
    vi.mocked(client.updateMessage).mockRejectedValueOnce(new Error('patch failed'));
    vi.mocked(client.sendMessage).mockClear();

    await feedback.updateFailed('写一个快排', 'compilation error');

    expect(client.updateMessage).toHaveBeenCalledOnce();
    expect(client.sendMessage).toHaveBeenCalledOnce();
    const [, , payload] = (client.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(payload).toEqual({
      msg_type: 'text',
      content: { text: 'Task failed\nTask: 写一个快排\n\ncompilation error' },
    });
  });

  it('updateRunning with workDir passes it to buildRunningCard', async () => {
    await feedback.sendAck('写一个快排');
    vi.mocked(client.sendMessage).mockClear();
    await feedback.updateRunning('Executing...', 50, undefined, '/workspace/proj');
    expect(client.updateMessage).toHaveBeenCalledOnce();
    const [, card] = (client.updateMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    const elements = (card as any).card.body.elements as Array<{
      element_id?: string;
      content?: string;
    }>;
    const workDirElement = elements.find((e) => e.element_id === 'workdir_markdown');
    expect(workDirElement).toBeDefined();
    expect(workDirElement!.content).toBe('📁 `/workspace/proj`');
  });

  it('updateRunning without workDir omits workDir element', async () => {
    await feedback.sendAck('写一个快排');
    vi.mocked(client.sendMessage).mockClear();
    await feedback.updateRunning('Executing...', 50);
    expect(client.updateMessage).toHaveBeenCalledOnce();
    const [, card] = (client.updateMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    const elements = (card as any).card.body.elements as Array<{ element_id?: string }>;
    expect(elements.some((e) => e.element_id === 'workdir_markdown')).toBe(false);
  });
});
