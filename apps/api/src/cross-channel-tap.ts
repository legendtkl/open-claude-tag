import {
  evaluateCrossChannelFlag,
  renderCrossChannelFlag,
  CROSS_CHANNEL_DELIVERY_ACTION,
  type CrossChannelAuditSeverity,
  type CrossChannelAuditSink,
  type CrossChannelDeliveryResolver,
  type CrossChannelFlag,
  type CrossChannelScope,
} from '@open-tag/cross-channel';
import { AuditSeverity } from '@open-tag/core-types';
import type { ConversationRef } from '@open-tag/channel-core';
import { createLogger } from '@open-tag/observability';
import {
  resolveChannelSender,
  type ChannelSenderResolutionContext,
} from './channel-sender-resolver.js';

const logger = createLogger('cross-channel-tap');

/**
 * The IO edge for the cross-channel flag broker (Stage 5), mirroring
 * `ambient-tap.ts`. The pure core (`@open-tag/cross-channel`) owns the audited,
 * fail-closed, `isPrivate`-/cross-tenant-/self-excluded decision; this edge
 * supplies the trusted candidate scopes and delivers each approved flag to its
 * target channel via {@link resolveChannelSender}.
 *
 * INVOCABLE BUT INERT by default. This is NOT wired into the always-on inbound
 * pipeline — calling it with the master switch off is a COMPLETE no-op (no
 * candidate resolution, no audit, no send). "What raises a flag" is a documented
 * follow-up seam: a future raiser calls {@link brokerCrossChannelFlag} with a
 * flag built from TRUSTED channel metadata.
 *
 * TRUST BOUNDARY (load-bearing): `flag.sourceScope` and every scope returned by
 * {@link CrossChannelTapDeps.resolveCandidates} MUST be constructed from trusted
 * channel metadata (the channel registry / `Channel.resolveScope`), NEVER from
 * user-controlled event fields — a spoofed `isPrivate`/`installationId` would
 * defeat the broker's exclusions. The pure core trusts its injected scopes by
 * contract, exactly as `evaluateAmbientPost` trusts its adapted `AmbientInbound`.
 *
 * LOOP PREVENTION: the broker's `self_target` exclusion drops the source scope,
 * and every delivered message carries the `[cross-channel]` marker. Any future
 * live raiser MUST additionally skip bot/app-authored messages (mirrors
 * `tapAmbient`'s `senderType === 'app'` skip) so a delivered flag — posted by the
 * bot — can never re-raise a flag.
 */

/** The minimal API-side audit sink (uses the `AuditSeverity` enum). `AuditService` satisfies it. */
export interface ApiAuditSink {
  record(
    actorId: string | null,
    action: string,
    targetType?: string,
    targetId?: string,
    detail?: Record<string, unknown>,
    severity?: AuditSeverity,
  ): Promise<void>;
}

/** Resolve eligible candidate target scopes for a flag (trusted — see file doc). */
export type ResolveCrossChannelCandidates = (
  flag: CrossChannelFlag,
) => Promise<CrossChannelScope[]>;

/** Deliver the rendered flag text to one approved target. */
export type CrossChannelDelivery = (target: CrossChannelScope, text: string) => Promise<void>;

export interface CrossChannelTapDeps {
  /** The global master switch — `OPEN_TAG_CROSS_CHANNEL_ENABLED`. Off ⇒ complete no-op. */
  globalEnabled: boolean;
  /** Enumerate trusted candidate target scopes for the flag. */
  resolveCandidates: ResolveCrossChannelCandidates;
  /** Per-(source,target) allowlist (the second opt-in layer). */
  resolveDelivery: CrossChannelDeliveryResolver;
  /** API audit sink (adapted to the core's string-severity sink internally). */
  audit: ApiAuditSink;
  /** Deliver an approved flag to its target channel. */
  deliver: CrossChannelDelivery;
  /** Same-tenant only (default true). See the broker. */
  sameTenantOnly?: boolean;
}

