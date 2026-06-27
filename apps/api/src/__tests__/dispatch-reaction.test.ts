/**
 * Byte-identical proof + source wiring guard for routing the inbound-dispatch
 * ack reaction through the neutral channel contract (`createFeishuChannelSender`
 * -> `LarkChannel.react` -> `FeishuClient.addReaction`) instead of calling the
 * Feishu client directly.
 *
 * The behavioral block drives the real seam with a mock client and asserts the
 * forwarded `addReaction` wire args + the returned reaction id are identical to
 * the prior direct call. The source block pins that server.ts actually routes the
 * reaction through the helper and no longer calls `client.addReaction` directly.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { FeishuClient } from '@open-tag/feishu-adapter';
import { addDispatchReactionViaChannel } from '../dispatch-reaction.js';

function createMockClient(reactionId = 'reaction_1') {
  const addReaction = vi.fn().mockResolvedValue({ reactionId });
  return { client: { addReaction } as unknown as FeishuClient, addReaction };
}

describe('addDispatchReactionViaChannel — byte-identical reaction through the neutral seam', () => {
  it('forwards the reaction to client.addReaction with the identical wire args', async () => {
    const { client, addReaction } = createMockClient('reaction_42');

    const id = await addDispatchReactionViaChannel(client, 'om_user_1', 'OK');

    expect(id).toBe('reaction_42');
    expect(addReaction).toHaveBeenCalledTimes(1);
    // Old direct call: client.addReaction(event.messageId, 'OK').
    expect(addReaction).toHaveBeenCalledWith('om_user_1', 'OK');
  });

  it('returns the empty reaction id verbatim (caller aliases it to undefined)', async () => {
    const { client } = createMockClient('');

    const id = await addDispatchReactionViaChannel(client, 'om_user_2', 'OK');

    expect(id).toBe('');
  });

  it('propagates a client failure so the caller try/catch can warn', async () => {
    const addReaction = vi.fn().mockRejectedValue(new Error('boom'));
    const client = { addReaction } as unknown as FeishuClient;

    await expect(addDispatchReactionViaChannel(client, 'om_user_3', 'OK')).rejects.toThrow('boom');
  });
});

describe('server.ts — the dispatch ack reaction routes through the neutral helper', () => {
  const serverSrc = readFileSync(fileURLToPath(new URL('../server.ts', import.meta.url)), 'utf8');

  it('imports and uses the neutral dispatch-reaction helper', () => {
    expect(serverSrc).toContain("from './dispatch-reaction.js'");
    expect(serverSrc).toMatch(
      /addDispatchReactionViaChannel\(\s*appContext\.client,\s*event\.messageId,\s*'OK',?\s*\)/,
    );
  });

  it('still threads the returned reaction id into userMessageReactionId', () => {
    expect(serverSrc).toContain('userMessageReactionId = reactionId || undefined;');
  });

  it('leaves no direct client.addReaction call on the dispatch path', () => {
    expect(serverSrc).not.toContain("appContext.client.addReaction(event.messageId, 'OK')");
  });
});
