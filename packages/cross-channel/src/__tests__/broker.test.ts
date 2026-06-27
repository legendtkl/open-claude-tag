import { describe, expect, it, vi } from 'vitest';
import {
  evaluateCrossChannelFlag,
  CROSS_CHANNEL_DECISION_ACTION,
  MAX_CANDIDATES,
} from '../broker.js';
import type {
  CrossChannelBrokerDeps,
  CrossChannelFlag,
  CrossChannelScope,
} from '../types.js';

function scope(overrides: Partial<CrossChannelScope> = {}): CrossChannelScope {
  return {
    kind: 'lark',
    scopeId: 'oc_source',
    installationId: 'tenant_a',
    isPrivate: false,
    ...overrides,
  };
}

function makeFlag(overrides: Partial<CrossChannelFlag> = {}): CrossChannelFlag {
  return {
    sourceScope: scope({ scopeId: 'oc_source' }),
    summary: 'staging deploy is broken',
    severity: 'warning',
    raisedBy: 'ou_raiser',
    sourceRef: 'msg_private_ref',
    ...overrides,
  };
}

interface Spied {
  deps: CrossChannelBrokerDeps;
  record: ReturnType<typeof vi.fn>;
  resolveDelivery: ReturnType<typeof vi.fn>;
}

function makeDeps(overrides: Partial<CrossChannelBrokerDeps> = {}): Spied {
  const record = vi.fn(async () => undefined);
  const resolveDelivery = vi.fn(() => true);
  const deps: CrossChannelBrokerDeps = {
    globalEnabled: true,
    resolveDelivery,
    audit: { record },
    ...overrides,
  };
  return {
    deps,
    record: deps.audit.record as ReturnType<typeof vi.fn>,
    resolveDelivery: deps.resolveDelivery as ReturnType<typeof vi.fn>,
  };
}

/** Assert a single audit row was written with the standard cross-channel shape. */
function expectDecisionAudit(
  record: ReturnType<typeof vi.fn>,
  index: number,
  expected: { outcome: 'delivered' | 'declined'; reason: string; targetScopeId: string },
) {
  const [actorId, action, targetType, targetId, detail] = record.mock.calls[index];
  expect(actorId).toBeNull();
  expect(action).toBe(CROSS_CHANNEL_DECISION_ACTION);
  expect(targetType).toBe('channel');
  expect(targetId).toBe(expected.targetScopeId);
  expect(detail).toMatchObject({ outcome: expected.outcome, reason: expected.reason });
  return detail as Record<string, unknown>;
}

const publicTargetSameTenant = scope({ scopeId: 'oc_target', installationId: 'tenant_a' });

