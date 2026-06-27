/**
 * Wiring guard for ADR-0004 Stage 1a-ii/1a-iii: handleNormalMessage (the main
 * task-creation path) accepts the channel-neutral InboundMessage and reads its
 * lossless task-creation inputs from the neutral surface. As of 1a-iii the ACK
 * card and the orchestrator direct reply both route through the neutral channel
 * sender (destination from message.scope.scopeId, byte-identical Feishu via a
 * kind:'native' payload); the OK reaction now also routes through the neutral
 * Channel contract (Channel.react -> ReactionRef carries the reaction id the
 * dispatch path threads into userMessageReactionId). The still-native downstream
 * calls (orchestrator handleEvent, buildQueuedTaskInput,
 * upgradeRootProvisionalSession, buildFeishuTaskSourceTopicKey) keep flowing
 * from a lark-guarded recovered native event.
 *
 * This mirrors the source-level wiring-guard convention already used for the
 * dispatch seam (inbound-dispatch-seam-golden.test.ts) and the ambient /
 * observation taps. The byte-identical BEHAVIOR is covered by the golden suite
 * (handleEvent + buildQueuedTaskInput produce identical task rows + jobs for the
 * original vs the recovered native event) plus the /debug/simulate e2e suite;
 * this file pins that server.ts actually draws the neutral/native line here.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { NormalizedEvent } from '@open-tag/core-types';
import { adaptNormalizedEvent } from '@open-tag/feishu-adapter';

const serverSrc = readFileSync(fileURLToPath(new URL('../server.ts', import.meta.url)), 'utf8');

/** The handleNormalMessage function body, sliced to its next top-level sibling. */
function handlerBody(): string {
  const start = serverSrc.indexOf('async function handleNormalMessage(');
  const end = serverSrc.indexOf('function buildFeishuTaskSourceTopicKey(');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return serverSrc.slice(start, end);
}

