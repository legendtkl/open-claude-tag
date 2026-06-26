import {
  evaluateAmbientPost,
  isAmbientEnabled,
  type AmbientConfig,
  type AmbientDecision,
  type AmbientJudge,
  type BudgetCheck,
} from '@open-tag/ambient';
import { AuditSeverity } from '@open-tag/core-types';
import type { NormalizedEvent } from '@open-tag/core-types';
import { adaptNormalizedEvent, type InboundMessage } from '@open-tag/feishu-adapter';
import { hydrateChannelMemory } from '@open-tag/memory';
import { createLogger } from '@open-tag/observability';
import type { Database } from '@open-tag/storage';

const logger = createLogger('ambient-tap');

/** Single audit action for every per-message ambient decision (≤64 chars). */
const AMBIENT_AUDIT_ACTION = 'ambient.post_decision';

/**
 * Hard cap on concurrent in-flight ambient evaluations. Like the observation
 * tap, ambient evaluation fires detached against the shared API resources (DB
 * read for context + an optional judge LLM call). A judge call is slower and
 * costlier than an observation insert, so the cap is tighter: a backlog of slow
 * judge round-trips can never pile up and starve the primary inbound pipeline.
 * Excess evaluations are shed (no post, no audit) — protecting dispatch always
 * wins over a single proactive reply.
 */
const MAX_INFLIGHT_AMBIENT = 4;
let inflightAmbient = 0;

/** What the tap hands the dispatcher once the gate approves a proactive post. */
export interface AmbientDispatchInput {
  /** The un-addressed source event the proactive reply answers. */
  event: NormalizedEvent;
  /** The neutral projection the gate decided on. */
  inbound: InboundMessage;
  /** The approving decision (always `shouldPost === true` here). */
  decision: AmbientDecision;
  /** Hydrated per-channel memory the gate saw (carried for the dispatcher). */
  context: string;
}

/**
 * Injected enqueue seam. The caller (server.ts) creates the session + task rows
 * and enqueues an AMBIENT-flagged task through the existing dispatch path, so
 * the worker generates a reply and the channel posts it. Kept as a bare function
 * so the tap is unit-testable without the whole queue/orchestrator stack.
 */
export type AmbientDispatch = (input: AmbientDispatchInput) => Promise<void>;

/**
 * Minimal audit sink — `@open-tag/approval`'s `AuditService` satisfies this
 * structurally. Declared narrowly so tests can pass a spy without a real DB.
 */
export interface AmbientAuditSink {
  record(
    actorId: string | null,
    action: string,
    targetType?: string,
    targetId?: string,
    detail?: Record<string, unknown>,
    severity?: AuditSeverity,
  ): Promise<void>;
}

export interface AmbientTapDeps {
  db: Database;
  audit: AmbientAuditSink;
  /**
   * Resolve the per-channel ambient config for an event. SYNCHRONOUS by design
   * (today: global env flag ⊕ per-channel allowlist) so the default-off gate is
   * evaluated before any side effect — see {@link tapAmbient}.
   */
  resolveConfig: (event: NormalizedEvent) => AmbientConfig;
  /** Enqueue an AMBIENT-flagged task when the gate approves a post. */
  dispatch: AmbientDispatch;
  /** Optional injected judge (the only token-spending gate). Absent ⇒ heuristic-only. */
  judge?: AmbientJudge;
  /**
   * Optional spend gate. Absent ⇒ treated as within budget.
   * TODO(stage-5): wire to per-identity budget — real spend enforcement is a
   * separate milestone.
   */
  checkBudget?: BudgetCheck;
  /** Context hydration seam (default {@link hydrateChannelMemory}); injectable for tests. */
  hydrateContext?: (db: Database, scope: { kind: string; scopeId: string }) => Promise<string>;
}

/**
 * Per-message ambient post tap. Sits beside the always-on observation tap in the
 * gateway's UN-ADDRESSED branch: both observe, but ambient additionally MAY post
 * a gated/budgeted/audited proactive reply.
 *
 * DEFAULT-OFF is airtight by construction. The very first thing this does is a
 * SYNCHRONOUS per-channel enable check; a disabled/unconfigured channel returns
 * here with ZERO side effects — no adapt, no memory read, no audit row, no
 * detached task. The airtight property therefore never depends on an async step
 * completing, and an unconfigured channel can never post or enqueue.
 *
 * For an ENABLED channel it is strictly non-blocking and error-isolated, exactly
 * like {@link tapChannelObservation}: it returns `void` synchronously, the
 * evaluation (context read → gate → audit → dispatch) is fire-and-forget and
 * fully `.catch()`-guarded, and in-flight evaluations are capped so a slow judge
 * can never starve the inbound pipeline.
 *
 * Loop prevention: the resulting task's reply is posted BY THE BOT
 * (`sender.isBot === true`). {@link evaluateAmbientPost} short-circuits bot
 * senders to `bot_sender` before any spend, so an ambient reply can never
 * re-trigger ambient; the enqueued task is additionally flagged `source:
 * 'ambient'`.
 */