describe('evaluateCrossChannelFlag — security exclusions (fail-closed, audited)', () => {
  it('never delivers back to the source scope (self_target)', async () => {
    const { deps, record } = makeDeps();
    const self = scope({ scopeId: 'oc_source', installationId: 'tenant_a' });

    const res = await evaluateCrossChannelFlag(makeFlag(), [self], deps);

    expect(res.delivered).toHaveLength(0);
    expect(res.decisions[0]).toMatchObject({ deliver: false, reason: 'self_target' });
    expectDecisionAudit(record, 0, {
      outcome: 'declined',
      reason: 'self_target',
      targetScopeId: 'oc_source',
    });
  });

  it("never leaks a PRIVATE source's signal OUT to a public target (private_source)", async () => {
    const { deps, record } = makeDeps();
    const flag = makeFlag({ sourceScope: scope({ scopeId: 'oc_secret', isPrivate: true }) });

    const res = await evaluateCrossChannelFlag(flag, [publicTargetSameTenant], deps);

    expect(res.delivered).toHaveLength(0);
    expect(res.decisions[0]).toMatchObject({ deliver: false, reason: 'private_source' });
    const [, , , , , severity] = record.mock.calls[0];
    expect(severity).toBe('warn');
  });

  it('never delivers INTO a private target (private_target)', async () => {
    const { deps } = makeDeps();
    const privateTarget = scope({ scopeId: 'oc_private', isPrivate: true });

    const res = await evaluateCrossChannelFlag(makeFlag(), [privateTarget], deps);

    expect(res.delivered).toHaveLength(0);
    expect(res.decisions[0]).toMatchObject({ deliver: false, reason: 'private_target' });
  });

  it('blocks cross-tenant delivery by default (cross_tenant)', async () => {
    const { deps } = makeDeps();
    const foreignTenant = scope({ scopeId: 'oc_other', installationId: 'tenant_b' });

    const res = await evaluateCrossChannelFlag(makeFlag(), [foreignTenant], deps);

    expect(res.delivered).toHaveLength(0);
    expect(res.decisions[0]).toMatchObject({ deliver: false, reason: 'cross_tenant' });
  });

  it('allows cross-tenant ONLY when sameTenantOnly=false AND allowlisted', async () => {
    const { deps } = makeDeps({ sameTenantOnly: false });
    const foreignTenant = scope({ scopeId: 'oc_other', installationId: 'tenant_b' });

    const res = await evaluateCrossChannelFlag(makeFlag(), [foreignTenant], deps);

    expect(res.delivered).toHaveLength(1);
    expect(res.decisions[0]).toMatchObject({ deliver: true, reason: 'allowlisted' });
  });

  it('private exclusions ALWAYS win, even in the privileged cross-tenant mode', async () => {
    const { deps } = makeDeps({ sameTenantOnly: false });
    // Private SOURCE → public foreign-tenant target: still private_source.
    const flag = makeFlag({
      sourceScope: scope({ scopeId: 'oc_secret', installationId: 'tenant_a', isPrivate: true }),
    });
    const privateForeign = scope({
      scopeId: 'oc_private_b',
      installationId: 'tenant_b',
      isPrivate: true,
    });

    const leakOut = await evaluateCrossChannelFlag(flag, [scope({ scopeId: 'oc_pub_b', installationId: 'tenant_b' })], deps);
    expect(leakOut.delivered).toHaveLength(0);
    expect(leakOut.decisions[0].reason).toBe('private_source');

    // Public source → private foreign target: still private_target.
    const leakIn = await evaluateCrossChannelFlag(makeFlag(), [privateForeign], deps);
    expect(leakIn.delivered).toHaveLength(0);
    expect(leakIn.decisions[0].reason).toBe('private_target');
  });

  it('security exclusions BEAT a permissive (always-true) allowlist', async () => {
    const { deps, resolveDelivery } = makeDeps({ resolveDelivery: vi.fn(() => true) });
    const self = scope({ scopeId: 'oc_source' });
    const privateTarget = scope({ scopeId: 'oc_private', isPrivate: true });
    const foreignTenant = scope({ scopeId: 'oc_other', installationId: 'tenant_b' });
    const privateSourceFlag = makeFlag({
      sourceScope: scope({ scopeId: 'oc_secret', isPrivate: true }),
    });

    expect((await evaluateCrossChannelFlag(makeFlag(), [self], deps)).delivered).toHaveLength(0);
    expect((await evaluateCrossChannelFlag(makeFlag(), [privateTarget], deps)).delivered).toHaveLength(0);
    expect((await evaluateCrossChannelFlag(makeFlag(), [foreignTenant], deps)).delivered).toHaveLength(0);
    expect((await evaluateCrossChannelFlag(privateSourceFlag, [publicTargetSameTenant], deps)).delivered).toHaveLength(0);
    // The allowlist was never even consulted for the structural exclusions.
    expect(resolveDelivery).not.toHaveBeenCalled();
  });
});

describe('evaluateCrossChannelFlag — default-OFF two-layer gate (audited)', () => {
  it('declines every candidate as global_disabled when the master switch is off (audited)', async () => {
    const { deps, record } = makeDeps({ globalEnabled: false });

    const res = await evaluateCrossChannelFlag(makeFlag(), [publicTargetSameTenant], deps);

    expect(res.delivered).toHaveLength(0);
    expect(res.decisions[0]).toMatchObject({ deliver: false, reason: 'global_disabled' });
    expectDecisionAudit(record, 0, {
      outcome: 'declined',
      reason: 'global_disabled',
      targetScopeId: 'oc_target',
    });
  });

  it('declines a non-allowlisted target (target_not_allowlisted), audited', async () => {
    const { deps, record } = makeDeps({ resolveDelivery: vi.fn(() => false) });

    const res = await evaluateCrossChannelFlag(makeFlag(), [publicTargetSameTenant], deps);

    expect(res.delivered).toHaveLength(0);
    expect(res.decisions[0]).toMatchObject({ deliver: false, reason: 'target_not_allowlisted' });
    expectDecisionAudit(record, 0, {
      outcome: 'declined',
      reason: 'target_not_allowlisted',
      targetScopeId: 'oc_target',
    });
  });

  it('treats a thrown allowlist resolver as a config_error (fail-closed, WARN)', async () => {
    const { deps, record } = makeDeps({
      resolveDelivery: vi.fn(() => {
        throw new Error('allowlist backend down');
      }),
    });

    const res = await evaluateCrossChannelFlag(makeFlag(), [publicTargetSameTenant], deps);

    expect(res.delivered).toHaveLength(0);
    expect(res.decisions[0]).toMatchObject({ deliver: false, reason: 'config_error' });
    const [, , , , , severity] = record.mock.calls[0];
    expect(severity).toBe('warn');
  });
});