describe('handleNormalMessage — neutral InboundMessage contract (ADR-0004 1a-ii)', () => {
  it('accepts the channel-neutral InboundMessage as its input contract', () => {
    expect(serverSrc).toMatch(/async function handleNormalMessage\(\s*message: InboundMessage,/);
  });

  it('recovers the lark-native event once for outbound + native-downstream calls', () => {
    const body = handlerBody();
    expect(body).toContain('const event = recoverFeishuNormalizedEvent(message);');
  });

  it('reads its lossless task-creation inputs from the neutral surface', () => {
    const body = handlerBody();
    // goal/summary fallback text, tenant, chat, and requester all come from message.*
    expect(body).toContain('message.content.text');
    expect(body).toContain('message.scope.installationId');
    expect(body).toContain('message.scope.scopeId');
    expect(body).toContain('message.sender.id');
  });

  it('routes the orchestrator direct reply through the neutral channel sender with the neutral scope (ADR-0004 1a-iii)', () => {
    const body = handlerBody();
    // The direct reply now resolves its destination from the neutral message scope
    // and sends a kind:'native' payload through createFeishuChannelSender, so it no
    // longer calls the Feishu client directly.
    expect(body).toMatch(
      /sendDispatchReplyViaChannel\(\s*appContext\.client,\s*message\.scope\.scopeId,/,
    );
    expect(body).not.toMatch(/appContext\.client\.sendMessage\(\s*'chat_id',\s*event\.chatId,/);
  });

  it('keeps non-lossless ids / topology on the recovered native event', () => {
    const body = handlerBody();
    // sourceMessageId is non-lossless (messageId-or-eventId fallback) -> native.
    expect(body).toContain('sourceMessageId: event.messageId');
    // topic key derivation uses empty-string-sensitive ?? chains -> native event.
    expect(body).toContain('buildFeishuTaskSourceTopicKey(event,');
  });

  it('routes the OK reaction through the neutral channel contract with the native target id', () => {
    const body = handlerBody();
    // The ack reaction now goes through Channel.react via the neutral helper
    // (byte-identical Feishu addReaction), capturing the ReactionRef.reactionId
    // into userMessageReactionId. The target stays the native message id.
    expect(body).toMatch(
      /addDispatchReactionViaChannel\(\s*appContext\.client,\s*event\.messageId,\s*'OK',?\s*\)/,
    );
    expect(body).toContain('userMessageReactionId = reactionId || undefined;');
    // The raw client reaction call must be gone from this path.
    expect(body).not.toContain("appContext.client.addReaction(event.messageId, 'OK')");
  });

  it('resolves the dispatch ACK destination from the neutral message scope (ADR-0004 1a-iii)', () => {
    const body = handlerBody();
    // The queued-task ACK now targets the chat via the neutral InboundMessage
    // (message.scope.scopeId), not the recovered native event.chatId. The send is
    // byte-identical (the resolved lark sender + kind:'native' card payload stay
    // Feishu); only the destination source moves onto the neutral surface. The
    // reply target (replyToMessageId) stays native this slice.
    expect(body).toMatch(/new ThreePhaseFeedback\(\s*resolveChannelSender\(/);
    expect(body).toMatch(/message\.scope\.scopeId,/);
    expect(body).not.toMatch(
      /new ThreePhaseFeedback\(\s*createFeishuChannelSender\(appContext\.client\),\s*event\.chatId/,
    );
  });

  it('resolves the dispatch ACK sender by the inbound message channel kind (ADR-0004 1a-iii)', () => {
    const body = handlerBody();
    // The ACK sender is no longer hardcoded to Feishu: it resolves from the
    // inbound message's channel kind, so a non-Feishu inbound gets its own
    // sender. For the lark dispatch path this still yields the Feishu sender.
    expect(body).toMatch(
      /resolveChannelSender\(\s*message\.channel\.kind,\s*\{\s*feishuAppContext:\s*appContext\s*\}\s*\)/,
    );
    // The feedback sender must no longer be the hardcoded Feishu one (guard the
    // wiring, not the explanatory comments that name the prior call).
    expect(body).not.toMatch(/new ThreePhaseFeedback\(\s*createFeishuChannelSender\(/);
  });

  it('does not read its own task-creation inputs from the neutral message id', () => {
    // messageId is the one non-lossless scalar; the handler must never source it
    // from message.messageId (which falls back to eventId).
    const body = handlerBody();
    expect(body).not.toContain('message.messageId');
  });
});

describe('handleNormalMessage — call sites adapt the enriched event at the boundary', () => {
  it('adapts the sanitized/buffer-gated effectiveEvent (not the stale entry message)', () => {
    const calls = serverSrc.match(/handleNormalMessage\(\s*adaptNormalizedEvent\(effectiveEvent\),/g) ?? [];
    expect(calls).toHaveLength(2);
  });
});

/**
 * Byte-identity proof for the ADR-0004 1a-iii destination switch. handleNormalMessage
 * is fed `adaptNormalizedEvent(effectiveEvent)` and recovers `event === effectiveEvent`,
 * so moving the ACK destination from `event.chatId` to `message.scope.scopeId` is
 * byte-identical iff the adapter maps the chat id losslessly. Pin that invariant here
 * (the send seam + card payload are unchanged, so the chat id is the only moving part).
 */
describe('dispatch ACK destination — neutral scope is byte-identical to native chatId (ADR-0004 1a-iii)', () => {
  function makeEvent(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
    return {
      eventId: 'evt_ack_1',
      messageId: 'om_ack_1',
      chatId: 'oc_ack_chat',
      chatType: 'group',
      senderOpenId: 'ou_ack_sender',
      senderUnionId: 'on_ack_sender',
      senderType: 'user',
      tenantKey: 'tenant_ack',
      content: { type: 'text', text: 'hello', raw: {} },
      replyLanguage: 'zh-CN',
      timestamp: 1710000000000,
      ...overrides,
    };
  }

  const cases: Array<{ name: string; event: NormalizedEvent }> = [
    { name: 'group chat', event: makeEvent() },
    { name: 'p2p chat', event: makeEvent({ chatId: 'oc_ack_p2p', chatType: 'p2p' }) },
    { name: 'threaded message', event: makeEvent({ chatId: 'oc_ack_thread', threadId: 'omt_thread' }) },
  ];

  for (const { name, event } of cases) {
    it(`${name}: scope.scopeId and conversation.scopeId equal the native chatId`, () => {
      const inbound = adaptNormalizedEvent(event);
      expect(inbound.scope.scopeId).toBe(event.chatId);
      expect(inbound.conversation.scopeId).toBe(event.chatId);
    });
  }
});
