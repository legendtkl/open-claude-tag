import { describe, expect, it, vi } from 'vitest';
import type { IdentityAgentSource, RecordUsageInput } from '@open-tag/registry';
import type { Database } from '@open-tag/storage';
import { recordTaskUsage, recordTaskUsageBestEffort } from '../usage-recording.js';

// A stand-in DB — recordUsage is injected, so the helper never touches it.
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

describe('recordTaskUsage', () => {
  it('records the running identity id/window/usage when the agent declares a budget', async () => {
    const recordUsage = vi.fn<(db: Database, input: RecordUsageInput) => Promise<void>>(
      async () => {},
    );

    await recordTaskUsage(
      fakeDb,
      {
        agent: makeAgent({ budget: { tokenCap: 10_000, window: 'day' } }),
        // tokenIn + tokenOut → 350; estimatedCostUsd → spend.
        metrics: { tokenIn: 200, tokenOut: 150, estimatedCostUsd: 1.25 },
        occurredAt: '2026-06-27T13:45:00.000Z',
      },
      { recordUsage },
    );

    expect(recordUsage).toHaveBeenCalledTimes(1);
    // identityId is resolveIdentity(agent).id (defaults to agent.id) — the SAME id
    // the ambient checkBudget gate composes, so recording and checking agree.
    // period is the agent's budget window; windowKey is derived from occurredAt
    // (the UTC day bucket), never Date.now.
    expect(recordUsage).toHaveBeenCalledWith(fakeDb, {
      identityId: 'agent-uuid-1',
      period: 'day',
      windowKey: '2026-06-27',
      tokens: 350,
      spend: 1.25,
    });
  });

  it('records under the agent budget month window for a monthly cap', async () => {
    const recordUsage = vi.fn<(db: Database, input: RecordUsageInput) => Promise<void>>(
      async () => {},
    );

    await recordTaskUsage(
      fakeDb,
      {
        agent: makeAgent({ budget: { spendCap: 50, window: 'month' } }),
        metrics: { tokenIn: 10, tokenOut: 5 },
        occurredAt: '2026-06-27T13:45:00.000Z',
      },
      { recordUsage },
    );

    expect(recordUsage).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({ period: 'month', windowKey: '2026-06', tokens: 15, spend: 0 }),
    );
  });

  it('does not record for an unlimited identity (no budget → never gated, never accounted)', async () => {
    const recordUsage = vi.fn<(db: Database, input: RecordUsageInput) => Promise<void>>(
      async () => {},
    );

    await recordTaskUsage(
      fakeDb,
      {
        agent: makeAgent({ budget: null }),
        metrics: { tokenIn: 200, tokenOut: 150, estimatedCostUsd: 1.25 },
        occurredAt: '2026-06-27T13:45:00.000Z',
      },
      { recordUsage },
    );

    expect(recordUsage).not.toHaveBeenCalled();
  });

  it('does not record a capless budget (window only) — mirrors checkBudget unlimited', async () => {
    const recordUsage = vi.fn<(db: Database, input: RecordUsageInput) => Promise<void>>(
      async () => {},
    );

    await recordTaskUsage(
      fakeDb,
      {
        // A budget with a window but neither tokenCap nor spendCap is unlimited to
        // checkBudget; recording it would write rows the gate never reads.
        agent: makeAgent({ budget: { window: 'day' } }),
        metrics: { tokenIn: 200, tokenOut: 150, estimatedCostUsd: 1.25 },
        occurredAt: '2026-06-27T13:45:00.000Z',
      },
      { recordUsage },
    );

    expect(recordUsage).not.toHaveBeenCalled();
  });

  it('no-ops when the turn consumed nothing (zero tokens and zero spend)', async () => {
    const recordUsage = vi.fn<(db: Database, input: RecordUsageInput) => Promise<void>>(
      async () => {},
    );

    await recordTaskUsage(
      fakeDb,
      {
        agent: makeAgent({ budget: { tokenCap: 10_000, window: 'day' } }),
        metrics: {},
        occurredAt: '2026-06-27T13:45:00.000Z',
      },
      { recordUsage },
    );

    expect(recordUsage).not.toHaveBeenCalled();
  });
});