describe('evaluateCrossChannelFlag — approved delivery + audit shape', () => {
  it('delivers a same-tenant public allowlisted non-self target (allowlisted, INFO)', async () => {
    const { deps, record, resolveDelivery } = makeDeps();

    const res = await evaluateCrossChannelFlag(makeFlag(), [publicTargetSameTenant], deps);

    expect(res.delivered).toEqual([publicTargetSameTenant]);
    expect(res.decisions[0]).toMatchObject({ deliver: true, reason: 'allowlisted' });
    expect(resolveDelivery).toHaveBeenCalledWith(makeFlag().sourceScope, publicTargetSameTenant);
    const detail = expectDecisionAudit(record, 0, {
      outcome: 'delivered',
      reason: 'allowlisted',
      targetScopeId: 'oc_target',
    });
    const [, , , , , severity] = record.mock.calls[0];
    expect(severity).toBe('info');
    // Delivered rows MAY enrich with raiser/source ref.
    expect(detail).toMatchObject({ raisedBy: 'ou_raiser', sourceRef: 'msg_private_ref' });
  });

  it('NEVER stores the raw summary in audit detail (only summaryLength); declines drop raiser/ref', async () => {
    const { deps, record } = makeDeps();
    const flag = makeFlag({ sourceScope: scope({ scopeId: 'oc_secret', isPrivate: true }) });

    await evaluateCrossChannelFlag(flag, [publicTargetSameTenant], deps);

    const detail = record.mock.calls[0][4] as Record<string, unknown>;
    expect(JSON.stringify(detail)).not.toContain(flag.summary);
    expect(detail).toMatchObject({ summaryLength: flag.summary.length });
    // A decline must not leak the raiser id or the (private) source ref.
    expect(detail).not.toHaveProperty('raisedBy');
    expect(detail).not.toHaveProperty('sourceRef');
  });
});

describe('evaluateCrossChannelFlag — audit-fail-closed-on-delivery + amplification', () => {
  it('suppresses an APPROVED delivery whose audit write fails (audit_failed, not delivered)', async () => {
    const record = vi.fn(async () => {
      throw new Error('audit sink down');
    });
    const { deps } = makeDeps({ audit: { record } });

    const res = await evaluateCrossChannelFlag(makeFlag(), [publicTargetSameTenant], deps);

    expect(res.delivered).toHaveLength(0);
    expect(res.decisions[0]).toMatchObject({ deliver: false, reason: 'audit_failed' });
  });

  it('clamps candidates to MAX_CANDIDATES (bounds audit/send amplification)', async () => {
    const { deps, record } = makeDeps();
    const many = Array.from({ length: MAX_CANDIDATES + 10 }, (_, i) =>
      scope({ scopeId: `oc_t_${i}`, installationId: 'tenant_a' }),
    );

    const res = await evaluateCrossChannelFlag(makeFlag(), many, deps);

    expect(res.decisions).toHaveLength(MAX_CANDIDATES);
    expect(record).toHaveBeenCalledTimes(MAX_CANDIDATES);
  });

  it('de-duplicates repeated candidates so one target is audited/delivered once', async () => {
    const { deps, record } = makeDeps();
    const dup = scope({ scopeId: 'oc_target', installationId: 'tenant_a' });

    const res = await evaluateCrossChannelFlag(makeFlag(), [dup, dup, dup], deps);

    expect(res.decisions).toHaveLength(1);
    expect(res.delivered).toHaveLength(1);
    expect(record).toHaveBeenCalledTimes(1);
  });

  it('evaluates a mixed candidate list and delivers exactly the eligible target', async () => {
    const { deps, record } = makeDeps();
    const self = scope({ scopeId: 'oc_source' });
    const privateTarget = scope({ scopeId: 'oc_private', isPrivate: true });
    const foreignTenant = scope({ scopeId: 'oc_other', installationId: 'tenant_b' });
    const eligible = scope({ scopeId: 'oc_ok', installationId: 'tenant_a' });

    const res = await evaluateCrossChannelFlag(
      makeFlag(),
      [self, privateTarget, foreignTenant, eligible],
      deps,
    );

    expect(res.delivered).toEqual([eligible]);
    expect(res.decisions.map((d) => d.reason)).toEqual([
      'self_target',
      'private_target',
      'cross_tenant',
      'allowlisted',
    ]);
    // Every candidate — delivered and declined — is audited.
    expect(record).toHaveBeenCalledTimes(4);
  });
});
