import { describe, expect, it, vi } from 'vitest';
import type { NormalizedEvent } from '@open-tag/core-types';
import {
  getReplyToMessageId,
  getRootAliasMessageIds,
  shouldUpgradeRootProvisionalSession,
  upgradeRootProvisionalSession,
} from '../reply-threading.js';

function makeEvent(
  overrides: Partial<NormalizedEvent> & {
    content?: Partial<NormalizedEvent['content']>;
  } = {},
): NormalizedEvent {
  return {
    eventId: overrides.eventId ?? 'evt_001',
    messageId: overrides.messageId ?? 'om_root_001',
    chatId: overrides.chatId ?? 'chat_001',
    chatType: overrides.chatType ?? 'p2p',
    threadId: overrides.threadId,
    rootMessageId: overrides.rootMessageId,
    parentMessageId: overrides.parentMessageId,
    senderOpenId: overrides.senderOpenId ?? 'ou_user_001',
    tenantKey: overrides.tenantKey ?? 'tenant_001',
    content: {
      type: overrides.content?.type ?? 'text',
      text: overrides.content?.text ?? 'hello',
      mentions: overrides.content?.mentions ?? [],
      raw: overrides.content?.raw ?? {},
      command: overrides.content?.command,
      args: overrides.content?.args,
      imageKey: overrides.content?.imageKey,
      imageMessageId: overrides.content?.imageMessageId,
    },
    timestamp: overrides.timestamp ?? Date.now(),
  };
}

