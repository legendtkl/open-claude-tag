import type { CrossChannelFlag } from './types.js';

/**
 * A stable, neutral marker prefixed onto every delivered cross-channel flag. It
 * makes a delivered flag identifiable so a future flag-raising trigger can SKIP
 * cross-channel deliveries (loop prevention, defense-in-depth alongside the
 * broker's `self_target` exclusion and the bot/app-sender skip the trigger must
 * apply — mirrors `tapAmbient`'s `senderType === 'app'` skip).
 */
export const CROSS_CHANNEL_MARKER = '[cross-channel]';

/**
 * Neutralize untrusted flag content before it is rendered into a channel message.
 * The `summary` is human/agent-authored, so it is the highest prompt-injection
 * risk in this path. Mirrors `@open-tag/memory`'s `sanitizeGistForPrompt`:
 *  - collapse whitespace / newlines to a single line (no injected headings/blocks);
 *  - break `</…>` so it cannot close a wrapper element.
 */
function sanitizeSummary(summary: string): string {
  return summary.replace(/\s+/g, ' ').trim().replace(/<\//g, '< /');
}

/**
 * Render a cross-channel flag as the neutral text body delivered to an approved
 * target. Pure. Carries the {@link CROSS_CHANNEL_MARKER} and a sanitized summary;
 * a severity, when present, is surfaced as a short prefix.
 */
export function renderCrossChannelFlag(flag: CrossChannelFlag): string {
  const safe = sanitizeSummary(flag.summary);
  const severity = flag.severity ? ` (${flag.severity})` : '';
  return `${CROSS_CHANNEL_MARKER}${severity} ${safe}`.trim();
}
