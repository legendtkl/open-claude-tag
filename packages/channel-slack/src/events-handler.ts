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

export type SlackEventOutcome =
  /** Slack endpoint handshake — echo `challenge` back in the 200 body. */
  | { type: 'url_verification'; challenge: string }
  /** A normalized human message the transport should dispatch (then ack 200). */
  | { type: 'dispatch'; message: InboundMessage; retryNum?: number }
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
 * - `event_callback` → `normalize`; a parseable human message dispatches, while a
 *   bot/subtype/non-message (normalize → null) is ignored.
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
    const message = channel.normalize(parsed);
    if (!message) {
      return { type: 'ignore', reason: 'non_dispatchable_event' };
    }
    return { type: 'dispatch', message, ...(retryNum !== undefined ? { retryNum } : {}) };
  }

  return { type: 'ignore', reason: `unsupported_type:${type ?? 'unknown'}` };
}