describe('reply threading', () => {
  it('threads task ACK replies from a root private message', () => {
    const event = makeEvent({ chatType: 'p2p', messageId: 'om_dm_task_root' });

    expect(getReplyToMessageId(event)).toBe('om_dm_task_root');
    expect(shouldUpgradeRootProvisionalSession(event)).toBe(true);
  });

  it('threads orchestrator direct replies from a root private message', () => {
    const event = makeEvent({ chatType: 'p2p', messageId: 'om_dm_direct_root' });

    expect(getReplyToMessageId(event)).toBe('om_dm_direct_root');
    expect(shouldUpgradeRootProvisionalSession(event)).toBe(true);
  });

  it('threads slash-command replies from a root private message', () => {
    const event = makeEvent({
      chatType: 'p2p',
      messageId: 'om_dm_slash_root',
      content: { type: 'command', command: '/status', args: '' },
    });

    expect(getReplyToMessageId(event)).toBe('om_dm_slash_root');
    expect(shouldUpgradeRootProvisionalSession(event)).toBe(true);
  });

  it('aliases both the root private message and first bot reply', () => {
    const event = makeEvent({ chatType: 'p2p', messageId: 'om_dm_root_001' });

    expect(getRootAliasMessageIds(event, 'om_bot_reply_001')).toEqual([
      'om_dm_root_001',
      'om_bot_reply_001',
    ]);
  });

  it('deduplicates alias message ids when the sent reply id matches the root message id', () => {
    const event = makeEvent({ chatType: 'p2p', messageId: 'om_dm_root_001' });

    expect(getRootAliasMessageIds(event, 'om_dm_root_001')).toEqual(['om_dm_root_001']);
  });

  it('swallows alias-upgrade failures after sending a root private reply', async () => {
    const event = makeEvent({ chatType: 'p2p', messageId: 'om_dm_root_001' });
    const logger = { warn: vi.fn() };
    const alias = vi.fn().mockRejectedValue(new Error('db unavailable'));

    await expect(
      upgradeRootProvisionalSession({
        db: {} as never,
        event,
        logger,
        sessionId: 'sess-p2p-001',
        sentMessageId: 'om_bot_reply_001',
        alias,
      }),
    ).resolves.toBeUndefined();

    expect(alias).toHaveBeenCalledTimes(1);
    expect(alias).toHaveBeenCalledWith(
      {} as never,
      'sess-p2p-001',
      ['om_dm_root_001', 'om_bot_reply_001'],
      'tenant_001',
      'chat_001',
    );
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('anchors group root @bot replies on the user message to open a topic', () => {
    const event = makeEvent({ chatType: 'group', messageId: 'om_group_root' });

    expect(getReplyToMessageId(event)).toBe('om_group_root');
    // Group root @bot now creates a topic on first reply, so the bootstrap
    // session must be aliased under the soon-to-be thread keys exactly like P2P.
    expect(shouldUpgradeRootProvisionalSession(event)).toBe(true);
  });

  it('upgrades parent-only quoted group roots after the first bot reply', () => {
    const event = makeEvent({
      chatType: 'group',
      messageId: 'om_group_quoted_root',
      parentMessageId: 'om_quoted_image',
    });

    expect(getReplyToMessageId(event)).toBe('om_group_quoted_root');
    expect(shouldUpgradeRootProvisionalSession(event)).toBe(true);
  });

  it('anchors group slash-command replies on the user message to open a topic', () => {
    const event = makeEvent({
      chatType: 'group',
      messageId: 'om_group_slash_root',
      content: { type: 'command', command: '/status', args: '' },
    });

    expect(getReplyToMessageId(event)).toBe('om_group_slash_root');
    expect(shouldUpgradeRootProvisionalSession(event)).toBe(true);
  });

  it('aliases the resolved session under the group root and bot reply ids', async () => {
    const event = makeEvent({ chatType: 'group', messageId: 'om_group_root' });
    const logger = { warn: vi.fn() };
    const alias = vi.fn().mockResolvedValue(undefined);

    await upgradeRootProvisionalSession({
      db: {} as never,
      event,
      logger,
      sessionId: 'sess-bootstrap-001',
      sentMessageId: 'om_bot_ack_001',
      alias,
    });

    expect(alias).toHaveBeenCalledTimes(1);
    expect(alias).toHaveBeenCalledWith(
      {} as never,
      'sess-bootstrap-001',
      ['om_group_root', 'om_bot_ack_001'],
      'tenant_001',
      'chat_001',
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('aliases an active manual session into a new group topic', async () => {
    // /new in group resolves to a manual session with the chatActiveSessions
    // pointer set; the next group root @bot still resolves to that manual
    // session, and we must alias it (not the bootstrap key) so topic
    // follow-ups stay on the manual session.
    const event = makeEvent({ chatType: 'group', messageId: 'om_group_active_root' });
    const logger = { warn: vi.fn() };
    const alias = vi.fn().mockResolvedValue(undefined);

    await upgradeRootProvisionalSession({
      db: {} as never,
      event,
      logger,
      sessionId: 'sess-manual-active-001',
      sentMessageId: 'om_bot_ack_002',
      alias,
    });

    expect(alias).toHaveBeenCalledWith(
      {} as never,
      'sess-manual-active-001',
      ['om_group_active_root', 'om_bot_ack_002'],
      'tenant_001',
      'chat_001',
    );
  });

  it('skips alias upgrade when the user message is already inside a thread', async () => {
    const event = makeEvent({
      chatType: 'group',
      messageId: 'om_group_followup',
      threadId: 'om_group_topic_root',
    });
    const logger = { warn: vi.fn() };
    const alias = vi.fn();

    await upgradeRootProvisionalSession({
      db: {} as never,
      event,
      logger,
      sessionId: 'sess-thread-001',
      sentMessageId: 'om_bot_followup',
      alias,
    });

    expect(alias).not.toHaveBeenCalled();
  });

  it('keeps existing thread replies inside the thread', () => {
    const event = makeEvent({
      chatType: 'group',
      messageId: 'om_thread_reply',
      threadId: 'om_thread_root',
    });

    expect(getReplyToMessageId(event)).toBe('om_thread_reply');
    expect(shouldUpgradeRootProvisionalSession(event)).toBe(false);
  });
});
