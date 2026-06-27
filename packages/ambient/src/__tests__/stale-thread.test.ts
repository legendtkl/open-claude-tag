import { describe, expect, it } from 'vitest';
import {
  findStaleThreads,
  evaluateStaleThreadNudge,
  type StaleThreadCandidate,
} from '../stale-thread.js';

const NOW = 1_700_000_000_000;
const IDLE_MS = 24 * 60 * 60 * 1000; // 24h

function candidate(overrides: Partial<StaleThreadCandidate> = {}): StaleThreadCandidate {
  return {
    taskId: 't1',
    sessionId: 's1',
    chatId: 'oc_1',
    channelKind: 'lark',
    scope: 'group-main',
    isPrivate: false,
    status: 'waiting_approval',
    lastActivityAt: NOW - IDLE_MS - 1, // just past the threshold ⇒ stale
    feishuAppId: 'app1',
    ...overrides,
  };
}

describe('findStaleThreads', () => {
  it('includes a waiting_approval thread idle past the threshold (stale)', () => {
    const stale = findStaleThreads([candidate()], { now: NOW, idleMs: IDLE_MS });
    expect(stale).toHaveLength(1);
    expect(stale[0].taskId).toBe('t1');
    expect(stale[0].idleForMs).toBe(IDLE_MS + 1);
  });

  it('excludes a waiting thread that is still fresh (idle < threshold)', () => {
    const fresh = candidate({ lastActivityAt: NOW - 1000 });
    expect(findStaleThreads([fresh], { now: NOW, idleMs: IDLE_MS })).toEqual([]);
  });

  it('treats exactly-at-threshold as stale (<= boundary)', () => {
    const atBoundary = candidate({ lastActivityAt: NOW - IDLE_MS });
    expect(findStaleThreads([atBoundary], { now: NOW, idleMs: IDLE_MS })).toHaveLength(1);
  });

  it('excludes resolved/terminal statuses even when idle', () => {
    for (const status of ['completed', 'failed', 'cancelled', 'running', 'queued', 'pending']) {
      const resolved = candidate({ status });
      expect(findStaleThreads([resolved], { now: NOW, idleMs: IDLE_MS })).toEqual([]);
    }
  });

  it('excludes waiting_delegation (awaits a sub-agent, not a human)', () => {
    const delegated = candidate({ status: 'waiting_delegation' });
    expect(findStaleThreads([delegated], { now: NOW, idleMs: IDLE_MS })).toEqual([]);
  });

  it('only keeps directly chat-sendable scopes (fail-closed allowlist)', () => {
    // Sendable chat scopes ⇒ kept.
    for (const scope of ['p2p', 'group-main', 'group-manual']) {
      expect(findStaleThreads([candidate({ scope })], { now: NOW, idleMs: IDLE_MS })).toHaveLength(1);
    }
    // Non-chat-sendable scopes (incl. ones sharing the feishu: namespace) ⇒ excluded.
    for (const scope of ['thread', 'doc-comment', 'discussion', 'delegated-child', 'session', 'future-x']) {
      expect(findStaleThreads([candidate({ scope })], { now: NOW, idleMs: IDLE_MS })).toEqual([]);
    }
  });

  it('returns stale threads sorted oldest-first with a stable taskId tiebreak', () => {
    const a = candidate({ taskId: 'a', lastActivityAt: NOW - IDLE_MS - 10 });
    const b = candidate({ taskId: 'b', lastActivityAt: NOW - IDLE_MS - 100 }); // older
    const c = candidate({ taskId: 'c', lastActivityAt: NOW - IDLE_MS - 10 });
    const stale = findStaleThreads([a, b, c], { now: NOW, idleMs: IDLE_MS });
    expect(stale.map((s) => s.taskId)).toEqual(['b', 'a', 'c']);
  });
});

describe('evaluateStaleThreadNudge', () => {
  it('declines when the two-layer opt-in is off, naming the gate (fail-closed)', async () => {
    expect(await evaluateStaleThreadNudge({ enabled: false, budget: { withinBudget: true } })).toEqual({
      shouldNudge: false,
      reason: 'disabled',
    });
  });

  it('treats any non-true enabled as OFF', async () => {
    for (const flag of [undefined, null, 0, '', 'true']) {
      expect(
        await evaluateStaleThreadNudge({
          enabled: flag as unknown as boolean,
          budget: { withinBudget: true },
        }),
      ).toEqual({ shouldNudge: false, reason: 'disabled' });
    }
  });

  it('declines when over budget', async () => {
    expect(await evaluateStaleThreadNudge({ enabled: true, budget: { withinBudget: false } })).toEqual({
      shouldNudge: false,
      reason: 'budget_exhausted',
    });
  });

  it('declines (fail-closed) when the injected budget check throws', async () => {
    expect(
      await evaluateStaleThreadNudge({
        enabled: true,
        budget: () => {
          throw new Error('budget backend down');
        },
      }),
    ).toEqual({ shouldNudge: false, reason: 'budget_check_failed' });
  });

  it('nudges when enabled and within budget (async budget check supported)', async () => {
    expect(
      await evaluateStaleThreadNudge({ enabled: true, budget: async () => ({ withinBudget: true }) }),
    ).toEqual({ shouldNudge: true, reason: 'nudge' });
  });
});
