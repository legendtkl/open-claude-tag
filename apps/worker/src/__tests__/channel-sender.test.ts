import { describe, expect, it, vi } from 'vitest';
import { buildRunningCard, type FeishuClient } from '@open-tag/feishu-adapter';
import { SlackChannel } from '@open-tag/channel-slack';
import type { Logger } from 'pino';
import type { TaskFeishuClientResolver } from '../agent-runtime.js';
import {
  NeutralChannelFeedback,
  createLarkChannelSender,
  createWorkerChannelSenderResolver,
  reconstructAckDeliveryRef,
  reconstructLarkReactionRef,
  removeAckReactionViaChannel,
  resolveTaskChannelSender,
  updateRunningFeedbackCard,
  type ArtifactUploadTarget,
  type ChannelSender,
  type ConversationRef as WorkerConversationRef,
  type DeliveryRef,
  type LocalFile,
  type OutboundMessage,
  type ReactionRef,
  type RemoteAttachmentRef,
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

  it('removes a reaction via FeishuClient.removeReaction verbatim (byte-identical path)', async () => {
    const removeReaction = vi.fn(async () => undefined);
    const fake = { ...makeFakeClient(), removeReaction };
    const sender = createLarkChannelSender(asClient(fake as unknown as FakeFeishuClient));

    await sender.removeReaction!(reconstructLarkReactionRef('om_user_1', 'reaction_1'));

    expect(removeReaction).toHaveBeenCalledTimes(1);
    expect(removeReaction).toHaveBeenCalledWith('om_user_1', 'reaction_1');
  });

  it('uploadArtifact delegates to LarkChannel (not implemented yet → it throws)', async () => {
    const fake = makeFakeClient();
    const sender = createLarkChannelSender(asClient(fake));
    // Delegation reaches LarkChannel.uploadArtifact, which is not implemented yet
    // (it has no conversation-targeting and throws), proving the call passes through.
    await expect(
      sender.uploadArtifact!({ path: '/tmp/x.txt', name: 'x.txt' }, { channel: 'C1' }),
    ).rejects.toThrow(/not implemented/i);
  });
});

describe('reconstructLarkReactionRef', () => {
  it('carries the reaction id first-class and the owning message id under native', () => {
    expect(reconstructLarkReactionRef('om_user_1', 'reaction_1')).toEqual({
      kind: 'lark',
      reactionId: 'reaction_1',
      native: { messageId: 'om_user_1' },
    });
  });
});

