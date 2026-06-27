/**
 * Unit + byte-identical proof for the dispatch-path channel sender resolver
 * (ADR-0004 Stage 1a-iii follow-up). The inbound dispatch ACK sender is now
 * resolved BY the inbound message's `channel.kind` instead of being hardcoded to
 * Feishu, with a clean registered slot per kind.
 *
 *  - `lark` resolves to exactly `createFeishuChannelSender(feishuAppContext.client)`:
 *    proven byte-identical by driving both the resolved sender and a directly
 *    constructed one with the same inputs and asserting the forwarded
 *    `FeishuClient` wire args (send + update) match.
 *  - The lark factory binds the PER-REQUEST client (not a global), so a second
 *    context yields a sender bound to that context's client.
 *  - An unconfigured (`slack`) or unregistered (`discord`) kind fails fast with a
 *    clear error, so a reply is never silently dropped or sent to a wrong vendor.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { LarkChannel, createFeishuChannelSender } from '@open-tag/feishu-adapter';
import type { FeishuClient } from '@open-tag/feishu-adapter';
import type { ChannelKind, ConversationRef, DeliveryRef } from '@open-tag/channel-core';
import type { FeishuAppRuntimeContext } from '../feishu-app-runtime.js';
import { resolveChannelSender } from '../channel-sender-resolver.js';

/** A recording fake FeishuClient capturing the send/update wire args. */
function createRecordingClient(messageId = 'om_resolved') {
  const sendMessage = vi.fn().mockResolvedValue({ messageId });
  const updateMessage = vi.fn().mockResolvedValue({ messageId });
  return { client: { sendMessage, updateMessage } as unknown as FeishuClient, sendMessage, updateMessage };
}

/** Wrap a fake client into the per-request resolution context (only `client` is read). */
function contextFor(client: FeishuClient) {
  return { feishuAppContext: { client } as unknown as FeishuAppRuntimeContext };
}

const TO: ConversationRef = { kind: 'lark', scopeId: 'oc_chat', reply: { parentId: 'om_user' } };
const CARD_REF: DeliveryRef = {
  kind: 'lark',
  logicalMessageId: 'om_ack',
  revision: 0,
  physicalIds: ['om_ack'],
};

describe('resolveChannelSender — lark resolves to the byte-identical Feishu sender', () => {
  it('returns a LarkChannel bound to the per-request client', () => {
    const { client } = createRecordingClient();
    const sender = resolveChannelSender('lark', contextFor(client));
    expect(sender).toBeInstanceOf(LarkChannel);
  });

  it('forwards a native send identically to createFeishuChannelSender(client)', async () => {
    const payload = { msg_type: 'text' as const, content: { text: 'ack' } };

    const resolved = createRecordingClient('om_via_resolved');
    await resolveChannelSender('lark', contextFor(resolved.client)).send(TO, {
      kind: 'native',
      payload,
    });

    const direct = createRecordingClient('om_via_direct');
    await createFeishuChannelSender(direct.client).send(TO, { kind: 'native', payload });

    expect(resolved.sendMessage).toHaveBeenCalledTimes(1);
    expect(resolved.sendMessage.mock.calls[0]).toEqual(direct.sendMessage.mock.calls[0]);
    // Pin the concrete wire shape too (chat_id, scope, verbatim payload, reply, opts).
    expect(resolved.sendMessage).toHaveBeenCalledWith(
      'chat_id',
      'oc_chat',
      payload,
      'om_user',
      undefined,
    );
    // The native payload passes through verbatim (never a JSON string).
    expect(resolved.sendMessage.mock.calls[0][2]).toBe(payload);
  });

  it('forwards a native update identically to createFeishuChannelSender(client)', async () => {
    const card = { config: {}, elements: [] };

    const resolved = createRecordingClient();
    await resolveChannelSender('lark', contextFor(resolved.client)).update(CARD_REF, {
      kind: 'native',
      payload: card,
    });

    const direct = createRecordingClient();
    await createFeishuChannelSender(direct.client).update(CARD_REF, { kind: 'native', payload: card });

    expect(resolved.updateMessage.mock.calls[0]).toEqual(direct.updateMessage.mock.calls[0]);
    expect(resolved.updateMessage).toHaveBeenCalledWith('om_ack', card);
  });

  it('binds the per-request client, not a shared/global one', async () => {
    const first = createRecordingClient();
    const second = createRecordingClient();
    const payload = { msg_type: 'text' as const, content: { text: 'x' } };

    await resolveChannelSender('lark', contextFor(first.client)).send(TO, { kind: 'native', payload });

    expect(first.sendMessage).toHaveBeenCalledTimes(1);
    expect(second.sendMessage).not.toHaveBeenCalled();
  });
});

describe('resolveChannelSender — fail-fast for unconfigured / unregistered kinds', () => {
  it('throws a clear error for the registered-but-unconfigured slack slot', () => {
    const { client } = createRecordingClient();
    expect(() => resolveChannelSender('slack', contextFor(client))).toThrowError(
      /slack.*not configured/i,
    );
  });

  it('throws a clear error for an unregistered kind', () => {
    const { client } = createRecordingClient();
    expect(() => resolveChannelSender('discord' as ChannelKind, contextFor(client))).toThrowError(
      /no channel sender registered/i,
    );
  });
});

// Source-level wiring guard for the proactive (ambient) dispatch site. The
// handleNormalMessage queued-task ACK is guarded in
// handle-normal-message-neutral-contract.test.ts; this pins that
// dispatchAmbientReply also resolves its ACK sender by the inbound message's
// channel kind, so a regression back to a hardcoded Feishu sender on the
// proactive path is caught too.
describe('server.ts — dispatchAmbientReply resolves the ACK sender by channel kind', () => {
  const serverSrc = readFileSync(fileURLToPath(new URL('../server.ts', import.meta.url)), 'utf8');

  function ambientBody(): string {
    const start = serverSrc.indexOf('async function dispatchAmbientReply(');
    const end = serverSrc.indexOf('async function processEvent(', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return serverSrc.slice(start, end);
  }

  it('feeds ThreePhaseFeedback a kind-resolved sender, not a hardcoded Feishu one', () => {
    const body = ambientBody();
    expect(body).toMatch(
      /resolveChannelSender\(\s*inbound\.channel\.kind,\s*\{\s*feishuAppContext:\s*appContext\s*\}\s*\)/,
    );
    expect(body).not.toMatch(/new ThreePhaseFeedback\(\s*createFeishuChannelSender\(/);
  });
});
