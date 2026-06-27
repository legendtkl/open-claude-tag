import { describe, it, expect, vi } from 'vitest';
import type { StaleThread, StaleThreadCandidate } from '@open-tag/ambient';
import {
  scanStaleThreads,
  buildStaleThreadDelivery,
  STALE_THREAD_NUDGE_ACTION,
  STALE_THREAD_NUDGE_MARKER,
  type StaleThreadScannerDeps,
} from '../stale-thread-scanner.js';

const NOW = 1_700_000_000_000;
const IDLE_MS = 24 * 60 * 60 * 1000;

function candidate(overrides: Partial<StaleThreadCandidate> = {}): StaleThreadCandidate {
  return {
    taskId: 't1',
    sessionId: 's1',
    chatId: 'oc_1',
    channelKind: 'lark',
    scope: 'group-main',
    isPrivate: false,
    status: 'waiting_approval',
    lastActivityAt: NOW - IDLE_MS - 1, // stale
    feishuAppId: 'app1',
    ...overrides,
  };
}

interface Spies {
  loadCandidates: ReturnType<typeof vi.fn>;
  alreadyHandled: ReturnType<typeof vi.fn>;
  record: ReturnType<typeof vi.fn>;
  deliver: ReturnType<typeof vi.fn>;
  isChannelAllowed: ReturnType<typeof vi.fn>;
}

function makeDeps(
  overrides: Partial<StaleThreadScannerDeps> = {},
): { deps: StaleThreadScannerDeps; spies: Spies } {
  const loadCandidates = vi.fn(async () => [candidate()]);
  const alreadyHandled = vi.fn(async () => false);
  const record = vi.fn(async () => undefined);
  const deliver = vi.fn(async () => undefined);
  const isChannelAllowed = vi.fn(() => true);
  const deps: StaleThreadScannerDeps = {
    globalEnabled: true,
    idleMs: IDLE_MS,
    isChannelAllowed,
    loadCandidates,
    alreadyHandled,
    audit: { record },
    deliver,
    now: () => NOW,
    ...overrides,
  };
  return {
    deps,
    spies: {
      loadCandidates: deps.loadCandidates as ReturnType<typeof vi.fn>,
      alreadyHandled: deps.alreadyHandled as ReturnType<typeof vi.fn>,
      record: deps.audit.record as ReturnType<typeof vi.fn>,
      deliver: deps.deliver as ReturnType<typeof vi.fn>,
      isChannelAllowed: deps.isChannelAllowed as ReturnType<typeof vi.fn>,
    },
  };
}

