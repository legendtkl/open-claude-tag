/**
 * Byte-identical proof + source wiring guard for ADR-0004 Stage 1a-iii: the
 * inbound-dispatch-path text replies route through the neutral channel sender
 * (`createFeishuChannelSender` -> `LarkChannel.send` with a `kind:'native'`
 * payload) instead of calling `FeishuClient.sendMessage` directly.
 *
 * The behavioral block drives the real seam with a mock client and asserts the
 * forwarded `sendMessage` wire args + the returned message id are identical to
 * the prior direct call. The source block pins that server.ts actually routes
 * the four reply sites (and resolves the destination from the neutral
 * `message.scope.scopeId`). The OK reaction routes through its own neutral helper
 * (`addDispatchReactionViaChannel`), covered by `dispatch-reaction.test.ts`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { FeishuClient } from '@open-tag/feishu-adapter';
import { sendDispatchReplyViaChannel } from '../dispatch-reply.js';

function createMockClient(messageId = 'om_sent_reply') {
  const sendMessage = vi.fn().mockResolvedValue({ messageId });
  return { client: { sendMessage } as unknown as FeishuClient, sendMessage };
}

describe('sendDispatchReplyViaChannel — byte-identical native send through the neutral seam', () => {
  it('forwards a reply-targeted send to client.sendMessage with the identical wire args', async () => {
    const { client, sendMessage } = createMockClient('om_reply_1');
    const payload = { msg_type: 'text' as const, content: { text: 'hello' } };

    const id = await sendDispatchReplyViaChannel(client, 'oc_chat', payload, 'om_user_1');

    expect(id).toBe('om_reply_1');
    expect(sendMessage).toHaveBeenCalledTimes(1);
    // Old direct call: client.sendMessage('chat_id', chatId, payload, replyToMessageId).
    // The seam adds a trailing `undefined` send-options arg, which FeishuClient
    // defaults to `{}` -> wire-identical (own uuid via randomUUID()).
    expect(sendMessage).toHaveBeenCalledWith('chat_id', 'oc_chat', payload, 'om_user_1', undefined);
  });

  it('forwards a no-reply send (denial) without a reply id', async () => {
    const { client, sendMessage } = createMockClient('om_denial_1');
    const payload = {
      msg_type: 'text' as const,
      content: { text: 'Permission denied: this agent is private.' },
    };

    const id = await sendDispatchReplyViaChannel(client, 'oc_chat', payload);

    expect(id).toBe('om_denial_1');
    expect(sendMessage).toHaveBeenCalledWith('chat_id', 'oc_chat', payload, undefined, undefined);
  });

  it('passes the text payload object through verbatim (never a JSON string)', async () => {
    const { client, sendMessage } = createMockClient();
    const payload = { msg_type: 'text' as const, content: { text: 'verbatim' } };

    await sendDispatchReplyViaChannel(client, 'oc_chat', payload, 'om_user');

    expect(sendMessage.mock.calls[0][2]).toBe(payload);
  });
});

describe('server.ts — dispatch-path replies route through the neutral channel sender', () => {
  const serverSrc = readFileSync(fileURLToPath(new URL('../server.ts', import.meta.url)), 'utf8');

  it('imports and uses the neutral dispatch-reply helper', () => {
    expect(serverSrc).toContain("from './dispatch-reply.js'");
    expect(serverSrc).toContain('sendDispatchReplyViaChannel');
  });

  it('routes the handleNormalMessage direct reply via the helper with the neutral scope', () => {
    expect(serverSrc).toMatch(
      /sendDispatchReplyViaChannel\(\s*appContext\.client,\s*message\.scope\.scopeId,/,
    );
  });

  it('routes the three dispatch-body denial/help/owner replies via the helper with the neutral scope', () => {
    const calls =
      serverSrc.match(
        /sendDispatchReplyViaChannel\(\s*currentAppContext\.client,\s*message\.scope\.scopeId,/g,
      ) ?? [];
    expect(calls).toHaveLength(3);
  });

  it('leaves no direct chat_id text reply on the neutralized dispatch core', () => {
    // The four routed sites must no longer call the Feishu client directly. The
    // discussion / deferred-mention sub-handlers (still NormalizedEvent-based) and
    // the ambient / debug paths remain native and are intentionally not asserted
    // here, so scope the handleNormalMessage check to its own body.
    const handlerStart = serverSrc.indexOf('async function handleNormalMessage(');
    const handlerEnd = serverSrc.indexOf('function buildFeishuTaskSourceTopicKey(');
    expect(handlerStart).toBeGreaterThan(-1);
    expect(handlerEnd).toBeGreaterThan(handlerStart);
    const handlerBody = serverSrc.slice(handlerStart, handlerEnd);
    expect(handlerBody).not.toMatch(/appContext\.client\.sendMessage\(\s*'chat_id',\s*event\.chatId,/);
    // All three dispatch-body sends used `currentAppContext.client.sendMessage`,
    // which appears nowhere else, so a global guard pins they are all routed.
    expect(serverSrc).not.toContain('currentAppContext.client.sendMessage(');
  });
});
