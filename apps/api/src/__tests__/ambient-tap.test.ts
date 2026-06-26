import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi } from 'vitest';
import type { NormalizedEvent } from '@open-tag/core-types';
import type { Identity } from '@open-tag/registry';
import type { Database } from '@open-tag/storage';
import {
  tapAmbient,
  type AmbientTapDeps,
  type AmbientAuditSink,
  type AmbientDispatch,
} from '../ambient-tap.js';

/** A minimal composed Identity for budget-gate tests (zero-access, optional cap). */
function makeIdentity(budget?: Identity['budget']): Identity {
  return {
    id: 'agent-uuid-amb',
    persona: { profileId: 'profile-amb' },
    runtimeBackend: 'claude_code',
    boundChannels: [],
    active: true,
    budget,
  };
}

// hydrateContext is always injected below, so the real DB handle is never used.
const fakeDb = {} as unknown as Database;

function makeEvent(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    eventId: 'evt_amb_001',
    messageId: 'msg_amb_001',
    chatId: 'oc_chat_amb',
    chatType: 'group',
    threadId: 'thread_amb',
    rootMessageId: 'root_amb',
    parentMessageId: 'parent_amb',
    senderOpenId: 'ou_user_amb',
    senderUnionId: 'on_user_amb',
    senderType: 'user',
    tenantKey: 'tenant_amb',
    content: {
      // A question → the gate's `unanswered_question` heuristic fires.
      type: 'text',
      text: 'is the staging deploy done yet?',
      raw: { schema: '2.0' },
    },
    replyLanguage: 'en-US',
    timestamp: 1782864000000,
    ...overrides,
  } as NormalizedEvent;
}

interface Spies {
  dispatch: ReturnType<typeof vi.fn>;
  record: ReturnType<typeof vi.fn>;
  hydrate: ReturnType<typeof vi.fn>;
}

function makeDeps(
  overrides: Partial<AmbientTapDeps> = {},
): { deps: AmbientTapDeps; spies: Spies } {
  const dispatch = vi.fn(async (_input: Parameters<AmbientDispatch>[0]) => undefined);
  const record = vi.fn(
    async (..._args: Parameters<AmbientAuditSink['record']>): Promise<void> => undefined,
  );
  const hydrate = vi.fn(async () => '');
  const deps: AmbientTapDeps = {
    db: fakeDb,
    audit: { record },
    // Default ENABLED config (tests opt-out via override). channelEnabled is an
    // explicit boolean so isAmbientEnabled is the airtight AND.
    resolveConfig: () => ({ globalEnabled: true, channelEnabled: true }),
    dispatch,
    hydrateContext: hydrate,
    // Approve by default; decline-path tests override the judge.
    judge: async () => ({ post: true, rationale: 'helpful' }),
    ...overrides,
  };
  // Spies must reflect the FINAL deps so a test that overrides a seam asserts on
  // the function actually invoked (not the shadowed default).
  return {
    deps,
    spies: {
      dispatch: deps.dispatch as ReturnType<typeof vi.fn>,
      record: deps.audit.record as ReturnType<typeof vi.fn>,
      hydrate: deps.hydrateContext as unknown as ReturnType<typeof vi.fn>,
    },
  };
}

// Drain the detached `evaluateAndAct` chain (hydrate → gate → audit → dispatch).
async function settle(): Promise<void> {
  for (let i = 0; i < 25; i += 1) {
    await Promise.resolve();
  }
}

