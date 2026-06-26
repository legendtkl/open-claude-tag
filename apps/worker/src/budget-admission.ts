import {
  checkBudget as defaultCheckBudget,
  resolveIdentity,
  windowKeyFor,
  type BudgetCheckResult,
  type CheckBudgetInput,
  type IdentityAgentSource,
  type IdentityBudgetWindow,
} from '@open-tag/registry';
import type { Database } from '@open-tag/storage';
import type { Logger } from 'pino';

/**
 * Per-identity budget enforcement at the worker's task-admission boundary.
 *
 * This is the ADDRESSED-task counterpart of the ambient proactive-post gate: it
 * blocks a regular task from starting the runtime when the running identity has
 * already exhausted its declared cap. It reuses the registry `checkBudget`
 * mechanism over the SAME identity (`resolveIdentity`) that
 * {@link recordTaskUsage} records under, so the checking-id and recording-id can
 * never drift.
 *
 * Semantics — "do NOT start when already exhausted", NOT strict reservation.
 * `checkBudget` compares the CURRENT aggregate window usage against the cap and
 * blocks only once `used >= cap`. Usage is written after each turn COMPLETES
 * (see {@link recordTaskUsage}), so several concurrently-admitted tasks may all
 * pass while headroom is positive and then collectively overshoot the cap. This
 * matches the existing record-on-completion model and is intentional: the gate
 * is an admission stop for an already-over-budget identity, not a token reserve.
 */

/** Audit action for a confirmed budget-exhaustion admission block (≤64 chars). */
export const BUDGET_ADMISSION_BLOCKED_AUDIT_ACTION = 'budget.task_admission_blocked';

/**
 * Thrown at the task-admission seam when the running identity's budget cap is
 * genuinely exhausted (fail-CLOSED). A plain {@link Error} subclass so the
 * worker's terminal-failure catch finalizes the task EXACTLY like every other
 * failure — mirroring the existing `RemoteDispatchError` fail-fast precedent
 * (terminal FAILED transition + channel failure card + delegation/contract
 * finalization + admission-slot release).
 */
export class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BudgetExceededError';
  }
}

/** The verdict of {@link evaluateTaskAdmissionBudget}. */
export interface TaskAdmissionBudgetDecision {
  /** False ⇒ a declared cap is at/over its limit for the current window. */
  allowed: boolean;
  /** The composed identity id the verdict was computed for (== recording id). */
  identityId: string;
  /** Window family the cap is declared over; absent on the uncapped fast-path. */
  window?: IdentityBudgetWindow;
  /** The evaluated bucket label; absent on the uncapped fast-path. */
  windowKey?: string;
  /** Headroom against each declared cap (may be negative once exceeded). */
  remaining?: BudgetCheckResult['remaining'];
}

export interface EvaluateTaskAdmissionBudgetInput {
  /**
   * The agent the task runs as. Composed through {@link resolveIdentity} — the
   * SAME path {@link recordTaskUsage} uses — so checking and recording always
   * agree on id and window.
   */
  agent: IdentityAgentSource;
  /**
   * ISO timestamp the admission decision is taken at; the only clock input. The
   * window bucket is derived from it via `windowKeyFor`, never wall-clock here.
   */
  occurredAt: string;
}

export interface EvaluateTaskAdmissionBudgetDeps {
  /** Injectable seam for tests; defaults to the registry `checkBudget`. */
  checkBudget?: (db: Database, input: CheckBudgetInput) => Promise<BudgetCheckResult>;
}

/**
 * Evaluate the running identity's declared budget for the admission window.
 *
 * Unlimited fast-path: an identity with no budget — or a budget with neither cap
 * declared — is ALLOWED without touching the DB (mirrors `checkBudget` /
 * {@link recordTaskUsage} exactly), so the default uncapped agent pays zero
 * usage-table cost. Otherwise the matching window bucket is summed and compared
 * against the cap; `allowed` is the registry verdict's `withinBudget`.
 */
export async function evaluateTaskAdmissionBudget(
  db: Database,
  input: EvaluateTaskAdmissionBudgetInput,
  deps: EvaluateTaskAdmissionBudgetDeps = {},
): Promise<TaskAdmissionBudgetDecision> {
  const identity = resolveIdentity(input.agent);
  const budget = identity.budget;

  // Unlimited: no budget, or a budget with neither cap declared. Never gated, so
  // never queried — short-circuit before any DB read.
  if (!budget || (budget.tokenCap === undefined && budget.spendCap === undefined)) {
    return { allowed: true, identityId: identity.id };
  }

  const windowKey = windowKeyFor(budget.window, input.occurredAt);
  const check = deps.checkBudget ?? defaultCheckBudget;
  const result = await check(db, { identity, windowKey });
  return {
    allowed: result.withinBudget,
    identityId: identity.id,
    window: budget.window,
    windowKey,
    remaining: result.remaining,
  };
}