describe('scanStaleThreads', () => {
  it('default-off: global flag off ⇒ COMPLETE no-op (no load, no audit, no deliver)', async () => {
    const { deps, spies } = makeDeps({ globalEnabled: false });

    await expect(scanStaleThreads(deps)).resolves.toBeUndefined();

    expect(spies.loadCandidates).not.toHaveBeenCalled();
    expect(spies.alreadyHandled).not.toHaveBeenCalled();
    expect(spies.record).not.toHaveBeenCalled();
    expect(spies.deliver).not.toHaveBeenCalled();
  });

  it('approved: anchors BEFORE the send, then delivers a neutral marked nudge and audits sent', async () => {
    const { deps, spies } = makeDeps();

    await scanStaleThreads(deps);

    expect(spies.deliver).toHaveBeenCalledTimes(1);
    const [deliveredThread, text] = spies.deliver.mock.calls[0];
    expect((deliveredThread as StaleThread).taskId).toBe('t1');
    expect(text.startsWith(STALE_THREAD_NUDGE_MARKER)).toBe(true);
    // No sensitive task content leaks into the nudge text.
    expect(text).not.toContain('goal');

    // Two audit rows: the pre-delivery 'attempted' anchor, then the 'sent' outcome.
    expect(spies.record).toHaveBeenCalledTimes(2);
    expect(spies.record.mock.calls[0][4]).toMatchObject({ outcome: 'attempted' });
    const [actorId, action, targetType, targetId, detail, severity] = spies.record.mock.calls[1];
    expect(actorId).toBeNull();
    expect(action).toBe(STALE_THREAD_NUDGE_ACTION);
    expect(targetType).toBe('task');
    expect(targetId).toBe('t1');
    expect(detail).toMatchObject({ outcome: 'sent', scopeId: 'oc_1', scope: 'group-main' });
    // The audit must never carry raw task content.
    expect(JSON.stringify(detail)).not.toMatch(/goal/i);
    expect(severity).toBe('info');

    // The idempotency anchor is durably written BEFORE the side effect.
    expect(spies.record.mock.invocationCallOrder[0]).toBeLessThan(
      spies.deliver.mock.invocationCallOrder[0],
    );
  });

  it('fail-closed: a failed idempotency anchor write skips the send (no un-deduped nudge)', async () => {
    const record = vi.fn(async () => {
      throw new Error('audit down');
    });
    const { deps, spies } = makeDeps({ audit: { record } });

    await expect(scanStaleThreads(deps)).resolves.toBeUndefined();

    // The anchor write was attempted (and threw); delivery never happened.
    expect(record).toHaveBeenCalledTimes(1);
    expect(spies.deliver).not.toHaveBeenCalled();
  });

  it('budget exhausted: audited decline, NO delivery (no anchor written)', async () => {
    const { deps, spies } = makeDeps({ budget: { withinBudget: false } });

    await scanStaleThreads(deps);

    expect(spies.deliver).not.toHaveBeenCalled();
    expect(spies.record).toHaveBeenCalledTimes(1);
    expect(spies.record.mock.calls[0][4]).toMatchObject({ outcome: 'budget_exhausted' });
  });

  it('per-tick cap counts declines too: a backlog of declines cannot burst past the cap', async () => {
    const rows = [
      candidate({ taskId: 'a', chatId: 'oc_a', lastActivityAt: NOW - IDLE_MS - 100 }),
      candidate({ taskId: 'b', chatId: 'oc_b', lastActivityAt: NOW - IDLE_MS - 50 }),
    ];
    const { deps, spies } = makeDeps({
      loadCandidates: vi.fn(async () => rows),
      budget: { withinBudget: false }, // every candidate declines
      maxPerTick: 1,
    });

    await scanStaleThreads(deps);

    // Only ONE candidate handled despite two stale + declined.
    expect(spies.record).toHaveBeenCalledTimes(1);
    expect(spies.record.mock.calls[0][4]).toMatchObject({ outcome: 'budget_exhausted' });
    expect(spies.deliver).not.toHaveBeenCalled();
  });

  it('idempotent: an already-handled thread is skipped silently (no re-nudge, no audit)', async () => {
    const { deps, spies } = makeDeps({ alreadyHandled: vi.fn(async () => true) });

    await scanStaleThreads(deps);

    expect(spies.alreadyHandled).toHaveBeenCalledWith('t1', NOW - IDLE_MS - 1);
    expect(spies.deliver).not.toHaveBeenCalled();
    expect(spies.record).not.toHaveBeenCalled();
  });

  it('per-channel allowlist: a non-allowlisted channel is skipped silently (no audit, no deliver)', async () => {
    const { deps, spies } = makeDeps({ isChannelAllowed: vi.fn(() => false) });

    await scanStaleThreads(deps);

    expect(spies.alreadyHandled).not.toHaveBeenCalled();
    expect(spies.deliver).not.toHaveBeenCalled();
    expect(spies.record).not.toHaveBeenCalled();
  });

  it('delivery failure is isolated and corrected to send_failed; the scan still resolves', async () => {
    const deliver = vi.fn(async () => {
      throw new Error('channel down');
    });
    const { deps, spies } = makeDeps({ deliver });

    await expect(scanStaleThreads(deps)).resolves.toBeUndefined();

    expect(deliver).toHaveBeenCalledTimes(1);
    // 'attempted' anchor (info), then the 'send_failed' correction (warn).
    expect(spies.record).toHaveBeenCalledTimes(2);
    expect(spies.record.mock.calls[0][4]).toMatchObject({ outcome: 'attempted' });
    expect(spies.record.mock.calls[1][4]).toMatchObject({ outcome: 'send_failed' });
    expect(spies.record.mock.calls[1][5]).toBe('warn');
  });

  it('processes oldest-first and caps nudges per tick (backlog never bursts)', async () => {
    const rows = [
      candidate({ taskId: 'a', chatId: 'oc_a', lastActivityAt: NOW - IDLE_MS - 10 }),
      candidate({ taskId: 'b', chatId: 'oc_b', lastActivityAt: NOW - IDLE_MS - 100 }), // oldest
      candidate({ taskId: 'c', chatId: 'oc_c', lastActivityAt: NOW - IDLE_MS - 50 }),
    ];
    const delivered: string[] = [];
    const { deps } = makeDeps({
      loadCandidates: vi.fn(async () => rows),
      deliver: vi.fn(async (t: StaleThread) => {
        delivered.push(t.taskId);
      }),
      maxPerTick: 2,
    });

    await scanStaleThreads(deps);

    // Oldest two only, in oldest-first order.
    expect(delivered).toEqual(['b', 'c']);
  });

  it('a fresh/resolved candidate set yields no work (detector filters before any IO)', async () => {
    const { deps, spies } = makeDeps({
      loadCandidates: vi.fn(async () => [candidate({ lastActivityAt: NOW - 1000 })]), // fresh
    });

    await scanStaleThreads(deps);

    expect(spies.alreadyHandled).not.toHaveBeenCalled();
    expect(spies.deliver).not.toHaveBeenCalled();
    expect(spies.record).not.toHaveBeenCalled();
  });

  it('candidate load failure is isolated (no throw, no deliver)', async () => {
    const { deps, spies } = makeDeps({
      loadCandidates: vi.fn(async () => {
        throw new Error('db down');
      }),
    });

    await expect(scanStaleThreads(deps)).resolves.toBeUndefined();
    expect(spies.deliver).not.toHaveBeenCalled();
    expect(spies.record).not.toHaveBeenCalled();
  });
});