describe('tapAmbient', () => {
  it('default-off: a disabled/unconfigured channel never evaluates, audits, or dispatches', async () => {
    const { deps, spies } = makeDeps({
      // Global on but channel NOT allowlisted ⇒ channelEnabled false ⇒ hard off.
      resolveConfig: () => ({ globalEnabled: true, channelEnabled: false }),
    });

    expect(() => tapAmbient(deps, makeEvent())).not.toThrow();
    await settle();

    expect(spies.hydrate).not.toHaveBeenCalled();
    expect(spies.record).not.toHaveBeenCalled();
    expect(spies.dispatch).not.toHaveBeenCalled();
  });

  it('loop prevention: a bot-authored message is skipped before any work (no evaluation/audit/dispatch)', async () => {
    const { deps, spies } = makeDeps();

    // The bot's own ambient reply re-entering the un-addressed branch must not
    // spend work on, audit, or re-trigger ambient.
    expect(() => tapAmbient(deps, makeEvent({ senderType: 'app' }))).not.toThrow();
    await settle();

    expect(spies.hydrate).not.toHaveBeenCalled();
    expect(spies.record).not.toHaveBeenCalled();
    expect(spies.dispatch).not.toHaveBeenCalled();
  });

  it('default-off airtight even when config resolution throws (treated as disabled)', async () => {
    const { deps, spies } = makeDeps({
      resolveConfig: () => {
        throw new Error('config backend down');
      },
    });

    expect(() => tapAmbient(deps, makeEvent())).not.toThrow();
    await settle();

    expect(spies.dispatch).not.toHaveBeenCalled();
    expect(spies.record).not.toHaveBeenCalled();
  });

  it('enabled + gate approves: enqueues an AMBIENT post and audits the decision as posted', async () => {
    const { deps, spies } = makeDeps();

    tapAmbient(deps, makeEvent());
    await settle();

    // The dispatch (enqueue) seam is invoked exactly once with a posting decision.
    expect(spies.dispatch).toHaveBeenCalledTimes(1);
    const dispatched = spies.dispatch.mock.calls[0][0];
    expect(dispatched.decision.shouldPost).toBe(true);
    expect(dispatched.decision.reason).toBe('judge_approved');

    // Every decision is audited; this one as a post.
    expect(spies.record).toHaveBeenCalledTimes(1);
    const [actorId, action, targetType, targetId, detail] = spies.record.mock.calls[0];
    expect(actorId).toBeNull();
    expect(action).toBe('ambient.post_decision');
    expect(targetType).toBe('channel');
    expect(targetId).toBe('oc_chat_amb');
    expect(detail).toMatchObject({ outcome: 'posted', reason: 'judge_approved' });
  });

  it('enabled + judge declines: audits the decline reason and never dispatches', async () => {
    const { deps, spies } = makeDeps({
      judge: async () => ({ post: false, rationale: 'not worth it' }),
    });

    tapAmbient(deps, makeEvent());
    await settle();

    expect(spies.dispatch).not.toHaveBeenCalled();
    expect(spies.record).toHaveBeenCalledTimes(1);
    expect(spies.record.mock.calls[0][4]).toMatchObject({
      outcome: 'declined',
      reason: 'judge_declined',
    });
  });

  it('enabled + heuristic finds nothing worth saying: declines without reaching the judge', async () => {
    const judge = vi.fn(async () => ({ post: true, rationale: 'x' }));
    const { deps, spies } = makeDeps({
      judge,
      // No question, no context overlap ⇒ not_worth_saying.
      hydrateContext: async () => '',
    });

    tapAmbient(deps, makeEvent({ content: { type: 'text', text: 'lunch was good', raw: {} } as any }));
    await settle();

    expect(judge).not.toHaveBeenCalled();
    expect(spies.dispatch).not.toHaveBeenCalled();
    expect(spies.record.mock.calls[0][4]).toMatchObject({
      outcome: 'declined',
      reason: 'not_worth_saying',
    });
  });

  it('budget exhausted: an over-cap budget gate declines budget_exhausted before the judge (no dispatch)', async () => {
    const judge = vi.fn(async () => ({ post: true, rationale: 'x' }));
    const { deps, spies } = makeDeps({
      judge,
      // Over budget ⇒ the gate declines at the spend step, ahead of any judge spend.
      checkBudget: () => ({ withinBudget: false }),
    });

    tapAmbient(deps, makeEvent());
    await settle();

    expect(judge).not.toHaveBeenCalled();
    expect(spies.dispatch).not.toHaveBeenCalled();
    expect(spies.record).toHaveBeenCalledTimes(1);
    expect(spies.record.mock.calls[0][4]).toMatchObject({
      outcome: 'declined',
      reason: 'budget_exhausted',
    });
  });

  it('resolved identity with no declared budget → unlimited (posts without a DB budget query)', async () => {
    const resolveIdentity = vi.fn(async () => makeIdentity(undefined));
    const { deps, spies } = makeDeps({ resolveIdentity });

    tapAmbient(deps, makeEvent());
    await settle();

    // fakeDb would throw if queried; an uncapped identity short-circuits before any
    // checkBudget query, so the gate proceeds to the (approving) judge and posts.
    expect(resolveIdentity).toHaveBeenCalledTimes(1);
    expect(spies.dispatch).toHaveBeenCalledTimes(1);
    expect(spies.record.mock.calls[0][4]).toMatchObject({ outcome: 'posted' });
  });

  it('identity resolution failure fails OPEN: budget treated as unlimited, still posts', async () => {
    const resolveIdentity = vi.fn(async () => {
      throw new Error('agent route backend down');
    });
    const { deps, spies } = makeDeps({ resolveIdentity });

    expect(() => tapAmbient(deps, makeEvent())).not.toThrow();
    await settle();

    // A resolution failure must never block the always-on proactive path.
    expect(spies.dispatch).toHaveBeenCalledTimes(1);
    expect(spies.record.mock.calls[0][4]).toMatchObject({ outcome: 'posted' });
  });

  it('error isolation: a thrown judge fails closed (no dispatch, audited) and never escapes', async () => {
    const { deps, spies } = makeDeps({
      judge: async () => {
        throw new Error('judge LLM down');
      },
    });

    expect(() => tapAmbient(deps, makeEvent())).not.toThrow();
    await settle();

    expect(spies.dispatch).not.toHaveBeenCalled();
    expect(spies.record.mock.calls[0][4]).toMatchObject({
      outcome: 'declined',
      reason: 'judge_failed',
    });
  });

  it('error isolation: a thrown dispatch is swallowed (decision still audited as posted)', async () => {
    const { deps, spies } = makeDeps({
      dispatch: vi.fn(async () => {
        throw new Error('queue down');
      }),
    });

    expect(() => tapAmbient(deps, makeEvent())).not.toThrow();
    await settle();

    expect(spies.dispatch).toHaveBeenCalledTimes(1);
    // The decision was audited as posted before the dispatch failure (isolated).
    expect(spies.record.mock.calls[0][4]).toMatchObject({ outcome: 'posted' });
  });

  it('audit-sink failure does not block the dispatch (audit isolated from post)', async () => {
    const record = vi.fn(async () => {
      throw new Error('audit sink down');
    });
    const { deps, spies } = makeDeps({ audit: { record } });

    expect(() => tapAmbient(deps, makeEvent())).not.toThrow();
    await settle();

    // A failed audit write must not suppress an otherwise-valid proactive post.
    expect(spies.dispatch).toHaveBeenCalledTimes(1);
  });

  it('sheds evaluations past the in-flight cap, then recovers once they drain', async () => {
    // Hold every hydrate open so the in-flight counter climbs to the cap.
    const resolvers: Array<() => void> = [];
    const hydrate = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolvers.push(() => resolve(''));
        }),
    );
    const { deps, spies } = makeDeps({ hydrateContext: hydrate });

    // Cap is 4: the first 4 start evaluating (hydrate), the 5th is shed.
    for (let i = 0; i < 5; i += 1) {
      tapAmbient(deps, makeEvent({ eventId: `evt_${i}` }));
    }
    expect(hydrate).toHaveBeenCalledTimes(4);

    // Drain the held evaluations; the counter returns to zero.
    resolvers.forEach((resolve) => resolve());
    await settle();

    // A subsequent message is accepted again now that capacity freed up.
    tapAmbient(deps, makeEvent({ eventId: 'evt_after' }));
    expect(hydrate).toHaveBeenCalledTimes(5);
    resolvers.forEach((resolve) => resolve());
    await settle();
    void spies;
  });
});