export function tapAmbient(deps: AmbientTapDeps, event: NormalizedEvent): void {
  // Gate 0 — per-channel default-off, evaluated SYNCHRONOUSLY before any work.
  let config: AmbientConfig;
  try {
    config = deps.resolveConfig(event);
  } catch (err) {
    logger.warn(
      { err, eventId: event.eventId },
      'Ambient config resolve failed (isolated, treated as disabled)',
    );
    return;
  }
  if (!isAmbientEnabled(config)) {
    // Airtight default-off: a disabled/unconfigured channel does nothing.
    return;
  }

  // Loop prevention (defense in depth): a bot's own messages — including this
  // bot's ambient replies — are never ambient candidates. Skip them
  // SYNCHRONOUSLY, before any adapt/hydrate/gate/audit work, so an ambient post
  // can never spend work on, audit, or re-trigger from its own output. The gate
  // independently declines bot senders (`bot_sender`), so this is belt-and-
  // suspenders, not the sole guard.
  if (event.senderType === 'app' || event.senderType === 'bot') {
    return;
  }

  // Bound detached evaluations so a slow judge/DB can't let them pile up.
  // A shed is a LOAD-PROTECTION drop, not a gate decision, so it is
  // intentionally NOT audited: shedding only fires when ambient evaluations are
  // already backing up, and writing an audit row per shed would amplify the very
  // DB pressure the cap exists to relieve. This mirrors the observation tap,
  // which also sheds without a write. (Audit covers every gate decision below.)
  if (inflightAmbient >= MAX_INFLIGHT_AMBIENT) {
    logger.warn(
      { eventId: event.eventId, inflight: inflightAmbient },
      'Ambient evaluation shed (max in-flight reached)',
    );
    return;
  }

  let inbound: InboundMessage;
  try {
    inbound = adaptNormalizedEvent(event);
  } catch (err) {
    logger.warn(
      { err, eventId: event.eventId },
      'Ambient tap failed before evaluation (isolated, non-fatal)',
    );
    return;
  }

  inflightAmbient += 1;
  void evaluateAndAct(deps, event, inbound)
    .catch((err) => {
      logger.warn(
        { err, eventId: event.eventId, chatId: event.chatId },
        'Ambient evaluation failed (isolated, non-fatal)',
      );
    })
    .finally(() => {
      inflightAmbient -= 1;
    });
}

async function evaluateAndAct(
  deps: AmbientTapDeps,
  event: NormalizedEvent,
  inbound: InboundMessage,
): Promise<void> {
  const scope = { kind: inbound.scope.kind, scopeId: inbound.scope.scopeId };

  // Context hydration is best-effort: a failure degrades to empty context rather
  // than blocking the decision (the gate still fails closed downstream).
  let context = '';
  try {
    const hydrate = deps.hydrateContext ?? hydrateChannelMemory;
    context = await hydrate(deps.db, scope);
  } catch (err) {
    logger.warn(
      { err, scopeId: scope.scopeId },
      'Ambient context hydration failed (degraded to empty context)',
    );
  }

  // TODO(stage-5): wire to per-identity budget. Until real spend enforcement
  // lands, ambient is treated as within budget so the gate proceeds to the judge.
  const budget: BudgetCheck = deps.checkBudget ?? (() => ({ withinBudget: true }));

  const decision = await evaluateAmbientPost({
    // InboundMessage is structurally assignable to the gate's AmbientInbound.
    message: inbound,
    context,
    ambientEnabled: true,
    budget,
    judge: deps.judge,
  });

  // Audit EVERY decision (posted or declined). Isolated from dispatch: an audit
  // sink failure must neither block a valid post nor escape the handler.
  await writeAmbientAudit(deps.audit, event, inbound, decision).catch((err) => {
    logger.warn(
      { err, eventId: event.eventId },
      'Ambient decision audit failed (isolated, non-fatal)',
    );
  });

  if (!decision.shouldPost) {
    return;
  }

  await deps.dispatch({ event, inbound, decision, context });
}

async function writeAmbientAudit(
  audit: AmbientAuditSink,
  event: NormalizedEvent,
  inbound: InboundMessage,
  decision: AmbientDecision,
): Promise<void> {
  await audit.record(
    // System actor: audit_events.actor_id is a NULLABLE uuid FK to users.id, so
    // the proactive decision (no human author) records a null actor; the human
    // sender lives in `detail`, never as actorId (which would violate the FK).
    null,
    AMBIENT_AUDIT_ACTION,
    'channel',
    inbound.scope.scopeId,
    {
      outcome: decision.shouldPost ? 'posted' : 'declined',
      reason: decision.reason,
      channelKind: inbound.scope.kind,
      scopeId: inbound.scope.scopeId,
      messageId: inbound.messageId,
      senderOpenId: event.senderOpenId,
    },
    AuditSeverity.INFO,
  );
}
