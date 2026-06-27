import type {
  CrossChannelAuditSeverity,
  CrossChannelBrokerDeps,
  CrossChannelEvaluation,
  CrossChannelFlag,
  CrossChannelReason,
  CrossChannelScope,
  CrossChannelTargetDecision,
} from './types.js';

/** Audit action namespace for every per-candidate decision (mirrors `ambient.post_decision`). */
export const CROSS_CHANNEL_DECISION_ACTION = 'cross_channel.flag_decision';

/**
 * Audit action for a delivery OUTCOME correction recorded by the wiring (e.g.
 * `send_failed`). The core records the DECISION (intent) under
 * {@link CROSS_CHANNEL_DECISION_ACTION}; the wiring records the actual send
 * outcome under this action so the audit trail reflects reality when a send fails.
 */
export const CROSS_CHANNEL_DELIVERY_ACTION = 'cross_channel.flag_delivery';

/**
 * Hard cap on candidates evaluated per flag. A flag with more candidates is
 * truncated to the first N before evaluation, bounding audit/send amplification
 * (a single flag can never fan out to an unbounded number of channels). Pure and
 * deterministic — the cap is applied to the head of the injected list.
 */
export const MAX_CANDIDATES = 64;

/** The identity key for a scope — `(kind, scopeId)` is the unit of isolation. */
function scopeKey(scope: CrossChannelScope): string {
  return JSON.stringify([scope.kind, scope.scopeId]);
}

/** Two scopes identify the same channel iff BOTH the vendor and the isolation key match. */
function isSameScope(a: CrossChannelScope, b: CrossChannelScope): boolean {
  return scopeKey(a) === scopeKey(b);
}

/** Drop duplicate candidate scopes (first occurrence wins) so one target is never
 * audited/delivered twice when the caller's resolver returns it more than once. */
function dedupeScopes(candidates: ReadonlyArray<CrossChannelScope>): CrossChannelScope[] {
  const seen = new Set<string>();
  const out: CrossChannelScope[] = [];
  for (const scope of candidates) {
    const key = scopeKey(scope);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(scope);
  }
  return out;
}

/**
 * Decide deliver-or-not for ONE candidate. PURE and synchronous. Security
 * exclusions run BEFORE the allowlist so an over-broad or buggy allowlist can
 * NEVER cause a private/cross-tenant/self leak. Every branch is fail-closed.
 *
 * Order (first match wins):
 *   1. master switch off          → global_disabled
 *   2. target IS the source       → self_target            (never deliver back)
 *   3. source is private          → private_source         (no leak OUT of private)
 *   4. target is private          → private_target         (no delivery INTO private)
 *   5. cross-tenant (same-tenant) → cross_tenant
 *   6. allowlist resolver throws  → config_error           (fail-closed)
 *   7. not explicitly allowlisted → target_not_allowlisted
 *   8. otherwise                  → DELIVER (allowlisted)
 */
function decideTarget(
  flag: CrossChannelFlag,
  target: CrossChannelScope,
  deps: CrossChannelBrokerDeps,
): { deliver: boolean; reason: CrossChannelReason } {
  const decline = (reason: CrossChannelReason) => ({ deliver: false, reason });

  if (deps.globalEnabled !== true) return decline('global_disabled');
  if (isSameScope(flag.sourceScope, target)) return decline('self_target');
  if (flag.sourceScope.isPrivate) return decline('private_source');
  if (target.isPrivate) return decline('private_target');

  const sameTenantOnly = deps.sameTenantOnly !== false; // default true
  if (sameTenantOnly && flag.sourceScope.installationId !== target.installationId) {
    return decline('cross_tenant');
  }

  let allowed: boolean;
  try {
    allowed = deps.resolveDelivery(flag.sourceScope, target) === true;
  } catch {
    return decline('config_error'); // fail-closed on a broken allowlist
  }
  if (!allowed) return decline('target_not_allowlisted');

  return { deliver: true, reason: 'allowlisted' };
}

/** Map a decision to an audit severity — blocked leaks/misconfig are queryable at WARN. */
function auditSeverityFor(deliver: boolean, reason: CrossChannelReason): CrossChannelAuditSeverity {
  if (deliver) return 'info';
  switch (reason) {
    case 'private_source':
    case 'private_target':
    case 'cross_tenant':
    case 'config_error':
    case 'audit_failed':
      return 'warn';
    default:
      return 'info';
  }
}

