import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ConversationRef } from '@open-tag/channel-core';
import { LarkChannel } from '../lark-channel.js';
import type { FeishuClient } from '../feishu-client.js';

const BOT_OPEN_ID = 'ou_bot_001';
const config = { botOpenId: BOT_OPEN_ID };

function makeRawEvent() {
  return {
    header: {
      event_id: 'evt_001',
      event_type: 'im.message.receive_v1',
      create_time: '1710000000000',
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
        content: JSON.stringify({ text: '@_user_1 hello @_user_2 world' }),
        mentions: [
          { key: '@_user_1', id: { open_id: BOT_OPEN_ID }, name: 'Bot' },
          { key: '@_user_2', id: { open_id: 'ou_user_002' }, name: 'Alice' },
        ],
      },
    },
  };
}

function makeClient() {
  return {
    sendMessage: vi.fn().mockResolvedValue({ messageId: 'msg_out_1' }),
    updateMessage: vi.fn().mockResolvedValue(undefined),
    addReaction: vi.fn().mockResolvedValue({ reactionId: 'r1' }),
    removeReaction: vi.fn().mockResolvedValue(undefined),
    createDocumentComment: vi.fn().mockResolvedValue({ commentId: 'cmt_1' }),
    downloadImage: vi.fn(),
    downloadFile: vi.fn(),
  };
}

const TO: ConversationRef = { kind: 'lark', scopeId: 'oc_chat_001' };

