import { describe, expect, it, vi } from 'vitest';
import type {
  BudgetCheckResult,
  CheckBudgetInput,
  IdentityAgentSource,
} from '@open-tag/registry';
import type { Database } from '@open-tag/storage';
import type { Logger } from 'pino';
import {
  BUDGET_ADMISSION_BLOCKED_AUDIT_ACTION,
  BudgetExceededError,
  buildOverBudgetMessage,
  enforceTaskAdmissionBudget,
  evaluateTaskAdmissionBudget,
  type BudgetAdmissionBlockAuditInput,
  type EnforceTaskAdmissionBudgetDeps,
} from '../budget-admission.js';

// A stand-in DB — checkBudget is injected, so the helper never touches it.
const fakeDb = {} as Database;

function makeAgent(overrides: Partial<IdentityAgentSource> = {}): IdentityAgentSource {
  return {
    id: 'agent-uuid-1',
    handle: 'open-claude-tag',
    profileId: 'profile-uuid-1',
    defaultRuntime: 'claude_code',
    scopeType: 'system',
    scopeId: 'default',
    status: 'active',
    budget: null,
    ...overrides,
  };
}

function makeLogger(): Logger {
  return { warn: vi.fn(), error: vi.fn(), info: vi.fn() } as unknown as Logger;
}

const OCCURRED_AT = '2026-06-27T13:45:00.000Z';

describe('evaluateTaskAdmissionBudget', () => {
  it('allows an unlimited identity without touching checkBudget (fast-path)', async () => {
    const checkBudget = vi.fn<(db: Database, input: CheckBudgetInput) => Promise<BudgetCheckResult>>();

    const decision = await evaluateTaskAdmissionBudget(
      fakeDb,
      { agent: makeAgent({ budget: null }), occurredAt: OCCURRED_AT },
      { checkBudget },
    );

    expect(decision).toEqual({ allowed: true, identityId: 'agent-uuid-1' });
    expect(checkBudget).not.toHaveBeenCalled();
  });

  it('allows a capless budget (window only) without touching checkBudget', async () => {
    const checkBudget = vi.fn<(db: Database, input: CheckBudgetInput) => Promise<BudgetCheckResult>>();

    const decision = await evaluateTaskAdmissionBudget(
      fakeDb,
      { agent: makeAgent({ budget: { window: 'day' } }), occurredAt: OCCURRED_AT },
      { checkBudget },
    );

    expect(decision.allowed).toBe(true);
    expect(checkBudget).not.toHaveBeenCalled();
  });

  it('allows when under cap, deriving the window bucket from occurredAt', async () => {
    const checkBudget = vi.fn(async () => ({
      withinBudget: true,
      remaining: { tokens: 9_000 },
    }));

    const decision = await evaluateTaskAdmissionBudget(
      fakeDb,
      { agent: makeAgent({ budget: { tokenCap: 10_000, window: 'day' } }), occurredAt: OCCURRED_AT },
      { checkBudget },
    );

    // checking-id == recording-id (resolveIdentity(agent).id defaults to agent.id),
    // and the bucket is the UTC day derived from occurredAt — never Date.now.
    expect(checkBudget).toHaveBeenCalledWith(fakeDb, {
      identity: expect.objectContaining({ id: 'agent-uuid-1' }),
      windowKey: '2026-06-27',
    });
    expect(decision).toMatchObject({
      allowed: true,
      identityId: 'agent-uuid-1',
      window: 'day',
      windowKey: '2026-06-27',
    });
  });

  it('blocks when the cap is exhausted, surfacing the window and remaining headroom', async () => {
    const checkBudget = vi.fn(async () => ({
      withinBudget: false,
      remaining: { spend: -2.5 },
    }));

    const decision = await evaluateTaskAdmissionBudget(
      fakeDb,
      { agent: makeAgent({ budget: { spendCap: 50, window: 'month' } }), occurredAt: OCCURRED_AT },
      { checkBudget },
    );

    expect(checkBudget).toHaveBeenCalledWith(fakeDb, {
      identity: expect.objectContaining({ id: 'agent-uuid-1' }),
      windowKey: '2026-06',
    });
    expect(decision).toEqual({
      allowed: false,
      identityId: 'agent-uuid-1',
      window: 'month',
      windowKey: '2026-06',
      remaining: { spend: -2.5 },
    });
  });
});

describe('buildOverBudgetMessage', () => {
  it('is user-friendly and does NOT match the runtime quota-exceeded routing', () => {
    const daily = buildOverBudgetMessage({
      allowed: false,
      identityId: 'x',
      window: 'day',
      windowKey: '2026-06-27',
    });
    const monthly = buildOverBudgetMessage({
      allowed: false,
      identityId: 'x',
      window: 'month',
      windowKey: '2026-06',
    });

    expect(daily).toContain('daily budget cap');
    expect(monthly).toContain('monthly budget cap');
    // Must not route to the Codex-specific notifyQuotaExceeded card.
    for (const text of [daily, monthly]) {
      expect(text).not.toMatch(/usage.?limit/i);
      expect(text).not.toMatch(/quota.?exceeded/i);
    }
  });
});

interface HarnessOverrides {
  agent?: IdentityAgentSource | null;
  checkBudget?: EnforceTaskAdmissionBudgetDeps['checkBudget'];
  loadAgent?: EnforceTaskAdmissionBudgetDeps['loadAgent'];
  agentId?: string | undefined;
}

