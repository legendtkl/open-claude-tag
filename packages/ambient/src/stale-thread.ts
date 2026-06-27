/**
 * Stale-thread scanner pure core (DESIGN Stage 5). A proactive behavior: notice
 * when a conversation/thread the bot was involved in has gone QUIET while still
 * in an UNRESOLVED, awaiting-a-human state, and surface a single gated, audited,
 * idempotent nudge to the thread's OWN channel.
 *
 * Lives in `@open-tag/ambient` (not a new package) because it is the same
 * proactive-posting family as the ambient post gate and reuses its budget seam.
 * This module is PURE: no DB / network / wall-clock. The IO edge (apps/api) queries
 * candidates, computes the scan clock, runs this detector, runs {@link
 * evaluateStaleThreadNudge}, and delivers — exactly as `@open-tag/cross-channel`'s
 * pure broker is driven by `cross-channel-tap.ts`.
 */
import type { BudgetCheck, BudgetStatus } from './types.js';

/**
 * Task statuses that mean "blocked, awaiting a HUMAN response" — the durable
 * unresolved marker a stale-thread nudge keys on. `waiting_approval` is the only
 * such state today: the worker posted a clarify/confirmation card and parked the
 * task until the user approves (it transitions only to terminal states).
 *
 * `waiting_delegation` is deliberately EXCLUDED — it waits on a delegated
 * sub-agent (it transitions back to `queued`), not on a human, so nudging the
 * user about it would be wrong. `pending`/`queued`/`running` are transient
 * in-flight states (work is happening) and are likewise not awaiting-human.
 */
export const STALE_UNRESOLVED_STATUSES: readonly string[] = ['waiting_approval'];

/**
 * Session scopes whose `chatId` is a directly chat-sendable target — the only
 * scopes a nudge may post into. A fail-closed ALLOWLIST: only the canonical chat
 * scopes (`p2p`, `group-main`, `group-manual`) qualify. Everything else is
 * excluded, including scopes that share the Feishu session-key namespace but are
 * NOT a sendable chat — `thread` (chatId is the parent chat, not the thread),
 * `doc-comment` (chatId is a `doc:*` ref), `discussion`, `delegated-child`, and
 * any future scope — so a stale task in one of those is never nudged through a
 * chat sender until it is proven sendable.
 */
const SENDABLE_CHAT_SCOPES: ReadonlySet<string> = new Set(['p2p', 'group-main', 'group-manual']);

/**
 * One candidate row the IO edge passes in (queried at the edge, never inside this
 * pure core). `lastActivityAt` MUST be `max(task.updatedAt, session.updatedAt)`
 * computed by the caller, so a user reply that touched the session (but not the
 * parked task) correctly resets staleness.
 */
export interface StaleThreadCandidate {
  taskId: string;
  sessionId: string;
  /** The channel isolation key (Feishu chat id) — the nudge's delivery target. */
  chatId: string;
  /** Vendor of the channel (e.g. `lark`); resolves the outbound sender. */
  channelKind: string;
  /** Session scope (`p2p` | `group-main` | `group-manual` | `thread`). */
  scope: string;
  /** Private (DM) channel? Carried + audited; does not by itself block a same-channel nudge. */
  isPrivate: boolean;
  /** The task status (re-validated here for defense in depth). */
  status: string;
  /** Epoch ms of the most recent activity = max(task.updatedAt, session.updatedAt). */
  lastActivityAt: number;
  /** The Feishu app that owns the task, used to resolve the outbound sender. */
  feishuAppId?: string | null;
}

export interface StaleThread extends StaleThreadCandidate {
  /** How long (ms) the thread has been idle at scan time (`now - lastActivityAt`). */
  idleForMs: number;
}

export interface FindStaleThreadsOptions {
  /** Scan clock, epoch ms (INJECTED — this module never reads wall-clock). */
  now: number;
  /** Idle threshold; a thread is stale only when idle for at least this long. */
  idleMs: number;
}

