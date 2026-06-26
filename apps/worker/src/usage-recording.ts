import {
  recordUsage as defaultRecordUsage,
  resolveIdentity,
  windowKeyFor,
  type IdentityAgentSource,
  type RecordUsageInput,
} from '@open-tag/registry';
import type { Database } from '@open-tag/storage';
import type { Logger } from 'pino';

/**
 * The usage a runtime `completed` event carries on its `TaskResult.metrics`. The
 * Claude Agent SDK and Codex SDK both surface real token counts; only Claude Code
 * surfaces a cost (Codex reports `estimatedCostUsd` 0). Missing fields normalize to
 * 0 — never `NaN` — before the additive accumulate.
 */
export interface TaskUsageMetrics {
  tokenIn?: number;
  tokenOut?: number;
  estimatedCostUsd?: number;
}

export interface RecordTaskUsageInput {
  /**
   * The agent the task ran as (the row keyed by `tasks.agentId`). It is composed
   * through {@link resolveIdentity} so the id and window this records under are the
   * EXACT id/window the ambient `checkBudget` gate composes from the same agent —
   * recording and checking always agree.
   */
  agent: IdentityAgentSource;
  /** Usage lifted from the runtime `completed` event's `TaskResult.metrics`. */
  metrics: TaskUsageMetrics;
  /**
   * ISO timestamp the usage settled at. A single boundary read taken at the worker
   * call site (`new Date().toISOString()`) — this helper never reads wall-clock, so
   * the window bucket stays deterministic for a given input.
   */
  occurredAt: string;
}

export interface RecordTaskUsageDeps {
  /** Injectable seam for tests; defaults to the registry `recordUsage`. */
  recordUsage?: (db: Database, input: RecordUsageInput) => Promise<void>;
}

/**
 * Record one completed turn's token/spend against the running identity's budget
 * window.
 *
 * Records ONLY when the composed identity declares an ENFORCED cap: an unlimited
 * identity is never gated (the `checkBudget` fast-path), so accounting it would
 * scatter rows the gate never reads. When a cap IS declared, this writes into
 * `(identity.id, budget.window, windowKey)` — the same bucket `checkBudget` sums,
 * so the window can never drift between the two sides.
 *
 * No-ops when nothing was consumed. The caller error-isolates this: the task has
 * already completed, so a failed usage-record must never fail the task.
 */
export async function recordTaskUsage(
  db: Database,
  input: RecordTaskUsageInput,
  deps: RecordTaskUsageDeps = {},
): Promise<void> {
  const identity = resolveIdentity(input.agent);
  const budget = identity.budget;
  // Unlimited identity: never gated, so never accounted. Mirror `checkBudget`'s
  // unlimited fast-path EXACTLY — no budget, OR a budget with neither cap declared —
  // so we never write rows the gate would short-circuit past.
  if (!budget || (budget.tokenCap === undefined && budget.spendCap === undefined)) return;

  const tokens = (input.metrics.tokenIn ?? 0) + (input.metrics.tokenOut ?? 0);
  const spend = input.metrics.estimatedCostUsd ?? 0;
  if (tokens <= 0 && spend <= 0) return;

  const record = deps.recordUsage ?? defaultRecordUsage;
  const period = budget.window;
  await record(db, {
    identityId: identity.id,
    period,
    windowKey: windowKeyFor(period, input.occurredAt),
    tokens,
    spend,
  });
}

export interface RecordTaskUsageBestEffortInput {
  /** The task whose runtime turn settled; used only for log context. */
  taskId: string;
  /** Acting agent id; a legacy no-agent task carries `undefined` (no-op). */
  agentId: string | undefined;
  /**
   * Usage settled for this terminal turn. `null`/`undefined` when no usage is
   * known (e.g. a failure before any token spend, or an adapter that exposes
   * nothing at the failure point) — a clean no-op, never an empty row.
   */
  metrics: TaskUsageMetrics | null | undefined;
  /** ISO timestamp the usage settled at (a single boundary clock read). */
  occurredAt: string;
}

export interface RecordTaskUsageBestEffortDeps {
  /** Load the acting agent as an {@link IdentityAgentSource} (incl. `budget`). */
  loadAgent: (agentId: string) => Promise<IdentityAgentSource | null>;
  /** Used for the non-fatal warning when recording fails. */
  logger: Pick<Logger, 'warn'>;
  /** Injectable registry recorder seam for tests; forwarded to recordTaskUsage. */
  recordUsage?: (db: Database, input: RecordUsageInput) => Promise<void>;
}

/**
 * Error-isolated, single-seam wrapper used by BOTH the worker's terminal
 * success and failure paths to charge a settled turn's token/spend against the
 * running identity's budget window.
 *
 * The runtime has already settled when this runs, so a recording failure must
 * NEVER change the task's terminal outcome — every failure mode (no agent, agent
 * gone, load error, record error) is swallowed with a warning. No-ops cleanly
 * when no usage is known, reusing {@link recordTaskUsage}'s unlimited-identity
 * and zero-usage fast-paths (so an uncapped agent or a zero-spend failure writes
 * nothing). Identity is composed by {@link recordTaskUsage} via the SAME
 * `resolveIdentity` path the admission gate checks under, so recording-id ==
 * checking-id always holds.
 */
export async function recordTaskUsageBestEffort(
  db: Database,
  input: RecordTaskUsageBestEffortInput,
  deps: RecordTaskUsageBestEffortDeps,
): Promise<void> {
  if (!input.agentId || !input.metrics) return;
  try {
    const agent = await deps.loadAgent(input.agentId);
    if (!agent) return;
    await recordTaskUsage(
      db,
      { agent, metrics: input.metrics, occurredAt: input.occurredAt },
      { recordUsage: deps.recordUsage },
    );
  } catch (err) {
    deps.logger.warn(
      { taskId: input.taskId, agentId: input.agentId, err },
      'Failed to record per-identity task usage (non-fatal)',
    );
  }
}