const CROSS_CHANNEL_SEVERITY_MAP: Record<CrossChannelAuditSeverity, AuditSeverity> = {
  info: AuditSeverity.INFO,
  warn: AuditSeverity.WARN,
  critical: AuditSeverity.CRITICAL,
};

/**
 * Adapt an API {@link ApiAuditSink} (which uses the `AuditSeverity` enum) into the
 * core's {@link CrossChannelAuditSink} (which uses a string-literal severity).
 * Keeps `@open-tag/cross-channel` free of an `@open-tag/core-types` dependency.
 */
export function adaptCrossChannelAuditSink(audit: ApiAuditSink): CrossChannelAuditSink {
  return {
    record: (actorId, action, targetType, targetId, detail, severity) =>
      audit.record(
        actorId,
        action,
        targetType,
        targetId,
        detail,
        severity ? CROSS_CHANNEL_SEVERITY_MAP[severity] : undefined,
      ),
  };
}

/**
 * Build the production delivery function: resolve the target channel's sender by
 * its neutral {@link CrossChannelScope.kind} and send a neutral `text`
 * `OutboundMessage`. No new core→vendor coupling — `resolveChannelSender` lives in
 * the API composition root.
 */
export function buildChannelSenderDelivery(ctx: ChannelSenderResolutionContext): CrossChannelDelivery {
  return async (target, text) => {
    const sender = resolveChannelSender(target.kind, ctx);
    const to: ConversationRef = { kind: target.kind, scopeId: target.scopeId };
    await sender.send(to, { kind: 'text', markdown: text });
  };
}

/**
 * Broker one cross-channel flag: resolve trusted candidates, evaluate the audited
 * fail-closed gate, and deliver every approved flag. Non-throwing — a candidate
 * resolution failure or a per-target send failure is isolated and logged (a send
 * failure is also audited as `send_failed`, so the audit trail reflects reality).
 */
export async function brokerCrossChannelFlag(
  deps: CrossChannelTapDeps,
  flag: CrossChannelFlag,
): Promise<void> {
  // Gate 0 — complete no-op when the master switch is off: no candidate resolve,
  // no audit, no send. Mirrors tapAmbient's synchronous default-off gate.
  if (!deps.globalEnabled) return;

  let candidates: CrossChannelScope[];
  try {
    candidates = await deps.resolveCandidates(flag);
  } catch (err) {
    logger.warn({ err, sourceScopeId: flag.sourceScope.scopeId }, 'Cross-channel candidate resolution failed (isolated)');
    return;
  }
  if (candidates.length === 0) return;

  const audit = adaptCrossChannelAuditSink(deps.audit);
  const evaluation = await evaluateCrossChannelFlag(flag, candidates, {
    globalEnabled: deps.globalEnabled,
    resolveDelivery: deps.resolveDelivery,
    audit,
    sameTenantOnly: deps.sameTenantOnly,
  });

  if (evaluation.delivered.length === 0) return;

  const text = renderCrossChannelFlag(flag);
  for (const target of evaluation.delivered) {
    try {
      await deps.deliver(target, text);
    } catch (err) {
      logger.warn(
        { err, targetKind: target.kind, targetScopeId: target.scopeId },
        'Cross-channel flag delivery failed (isolated)',
      );
      // Correct the audit trail: the decision audited `delivered`, but the send
      // failed. Best-effort — a failed correction write must not escape.
      await deps.audit
        .record(
          null,
          CROSS_CHANNEL_DELIVERY_ACTION,
          'channel',
          target.scopeId,
          {
            outcome: 'send_failed',
            sourceKind: flag.sourceScope.kind,
            sourceScopeId: flag.sourceScope.scopeId,
            targetKind: target.kind,
            targetScopeId: target.scopeId,
          },
          AuditSeverity.WARN,
        )
        .catch((auditErr) => {
          logger.warn({ err: auditErr, targetScopeId: target.scopeId }, 'Cross-channel send_failed audit failed (isolated)');
        });
    }
  }
}
