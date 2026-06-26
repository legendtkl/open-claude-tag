import { describe, expect, it } from 'vitest';
import {
  appendFeishuRuntimeContextGuidance,
  buildFeishuRuntimeContextGuidance,
  extractRuntimeFinalReply,
  getFeishuRuntimeContextFromConstraints,
} from '../feishu-runtime-context.js';

describe('getFeishuRuntimeContextFromConstraints', () => {
  it('returns structured Feishu context from task constraints', () => {
    expect(
      getFeishuRuntimeContextFromConstraints({
        feishuContext: {
          chatId: 'oc_chat',
          replyToMessageId: 'om_root',
          senderOpenId: 'ou_sender',
          text: 'finish and ask Chen to review',
          mentions: [
            {
              openId: 'ou_chen',
              name: 'Chen',
              isBot: false,
              key: '@_user_2',
              index: 24,
            },
          ],
        },
      }),
    ).toEqual({
      chatId: 'oc_chat',
      replyToMessageId: 'om_root',
      senderOpenId: 'ou_sender',
      text: 'finish and ask Chen to review',
      mentions: [
        {
          openId: 'ou_chen',
          name: 'Chen',
          isBot: false,
          key: '@_user_2',
          index: 24,
        },
      ],
    });
  });

  it('returns undefined when Feishu context is missing', () => {
    expect(getFeishuRuntimeContextFromConstraints({})).toBeUndefined();
  });
});

describe('buildFeishuRuntimeContextGuidance', () => {
  it('builds prompt guidance with context and final reply protocol', () => {
    const guidance = buildFeishuRuntimeContextGuidance({
      chatId: 'oc_chat',
      replyToMessageId: 'om_root',
      senderOpenId: 'ou_sender',
      text: 'create file and ask Chen to review',
      mentions: [{ openId: 'ou_chen', name: 'Chen', isBot: false }],
    });

    expect(guidance).toContain('<feishu_context>');
    expect(guidance).toContain('"chatId": "oc_chat"');
    expect(guidance).toContain('"mentionableUsers"');
    expect(guidance).toContain('"openId": "ou_chen"');
    expect(guidance).not.toContain('"senderOpenId"');
    expect(guidance).not.toContain('"ou_sender"');
    expect(guidance).toContain('<openClaudeTag_final_reply>');
    expect(guidance).toContain('{{mention:open_id:name}}');
    expect(guidance).toContain('original chat/thread');
    expect(guidance).toContain('Do not mention the sender by default');
  });

  it('appends guidance to an existing prompt', () => {
    const prompt = appendFeishuRuntimeContextGuidance('Base prompt', {
      chatId: 'oc_chat',
      mentions: [],
    });

    expect(prompt).toContain('Base prompt');
    expect(prompt).toContain('<feishu_context>');
  });
});

describe('extractRuntimeFinalReply', () => {
  it('extracts the final reply block and removes it from output text', () => {
    const result = extractRuntimeFinalReply(
      [
        'Created file 1.txt.',
        '',
        '<openClaudeTag_final_reply>',
        '{{mention:ou_chen:Chen}} File is ready for review.',
        '</openClaudeTag_final_reply>',
      ].join('\n'),
    );

    expect(result.finalReplyText).toBe('{{mention:ou_chen:Chen}} File is ready for review.');
    expect(result.outputText).toBe('Created file 1.txt.');
  });

  it('leaves output unchanged when no valid final reply block exists', () => {
    const output = 'Created file 1.txt.';

    expect(extractRuntimeFinalReply(output)).toEqual({ outputText: output });
  });

  it('extracts a final reply block even when trailing commentary follows it', () => {
    const result = extractRuntimeFinalReply(
      [
        'Created file 1.txt.',
        '',
      '<openClaudeTag_final_reply>',
        'Visible answer.',
      '</openClaudeTag_final_reply>',
      '',
        'Follow-up runtime details.',
      ].join('\n'),
    );

    expect(result.finalReplyText).toBe('Visible answer.');
    expect(result.outputText).toBe(
      ['Created file 1.txt.', '', 'Follow-up runtime details.'].join('\n'),
    );
  });

  it('extracts the trailing final reply block when earlier examples are present', () => {
    const result = extractRuntimeFinalReply(
      [
        'Use this format:',
        '<openClaudeTag_final_reply>',
        'Example message',
        '</openClaudeTag_final_reply>',
        '',
        'Created file 1.txt.',
        '',
        '<openClaudeTag_final_reply>',
        '{{mention:ou_chen:Chen}} File is ready for review.',
        '</openClaudeTag_final_reply>',
      ].join('\n'),
    );

    expect(result.finalReplyText).toBe('{{mention:ou_chen:Chen}} File is ready for review.');
    expect(result.outputText).toBe(
      [
        'Use this format:',
        '<openClaudeTag_final_reply>',
        'Example message',
        '</openClaudeTag_final_reply>',
        '',
        'Created file 1.txt.',
      ].join('\n'),
    );
  });

  it('removes an empty final reply block without returning final reply text', () => {
    const result = extractRuntimeFinalReply(
      ['Created file 1.txt.', '<openClaudeTag_final_reply>   </openClaudeTag_final_reply>'].join('\n'),
    );

    expect(result.finalReplyText).toBeUndefined();
    expect(result.outputText).toBe('Created file 1.txt.');
  });
});