describe('recordTaskUsageBestEffort', () => {
  const cappedAgent = makeAgent({ budget: { tokenCap: 10_000, window: 'day' } });
  const silentLogger = { warn: vi.fn() };

  it('records once for a failing task with non-zero metrics under a capped identity', async () => {
    const recordUsage = vi.fn<(db: Database, input: RecordUsageInput) => Promise<void>>(
      async () => {},
    );
    const loadAgent = vi.fn(async () => cappedAgent);

    await recordTaskUsageBestEffort(
      fakeDb,
      {
        taskId: 'task-1',
        agentId: cappedAgent.id,
        // A task that consumed tokens then FAILED: usage lifted from the failed
        // event's metrics, recorded the same way the success path records.
        metrics: { tokenIn: 200, tokenOut: 150, estimatedCostUsd: 1.25 },
        occurredAt: '2026-06-27T13:45:00.000Z',
      },
      { loadAgent, logger: silentLogger, recordUsage },
    );

    expect(recordUsage).toHaveBeenCalledTimes(1);
    expect(recordUsage).toHaveBeenCalledWith(fakeDb, {
      identityId: cappedAgent.id,
      period: 'day',
      windowKey: '2026-06-27',
      tokens: 350,
      spend: 1.25,
    });
  });

  it('records once for the success path metrics shape (no regression)', async () => {
    const recordUsage = vi.fn<(db: Database, input: RecordUsageInput) => Promise<void>>(
      async () => {},
    );
    const loadAgent = vi.fn(async () => cappedAgent);

    // The worker forwards TaskResult.metrics (which also carries durationMs the
    // recorder ignores); model that here as a wider object the field narrows.
    const successMetrics = { durationMs: 1234, tokenIn: 10, tokenOut: 5, estimatedCostUsd: 0.5 };
    await recordTaskUsageBestEffort(
      fakeDb,
      {
        taskId: 'task-ok',
        agentId: cappedAgent.id,
        metrics: successMetrics,
        occurredAt: '2026-06-27T13:45:00.000Z',
      },
      { loadAgent, logger: silentLogger, recordUsage },
    );

    expect(recordUsage).toHaveBeenCalledTimes(1);
    expect(recordUsage).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({ tokens: 15, spend: 0.5 }),
    );
  });

  it('no-ops when metrics are absent (failed before any token spend / admission reject)', async () => {
    const recordUsage = vi.fn<(db: Database, input: RecordUsageInput) => Promise<void>>(
      async () => {},
    );
    const loadAgent = vi.fn(async () => cappedAgent);

    await recordTaskUsageBestEffort(
      fakeDb,
      { taskId: 'task-2', agentId: cappedAgent.id, metrics: null, occurredAt: 'x' },
      { loadAgent, logger: silentLogger, recordUsage },
    );

    // No usage means the agent is never even resolved — a clean no-op.
    expect(loadAgent).not.toHaveBeenCalled();
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it('no-ops on a zero-metric failure (no empty rows)', async () => {
    const recordUsage = vi.fn<(db: Database, input: RecordUsageInput) => Promise<void>>(
      async () => {},
    );
    const loadAgent = vi.fn(async () => cappedAgent);

    await recordTaskUsageBestEffort(
      fakeDb,
      {
        taskId: 'task-3',
        agentId: cappedAgent.id,
        metrics: { tokenIn: 0, tokenOut: 0, estimatedCostUsd: 0 },
        occurredAt: '2026-06-27T13:45:00.000Z',
      },
      { loadAgent, logger: silentLogger, recordUsage },
    );

    expect(recordUsage).not.toHaveBeenCalled();
  });

  it('no-ops for a legacy task with no agent id', async () => {
    const recordUsage = vi.fn<(db: Database, input: RecordUsageInput) => Promise<void>>(
      async () => {},
    );
    const loadAgent = vi.fn(async () => cappedAgent);

    await recordTaskUsageBestEffort(
      fakeDb,
      {
        taskId: 'task-4',
        agentId: undefined,
        metrics: { tokenIn: 5, tokenOut: 5, estimatedCostUsd: 0 },
        occurredAt: 'x',
      },
      { loadAgent, logger: silentLogger, recordUsage },
    );

    expect(loadAgent).not.toHaveBeenCalled();
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it('does not record when the agent no longer exists', async () => {
    const recordUsage = vi.fn<(db: Database, input: RecordUsageInput) => Promise<void>>(
      async () => {},
    );
    const loadAgent = vi.fn(async () => null);

    await recordTaskUsageBestEffort(
      fakeDb,
      {
        taskId: 'task-5',
        agentId: 'gone',
        metrics: { tokenIn: 5, tokenOut: 5, estimatedCostUsd: 0 },
        occurredAt: 'x',
      },
      { loadAgent, logger: silentLogger, recordUsage },
    );

    expect(recordUsage).not.toHaveBeenCalled();
  });

  it('isolates a recording error — never rethrows so the terminal outcome is unchanged', async () => {
    const warn = vi.fn();
    const recordUsage = vi.fn<(db: Database, input: RecordUsageInput) => Promise<void>>(
      async () => {
        throw new Error('db down');
      },
    );
    const loadAgent = vi.fn(async () => cappedAgent);

    await expect(
      recordTaskUsageBestEffort(
        fakeDb,
        {
          taskId: 'task-6',
          agentId: cappedAgent.id,
          metrics: { tokenIn: 5, tokenOut: 5, estimatedCostUsd: 0 },
          occurredAt: 'x',
        },
        { loadAgent, logger: { warn }, recordUsage },
      ),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(1);
  });
});
