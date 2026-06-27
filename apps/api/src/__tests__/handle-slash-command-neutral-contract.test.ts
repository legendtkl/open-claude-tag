/**
 * Wiring guard for ADR-0004 Stage 1a-ii: handleSlashCommand accepts the
 * channel-neutral InboundMessage and recovers the lark-native event once at the
 * top for its two still-native downstream consumers (the createSlashCommandHandler
 * handler and upgradeRootProvisionalSession). handleSlashCommand reads NO lossless
 * scalars of its own — it is a pure pass-through to those native consumers — so the
 * neutral/native line here is drawn entirely at the signature: it ENTERS neutral
 * and immediately recovers native.
 *
 * This mirrors the source-level wiring-guard convention already used for
 * handleNormalMessage (handle-normal-message-neutral-contract.test.ts), the
 * dispatch seam (inbound-dispatch-seam-golden.test.ts), and the ambient /
 * observation taps. The byte-identical BEHAVIOR is covered by the golden suite
 * plus the /debug/simulate e2e suite; this file pins that server.ts actually draws
 * the neutral/native line at this handler boundary.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const serverSrc = readFileSync(fileURLToPath(new URL('../server.ts', import.meta.url)), 'utf8');

/** The handleSlashCommand function body, sliced to its next top-level sibling. */
function handlerBody(): string {
  const start = serverSrc.indexOf('async function handleSlashCommand(');
  const end = serverSrc.indexOf('// ── Normal message handler ──');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return serverSrc.slice(start, end);
}

describe('handleSlashCommand — neutral InboundMessage contract (ADR-0004 1a-ii)', () => {
  it('accepts the channel-neutral InboundMessage as its input contract', () => {
    expect(serverSrc).toMatch(/async function handleSlashCommand\(\s*message: InboundMessage,/);
  });

  it('recovers the lark-native event once at the top for its native downstream calls', () => {
    const body = handlerBody();
    expect(body).toContain('const event = recoverFeishuNormalizedEvent(message);');
  });

  it('keeps both still-native downstream consumers on the recovered native event', () => {
    const body = handlerBody();
    // createSlashCommandHandler's returned handler still takes a NormalizedEvent.
    expect(body).toContain('await handler(event, sessionId, replyToMessageId)');
    // upgradeRootProvisionalSession still takes a Pick<NormalizedEvent, ...>.
    expect(body).toContain(
      'upgradeRootProvisionalSession({ db, event, logger, sessionId, sentMessageId })',
    );
  });

  it('does not source any input from the neutral message id (no projected scalars)', () => {
    // handleSlashCommand reads no scalars itself; in particular it must never read
    // message.messageId (the one non-lossless projection, which falls back to eventId).
    const body = handlerBody();
    expect(body).not.toContain('message.messageId');
  });
});

describe('handleSlashCommand — call sites adapt the enriched event at the boundary', () => {
  it('adapts the (thread/reference-)enriched native event, not effectiveEvent or a stale message', () => {
    const calls = serverSrc.match(/handleSlashCommand\(\s*adaptNormalizedEvent\(event\),/g) ?? [];
    expect(calls).toHaveLength(2);
  });
});