describe('removeAckReactionViaChannel', () => {
  function makeReactionSender() {
    const removed: ReactionRef[] = [];
    const sender = {
      send: vi.fn(),
      update: vi.fn(),
      removeReaction: vi.fn(async (ref: ReactionRef) => {
        removed.push(ref);
      }),
    } as unknown as ChannelSender;
    return { sender, removed };
  }

  it('routes removal through the sender with the reconstructed lark ReactionRef', async () => {
    const { sender, removed } = makeReactionSender();

    await removeAckReactionViaChannel(
      sender,
      { messageId: 'om_user_1', reactionId: 'reaction_1', reason: 'after task completion' },
    );

    expect(sender.removeReaction).toHaveBeenCalledTimes(1);
    expect(removed[0]).toEqual({
      kind: 'lark',
      reactionId: 'reaction_1',
      native: { messageId: 'om_user_1' },
    });
  });

  it('skips when the sender is null, lacks removeReaction, or an id is missing', async () => {
    const { sender } = makeReactionSender();

    await removeAckReactionViaChannel(null, {
      messageId: 'om_user_1',
      reactionId: 'reaction_1',
      reason: 'x',
    });
    await removeAckReactionViaChannel(
      { send: vi.fn(), update: vi.fn() } as unknown as ChannelSender,
      { messageId: 'om_user_1', reactionId: 'reaction_1', reason: 'x' },
    );
    await removeAckReactionViaChannel(sender, { reactionId: 'reaction_1', reason: 'x' });
    await removeAckReactionViaChannel(sender, { messageId: 'om_user_1', reason: 'x' });

    expect(sender.removeReaction).not.toHaveBeenCalled();
  });

  it('swallows a removal error and warns instead of throwing', async () => {
    const sender = {
      send: vi.fn(),
      update: vi.fn(),
      removeReaction: vi.fn(async () => {
        throw new Error('boom');
      }),
    } as unknown as ChannelSender;
    const warn = vi.fn();

    await expect(
      removeAckReactionViaChannel(
        sender,
        { messageId: 'om_user_1', reactionId: 'reaction_1', reason: 'after task error' },
        { warn } as unknown as Logger,
      ),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
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
  const updates: Array<{ ref: DeliveryRef; msg: OutboundMessage }> = [];
  const sender: ChannelSender = {
    send: vi.fn(async (to: WorkerConversationRef, msg: OutboundMessage): Promise<DeliveryRef> => {
      sends.push({ to, msg });
      return { kind: to.kind, logicalMessageId: 'ts-1', revision: 0, physicalIds: ['ts-1'] };
    }),
    update: vi.fn(async (ref: DeliveryRef, msg: OutboundMessage): Promise<DeliveryRef> => {
      updates.push({ ref, msg });
      return ref;
    }),
  };
  return { sender, sends, updates };
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

  it('UPDATES the threaded ack message in place instead of posting a new one', async () => {
    const { sender, sends, updates } = makeRecordingSender();
    const ackRef: DeliveryRef = {
      kind: 'slack',
      logicalMessageId: 'ack-ts',
      revision: 0,
      physicalIds: ['ack-ts'],
      native: { channel: 'C_chat' },
    };
    const feedback = new NeutralChannelFeedback({ sender, conversation, ackRef });

    await feedback.updateDone('do the thing', 'detailed output', {
      completionText: 'final reply',
    });
    await feedback.updateFailed('do the thing', 'boom');

    // No fresh sends — both terminal states edited the SAME ack message.
    expect(sends).toHaveLength(0);
    expect(updates).toHaveLength(2);
    expect(updates[0].ref).toBe(ackRef);
    expect(updates[0].msg).toEqual({ kind: 'result', markdown: 'final reply' });
    expect(updates[1].ref).toBe(ackRef);
    expect(updates[1].msg).toEqual({ kind: 'error', message: 'Task failed\nTask: do the thing\n\nboom' });
  });

  it('swallows an update failure without falling back to a fresh send (no duplicate)', async () => {
    const { updates } = makeRecordingSender();
    const send = vi.fn(async (): Promise<DeliveryRef> => {
      throw new Error('should not be called');
    });
    const sender: ChannelSender = {
      send,
      update: vi.fn(async (): Promise<DeliveryRef> => {
        throw new Error('chat.update failed');
      }),
    };
    const warn = vi.fn();
    const ackRef: DeliveryRef = {
      kind: 'slack',
      logicalMessageId: 'ack-ts',
      revision: 0,
      physicalIds: ['ack-ts'],
      native: { channel: 'C_chat' },
    };
    const feedback = new NeutralChannelFeedback({
      sender,
      conversation,
      ackRef,
      logger: { warn } as unknown as Logger,
    });

    await expect(feedback.updateDone('g', 'r')).resolves.toEqual({ sentMessageIds: [] });
    expect(send).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

/** A recording ChannelSender that ALSO records uploadArtifact + a global event order. */
function makeUploadingSender(
  upload?: (file: LocalFile, target?: ArtifactUploadTarget) => Promise<RemoteAttachmentRef>,
) {
  const events: string[] = [];
  const sends: Array<{ to: WorkerConversationRef; msg: OutboundMessage }> = [];
  const updates: Array<{ ref: DeliveryRef; msg: OutboundMessage }> = [];
  const uploads: Array<{ file: LocalFile; target?: ArtifactUploadTarget }> = [];
  const uploadArtifact = vi.fn(
    async (file: LocalFile, target?: ArtifactUploadTarget): Promise<RemoteAttachmentRef> => {
      events.push(`upload:${file.name}`);
      uploads.push({ file, target });
      if (upload) return upload(file, target);
      return { type: 'file', ref: `remote-${file.name}` };
    },
  );
  const sender: ChannelSender = {
    send: vi.fn(async (to: WorkerConversationRef, msg: OutboundMessage): Promise<DeliveryRef> => {
      events.push('send');
      sends.push({ to, msg });
      return { kind: to.kind, logicalMessageId: 'ts-1', revision: 0, physicalIds: ['ts-1'] };
    }),
    update: vi.fn(async (ref: DeliveryRef, msg: OutboundMessage): Promise<DeliveryRef> => {
      events.push('update');
      updates.push({ ref, msg });
      return ref;
    }),
    uploadArtifact,
  };
  return { sender, sends, updates, uploads, uploadArtifact, events };
}

describe('NeutralChannelFeedback artifact upload (Slack Milestone 3b)', () => {
  const conversation: WorkerConversationRef = { kind: 'slack', scopeId: 'C_chat' };
  const fileA: LocalFile = { path: '/w/a.txt', name: 'a.txt', mimeType: 'text/plain' };
  const fileB: LocalFile = { path: '/w/b.md', name: 'b.md' };

  it('uploads each artifact into the thread BEFORE delivering the result with the refs', async () => {
    const threaded: WorkerConversationRef = { kind: 'slack', scopeId: 'C_chat', threadId: '171.50' };
    const { sender, sends, uploads, uploadArtifact, events } = makeUploadingSender();
    const feedback = new NeutralChannelFeedback({ sender, conversation: threaded });

    const result = await feedback.updateDone('do the thing', 'detailed output', {
      completionText: 'final reply',
      artifacts: [fileA, fileB],
    });

    expect(uploadArtifact).toHaveBeenCalledTimes(2);
    // Conversation-derived target: scopeId → channel, threadId → thread_ts.
    expect(uploads.map((u) => u.target)).toEqual([
      { channel: 'C_chat', threadTs: '171.50' },
      { channel: 'C_chat', threadTs: '171.50' },
    ]);
    // Files post first, then the result text that references them.
    expect(events).toEqual(['upload:a.txt', 'upload:b.md', 'send']);
    expect(sends).toHaveLength(1);
    expect(sends[0].msg).toEqual({
      kind: 'result',
      markdown: 'final reply',
      artifacts: [
        { type: 'file', ref: 'remote-a.txt' },
        { type: 'file', ref: 'remote-b.md' },
      ],
    });
    expect(result).toEqual({ sentMessageIds: [] });
  });

  it('targets only the channel when the conversation carries no thread', async () => {
    const { sender, uploads } = makeUploadingSender();
    const feedback = new NeutralChannelFeedback({ sender, conversation });

    await feedback.updateDone('g', 'r', { artifacts: [fileA] });

    expect(uploads[0].target).toEqual({ channel: 'C_chat' });
  });

  it('falls back to reply.rootId for the thread target when threadId is absent', async () => {
    // A reply-in-thread conversation carries no explicit threadId but a reply root;
    // the upload target must thread off that root so the file lands in the thread.
    const replyThreaded: WorkerConversationRef = {
      kind: 'slack',
      scopeId: 'C_chat',
      reply: { rootId: '169.01' },
    };
    const { sender, uploads } = makeUploadingSender();
    const feedback = new NeutralChannelFeedback({ sender, conversation: replyThreaded });

    await feedback.updateDone('g', 'r', { artifacts: [fileA] });

    expect(uploads[0].target).toEqual({ channel: 'C_chat', threadTs: '169.01' });
  });

  it('skips a file that fails to upload (best-effort) and still delivers the result', async () => {
    const upload = vi
      .fn<(file: LocalFile) => Promise<RemoteAttachmentRef>>()
      .mockResolvedValueOnce({ type: 'file', ref: 'remote-a' })
      .mockRejectedValueOnce(new Error('upload failed'))
      .mockResolvedValueOnce({ type: 'file', ref: 'remote-c' });
    const { sender, sends, uploadArtifact } = makeUploadingSender((file) => upload(file));
    const warn = vi.fn();
    const feedback = new NeutralChannelFeedback({
      sender,
      conversation,
      logger: { warn } as unknown as Logger,
    });

    await feedback.updateDone('g', 'r', {
      artifacts: [fileA, fileB, { path: '/w/c.txt', name: 'c.txt' }],
    });

    // All three attempted; the failing one skipped, the result still delivered.
    expect(uploadArtifact).toHaveBeenCalledTimes(3);
    expect(sends).toHaveLength(1);
    expect(sends[0].msg).toEqual({
      kind: 'result',
      markdown: 'r',
      artifacts: [
        { type: 'file', ref: 'remote-a' },
        { type: 'file', ref: 'remote-c' },
      ],
    });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('still delivers the result text even when EVERY artifact upload fails', async () => {
    const { sender, sends } = makeUploadingSender(async () => {
      throw new Error('slack down');
    });
    const warn = vi.fn();
    const feedback = new NeutralChannelFeedback({
      sender,
      conversation,
      logger: { warn } as unknown as Logger,
    });

    await feedback.updateDone('g', 'r', { artifacts: [fileA, fileB] });

    expect(sends).toHaveLength(1);
    // No artifacts field when none uploaded — back-compat with the no-artifact shape.
    expect(sends[0].msg).toEqual({ kind: 'result', markdown: 'r' });
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('does not call uploadArtifact when no artifacts option is given', async () => {
    const { sender, sends, uploadArtifact } = makeUploadingSender();
    const feedback = new NeutralChannelFeedback({ sender, conversation });

    await feedback.updateDone('g', 'r');

    expect(uploadArtifact).not.toHaveBeenCalled();
    expect(sends[0].msg).toEqual({ kind: 'result', markdown: 'r' });
  });

  it('does not upload when the sender lacks uploadArtifact (Lark-style); result has no artifacts', async () => {
    // makeRecordingSender returns a send/update-only sender (no uploadArtifact).
    const { sender, sends } = makeRecordingSender();
    const feedback = new NeutralChannelFeedback({ sender, conversation });

    await feedback.updateDone('g', 'r', { artifacts: [fileA] });

    expect(sends).toHaveLength(1);
    expect(sends[0].msg).toEqual({ kind: 'result', markdown: 'r' });
  });

  it('uploads then UPDATES the ack message in place when an ack handle is threaded', async () => {
    const ackRef: DeliveryRef = {
      kind: 'slack',
      logicalMessageId: 'ack-ts',
      revision: 0,
      physicalIds: ['ack-ts'],
      native: { channel: 'C_chat' },
    };
    const { sender, sends, updates, events } = makeUploadingSender();
    const feedback = new NeutralChannelFeedback({ sender, conversation, ackRef });

    await feedback.updateDone('g', 'r', { artifacts: [fileA] });

    expect(events).toEqual(['upload:a.txt', 'update']);
    expect(sends).toHaveLength(0);
    expect(updates).toHaveLength(1);
    expect(updates[0].msg).toEqual({
      kind: 'result',
      markdown: 'r',
      artifacts: [{ type: 'file', ref: 'remote-a.txt' }],
    });
  });
});

describe('NeutralChannelFeedback running phase (Slack Milestone 2)', () => {
  const conversation: WorkerConversationRef = { kind: 'slack', scopeId: 'C_chat' };

  function slackAckRef(): DeliveryRef {
    return {
      kind: 'slack',
      logicalMessageId: 'ack-ts',
      revision: 0,
      physicalIds: ['ack-ts'],
      native: { channel: 'C_chat' },
    };
  }

  it('updates the ack message in place for running then done — no fresh postMessage', async () => {
    const { sender, sends, updates } = makeRecordingSender();
    const ackRef = slackAckRef();
    const feedback = new NeutralChannelFeedback({ sender, conversation, ackRef });

    await feedback.updateRunning({
      description: 'Executing with codex...',
      progress: 42,
      recentActivity: ['[stdout] building', 'running tests'],
      workDir: '/work',
    });
    await feedback.updateDone('do the thing', undefined, { completionText: 'all done' });

    // Both phases edited the SAME ack message; no fresh send was issued.
    expect(sends).toHaveLength(0);
    expect(updates).toHaveLength(2);
    expect(updates[0].ref).toBe(ackRef);
    expect(updates[1].ref).toBe(ackRef);

    const running = updates[0].msg as { kind: string; markdown: string };
    expect(running.kind).toBe('text');
    expect(running.markdown).toContain('Working on the task');
    expect(running.markdown).toContain('Executing with codex...');
    expect(running.markdown).toContain('Progress: 42%');
    expect(running.markdown).toContain('[stdout] building');
    expect(running.markdown).toContain('/work');

    expect(updates[1].msg).toEqual({ kind: 'result', markdown: 'all done' });
  });

  it('updates running then renders the error card on failure', async () => {
    const { sender, sends, updates } = makeRecordingSender();
    const ackRef = slackAckRef();
    const feedback = new NeutralChannelFeedback({ sender, conversation, ackRef });

    await feedback.updateRunning({ description: 'Working...', progress: 10 });
    await feedback.updateFailed('do the thing', 'boom');

    expect(sends).toHaveLength(0);
    expect(updates).toHaveLength(2);
    expect((updates[0].msg as { kind: string }).kind).toBe('text');
    expect(updates[1].msg).toEqual({
      kind: 'error',
      message: 'Task failed\nTask: do the thing\n\nboom',
    });
  });

  it('coalesces rapid running updates to <=1/s while the terminal always flushes', async () => {
    const { sender, sends, updates } = makeRecordingSender();
    const ackRef = slackAckRef();
    let clock = 0;
    const feedback = new NeutralChannelFeedback({
      sender,
      conversation,
      ackRef,
      now: () => clock,
    });

    await feedback.updateRunning({ description: 'step 1' }); // first ever → flush
    clock = 200;
    await feedback.updateRunning({ description: 'step 2' }); // within 1s window → dropped
    clock = 999;
    await feedback.updateRunning({ description: 'step 3' }); // still within window → dropped
    expect(updates).toHaveLength(1);
    expect((updates[0].msg as { markdown: string }).markdown).toContain('step 1');

    clock = 1000;
    await feedback.updateRunning({ description: 'step 4' }); // window elapsed → flush
    expect(updates).toHaveLength(2);
    expect((updates[1].msg as { markdown: string }).markdown).toContain('step 4');

    // Terminal bypasses the running throttle even though only 100ms passed.
    clock = 1100;
    await feedback.updateDone('goal', 'final');
    expect(updates).toHaveLength(3);
    expect(updates[2].msg).toEqual({ kind: 'result', markdown: 'final' });
    expect(sends).toHaveLength(0);
  });

  it('skips running updates entirely when there is no ack handle to edit', async () => {
    const { sender, sends, updates } = makeRecordingSender();
    const feedback = new NeutralChannelFeedback({ sender, conversation });

    await feedback.updateRunning({ description: 'step', progress: 5 });
    await feedback.updateRunning({ description: 'step again', progress: 6 });

    // No ackRef → no in-place edits, and running never posts a fresh message.
    expect(updates).toHaveLength(0);
    expect(sends).toHaveLength(0);
  });

  it('swallows a thrown running update (best-effort) instead of failing the task', async () => {
    const ackRef = slackAckRef();
    const sender: ChannelSender = {
      send: vi.fn(async (): Promise<DeliveryRef> => {
        throw new Error('should not be called');
      }),
      update: vi.fn(async (): Promise<DeliveryRef> => {
        throw new Error('chat.update failed');
      }),
    };
    const warn = vi.fn();
    const feedback = new NeutralChannelFeedback({
      sender,
      conversation,
      ackRef,
      logger: { warn } as unknown as Logger,
    });

    await expect(feedback.updateRunning({ description: 'step' })).resolves.toBeUndefined();
    expect(sender.send).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('keeps respecting the cap across failures (a failed attempt still consumes the window)', async () => {
    const ackRef = slackAckRef();
    let clock = 0;
    const update = vi.fn(async (): Promise<DeliveryRef> => {
      throw new Error('chat.update rate limited');
    });
    const sender: ChannelSender = {
      send: vi.fn(async (): Promise<DeliveryRef> => {
        throw new Error('should not be called');
      }),
      update,
    };
    const warn = vi.fn();
    const feedback = new NeutralChannelFeedback({
      sender,
      conversation,
      ackRef,
      now: () => clock,
      logger: { warn } as unknown as Logger,
    });

    await feedback.updateRunning({ description: 'a' }); // attempt 1 (fails, swallowed)
    clock = 200;
    await feedback.updateRunning({ description: 'b' }); // within window → not even attempted
    clock = 999;
    await feedback.updateRunning({ description: 'c' }); // still within window → not attempted
    // A failing endpoint is NOT hammered at the event rate: at most one call/window.
    expect(update).toHaveBeenCalledTimes(1);

    clock = 1000;
    await feedback.updateRunning({ description: 'd' }); // window elapsed → second attempt
    expect(update).toHaveBeenCalledTimes(2);
  });

  it('drives a real SlackChannel.update (chat.update) at the ack channel + ts (no live creds)', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchMock = vi.fn(async (url: string, init?: { body?: string }) => {
      const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
      calls.push({ url, body });
      return {
        ok: true,
        json: async () => ({ ok: true, ts: body.ts, channel: body.channel }),
      } as unknown as Response;
    });
    const slack = new SlackChannel({ token: 'xoxb-test', fetch: fetchMock as unknown as typeof fetch });

    const ackRef = reconstructAckDeliveryRef({
      kind: 'slack',
      scopeId: 'C_chat',
      messageId: '1710000000.000200',
    });
    const feedback = new NeutralChannelFeedback({
      sender: slack as unknown as ChannelSender,
      conversation,
      ackRef,
    });

    await feedback.updateRunning({ description: 'crunching', progress: 30 });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('chat.update');
    expect(calls[0].body).toMatchObject({
      channel: 'C_chat',
      ts: '1710000000.000200',
    });
    expect(String(calls[0].body.text)).toContain('Working on the task');
    expect(String(calls[0].body.text)).toContain('crunching');
  });
});

describe('reconstructAckDeliveryRef', () => {
  it('rebuilds a DeliveryRef SlackChannel.update can consume from the serialized handle', () => {
    const ref = reconstructAckDeliveryRef({
      kind: 'slack',
      scopeId: 'C_chat',
      messageId: '1710000000.000200',
    });
    expect(ref).toEqual({
      kind: 'slack',
      logicalMessageId: '1710000000.000200',
      revision: 0,
      physicalIds: ['1710000000.000200'],
      native: { channel: 'C_chat' },
    });
  });

  it('returns undefined for a missing or malformed handle (→ send fallback)', () => {
    expect(reconstructAckDeliveryRef(undefined)).toBeUndefined();
    expect(reconstructAckDeliveryRef(null)).toBeUndefined();
    expect(reconstructAckDeliveryRef('nope')).toBeUndefined();
    expect(reconstructAckDeliveryRef({ kind: 'slack', scopeId: 'C_chat' })).toBeUndefined();
    expect(reconstructAckDeliveryRef({ kind: 'slack', messageId: 'ts' })).toBeUndefined();
    expect(reconstructAckDeliveryRef({ scopeId: 'C_chat', messageId: 'ts' })).toBeUndefined();
    expect(
      reconstructAckDeliveryRef({ kind: 'slack', scopeId: '', messageId: 'ts' }),
    ).toBeUndefined();
  });

  it('drives a real SlackChannel.update at the right channel + ts (no live creds)', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchMock = vi.fn(async (url: string, init?: { body?: string }) => {
      const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
      calls.push({ url, body });
      return {
        ok: true,
        json: async () => ({ ok: true, ts: body.ts, channel: body.channel }),
      } as unknown as Response;
    });
    const slack = new SlackChannel({ token: 'xoxb-test', fetch: fetchMock as unknown as typeof fetch });

    const ref = reconstructAckDeliveryRef({
      kind: 'slack',
      scopeId: 'C_chat',
      messageId: '1710000000.000200',
    });
    expect(ref).toBeDefined();

    const sender: ChannelSender = slack as unknown as ChannelSender;
    const feedback = new NeutralChannelFeedback({
      sender,
      conversation: { kind: 'slack', scopeId: 'C_chat' },
      ackRef: ref,
    });
    await feedback.updateDone('goal', 'the result');

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('chat.update');
    expect(calls[0].body).toMatchObject({
      channel: 'C_chat',
      ts: '1710000000.000200',
      text: 'the result',
    });
  });
});
