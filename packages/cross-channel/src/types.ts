/**
 * Cross-channel flag broker contracts (DESIGN Stage 5: "brokered cross-channel
 * flag — audited, `isPrivate`-excluded"). A "flag" is a signal raised in one
 * SOURCE channel that MAY be surfaced to OTHER channels — but only through this
 * controlled broker, which is opt-in, audited, and fail-closed against leaks.
 *
 * The broker core is pure: it never queries channels. The caller injects the
 * candidate target scopes and the decision dependencies, so the security logic is
 * fully deterministic and unit-testable. Mirrors `@open-tag/ambient`'s shape.
 *
 * TRUST BOUNDARY (load-bearing): every {@link CrossChannelScope} the core sees —
 * the flag's `sourceScope` AND every candidate — MUST be constructed by the
 * caller from TRUSTED channel metadata (the channel registry /
 * `Channel.resolveScope`), NEVER from user-controlled event fields. The pure core
 * trusts its injected scopes by contract (exactly as `evaluateAmbientPost` trusts
 * its injected `AmbientInbound`, which the gateway adapts from a trusted
 * `NormalizedEvent`). A spoofed `isPrivate`/`installationId` would defeat the
 * exclusions, so canonicalizing scopes is the wiring's responsibility.
 */

/**
 * A `ChannelScope`-shaped key. Declared structurally so `@open-tag/cross-channel`
 * stays dependency-free of `@open-tag/channel-core` — exactly as
 * `@open-tag/memory`'s `ChannelMemoryScope` does. A full `ChannelScope` is
 * assignable to this by TypeScript's structural typing.
 */
export interface CrossChannelScope {
  /** The channel vendor (e.g. `lark`). Half of the isolation identity. */
  kind: string;
  /** The channel isolation key (`ChannelScope.scopeId`) — the unit of isolation. */
  scopeId: string;
  /** Tenant/workspace (`ChannelScope.installationId`): Slack team, Lark tenant, Discord guild. */
  installationId: string;
  /**
   * Whether this scope is private. A private scope's signals are NEVER surfaced
   * out (source), and a flag is NEVER delivered into one (target). See
   * {@link decideTarget}. MUST come from trusted channel metadata (see file doc).
   */
  isPrivate: boolean;
}

/** Caller-provided severity hint carried with the flag (distinct from audit severity). */
export type FlagSeverity = 'info' | 'warning' | 'critical';

/**
 * A signal raised in a SOURCE channel that the broker MAY surface to other
 * channels. The `summary` is human/agent-authored content; it is delivered to
 * approved targets but is NEVER stored in the audit detail (only its length) so a
 * declined private-source flag cannot leak its content through the audit table.
 */
export interface CrossChannelFlag {
  /** The channel the signal originated in (trusted scope — see file doc). */
  sourceScope: CrossChannelScope;
  /** Short summary of what is worth surfacing. Delivered; never audited verbatim. */
  summary: string;
  /** Optional severity hint. */
  severity?: FlagSeverity;
  /**
   * Optional opaque id of who/what raised the flag. Audited ONLY on an approved
   * (same-tenant, non-private) delivery — dropped from decline audit rows so it
   * cannot become a cross-channel breadcrumb.
   */
  raisedBy?: string;
  /**
   * Optional source message/observation ref. Like {@link raisedBy}, audited ONLY
   * on an approved delivery (it may embed a private channel's message/doc id).
   */
  sourceRef?: string;
}

/** The string severities the injected audit sink accepts — values match `AuditSeverity`. */
export type CrossChannelAuditSeverity = 'info' | 'warn' | 'critical';

/**
 * Minimal injected audit sink. `@open-tag/approval`'s `AuditService` satisfies
 * this once the wiring maps {@link CrossChannelAuditSeverity} to the
 * `AuditSeverity` enum (same string values). Declared narrowly so the core stays
 * dependency-free and tests can pass a spy without a real DB.
 */
export interface CrossChannelAuditSink {
  record(
    actorId: string | null,
    action: string,
    targetType?: string,
    targetId?: string,
    detail?: Record<string, unknown>,
    severity?: CrossChannelAuditSeverity,
  ): Promise<void>;
}

/**
 * The per-(source,target) allowlist resolver — the second of the two opt-in
 * layers. SCOPE-ONLY by design: it receives the trusted source and target scopes,
 * never the flag content, so config/logging code never sees `summary`/`sourceRef`.
 * Fail-closed: anything but an explicit `true` is treated as NOT allowed, and a
 * thrown resolver is treated as a config error (see {@link decideTarget}).
 */
export type CrossChannelDeliveryResolver = (
  sourceScope: CrossChannelScope,
  target: CrossChannelScope,
) => boolean;

export interface CrossChannelBrokerDeps {
  /**
   * The global master switch (layer 1). Fail-closed: anything but `true` ⇒ every
   * candidate declines `global_disabled`. The WIRING additionally short-circuits
   * BEFORE calling the core when this is false, so a disabled feature is a
   * complete no-op (no audit, no work) — see the cross-channel tap.
   */
  globalEnabled: boolean;
  /** The per-(source,target) allowlist (layer 2). See {@link CrossChannelDeliveryResolver}. */
  resolveDelivery: CrossChannelDeliveryResolver;
  /** Injected audit sink. EVERY decision (deliver and decline) is recorded. */
  audit: CrossChannelAuditSink;
  /**
   * Same-tenant only (default `true`). When `true`, a target in a different
   * `installationId` than the source is declined `cross_tenant`. Set `false` only
   * for an explicitly cross-tenant deployment; the private exclusions ALWAYS win
   * regardless of this flag.
   */
  sameTenantOnly?: boolean;
}

/** Why a single candidate was delivered to or declined — the precise gate name. */
export type CrossChannelReason =
  | 'allowlisted' // delivered: all gates passed
  | 'global_disabled' // declined: master switch off
  | 'self_target' // declined: target IS the source scope
  | 'private_source' // declined: source is private (signal must not leak out)
  | 'private_target' // declined: target is private (never deliver in)
  | 'cross_tenant' // declined: different tenant and same-tenant-only
  | 'config_error' // declined: the allowlist resolver threw (fail-closed)
  | 'target_not_allowlisted' // declined: not explicitly allowlisted
  | 'audit_failed'; // declined: an approved delivery could not be audited

/** The per-candidate decision the broker emits and audits. */
export interface CrossChannelTargetDecision {
  target: CrossChannelScope;
  deliver: boolean;
  reason: CrossChannelReason;
}

/** The result of evaluating one flag against a candidate set. */
export interface CrossChannelEvaluation {
  /** Every per-candidate decision (delivered AND declined), in candidate order. */
  decisions: CrossChannelTargetDecision[];
  /** Convenience projection: just the candidates approved for delivery. */
  delivered: CrossChannelScope[];
}