describe('LarkChannel', () => {
  let stub: ReturnType<typeof makeClient>;
  let channel: LarkChannel;

  beforeEach(() => {
    vi.clearAllMocks();
    stub = makeClient();
    channel = new LarkChannel(stub as unknown as FeishuClient, config);
  });

  it('exposes the lark capability flags', () => {
    expect(channel.kind).toBe('lark');
    const caps = channel.capabilities();
    expect(caps.supportsCards).toBe(true);
    expect(caps.supportsStreamingEdit).toBe(true);
    expect(caps.supportsThreads).toBe(true);
    expect(caps.supportsReactions).toBe(true);
    // renderForm is text-only and uploadArtifact is unimplemented, so those are
    // honest-false; approval buttons stay true (card.action.trigger wired) (#13).
    expect(caps.supportsForms).toBe(false);
    expect(caps.supportsApprovalButtons).toBe(true);
    expect(caps.supportsAttachmentsIn).toEqual(['image', 'file', 'audio']);
    expect(caps.supportsAttachmentsOut).toEqual([]);
    expect(caps.maxOutboundChars).toBe(30000);
    expect(caps.maxOutboundElements).toBe(200);
    expect(caps.maxUpdateRateHz).toBe(5);
  });

  it('normalizes a raw Lark event into a neutral lark InboundMessage', () => {
    const inbound = channel.normalize(makeRawEvent());
    expect(inbound).not.toBeNull();
    expect(inbound!.channel.kind).toBe('lark');
    expect(inbound!.messageId).toBe('msg_001');
    expect(inbound!.content.type).toBe('text');
    expect(inbound!.content.text).toBe('hello @Alice world');
  });

  it('returns null when the raw event cannot be normalized', () => {
    expect(channel.normalize({})).toBeNull();
  });

  it('maps inbound mentions to neutral addressing signals', () => {
    const inbound = channel.normalize(makeRawEvent());
    const signals = channel.extractAddressingSignals(inbound!);
    expect(signals).toEqual([
      { kind: 'bot', id: BOT_OPEN_ID, raw: '@_user_1' },
      { kind: 'user', id: 'ou_user_002', raw: '@_user_2' },
    ]);
  });

  it('sends a text message via the client and returns a lark DeliveryRef', async () => {
    const ref = await channel.send(TO, { kind: 'text', markdown: 'hello' });

    expect(stub.sendMessage).toHaveBeenCalledTimes(1);
    const [receiveIdType, receiveId, content] = stub.sendMessage.mock.calls[0];
    expect(receiveIdType).toBe('chat_id');
    expect(receiveId).toBe('oc_chat_001');
    expect(content).toEqual({ msg_type: 'text', content: { text: 'hello' } });

    expect(ref.kind).toBe('lark');
    expect(ref.revision).toBe(0);
    expect(ref.physicalIds).toEqual(['msg_out_1']);
    expect(ref.logicalMessageId).toBe('msg_out_1');
  });

  it('threads opts.idempotencyKey into the client uuid option', async () => {
    await channel.send(TO, { kind: 'text', markdown: 'hello' }, { idempotencyKey: 'render-key-1' });

    expect(stub.sendMessage).toHaveBeenCalledTimes(1);
    expect(stub.sendMessage.mock.calls[0][4]).toEqual({ uuid: 'render-key-1' });
  });

  it('passes no uuid option when no idempotencyKey is provided (client mints its own)', async () => {
    await channel.send(TO, { kind: 'text', markdown: 'hello' });

    expect(stub.sendMessage.mock.calls[0][4]).toBeUndefined();
  });

  it('sends a result as an interactive card', async () => {
    const ref = await channel.send(TO, { kind: 'result', markdown: '# Answer\nAll done' });

    expect(stub.sendMessage).toHaveBeenCalledTimes(1);
    const content = stub.sendMessage.mock.calls[0][2];
    expect(content.msg_type).toBe('interactive');
    expect(content.card).toBeDefined();
    expect(ref.kind).toBe('lark');
    expect(ref.physicalIds).toEqual(['msg_out_1']);
  });

  it('updates an existing card and bumps the revision', async () => {
    const ref = {
      kind: 'lark' as const,
      logicalMessageId: 'msg_out_1',
      revision: 0,
      physicalIds: ['msg_out_1'],
    };
    const next = await channel.update(ref, {
      kind: 'checklist',
      title: 'Run',
      status: 'done',
      steps: [{ id: 's1', title: 'step one', status: 'done' }],
    });

    expect(stub.updateMessage).toHaveBeenCalledTimes(1);
    expect(stub.updateMessage.mock.calls[0][0]).toBe('msg_out_1');
    expect(next.revision).toBe(1);
  });

  it('reacts via the client and returns a lark ReactionRef carrying the reaction id', async () => {
    const ref = {
      kind: 'lark' as const,
      logicalMessageId: 'msg_user_1',
      revision: 0,
      physicalIds: ['msg_user_1'],
    };

    const reaction = await channel.react(ref, 'OK');

    expect(stub.addReaction).toHaveBeenCalledTimes(1);
    expect(stub.addReaction).toHaveBeenCalledWith('msg_user_1', 'OK');
    // The owning message id rides `native.messageId` so the ReactionRef is
    // self-sufficient for a later removeReaction (round-trippable).
    expect(reaction).toEqual({
      kind: 'lark',
      reactionId: 'r1',
      native: { reactionId: 'r1', messageId: 'msg_user_1' },
    });
  });

  it('reacting on a ref with no physical id is a no-op with an empty reaction id', async () => {
    const ref = {
      kind: 'lark' as const,
      logicalMessageId: '',
      revision: 0,
      physicalIds: [] as string[],
    };

    const reaction = await channel.react(ref, 'OK');

    expect(stub.addReaction).not.toHaveBeenCalled();
    expect(reaction).toEqual({ kind: 'lark', reactionId: '' });
  });

  it('removes a reaction via the client using the message id on native and the reaction id', async () => {
    await channel.removeReaction({
      kind: 'lark',
      reactionId: 'r1',
      native: { messageId: 'msg_user_1' },
    });

    expect(stub.removeReaction).toHaveBeenCalledTimes(1);
    expect(stub.removeReaction).toHaveBeenCalledWith('msg_user_1', 'r1');
  });

  it('round-trips: the ReactionRef from react is removable as-is', async () => {
    const reaction = await channel.react(
      { kind: 'lark', logicalMessageId: 'msg_user_1', revision: 0, physicalIds: ['msg_user_1'] },
      'OK',
    );

    await channel.removeReaction(reaction);

    expect(stub.removeReaction).toHaveBeenCalledWith('msg_user_1', 'r1');
  });

  it('removeReaction is a no-op when the ref is missing its message id or reaction id', async () => {
    await channel.removeReaction({ kind: 'lark', reactionId: 'r1' });
    await channel.removeReaction({ kind: 'lark', reactionId: '', native: { messageId: 'msg_user_1' } });

    expect(stub.removeReaction).not.toHaveBeenCalled();
  });

  it('removeReaction skips a foreign-kind ref even if its native looks removable', async () => {
    await channel.removeReaction({
      kind: 'slack',
      reactionId: 'r1',
      native: { messageId: 'msg_user_1' },
    });

    expect(stub.removeReaction).not.toHaveBeenCalled();
  });

  it('resolves the neutral scope from an inbound message', () => {
    const inbound = channel.normalize(makeRawEvent());
    expect(channel.resolveScope(inbound!)).toBe(inbound!.scope);
  });

  it('reports a healthy status', async () => {
    await expect(channel.healthcheck()).resolves.toEqual({ healthy: true });
  });

  it('start returns a session whose stop is a no-op', async () => {
    const session = await channel.start(async () => {});
    await expect(session.stop()).resolves.toBeUndefined();
  });

  it('fetchAttachment sanitizes a traversal-laden file name before writing', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'lark-att-'));
    stub.downloadFile.mockResolvedValue(Buffer.from('payload'));

    const local = await channel.fetchAttachment(
      {
        type: 'file',
        id: 'file_key_001',
        name: '../../escape.txt',
        native: { messageId: 'msg_001', resourceType: 'file' },
      },
      tmpDir,
    );

    // The name is stripped to its basename so the write stays inside destDir.
    expect(local.name).toBe('escape.txt');
    expect(local.path).toBe(join(tmpDir, 'escape.txt'));
    await rm(tmpDir, { recursive: true, force: true });
  });
});
