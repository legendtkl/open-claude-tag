import { describe, expect, it, vi } from 'vitest';
import { buildRunningCard, type FeishuClient } from '@open-tag/feishu-adapter';
import type { Logger } from 'pino';
import type { TaskFeishuClientResolver } from '../agent-runtime.js';
import {
  NeutralChannelFeedback,
  createLarkChannelSender,
  createWorkerChannelSenderResolver,
  resolveTaskChannelSender,
  updateRunningFeedbackCard,
  type ChannelSender,
  type ConversationRef as WorkerConversationRef,
  type DeliveryRef,
  type OutboundMessage,
} from '../channel-sender.js';

interface FakeFeishuClient {
  sendMessage: ReturnType<typeof vi.fn>;
  updateMessage: ReturnType<typeof vi.fn>;
}

function makeFakeClient(): FakeFeishuClient {
  return {
    sendMessage: vi.fn(async () => ({ messageId: 'sent-1' })),
    updateMessage: vi.fn(async () => undefined),
  };
}

function asClient(fake: FakeFeishuClient): FeishuClient {
  return fake as unknown as FeishuClient;
}

describe('LarkChannelSender', () => {
  it('delegates a native send to FeishuClient.sendMessage verbatim', async () => {
    const fake = makeFakeClient();
    const sender = createLarkChannelSender(asClient(fake));
    const payload = { msg_type: 'text', content: { text: 'hi' } };

    const ref = await sender.send(
      { kind: 'lark', scopeId: 'chat-1', reply: { parentId: 'parent-1' } },
      { kind: 'native', payload },
    );

    expect(fake.sendMessage).toHaveBeenCalledTimes(1);
    // No idempotencyKey, so the options arg is undefined and the client mints
    // its own uuid — verbatim to a direct sendMessage with no options.
    expect(fake.sendMessage).toHaveBeenCalledWith('chat_id', 'chat-1', payload, 'parent-1', undefined);
    expect(ref.physicalIds).toEqual(['sent-1']);
  });

  it('threads a send idempotencyKey into the client uuid option', async () => {
    const fake = makeFakeClient();
    const sender = createLarkChannelSender(asClient(fake));
    const payload = { msg_type: 'text', content: { text: 'hi' } };

    await sender.send(
      { kind: 'lark', scopeId: 'chat-1', reply: { parentId: 'parent-1' } },
      { kind: 'native', payload },
      { idempotencyKey: 'render-key-1' },
    );

    expect(fake.sendMessage).toHaveBeenCalledWith('chat_id', 'chat-1', payload, 'parent-1', {
      uuid: 'render-key-1',
    });
  });

  it('delegates a native update to FeishuClient.updateMessage verbatim', async () => {
    const fake = makeFakeClient();
    const sender = createLarkChannelSender(asClient(fake));
    const card = buildRunningCard('do work', 50, ['step a'], '/work');

    await sender.update(
      { kind: 'lark', logicalMessageId: 'ack-1', revision: 0, physicalIds: ['ack-1'] },
      { kind: 'native', payload: card },
    );

    expect(fake.updateMessage).toHaveBeenCalledTimes(1);
    expect(fake.updateMessage).toHaveBeenCalledWith('ack-1', card);
  });
});

