/**
 * Stale-thread scanner IO edge (Stage 5), mirroring `cross-channel-tap.ts`. The
 * pure core (`@open-tag/ambient` `findStaleThreads` / `evaluateStaleThreadNudge`)
 * owns the deterministic detection + the opt-in/budgeted/fail-closed nudge
 * decision; this edge queries candidates, enforces the per-channel allowlist and
 * durable idempotency, audits every decision, and delivers each approved nudge to
 * the thread's OWN channel via {@link resolveChannelSender}.
 *
 * DEFAULT-OFF is airtight: with the global flag off, {@link scanStaleThreads}
 * returns BEFORE any DB query, audit, or send. Wired into the reconciler tick
 * (primary-API-only), it is otherwise inert.
 *
 * LOOP PREVENTION: the nudge is bot-authored and delivered DIRECTLY through the
 * sender — it never re-enters the inbound pipeline (which additionally skips
 * non-user senders), so it can never re-trigger ambient/cross-channel. The
 * staleness clock is `max(task.updatedAt, session.updatedAt)`; the nudge updates
 * NO task/session row, so it cannot reset staleness and oscillate. Every nudge
 * also carries the {@link STALE_THREAD_NUDGE_MARKER} for identifiability.
 *
 * IDEMPOTENCY: one attempt per stale EPISODE. The durable dedupe source is the
 * audit log itself — a prior `stale_thread.nudge` row for the task whose
 * `createdAt >= lastActivityAt` means "already handled this episode" (any
 * outcome: sent, send_failed, or a budget decline). After genuine activity the
 * task's `updatedAt` bumps, `lastActivityAt` advances past the old audit, and a
 * fresh stall re-qualifies — so exactly one attempt per episode, surviving
 * restarts, with NO marker column / migration.
 */
import {
  findStaleThreads,
  evaluateStaleThreadNudge,
  STALE_UNRESOLVED_STATUSES,
  type BudgetCheck,
  type BudgetStatus,
  type StaleThread,
  type StaleThreadCandidate,
} from '@open-tag/ambient';
import { AuditSeverity } from '@open-tag/core-types';
import type { ConversationRef } from '@open-tag/channel-core';
import { createLogger } from '@open-tag/observability';
import { auditEvents, sessions, tasks, type Database } from '@open-tag/storage';
import { and, eq, gte, inArray, like } from 'drizzle-orm';
import {
  resolveChannelSender,
  type ChannelSenderResolutionContext,
} from './channel-sender-resolver.js';
import type { FeishuAppRuntimeContext } from './feishu-app-runtime.js';

const logger = createLogger('stale-thread-scanner');

/** Single audit action for every stale-thread nudge decision/outcome (≤64 chars). */
export const STALE_THREAD_NUDGE_ACTION = 'stale_thread.nudge';

/**
 * A stable, neutral marker prefixed onto every delivered nudge. Mirrors
 * `@open-tag/cross-channel`'s `CROSS_CHANNEL_MARKER`: it makes a stale-thread
 * nudge identifiable so any future inbound-side trigger can skip it (loop
 * prevention, defense-in-depth alongside the direct-delivery + bot-sender skip).
 */
export const STALE_THREAD_NUDGE_MARKER = '[reminder]';

/** Default idle window before a thread is considered stale (24h). */
export const DEFAULT_STALE_THREAD_IDLE_MS = 24 * 60 * 60 * 1000;

/**
 * Hard cap on nudges delivered per scan tick. Stale threads are processed
 * oldest-first (deterministic), so a backlog can never burst — at most this many
 * nudges go out per tick, the rest wait for a later tick.
 */
export const MAX_NUDGES_PER_TICK = 20;

/** The neutral nudge body. No task goal or message content — nothing sensitive. */
const NUDGE_TEXT = `${STALE_THREAD_NUDGE_MARKER} This thread has an item still awaiting your response. Reply here to continue, or let me know if it's already resolved.`;

/** The minimal API-side audit sink (uses the `AuditSeverity` enum). `AuditService` satisfies it. */
export interface StaleThreadAuditSink {
  record(
    actorId: string | null,
    action: string,
    targetType?: string,
    targetId?: string,
    detail?: Record<string, unknown>,
    severity?: AuditSeverity,
  ): Promise<void>;
}

/** Deliver the neutral nudge text to a stale thread's own channel. */
export type StaleThreadDelivery = (thread: StaleThread, text: string) => Promise<void>;

export interface StaleThreadScannerDeps {
  /** The global master switch — `OPEN_TAG_STALE_THREAD_SCANNER_ENABLED`. Off ⇒ complete no-op. */
  globalEnabled: boolean;
  /** Idle threshold before a thread is stale. */
  idleMs: number;
  /** Per-channel allowlist (the second opt-in layer): the chatId must be present. */
  isChannelAllowed: (chatId: string) => boolean;
  /** Load candidate rows at the IO edge (waiting-state tasks joined to sessions). */
  loadCandidates: () => Promise<StaleThreadCandidate[]>;
  /** Durable idempotency: already nudged/handled this task in the current stale episode? */
  alreadyHandled: (taskId: string, sinceMs: number) => Promise<boolean>;
  /** Audit sink — every evaluated decision (nudge / decline / delivery outcome). */
  audit: StaleThreadAuditSink;
  /** Deliver an approved nudge to the thread's own channel. */
  deliver: StaleThreadDelivery;
  /** Spend gate (reuses the ambient budget seam). Absent ⇒ unlimited (static text spends no tokens). */
  budget?: BudgetStatus | BudgetCheck;
  /** Scan clock seam (default `Date.now`); injectable for tests. */
  now?: () => number;
  /** Per-tick nudge cap (default {@link MAX_NUDGES_PER_TICK}). */
  maxPerTick?: number;
}

