/**
 * Slack Events API handler core — a pure, transport-agnostic decision function.
 * Given an ALREADY-signature-verified, parsed request body, it returns a typed
 * {@link SlackEventOutcome} the HTTP transport acts on. It performs no IO and
 * holds no socket, so it is fully unit-testable with fixtures.
 *
 * It deliberately does NOT verify the signature itself: verification runs on the
 * raw bytes in the transport BEFORE the body is parsed and handed here, so even
 * the `url_verification` challenge echo sits behind authentication (no open echo).
 */
import type { InboundMessage } from '@open-tag/channel-core';

/** The slice of {@link Channel} the handler needs: just inbound normalization. */
export interface SlackEventNormalizer {
  normalize(raw: unknown): InboundMessage | null;
}

/** App-lifecycle events that retire a workspace's bot token (Milestone 1b). */
export type SlackLifecycleKind = 'app_uninstalled' | 'tokens_revoked';

export type SlackEventOutcome =
  /** Slack endpoint handshake — echo `challenge` back in the 200 body. */
  | { type: 'url_verification'; challenge: string }
  /** A normalized human message the transport should dispatch (then ack 200). */
  | { type: 'dispatch'; message: InboundMessage; retryNum?: number }
  /**
   * The Slack app was uninstalled (or its BOT token revoked) for a workspace; the
   * transport should disable that team's installation, then ack 200 (ADR-0014).
   */
  | {
      type: 'lifecycle';
      lifecycle: SlackLifecycleKind;
      teamId: string;
      /**
       * Envelope `event_time` (epoch ms). Slack does NOT guarantee lifecycle
       * ordering, so a stale `app_uninstalled` can arrive AFTER a re-install; the
       * transport uses this to skip disabling a row that was re-written later.
       */
      eventTimeMs?: number;
    }
  /** Nothing to do (handshake-less non-message, bot/subtype, unknown type). Ack 200. */
  | { type: 'ignore'; reason: string };

export interface HandleSlackEventInput {
  /** The parsed JSON request body (already validated by the transport's parser). */
  parsed: unknown;
  /** Channel adapter providing `normalize` (e.g. a `SlackChannel`). */
  channel: SlackEventNormalizer;
  /** `X-Slack-Retry-Num`, surfaced so the transport/dispatch can de-dupe retries. */
  retryNum?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Decide what to do with a verified Slack Events API request.
 *
 * - `url_verification` → echo the challenge (the endpoint handshake).
 * - `event_callback` with `app_uninstalled` / bot-token `tokens_revoked` → a
 *   `lifecycle` outcome so the transport disables that team's installation.
 * - `event_callback` (other) → `normalize`; a parseable human message dispatches,
 *   while a bot/subtype/non-message (normalize → null) is ignored.
 * - anything else → ignored.
 */
export function handleSlackEvent(input: HandleSlackEventInput): SlackEventOutcome {
  const { parsed, channel, retryNum } = input;
  if (!isRecord(parsed)) {
    return { type: 'ignore', reason: 'non_object_payload' };
  }

  const type = typeof parsed.type === 'string' ? parsed.type : undefined;

  if (type === 'url_verification') {
    const challenge = parsed.challenge;
    if (typeof challenge !== 'string' || challenge.length === 0) {
      return { type: 'ignore', reason: 'missing_challenge' };
    }
    return { type: 'url_verification', challenge };
  }

  if (type === 'event_callback') {
    const lifecycle = lifecycleOutcome(parsed);
    if (lifecycle) return lifecycle;

    const message = channel.normalize(parsed);
    if (!message) {
      return { type: 'ignore', reason: 'non_dispatchable_event' };
    }
    return { type: 'dispatch', message, ...(retryNum !== undefined ? { retryNum } : {}) };
  }

  return { type: 'ignore', reason: `unsupported_type:${type ?? 'unknown'}` };
}

/**
 * Recognize the two app-lifecycle events that retire a workspace's bot token.
 *
 * `app_uninstalled` always retires the install. `tokens_revoked` carries a
 * `tokens: { oauth: string[]; bot: string[] }` split — `oauth` lists user-token
 * owners, `bot` lists bot-token owners. We disable ONLY when the BOT token was
 * revoked (`tokens.bot` non-empty); an oauth-only (user-token) revocation must
 * NOT take down the workspace's bot install (Codex M1b design gate). Returns
 * `null` for any other event (so the caller falls through to `normalize`), or
 * when the `team_id` is missing (nothing to key the disable on).
 */
function lifecycleOutcome(parsed: Record<string, unknown>): SlackEventOutcome | null {
  const event = isRecord(parsed.event) ? parsed.event : undefined;
  const eventType = typeof event?.type === 'string' ? event.type : undefined;
  if (eventType !== 'app_uninstalled' && eventType !== 'tokens_revoked') return null;

  const teamId = typeof parsed.team_id === 'string' ? parsed.team_id.trim() : '';
  if (!teamId) return { type: 'ignore', reason: `${eventType}_missing_team_id` };

  if (eventType === 'tokens_revoked') {
    const tokens = isRecord(event?.tokens) ? event.tokens : undefined;
    const botRevoked = Array.isArray(tokens?.bot) && tokens.bot.length > 0;
    if (!botRevoked) return { type: 'ignore', reason: 'tokens_revoked_no_bot_token' };
  }

  // `event_time` is epoch SECONDS on the event_callback envelope; carry it (in ms)
  // so the transport can ignore a lifecycle event older than the install row.
  const eventTimeSec = typeof parsed.event_time === 'number' ? parsed.event_time : undefined;
  return {
    type: 'lifecycle',
    lifecycle: eventType,
    teamId,
    ...(eventTimeSec !== undefined ? { eventTimeMs: eventTimeSec * 1000 } : {}),
  };
}
