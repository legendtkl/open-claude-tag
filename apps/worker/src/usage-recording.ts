import {
  recordUsage as defaultRecordUsage,
  resolveIdentity,
  windowKeyFor,
  type IdentityAgentSource,
  type RecordUsageInput,
} from '@open-tag/registry';
import type { Database } from '@open-tag/storage';

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
