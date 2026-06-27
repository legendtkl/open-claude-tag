/**
 * Cross-channel broker configuration. DEFAULT OFF: brokered cross-channel
 * flagging is opt-in. The master switch is the global
 * `OPEN_TAG_CROSS_CHANNEL_ENABLED` env flag (layer 1); the per-(source,target)
 * allowlist is the second layer (injected — see {@link CrossChannelBrokerDeps}).
 * An absent or false flag NEVER delivers.
 */

export interface CrossChannelConfig {
  /** ← the global `OPEN_TAG_CROSS_CHANNEL_ENABLED` flag; absent ⇒ off. */
  globalEnabled?: boolean;
}

/**
 * Resolve whether the cross-channel feature's master switch is on. Fail-closed:
 * only an explicit `globalEnabled === true` enables; everything else is OFF.
 */
export function isCrossChannelEnabled(config?: CrossChannelConfig | null): boolean {
  return config?.globalEnabled === true;
}

/**
 * Parse the `OPEN_TAG_CROSS_CHANNEL_ENABLED` env string into a boolean. Pure —
 * takes the raw value, not `process.env`. Default OFF: only `1`/`true`/`on`/`yes`
 * (case-insensitive, trimmed) enable; everything else — including `undefined` — is
 * off. Same semantics as `@open-tag/ambient`'s `parseAmbientFlag`.
 */
export function parseCrossChannelFlag(raw?: string | null): boolean {
  if (raw == null) return false;
  return ['1', 'true', 'on', 'yes'].includes(raw.trim().toLowerCase());
}