function makeEnforceHarness(overrides: HarnessOverrides = {}) {
  const recordBlockAudit =
    vi.fn<(input: BudgetAdmissionBlockAuditInput) => Promise<void>>(async () => {});
  const deleteLease = vi.fn<(taskId: string) => Promise<void>>(async () => {});
  const loadAgent =
    overrides.loadAgent ??
    vi.fn(async () => (overrides.agent === undefined ? makeAgent() : overrides.agent));
  const logger = makeLogger();

  const run = () =>
    enforceTaskAdmissionBudget(
      fakeDb,
      {
        taskId: 'task-1',
        agentId: 'agentId' in overrides ? overrides.agentId : 'agent-uuid-1',
        occurredAt: OCCURRED_AT,
      },
      { loadAgent, deleteLease, recordBlockAudit, checkBudget: overrides.checkBudget, logger },
    );

  return { run, recordBlockAudit, deleteLease, loadAgent, logger };
}

describe('enforceTaskAdmissionBudget', () => {
  it('blocks an over-budget task: deletes the lease, audits, and throws BudgetExceededError', async () => {
    const harness = makeEnforceHarness({
      agent: makeAgent({ budget: { tokenCap: 100, window: 'day' } }),
      checkBudget: vi.fn(async () => ({ withinBudget: false, remaining: { tokens: -5 } })),
    });

    await expect(harness.run()).rejects.toBeInstanceOf(BudgetExceededError);

    // Terminal marking + the channel-visible message are delegated to the worker's
    // shared terminal-failure catch (which renders the thrown error's message);
    // here we assert the gate's own block side-effects.
    expect(harness.deleteLease).toHaveBeenCalledWith('task-1');
    expect(harness.recordBlockAudit).toHaveBeenCalledTimes(1);
    expect(harness.recordBlockAudit).toHaveBeenCalledWith({
      taskId: 'task-1',
      agentId: 'agent-uuid-1',
      decision: expect.objectContaining({ allowed: false, window: 'day', windowKey: '2026-06-27' }),
    });
  });

  it('carries a user-friendly message on the thrown error', async () => {
    const harness = makeEnforceHarness({
      agent: makeAgent({ budget: { spendCap: 1, window: 'month' } }),
      checkBudget: vi.fn(async () => ({ withinBudget: false, remaining: { spend: -1 } })),
    });

    await expect(harness.run()).rejects.toThrow(/monthly budget cap/);
  });

  it('allows an under-cap task: no lease delete, no audit, no throw', async () => {
    const harness = makeEnforceHarness({
      agent: makeAgent({ budget: { tokenCap: 100, window: 'day' } }),
      checkBudget: vi.fn(async () => ({ withinBudget: true, remaining: { tokens: 95 } })),
    });

    await expect(harness.run()).resolves.toBeUndefined();
    expect(harness.deleteLease).not.toHaveBeenCalled();
    expect(harness.recordBlockAudit).not.toHaveBeenCalled();
  });

  it('allows an uncapped identity without invoking checkBudget (zero usage-table cost)', async () => {
    const checkBudget = vi.fn<(db: Database, input: CheckBudgetInput) => Promise<BudgetCheckResult>>();
    const harness = makeEnforceHarness({ agent: makeAgent({ budget: null }), checkBudget });

    await expect(harness.run()).resolves.toBeUndefined();
    expect(checkBudget).not.toHaveBeenCalled();
    expect(harness.recordBlockAudit).not.toHaveBeenCalled();
  });

  it('fails OPEN when agent resolution / budget check throws (DB blip never blocks work)', async () => {
    const harness = makeEnforceHarness({
      agent: makeAgent({ budget: { tokenCap: 100, window: 'day' } }),
      checkBudget: vi.fn(async () => {
        throw new Error('db unavailable');
      }),
    });

    await expect(harness.run()).resolves.toBeUndefined();
    expect(harness.deleteLease).not.toHaveBeenCalled();
    expect(harness.recordBlockAudit).not.toHaveBeenCalled();
    expect(harness.logger.warn).toHaveBeenCalled();
  });

  it('skips the gate for a legacy no-agent task', async () => {
    const harness = makeEnforceHarness({ agentId: undefined });

    await expect(harness.run()).resolves.toBeUndefined();
    expect(harness.loadAgent).not.toHaveBeenCalled();
  });

  it('skips the gate when the agent no longer exists', async () => {
    const checkBudget = vi.fn<(db: Database, input: CheckBudgetInput) => Promise<BudgetCheckResult>>();
    const harness = makeEnforceHarness({ agent: null, checkBudget });

    await expect(harness.run()).resolves.toBeUndefined();
    expect(checkBudget).not.toHaveBeenCalled();
    expect(harness.recordBlockAudit).not.toHaveBeenCalled();
  });

  it('still blocks if the audit write fails (audit is best-effort)', async () => {
    const recordBlockAudit = vi.fn(async () => {
      throw new Error('audit sink down');
    });
    const deleteLease = vi.fn(async () => {});
    const logger = makeLogger();

    await expect(
      enforceTaskAdmissionBudget(
        fakeDb,
        { taskId: 'task-1', agentId: 'agent-uuid-1', occurredAt: OCCURRED_AT },
        {
          loadAgent: async () => makeAgent({ budget: { tokenCap: 1, window: 'day' } }),
          deleteLease,
          recordBlockAudit,
          checkBudget: vi.fn(async () => ({ withinBudget: false, remaining: { tokens: -1 } })),
          logger,
        },
      ),
    ).rejects.toBeInstanceOf(BudgetExceededError);

    expect(deleteLease).toHaveBeenCalledWith('task-1');
    expect(logger.warn).toHaveBeenCalled();
  });

  it('exposes a stable audit action constant within the column limit', () => {
    expect(BUDGET_ADMISSION_BLOCKED_AUDIT_ACTION).toBe('budget.task_admission_blocked');
    expect(BUDGET_ADMISSION_BLOCKED_AUDIT_ACTION.length).toBeLessThanOrEqual(64);
  });
});