// Source-level guard for the chokepoint wiring: prove server.ts fires the
// ambient tap on the un-addressed branch, right after the observation tap, and
// strictly before any task/dedup/session work (so the default-off branch can
// never leak into the addressed pipeline).
describe('ambient tap wiring in server.ts', () => {
  const serverSrc = readFileSync(fileURLToPath(new URL('../server.ts', import.meta.url)), 'utf8');

  it('fires tapAmbient exactly once, in the un-addressed observation branch', () => {
    const calls = serverSrc.match(/tapAmbient\(buildAmbientTapDeps\([^)]*\), observationEvent\)/g) ?? [];
    expect(calls).toHaveLength(1);
  });

  it('fires the ambient tap immediately after the un-addressed observation tap', () => {
    const obsIdx = serverSrc.indexOf('tapChannelObservation(db, observationEvent)');
    const ambIdx = serverSrc.indexOf('tapAmbient(buildAmbientTapDeps(');
    const skipReturnIdx = serverSrc.indexOf("'Event normalized to null, skipping'");
    expect(obsIdx).toBeGreaterThan(-1);
    expect(ambIdx).toBeGreaterThan(obsIdx);
    expect(skipReturnIdx).toBeGreaterThan(ambIdx);
  });

  it('keeps the ambient tap strictly before dedup record and session resolution', () => {
    const ambIdx = serverSrc.indexOf('tapAmbient(buildAmbientTapDeps(');
    const dedupIdx = serverSrc.indexOf('checkAndRecordEvent(db, event.eventId');
    const sessionIdx = serverSrc.indexOf('resolveSession(db, event)');
    expect(dedupIdx).toBeGreaterThan(ambIdx);
    expect(sessionIdx).toBeGreaterThan(ambIdx);
  });

  it('marks the enqueued ambient task with source: ambient (distinguishable, loop-safe)', () => {
    expect(serverSrc).toContain("extraConstraints: { source: 'ambient' }");
  });

  it('derives a deterministic ambient task id so a redelivery cannot double-enqueue', () => {
    expect(serverSrc).toContain('stableUuidFromKey(`ambient:${feishuAppId');
    expect(serverSrc).toContain('taskId: ambientTaskId');
  });

  it('resolves ambient config as global AND per-channel allowlist (airtight default-off)', () => {
    expect(serverSrc).toContain(
      'AMBIENT_GLOBAL_ENABLED && AMBIENT_CHANNEL_ALLOWLIST.has(event.chatId)',
    );
  });

  it('wires per-identity budget enforcement into the ambient tap deps', () => {
    // The tap resolves the responding agent's Identity so the budget gate can
    // enforce its declared cap before any judge spend.
    expect(serverSrc).toContain('resolveIdentity: (event) => resolveAmbientIdentity(event, feishuAppId)');
  });
});
