import { describe, expect, it, vi } from 'vitest';
import type { IdentityAgentSource, RecordUsageInput } from '@open-tag/registry';
import type { Database } from '@open-tag/storage';
import { recordTaskUsage } from '../usage-recording.js';

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