/**
 * Build the audit detail for one decision. The raw `summary` is NEVER stored
 * (only its length). `raisedBy`/`sourceRef` are included ONLY on an approved,
 * same-tenant, non-private delivery — they are dropped from every decline so a
 * blocked flag cannot leak raiser ids or message/doc refs through the audit table.
 * Scope keys (kind/scopeId/installationId/isPrivate) ARE recorded so the audit can
 * name WHICH leak was blocked (operationally essential; the `/api/audit` read
 * surface is admin/owner + loopback-gated).
 */
function buildAuditDetail(
  flag: CrossChannelFlag,
  target: CrossChannelScope,
  deliver: boolean,
  reason: CrossChannelReason,
): Record<string, unknown> {
  const detail: Record<string, unknown> = {
    outcome: deliver ? 'delivered' : 'declined',
    reason,
    sourceKind: flag.sourceScope.kind,
    sourceScopeId: flag.sourceScope.scopeId,
    sourceInstallationId: flag.sourceScope.installationId,
    sourcePrivate: flag.sourceScope.isPrivate,
    targetKind: target.kind,
    targetScopeId: target.scopeId,
    targetInstallationId: target.installationId,
    targetPrivate: target.isPrivate,
    flagSeverity: flag.severity ?? null,
    summaryLength: flag.summary.length,
  };
  if (deliver) {
    // Only an approved (same-tenant, non-private) delivery enriches with the
    // raiser/source ref; never a decline.
    detail.raisedBy = flag.raisedBy ?? null;
    detail.sourceRef = flag.sourceRef ?? null;
  }
  return detail;
}

/**
 * The cross-channel flag broker (DESIGN Stage 5). For each injected candidate
 * target scope it decides deliver-or-not via the two-layer default-OFF gate
 * (global master switch ∧ per-(source,target) allowlist) with hard, fail-closed
 * security exclusions (self / private-source / private-target / cross-tenant) that
 * always beat the allowlist. EVERY decision — deliver AND decline — is recorded
 * through the injected audit sink.
 *
 * Pure in the dependency-injection sense: it performs no DB/network/wall-clock I/O
 * itself; the audit sink and allowlist are injected. The core never enumerates
 * channels — candidates are supplied by the (trusted) caller (see the trust-
 * boundary note in {@link CrossChannelScope}).
 *
 * AUDIT-FAIL-CLOSED-ON-DELIVERY: if recording an APPROVED delivery throws, that
 * target is downgraded to NOT delivered (`audit_failed`) — an unaudited
 * cross-channel delivery would violate the audited invariant, so it is suppressed.
 * A decline whose audit write fails is best-effort (no delivery happens anyway).
 *
 * Candidates are de-duplicated by `(kind, scopeId)` and then clamped to
 * {@link MAX_CANDIDATES} to bound amplification (one target is never audited or
 * delivered twice for a single flag).
 */
export async function evaluateCrossChannelFlag(
  flag: CrossChannelFlag,
  candidates: ReadonlyArray<CrossChannelScope>,
  deps: CrossChannelBrokerDeps,
): Promise<CrossChannelEvaluation> {
  const decisions: CrossChannelTargetDecision[] = [];
  const delivered: CrossChannelScope[] = [];

  // Dedupe BEFORE clamping so the cap counts distinct targets, and one target is
  // never audited/delivered twice for a single flag.
  const bounded = dedupeScopes(candidates).slice(0, MAX_CANDIDATES);
  for (const target of bounded) {
    let { deliver, reason } = decideTarget(flag, target, deps);

    let audited = true;
    try {
      await deps.audit.record(
        // System actor: audit_events.actor_id is a NULLABLE uuid FK to users.id;
        // the (non-human) broker decision records a null actor. The raiser lives
        // in `detail` (delivered only), never as actorId.
        null,
        CROSS_CHANNEL_DECISION_ACTION,
        'channel',
        target.scopeId,
        buildAuditDetail(flag, target, deliver, reason),
        auditSeverityFor(deliver, reason),
      );
    } catch {
      audited = false;
    }

    // Fail-closed: never deliver something we could not audit.
    if (deliver && !audited) {
      deliver = false;
      reason = 'audit_failed';
    }

    decisions.push({ target, deliver, reason });
    if (deliver) delivered.push(target);
  }

  return { decisions, delivered };
}