/**
 * Scan for stale, unresolved threads and surface one gated/audited/idempotent
 * nudge each. Non-throwing — a candidate load failure or any per-thread failure
 * is isolated and logged; the scan never crashes the reconciler tick.
 */
export async function scanStaleThreads(deps: StaleThreadScannerDeps): Promise<void> {
  // Gate 0 — complete no-op when the master switch is off: no query, audit, or send.
  if (!deps.globalEnabled) return;

  let rows: StaleThreadCandidate[];
  try {
    rows = await deps.loadCandidates();
  } catch (err) {
    logger.warn({ err }, 'Stale-thread candidate load failed (isolated, non-fatal)');
    return;
  }

  const now = deps.now ? deps.now() : Date.now();
  const stale = findStaleThreads(rows, { now, idleMs: deps.idleMs });
  if (stale.length === 0) return;

  const budget = deps.budget ?? { withinBudget: true };
  const maxPerTick = deps.maxPerTick ?? MAX_NUDGES_PER_TICK;
  let handled = 0;

  for (const thread of stale) {
    if (handled >= maxPerTick) break;
    try {
      // Layer 2 — per-channel allowlist. A non-opted-in channel is skipped
      // SILENTLY (no audit), mirroring the ambient tap's non-allowlisted no-op.
      // Cheap pre-filter: it does not count toward the per-tick cap.
      if (!deps.isChannelAllowed(thread.chatId)) continue;

      // Idempotency — one attempt per stale episode. A prior audit for this task
      // since it went stale ⇒ skip SILENTLY (a load-protection skip, like the
      // ambient shed; auditing every already-handled thread each tick would grow
      // the audit table unboundedly). Does not count toward the per-tick cap.
      if (await deps.alreadyHandled(thread.taskId, thread.lastActivityAt)) continue;

      // From here the candidate is HANDLED this tick — it counts toward the cap
      // whether it nudges, declines, or fails to send. A backlog of declines /
      // send failures can therefore never burst past the per-tick bound.
      handled += 1;

      const decision = await evaluateStaleThreadNudge({ enabled: true, budget });
      if (!decision.shouldNudge) {
        await tryWriteAudit(deps.audit, thread, decision.reason, AuditSeverity.INFO);
        continue;
      }

      // Anchor idempotency BEFORE the side effect: record the attempt, and only
      // deliver if the anchor was durably written. A failed anchor write ⇒ skip
      // the send (never emit an un-deduped nudge a later tick would repeat). This
      // mirrors the cross-channel broker's audit-fail-closed-on-delivery.
      const anchored = await tryWriteAudit(deps.audit, thread, 'attempted', AuditSeverity.INFO);
      if (!anchored) {
        logger.warn(
          { taskId: thread.taskId },
          'Stale-thread nudge skipped (idempotency anchor audit failed, fail-closed)',
        );
        continue;
      }

      try {
        await deps.deliver(thread, NUDGE_TEXT);
        await tryWriteAudit(deps.audit, thread, 'sent', AuditSeverity.INFO);
      } catch (err) {
        // A failed send is corrected as a delivery failure (NOT a successful
        // nudge); the `attempted` anchor still dedupes this stale episode.
        logger.warn(
          { err, taskId: thread.taskId, chatId: thread.chatId },
          'Stale-thread nudge delivery failed (isolated, non-fatal)',
        );
        await tryWriteAudit(deps.audit, thread, 'send_failed', AuditSeverity.WARN);
      }
    } catch (err) {
      logger.warn(
        { err, taskId: thread.taskId },
        'Stale-thread nudge evaluation failed (isolated, non-fatal)',
      );
    }
  }
}

/**
 * Audit one nudge decision/outcome. System actor (null — no human author). The
 * task id is the target so the audit doubles as the idempotency dedupe key. NO
 * task goal / message content is recorded (only neutral scope identifiers).
 *
 * Returns whether the write SUCCEEDED so the caller can fail closed: the
 * pre-delivery anchor must not be silently lost (that would let a later tick
 * re-send an un-deduped nudge).
 */
