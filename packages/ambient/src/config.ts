/**
 * Per-channel ambient-posting configuration. DEFAULT OFF: ambient posting is
 * opt-in (DESIGN principle #10 / decision (f)). Only an explicit enable flips it
 * on — an absent or partial config NEVER posts.
 *
 * Sources (the caller resolves these into this shape):
 *  - `globalEnabled` ← the global `OPEN_TAG_AMBIENT` env flag (absent ⇒ off;
 *    parse via {@link parseAmbientFlag}).
 *  - `channelEnabled` ← a future per-channel `chatConfigs` flag (absent ⇒ inherit
 *    the global default; an explicit `false` hard-disables even when global is on).
 *
 * Note: this gates only proactive *posting*. Memory-*following* is always-on and
 * is NOT gated by this config.
 */
export interface AmbientConfig {
  globalEnabled?: boolean;
  channelEnabled?: boolean;
}

/**
 * Resolve whether ambient posting is enabled for a channel. Fail-closed: every
 * path that is not an explicit enable returns `false`.
 *  - no config             ⇒ false  (default OFF)
 *  - `channelEnabled: true`  ⇒ true   (explicit per-channel opt-in)
 *  - `channelEnabled: false` ⇒ false  (explicit per-channel opt-out beats global)
 *  - `channelEnabled` unset  ⇒ `globalEnabled === true` (else false)
 */
export function isAmbientEnabled(config?: AmbientConfig | null): boolean {
  if (!config) return false;
  if (config.channelEnabled === true) return true;
  if (config.channelEnabled === false) return false;
  return config.globalEnabled === true;
}

/**
 * Parse the `OPEN_TAG_AMBIENT` env string into the `globalEnabled` boolean. Pure
 * — takes the raw value, not `process.env`. Default OFF: only `1`/`true`/`on`/`yes`
 * (case-insensitive, trimmed) enable; everything else — including `undefined` —
 * is off.
 */
export function parseAmbientFlag(raw?: string | null): boolean {
  if (raw == null) return false;
  return ['1', 'true', 'on', 'yes'].includes(raw.trim().toLowerCase());
}