/**
 * Build the channel-visible, user-friendly over-budget message.
 *
 * Deliberately avoids the substrings `isQuotaExceededError` matches
 * (`/usage.?limit/i`, `/quota.?exceeded/i`) so the worker's failure path renders
 * the standard failure card, not the Codex-specific quota notice.
 */
export function buildOverBudgetMessage(decision: TaskAdmissionBudgetDecision): string {
  const windowLabel = decision.window === 'month' ? 'monthly' : 'daily';
  return [
    `This agent has reached its configured ${windowLabel} budget cap, so this task was not started.`,
    'New tasks will resume automatically once the budget window resets.',
  ].join(' ');
}

export interface BudgetAdmissionBlockAuditInput {
  taskId: string;
  agentId: string;
  decision: TaskAdmissionBudgetDecision;
}

export interface EnforceTaskAdmissionBudgetInput {
  taskId: string;
  /** The task's acting agent id; a legacy no-agent task carries `undefined`. */
  agentId: string | undefined;
  /** ISO timestamp of the admission decision (single boundary clock read). */
  occurredAt: string;
}

export interface EnforceTaskAdmissionBudgetDeps extends EvaluateTaskAdmissionBudgetDeps {
  /** Load the acting agent as an {@link IdentityAgentSource} (incl. the `budget`). */
  loadAgent: (agentId: string) => Promise<IdentityAgentSource | null>;
  /** Persist the block decision to the audit trail (best-effort). */
  recordBlockAudit: (input: BudgetAdmissionBlockAuditInput) => Promise<void>;
  /**
   * Delete the task's durable `admission_leases` row, if any. Called on a
   * confirmed block BEFORE throwing so a delegated / discussion task blocked at
   * admission does not strand a lease (the rescheduler would otherwise only
   * reap it indirectly). Safe to call when no lease exists (0-row delete).
   */
  deleteLease: (taskId: string) => Promise<void>;
  logger: Logger;
}

/**
 * Enforce the running identity's budget cap at the task-admission boundary.
 *
 * - No agent, agent gone, or no declared cap → return (ALLOW); the task proceeds.
 * - Resolution / DB error → swallow + return (ALLOW = fail-OPEN). A DB blip must
 *   never block legitimate, user-requested work. This DELIBERATELY diverges from
 *   the ambient gate (which fails CLOSED on a `checkBudget` DB error to avoid
 *   spending on a courtesy reply): an addressed task is explicitly requested, so
 *   the safe failure mode is to allow, not block.
 * - Cap genuinely exhausted → delete any durable lease, write a block audit
 *   (best-effort), then THROW {@link BudgetExceededError} (fail-CLOSED) so the
 *   worker's shared terminal-failure path delivers the message and marks the
 *   task failed without the runtime ever running.
 */
export async function enforceTaskAdmissionBudget(
  db: Database,
  input: EnforceTaskAdmissionBudgetInput,
  deps: EnforceTaskAdmissionBudgetDeps,
): Promise<void> {
  if (!input.agentId) return;

  let decision: TaskAdmissionBudgetDecision;
  try {
    const agent = await deps.loadAgent(input.agentId);
    if (!agent) return; // agent gone: no identity/cap to enforce.
    decision = await evaluateTaskAdmissionBudget(
      db,
      { agent, occurredAt: input.occurredAt },
      deps,
    );
  } catch (err) {
    // FAIL-OPEN: a resolution/DB error never blocks an addressed task.
    deps.logger.warn(
      { taskId: input.taskId, agentId: input.agentId, err },
      'Budget admission check failed; allowing task (fail-open)',
    );
    return;
  }

  if (decision.allowed) return;

  // FAIL-CLOSED: cap genuinely exhausted. Clean up the durable lease first so a
  // delegated/discussion task is not stranded, then audit (best-effort), then
  // throw to route into the shared terminal-failure finalization.
  try {
    await deps.deleteLease(input.taskId);
  } catch (leaseErr) {
    deps.logger.warn(
      { taskId: input.taskId, agentId: input.agentId, leaseErr },
      'Failed to delete admission lease for budget-blocked task (non-fatal)',
    );
  }
  try {
    await deps.recordBlockAudit({
      taskId: input.taskId,
      agentId: input.agentId,
      decision,
    });
  } catch (auditErr) {
    deps.logger.warn(
      { taskId: input.taskId, agentId: input.agentId, auditErr },
      'Failed to record budget admission block audit (non-fatal)',
    );
  }
  deps.logger.warn(
    {
      taskId: input.taskId,
      agentId: input.agentId,
      identityId: decision.identityId,
      window: decision.window,
      windowKey: decision.windowKey,
      remaining: decision.remaining,
    },
    'Task blocked at admission: identity budget exhausted',
  );
  throw new BudgetExceededError(buildOverBudgetMessage(decision));
}
