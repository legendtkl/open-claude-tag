import { describe, it, expect, vi } from 'vitest';
import { CROSS_CHANNEL_MARKER, type CrossChannelFlag, type CrossChannelScope } from '@open-tag/cross-channel';
import type { ConversationRef, DeliveryRef, OutboundMessage } from '@open-tag/channel-core';
import type { FeedbackChannelSender } from '@open-tag/feishu-adapter';
import {
  brokerCrossChannelFlag,
  buildChannelSenderDelivery,
  type CrossChannelTapDeps,
} from '../cross-channel-tap.js';

function scope(overrides: Partial<CrossChannelScope> = {}): CrossChannelScope {
  return { kind: 'lark', scopeId: 'oc_source', installationId: 'tenant_a', isPrivate: false, ...overrides };
}

function makeFlag(overrides: Partial<CrossChannelFlag> = {}): CrossChannelFlag {
  return {
    sourceScope: scope({ scopeId: 'oc_source' }),
    summary: 'staging deploy is broken',
    severity: 'warning',
    ...overrides,
  };
}

const target = scope({ scopeId: 'oc_target', installationId: 'tenant_a' });

interface Spies {
  resolveCandidates: ReturnType<typeof vi.fn>;
  resolveDelivery: ReturnType<typeof vi.fn>;
  record: ReturnType<typeof vi.fn>;
  deliver: ReturnType<typeof vi.fn>;
}

function makeDeps(overrides: Partial<CrossChannelTapDeps> = {}): { deps: CrossChannelTapDeps; spies: Spies } {
  const resolveCandidates = vi.fn(async () => [target]);
  const resolveDelivery = vi.fn(() => true);
  const record = vi.fn(async () => undefined);
  const deliver = vi.fn(async () => undefined);
  const deps: CrossChannelTapDeps = {
    globalEnabled: true,
    resolveCandidates,
    resolveDelivery,
    audit: { record },
    deliver,
    ...overrides,
  };
  return {
    deps,
    spies: {
      resolveCandidates: deps.resolveCandidates as ReturnType<typeof vi.fn>,
      resolveDelivery: deps.resolveDelivery as ReturnType<typeof vi.fn>,
      record: deps.audit.record as ReturnType<typeof vi.fn>,
      deliver: deps.deliver as ReturnType<typeof vi.fn>,
    },
  };
}

describe('brokerCrossChannelFlag', () => {
  it('default-off: master switch off ⇒ COMPLETE no-op (no candidate resolve, no audit, no send)', async () => {
    const { deps, spies } = makeDeps({ globalEnabled: false });

    await expect(brokerCrossChannelFlag(deps, makeFlag())).resolves.toBeUndefined();

    expect(spies.resolveCandidates).not.toHaveBeenCalled();
    expect(spies.record).not.toHaveBeenCalled();
    expect(spies.deliver).not.toHaveBeenCalled();
  });

  it('enabled + approved: delivers the rendered flag to the target and audits the decision', async () => {
    const { deps, spies } = makeDeps();

    await brokerCrossChannelFlag(deps, makeFlag());

    expect(spies.deliver).toHaveBeenCalledTimes(1);
    const [deliveredTarget, text] = spies.deliver.mock.calls[0];
    expect(deliveredTarget).toEqual(target);
    expect(text.startsWith(CROSS_CHANNEL_MARKER)).toBe(true);
    expect(text).toContain('staging deploy is broken');
    // The decision was audited as a delivery.
    expect(spies.record).toHaveBeenCalled();
    expect(spies.record.mock.calls[0][4]).toMatchObject({ outcome: 'delivered', reason: 'allowlisted' });
  });

  it('all declined: no send, declines still audited', async () => {
    const { deps, spies } = makeDeps({ resolveDelivery: vi.fn(() => false) });

    await brokerCrossChannelFlag(deps, makeFlag());

    expect(spies.deliver).not.toHaveBeenCalled();
    expect(spies.record.mock.calls[0][4]).toMatchObject({
      outcome: 'declined',
      reason: 'target_not_allowlisted',
    });
  });

  it('loop prevention: the source scope among candidates is excluded (self_target), never delivered', async () => {
    const self = scope({ scopeId: 'oc_source', installationId: 'tenant_a' });
    const { deps, spies } = makeDeps({ resolveCandidates: vi.fn(async () => [self, target]) });

    await brokerCrossChannelFlag(deps, makeFlag());

    // Only the non-self target is delivered; the marker is present on the body.
    expect(spies.deliver).toHaveBeenCalledTimes(1);
    expect(spies.deliver.mock.calls[0][0]).toEqual(target);
    expect(spies.deliver.mock.calls[0][1]).toContain(CROSS_CHANNEL_MARKER);
  });

  it('per-target send failure is isolated and audited send_failed; other targets still deliver', async () => {
    const target2 = scope({ scopeId: 'oc_target_2', installationId: 'tenant_a' });
    const deliver = vi.fn(async (t: CrossChannelScope) => {
      if (t.scopeId === 'oc_target') throw new Error('channel down');
    });
    const { deps, spies } = makeDeps({
      resolveCandidates: vi.fn(async () => [target, target2]),
      deliver,
    });

    await expect(brokerCrossChannelFlag(deps, makeFlag())).resolves.toBeUndefined();

    expect(deliver).toHaveBeenCalledTimes(2);
    // A send_failed correction was audited for the failing target.
    const sendFailed = spies.record.mock.calls.find(
      (c) => (c[4] as Record<string, unknown> | undefined)?.outcome === 'send_failed',
    );
    expect(sendFailed).toBeTruthy();
    expect(sendFailed?.[3]).toBe('oc_target');
  });

  it('forwards the flag and its trusted source scope to the candidate resolver unchanged', async () => {
    const { deps, spies } = makeDeps();
    const flag = makeFlag();

    await brokerCrossChannelFlag(deps, flag);

    // The tap never fabricates scopes; it forwards the caller-provided (trusted)
    // flag and the source scope flows untouched into the allowlist resolver.
    expect(spies.resolveCandidates).toHaveBeenCalledWith(flag);
    expect(spies.resolveDelivery).toHaveBeenCalledWith(flag.sourceScope, target);
  });
});

describe('buildChannelSenderDelivery', () => {
  it('resolves a sender by the target kind and sends a neutral text OutboundMessage', async () => {
    const sent: { to: ConversationRef; msg: OutboundMessage }[] = [];
    const slackSender: FeedbackChannelSender = {
      send: async (to, msg) => {
        sent.push({ to, msg });
        return { kind: 'slack', logicalMessageId: 'm1', revision: 0, physicalIds: ['m1'] } as DeliveryRef;
      },
      update: async (ref) => ref,
    };
    const deliver = buildChannelSenderDelivery({ slackSender });

    await deliver(scope({ kind: 'slack', scopeId: 'C123' }), `${CROSS_CHANNEL_MARKER} hi`);

    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual({ kind: 'slack', scopeId: 'C123' });
    expect(sent[0].msg).toEqual({ kind: 'text', markdown: `${CROSS_CHANNEL_MARKER} hi` });
  });
});