async function tryWriteAudit(
  audit: StaleThreadAuditSink,
  thread: StaleThread,
  outcome: string,
  severity: AuditSeverity,
): Promise<boolean> {
  try {
    await audit.record(
      null,
      STALE_THREAD_NUDGE_ACTION,
      'task',
      thread.taskId,
      {
        outcome,
        channelKind: thread.channelKind,
        scopeId: thread.chatId,
        scope: thread.scope,
        isPrivate: thread.isPrivate,
        sessionId: thread.sessionId,
        idleForMs: thread.idleForMs,
        staleSinceMs: thread.lastActivityAt,
      },
      severity,
    );
    return true;
  } catch (err) {
    logger.warn({ err, taskId: thread.taskId }, 'Stale-thread audit write failed (isolated)');
    return false;
  }
}

/**
 * Session-key namespace for Feishu/Lark sessions. Lark keys stay byte-identical
 * to the historical `feishu` namespace (see `@open-tag/session` resolve), so
 * Feishu sessions — the only vendor this background scanner can deliver to (the
 * delivery seam resolves a Feishu app context) — are exactly those whose
 * `sessionKey` starts with this prefix.
 */
const FEISHU_SESSION_KEY_PREFIX = 'feishu:';

/**
 * Build the production candidate loader: waiting-state tasks joined to their
 * session, restricted to FEISHU-namespaced sessions (the only background-
 * deliverable vendor today — a non-Lark session must never be delivered through
 * the Feishu sender), and mapped into {@link StaleThreadCandidate}.
 * `lastActivityAt` is `max(task.updatedAt, session.updatedAt)` so a user reply
 * that touched the session (but not the parked task) resets staleness.
 * `isPrivate` is `scope === 'p2p'`.
 */
export function buildLoadStaleThreadCandidates(
  db: Database,
): () => Promise<StaleThreadCandidate[]> {
  return async () => {
    const rows = await db
      .select({
        taskId: tasks.id,
        status: tasks.status,
        taskUpdatedAt: tasks.updatedAt,
        feishuAppId: tasks.feishuAppId,
        sessionId: sessions.id,
        chatId: sessions.chatId,
        scope: sessions.scope,
        sessionUpdatedAt: sessions.updatedAt,
      })
      .from(tasks)
      .innerJoin(sessions, eq(tasks.sessionId, sessions.id))
      .where(
        and(
          inArray(tasks.status, [...STALE_UNRESOLVED_STATUSES]),
          like(sessions.sessionKey, `${FEISHU_SESSION_KEY_PREFIX}%`),
        ),
      );

    return rows.map((row) => {
      const taskMs = row.taskUpdatedAt instanceof Date ? row.taskUpdatedAt.getTime() : 0;
      const sessionMs = row.sessionUpdatedAt instanceof Date ? row.sessionUpdatedAt.getTime() : 0;
      return {
        taskId: row.taskId,
        sessionId: row.sessionId,
        chatId: row.chatId,
        channelKind: 'lark',
        scope: row.scope,
        isPrivate: row.scope === 'p2p',
        status: row.status,
        lastActivityAt: Math.max(taskMs, sessionMs),
        feishuAppId: row.feishuAppId,
      } satisfies StaleThreadCandidate;
    });
  };
}

/**
 * Build the durable idempotency check: does a `stale_thread.nudge` audit row
 * exist for this task with `createdAt >= sinceMs` (i.e. since the thread last
 * went stale)? One row ⇒ already handled this episode.
 */
export function buildAlreadyHandled(
  db: Database,
): (taskId: string, sinceMs: number) => Promise<boolean> {
  return async (taskId, sinceMs) => {
    const rows = await db
      .select({ id: auditEvents.id })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.action, STALE_THREAD_NUDGE_ACTION),
          eq(auditEvents.targetType, 'task'),
          eq(auditEvents.targetId, taskId),
          gte(auditEvents.createdAt, new Date(sinceMs)),
        ),
      )
      .limit(1);
    return rows.length > 0;
  };
}

/**
 * Build the production delivery function: resolve the thread's Feishu app context,
 * resolve a sender by the neutral channel kind, and send the nudge as a neutral
 * text message. Fails CLOSED — no resolvable context throws, which the scanner
 * audits as `send_failed`. No new core→vendor coupling: `resolveChannelSender`
 * lives in the API composition root.
 *
 * Context resolution is fail-closed on the OWNING app: a task that records a
 * `feishuAppId` resolves ONLY that app's context (no primary fallback) so a
 * missing/disabled owning app never silently sends from the wrong bot. The
 * primary context is used ONLY for legacy rows that record no owning app.
 */
export function buildStaleThreadDelivery(deps: {
  resolveContextById: (feishuAppId: string) => FeishuAppRuntimeContext | null;
  resolvePrimaryContext: () => FeishuAppRuntimeContext | null;
}): StaleThreadDelivery {
  return async (thread, text) => {
    const context = thread.feishuAppId
      ? deps.resolveContextById(thread.feishuAppId)
      : deps.resolvePrimaryContext();
    if (!context) {
      throw new Error(`No Feishu app context for stale-thread nudge (task ${thread.taskId})`);
    }
    const senderCtx: ChannelSenderResolutionContext = { feishuAppContext: context };
    const sender = resolveChannelSender(thread.channelKind, senderCtx);
    const to: ConversationRef = { kind: thread.channelKind, scopeId: thread.chatId };
    await sender.send(to, { kind: 'text', markdown: text });
  };
}
