import { describe, expect, it } from 'vitest';
import type { NormalizedEvent } from '@open-tag/core-types';
import { stripUnassignedBotMentionsFromAgentEvent } from '../agent-goal-sanitizer.js';

function makeEvent(text: string, mentions: NormalizedEvent['content']['mentions']): NormalizedEvent {
  return {
    eventId: 'evt_1',
    messageId: 'om_1',
    chatId: 'oc_1',
    chatType: 'group',
    senderOpenId: 'ou_sender',
    tenantKey: 'tenant_1',
    content: {
      type: 'text',
      text,
      mentions,
      raw: {},
    },
    timestamp: Date.now(),
  };
}

describe('stripUnassignedBotMentionsFromAgentEvent', () => {
  it('removes unassigned entry bot mentions from an agent-assigned task', () => {
    const event = makeEvent('@EntryBot 解读一下这个图片', [
      {
        id: 'cli_entry',
        name: 'EntryBot',
        isBot: false,
        key: '@_user_1',
        index: 0,
      },
    ]);

    const sanitized = stripUnassignedBotMentionsFromAgentEvent(event, 'app_target', [
      { feishuAppId: 'app_entry', appId: 'cli_entry', botName: 'EntryBot' },
    ]);

    expect(sanitized.content.text).toBe('解读一下这个图片');
  });

  it('keeps human mentions and selected agent app mentions', () => {
    const event = makeEvent('@EntryBot 请 @陶克路 看一下', [
      { id: 'cli_entry', name: 'EntryBot', isBot: false, key: '@_user_1', index: 0 },
      { id: 'ou_human', name: '陶克路', isBot: false, key: '@_user_2', index: 12 },
    ]);

    const sanitized = stripUnassignedBotMentionsFromAgentEvent(event, 'app_entry', [
      { feishuAppId: 'app_entry', appId: 'cli_entry', botName: 'EntryBot' },
    ]);

    expect(sanitized.content.text).toBe('@EntryBot 请 @陶克路 看一下');
  });
});