/**
 * Pure, deterministic stale-thread detector. A candidate is stale iff ALL hold:
 *  - its status is an unresolved (awaiting-human) marker (see
 *    {@link STALE_UNRESOLVED_STATUSES}),
 *  - its scope is a directly chat-sendable scope (see {@link SENDABLE_CHAT_SCOPES}), and
 *  - it has been idle for at least `idleMs` (`lastActivityAt <= now - idleMs`).
 *
 * Returns the stale subset sorted oldest-first (ascending `lastActivityAt`, with
 * `taskId` as a stable tiebreak) so the IO edge can apply a deterministic
 * per-tick cap to the most-stale threads first.
 */
export function findStaleThreads(
  rows: readonly StaleThreadCandidate[],
  options: FindStaleThreadsOptions,
): StaleThread[] {
  const threshold = options.now - options.idleMs;
  const stale: StaleThread[] = [];
  for (const row of rows) {
    if (!STALE_UNRESOLVED_STATUSES.includes(row.status)) continue;
    if (!SENDABLE_CHAT_SCOPES.has(row.scope)) continue;
    if (row.lastActivityAt > threshold) continue; // still fresh
    stale.push({ ...row, idleForMs: options.now - row.lastActivityAt });
  }
  stale.sort(
    (a, b) => a.lastActivityAt - b.lastActivityAt || a.taskId.localeCompare(b.taskId),
  );
  return stale;
}

/** Why a nudge decision resolved — the precise gate name (parity with the ambient gate). */
export type StaleThreadNudgeReason =
  | 'disabled' // the two-layer opt-in is off (fail-closed)
  | 'budget_check_failed' // the injected budget check threw (fail-closed)
  | 'budget_exhausted' // the channel/identity is at/over its spend cap
  | 'nudge'; // all gates passed — nudge

export interface StaleThreadNudgeDecision {
  shouldNudge: boolean;
  reason: StaleThreadNudgeReason;
}

export interface StaleThreadNudgeInput {
  /**
   * The two-layer opt-in result (global flag AND per-channel allowlist), already
   * resolved by the caller. Fail-closed: anything but an explicit `true` is OFF.
   */
  enabled: boolean;
  /**
   * Spend gate — a resolved status or an injected (possibly async) check. Reuses
   * the ambient budget seam so a stale-thread nudge is budgeted exactly like an
   * ambient post (a static-text nudge spends no tokens, so the default is
   * unlimited; the seam exists for a future per-channel nudge rate cap).
   */
  budget: BudgetStatus | BudgetCheck;
}

async function resolveBudget(budget: BudgetStatus | BudgetCheck): Promise<BudgetStatus> {
  return typeof budget === 'function' ? budget() : budget;
}

/**
 * The stale-thread nudge gate. Same SHAPE as `evaluateAmbientPost` (opt-in AND
 * budgeted, fail-closed) MINUS the message-content heuristics, which do not apply
 * — a stale-thread nudge is triggered by a stalled task, not by a message. The
 * cross-channel broker set the precedent of a feature-specific evaluator that
 * reuses the ambient gate's shape rather than forcing `evaluateAmbientPost`.
 *
 * Fail-closed: a non-true `enabled`, or a budget check that throws, both yield NO
 * nudge.
 */
export async function evaluateStaleThreadNudge(
  input: StaleThreadNudgeInput,
): Promise<StaleThreadNudgeDecision> {
  if (input.enabled !== true) {
    return { shouldNudge: false, reason: 'disabled' };
  }
  let withinBudget: boolean;
  try {
    ({ withinBudget } = await resolveBudget(input.budget));
  } catch {
    return { shouldNudge: false, reason: 'budget_check_failed' };
  }
  if (!withinBudget) {
    return { shouldNudge: false, reason: 'budget_exhausted' };
  }
  return { shouldNudge: true, reason: 'nudge' };
}