describe('updateRunningFeedbackCard', () => {
  it('PATCHes the ack card with the exact buildRunningCard output', async () => {
    const fake = makeFakeClient();
    const sender = createLarkChannelSender(asClient(fake));

    await updateRunningFeedbackCard(sender, {
      ackMessageId: 'ack-1',
      description: 'do work',
      progress: 42,
      recentActivity: ['step a', 'step b'],
      workDir: '/work',
    });

    const expectedCard = buildRunningCard('do work', 42, ['step a', 'step b'], '/work');
    expect(fake.updateMessage).toHaveBeenCalledTimes(1);
    expect(fake.updateMessage).toHaveBeenCalledWith('ack-1', expectedCard);
  });

  it('no-ops when there is no sender or no ack message id', async () => {
    const fake = makeFakeClient();
    const sender = createLarkChannelSender(asClient(fake));

    await updateRunningFeedbackCard(null, { ackMessageId: 'ack-1', description: 'x' });
    await updateRunningFeedbackCard(sender, { ackMessageId: undefined, description: 'x' });

    expect(fake.updateMessage).not.toHaveBeenCalled();
  });

  it('swallows update failures and warns instead of throwing', async () => {
    const fake = makeFakeClient();
    fake.updateMessage.mockRejectedValueOnce(new Error('boom'));
    const sender = createLarkChannelSender(asClient(fake));
    const warn = vi.fn();

    await expect(
      updateRunningFeedbackCard(sender, { ackMessageId: 'ack-1', description: 'x' }, {
        warn,
      } as unknown as Logger),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('createWorkerChannelSenderResolver', () => {
  it('resolves the per-app client and returns a sender backed by it', async () => {
    const appClient = makeFakeClient();
    const resolver: TaskFeishuClientResolver = {
      getClient: vi.fn(async (feishuAppId) =>
        feishuAppId === 'app-1' ? asClient(appClient) : null,
      ),
    };
    const channelSenderResolver = createWorkerChannelSenderResolver({
      feishuClientResolver: resolver,
      defaultClient: null,
    });

    const sender = await channelSenderResolver.getChannelSender('app-1');
    expect(sender).not.toBeNull();
    await sender!.update(
      { kind: 'lark', logicalMessageId: 'ack-1', revision: 0, physicalIds: ['ack-1'] },
      { kind: 'native', payload: { tag: 'card' } },
    );
    expect(appClient.updateMessage).toHaveBeenCalledWith('ack-1', { tag: 'card' });
  });

  it('falls back to the default client when no app id is given', async () => {
    const defaultClient = makeFakeClient();
    const resolver: TaskFeishuClientResolver = {
      getClient: vi.fn(async () => null),
    };
    const channelSenderResolver = createWorkerChannelSenderResolver({
      feishuClientResolver: resolver,
      defaultClient: asClient(defaultClient),
    });

    const sender = await channelSenderResolver.getChannelSender();
    expect(sender).not.toBeNull();
  });

  it('returns null when no client can be resolved', async () => {
    const channelSenderResolver = createWorkerChannelSenderResolver({
      feishuClientResolver: { getClient: vi.fn(async () => null) },
      defaultClient: null,
    });

    await expect(channelSenderResolver.getChannelSender('missing')).resolves.toBeNull();
  });
});

/** A recording ChannelSender stub for the kind-resolution + neutral-feedback tests. */
function makeRecordingSender() {
  const sends: Array<{ to: WorkerConversationRef; msg: OutboundMessage }> = [];
  const sender: ChannelSender = {
    send: vi.fn(async (to: WorkerConversationRef, msg: OutboundMessage): Promise<DeliveryRef> => {
      sends.push({ to, msg });
      return { kind: to.kind, logicalMessageId: 'ts-1', revision: 0, physicalIds: ['ts-1'] };
    }),
    update: vi.fn(async (ref: DeliveryRef): Promise<DeliveryRef> => ref),
  };
  return { sender, sends };
}

describe('resolveTaskChannelSender', () => {
  it('resolves lark to a LarkChannelSender backed by the feishu client (byte-identical path)', async () => {
    const fake = makeFakeClient();
    const sender = resolveTaskChannelSender('lark', { feishuClient: asClient(fake) });
    expect(sender).not.toBeNull();
    await sender!.update(
      { kind: 'lark', logicalMessageId: 'ack-1', revision: 0, physicalIds: ['ack-1'] },
      { kind: 'native', payload: { tag: 'card' } },
    );
    expect(fake.updateMessage).toHaveBeenCalledWith('ack-1', { tag: 'card' });
  });

  it('resolves lark to null when no feishu client is present (matches prior worker behavior)', () => {
    expect(resolveTaskChannelSender('lark', { feishuClient: null })).toBeNull();
    expect(resolveTaskChannelSender('lark', {})).toBeNull();
  });

  it('resolves slack to the injected slack sender, else null when unconfigured', () => {
    const { sender } = makeRecordingSender();
    expect(resolveTaskChannelSender('slack', { slackSender: sender })).toBe(sender);
    expect(resolveTaskChannelSender('slack', { slackSender: null })).toBeNull();
    expect(resolveTaskChannelSender('slack', {})).toBeNull();
  });

  it('never falls back to another vendor: an unknown kind resolves to null', () => {
    const fake = makeFakeClient();
    const { sender } = makeRecordingSender();
    expect(
      resolveTaskChannelSender('discord', { feishuClient: asClient(fake), slackSender: sender }),
    ).toBeNull();
  });
});

describe('NeutralChannelFeedback', () => {
  const conversation: WorkerConversationRef = { kind: 'slack', scopeId: 'C_chat' };

  it('delivers a terminal completion as a neutral result message, preferring completionText', async () => {
    const { sender, sends } = makeRecordingSender();
    const feedback = new NeutralChannelFeedback({ sender, conversation });

    const result = await feedback.updateDone('do the thing', 'detailed output', {
      completionText: 'final reply to the user',
    });

    expect(sends).toHaveLength(1);
    expect(sends[0].to).toEqual(conversation);
    expect(sends[0].msg).toEqual({ kind: 'result', markdown: 'final reply to the user' });
    // Reports no sentMessageIds so neutral ids never enter Lark-shaped aliasing.
    expect(result).toEqual({ sentMessageIds: [] });
  });

  it('falls back to the result body, then a default, when no completionText is given', async () => {
    const { sender, sends } = makeRecordingSender();
    const feedback = new NeutralChannelFeedback({ sender, conversation });

    await feedback.updateDone('goal-a', 'just the result');
    await feedback.updateDone('goal-b');

    expect(sends[0].msg).toEqual({ kind: 'result', markdown: 'just the result' });
    expect(sends[1].msg).toEqual({ kind: 'result', markdown: 'Task complete\nTask: goal-b' });
  });

  it('delivers a failure as a neutral error message and a quota notice as text', async () => {
    const { sender, sends } = makeRecordingSender();
    const feedback = new NeutralChannelFeedback({ sender, conversation });

    await feedback.updateFailed('goal-x', 'boom happened');
    await feedback.notifyQuotaExceeded('goal-y', 'limit hit');

    expect(sends[0].msg).toEqual({
      kind: 'error',
      message: 'Task failed\nTask: goal-x\n\nboom happened',
    });
    expect(sends[1].msg).toEqual({
      kind: 'text',
      markdown: 'Usage limit reached\nTask: goal-y\n\nlimit hit',
    });
  });

  it('truncates an oversized body so a single channel message stays within limits', async () => {
    const { sender, sends } = makeRecordingSender();
    const feedback = new NeutralChannelFeedback({ sender, conversation });

    await feedback.updateDone('g', 'x'.repeat(5000));

    const msg = sends[0].msg as { kind: 'result'; markdown: string };
    expect(msg.markdown.length).toBeLessThanOrEqual(2800);
    expect(msg.markdown.endsWith('... (truncated)')).toBe(true);
  });

  it('swallows a send failure (best-effort) and warns instead of throwing', async () => {
    const sender: ChannelSender = {
      send: vi.fn(async () => {
        throw new Error('slack down');
      }),
      update: vi.fn(async (ref: DeliveryRef) => ref),
    };
    const warn = vi.fn();
    const feedback = new NeutralChannelFeedback({
      sender,
      conversation,
      logger: { warn } as unknown as Logger,
    });

    await expect(feedback.updateDone('g', 'r')).resolves.toEqual({ sentMessageIds: [] });
    await expect(feedback.updateFailed('g', 'e')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
