/**
 * Wiring guard for ADR-0004 Stage 1a-ii: handleNormalMessage (the main
 * task-creation path) accepts the channel-neutral InboundMessage and reads its
 * lossless task-creation inputs from the neutral surface, while the Feishu
 * OUTBOUND (ACK card / sendMessage / addReaction) and the still-native
 * downstream calls (orchestrator handleEvent, buildQueuedTaskInput,
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

  it('keeps non-lossless ids / topology and outbound on the recovered native event', () => {
    const body = handlerBody();
    // sourceMessageId is non-lossless (messageId-or-eventId fallback) -> native.
    expect(body).toContain('sourceMessageId: event.messageId');
    // topic key derivation uses empty-string-sensitive ?? chains -> native event.
    expect(body).toContain('buildFeishuTaskSourceTopicKey(event,');
    // Outbound stays native this slice: ACK card is built off event.chatId.
    expect(body).toMatch(/new ThreePhaseFeedback\([^]*?event\.chatId/);
    expect(body).toContain("appContext.client.addReaction(event.messageId, 'OK')");
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