describe('buildStaleThreadDelivery', () => {
  function thread(overrides: Partial<StaleThread> = {}): StaleThread {
    return {
      taskId: 't1',
      sessionId: 's1',
      chatId: 'oc_1',
      channelKind: 'lark',
      scope: 'group-main',
      isPrivate: false,
      status: 'waiting_approval',
      lastActivityAt: NOW,
      idleForMs: IDLE_MS,
      feishuAppId: 'app1',
      ...overrides,
    };
  }

  it('fails CLOSED on an explicit feishuAppId that cannot resolve — NO primary fallback', async () => {
    const resolveContextById = vi.fn(() => null);
    const resolvePrimaryContext = vi.fn(() => null);
    const deliver = buildStaleThreadDelivery({ resolveContextById, resolvePrimaryContext });

    await expect(deliver(thread(), 'hi')).rejects.toThrow(/No Feishu app context/);
    // The owning app is resolved exactly; it never silently falls back to another bot.
    expect(resolveContextById).toHaveBeenCalledWith('app1');
    expect(resolvePrimaryContext).not.toHaveBeenCalled();
  });

  it('uses the primary context ONLY for a legacy row without a feishuAppId', async () => {
    const resolveContextById = vi.fn(() => null);
    const resolvePrimaryContext = vi.fn(() => null);
    const deliver = buildStaleThreadDelivery({ resolveContextById, resolvePrimaryContext });

    await expect(deliver(thread({ feishuAppId: null }), 'hi')).rejects.toThrow(/No Feishu app context/);
    // No per-task lookup when there is no owning app id; straight to the primary.
    expect(resolveContextById).not.toHaveBeenCalled();
    expect(resolvePrimaryContext).toHaveBeenCalledTimes(1);
  });
});
