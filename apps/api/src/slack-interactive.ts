/**
 * Slack interactivity (`/slack/interactive`) inbound transport for the gateway.
 * Composes the pure `@open-tag/channel-slack` primitives (signature verify +
 * interaction handler core) with the Fastify request lifecycle and the gateway's
 * existing dedupe seam. It is the callback channel for Block Kit `block_actions`
 * (button clicks) — Milestone 3a.
 *
 * Security posture (verified in the Codex design gate):
 *  - The signature is verified over the RAW request bytes BEFORE any decoded form
 *    or payload is trusted; a failing request is rejected 401 and never dispatched
 *    (MUST-FIX: rawBody-before-trust).
 *  - The signing secret, the raw signature, the `response_url`, and the raw
 *    payload are NEVER logged; only coarse, non-sensitive fields are.
 *
 * Why no task dispatch here: an interaction is a direct CALLBACK on a message we
 * already posted (an approve/reject click), not a new inbound request. So unlike
 * `/slack/events`, this transport does NOT ingest an observation, run the
 * @-mention addressing gate, or create a task. It dedupes, then hands the neutral
 * interaction to an OPTIONAL consumer seam (`onInteraction`) — which is
 * intentionally unwired in M3a (design D-S6): the transport lands first, a neutral
 * approval consumer consumes it later. With no consumer, the request still
 * verifies, dedupes, and acks an empty 200, so Slack stops retrying.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { InboundMessage } from '@open-tag/channel-core';
import { handleSlackInteraction, verifySlackSignature } from '@open-tag/channel-slack';
import {
  checkAndRecordEvent,
  markEventProcessed,
  releaseInboundEventClaim,
} from '@open-tag/feishu-adapter';
import type { Logger } from '@open-tag/observability';
import type { Database } from '@open-tag/storage';

export const SLACK_INTERACTIVE_PATH = '/slack/interactive';

/** Dispatches a verified, normalized Slack interaction. Awaited before the ack. */
export type SlackInteractionDispatcher = (message: InboundMessage) => Promise<void>;

export interface SlackInteractiveHandlerDeps {
  /** Slack app signing secret; the route is only registered when this is set. */
  signingSecret: string;
  /** Side-effecting dispatch for accepted interactions (dedupe + optional consumer). */
  dispatch: SlackInteractionDispatcher;
  logger: Logger;
  /** Injectable clock (epoch ms) for tests. */
  now?: () => number;
  /** Replay tolerance in seconds (default 300, Slack's recommendation). */
  replayWindowSeconds?: number;
}

function getHeader(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Build the Fastify handler for `POST /slack/interactive`. Extracted from
 * `server.ts` so the verify → parse-form → dispatch → ack logic is unit-testable
 * without booting the full server.
 *
 * Slack sends interactivity as `application/x-www-form-urlencoded` with the JSON
 * payload under the `payload` field, so this transport ACCEPTS urlencoded (the
 * Events transport rejects non-JSON) and reads `request.rawBody` itself for both
 * the signature and the payload.
 */
export function createSlackInteractiveHandler(deps: SlackInteractiveHandlerDeps) {
  return async function handleSlackInteractiveRequest(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<unknown> {
    // The raw bytes are captured by the preParsing hook (server.ts). If they are
    // absent we MUST hard-reject: a signature can only be trusted over the exact
    // bytes Slack sent, and re-encoding the parsed form would verify auth against
    // bytes Slack never signed.
    const rawBody = (request as unknown as { rawBody?: Buffer }).rawBody;
    if (rawBody === undefined) {
      deps.logger.warn(
        { path: SLACK_INTERACTIVE_PATH },
        'Rejected Slack interaction: raw body unavailable for signature verification',
      );
      reply.code(401);
      return 'Invalid signature';
    }

    const verification = verifySlackSignature({
      signingSecret: deps.signingSecret,
      signatureHeader: getHeader(request, 'x-slack-signature'),
      timestampHeader: getHeader(request, 'x-slack-request-timestamp'),
      rawBody,
      now: deps.now?.() ?? Date.now(),
      ...(deps.replayWindowSeconds !== undefined
        ? { replayWindowSeconds: deps.replayWindowSeconds }
        : {}),
    });
    if (!verification.ok) {
      // Never log the secret or the raw signature — only the coarse reason.
      deps.logger.warn(
        { reason: verification.reason, path: SLACK_INTERACTIVE_PATH },
        'Rejected Slack interaction: signature verification failed',
      );
      reply.code(401);
      return 'Invalid signature';
    }

    // The interaction JSON rides the `payload` field of a urlencoded form body.
    const payloadStr = new URLSearchParams(rawBody.toString('utf8')).get('payload');
    if (!payloadStr) {
      // Never log the form contents; only the coarse reason.
      deps.logger.info({ reason: 'missing_payload' }, 'Slack interaction ignored');
      return { ok: true };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(payloadStr);
    } catch {
      // Never log the raw payload; only the coarse reason.
      deps.logger.info({ reason: 'payload_parse_error' }, 'Slack interaction ignored');
      return { ok: true };
    }

    const outcome = handleSlackInteraction({ parsed });

    if (outcome.type === 'ignore') {
      // Reason is a coarse, payload-free string (e.g. unsupported_interaction_type:<t>).
      deps.logger.info({ reason: outcome.reason }, 'Slack interaction ignored');
      return { ok: true };
    }

    // Dedupe-before-side-effect + optional consumer. Awaited BEFORE the ack so a
    // crash can never ack an interaction it then loses. A consumer failure surfaces
    // as a 500 (the claim is released inside the dispatch) so Slack retries.
    try {
      await deps.dispatch(outcome.message);
    } catch (err) {
      // This boundary logs ONLY `{ err, dedupeKey }` — never the response_url or the
      // raw payload (mirroring the approved /slack/events dispatch-failure log). In
      // M3a the only error that reaches here is a DB-layer throw from the dedupe
      // claim (no Slack payload), since the interaction consumer is unwired. A
      // future consumer MUST NOT embed the response_url / raw payload in a thrown
      // error, so this `err` log can never leak them.
      deps.logger.error(
        { err, dedupeKey: outcome.message.dedupeKey },
        'Slack interaction dispatch failed; returning 500 for retry',
      );
      reply.code(500);
      return { ok: false };
    }

    // block_actions wants an EMPTY 200 body — Slack just closes the action menu.
    reply.code(200);
    return '';
  };
}

export interface SlackInteractionDispatchDeps {
  db: Database;
  logger: Logger;
  /**
   * Consume a verified, deduped interaction (the neutral approval/answer seam).
   * INTENTIONALLY unwired in Milestone 3a (design D-S6): the transport lands
   * first; a neutral approval consumer attaches here later. Omitted ⇒ the
   * interaction is verified, deduped, and acked with no further side effect. A
   * throw releases the dedupe claim and propagates so the route 500s and Slack
   * retries (the immediate redelivery re-claims and re-attempts).
   */
  onInteraction?: (message: InboundMessage) => Promise<void>;
}

/**
 * Build the Slack interaction dispatch. It reuses the Lark dedupe store as an
 * idempotency guard so Slack's at-least-once redelivery never double-fires the
 * consumer, dedupe-FIRST (before any side effect), keyed on the composite
 * interaction dedupeKey.
 *
 * Deliberately NOT the events-path dispatch: an interaction is a callback on our
 * own message, so there is no observation ingest, no @-mention addressing gate,
 * and no task creation here — only dedupe + the optional consumer seam.
 *
 * Dedupe namespace: the composite Slack `dedupeKey`
 * (`slack:interaction:<team>:<channel>:<messageTs>:<user>:<action>:<action_ts>`)
 * is stored under the NULL `feishu_app_id` scope, shared with all non-Feishu
 * sources; the mandatory `slack:interaction:` prefix keeps it collision-free.
 */
export function createSlackInteractionDispatch(
  deps: SlackInteractionDispatchDeps,
): SlackInteractionDispatcher {
  return async (message) => {
    // Durable, atomic claim BEFORE any side effect. A failure here (e.g. DB down)
    // propagates so the route returns 500 and Slack retries the whole request.
    const dedup = await checkAndRecordEvent(
      deps.db,
      message.dedupeKey,
      message.messageId,
      undefined,
    );
    if (dedup.isDuplicate) {
      deps.logger.info(
        {
          dedupeKey: message.dedupeKey,
          scopeId: message.scope.scopeId,
          action: message.content.interaction?.action,
        },
        'Slack interaction deduped: duplicate delivery dropped',
      );
      return;
    }

    // Hand the interaction to the (optional) neutral consumer. On failure RELEASE
    // the claim and rethrow so the immediate Slack retry re-claims and re-attempts
    // instead of being dropped as an in-flight duplicate until the stale takeover.
    if (deps.onInteraction) {
      try {
        await deps.onInteraction(message);
      } catch (err) {
        await releaseClaimBestEffort(deps, message.dedupeKey);
        throw err;
      }
    }

    // Close the claim so the row does not sit `received` and look reclaimable.
    await markEventProcessedBestEffort(deps, message.dedupeKey);
  };
}

/** Close the dedupe claim; a failure here only leaves a reclaimable row, so swallow it. */
async function markEventProcessedBestEffort(
  deps: SlackInteractionDispatchDeps,
  dedupeKey: string,
): Promise<void> {
  try {
    await markEventProcessed(deps.db, dedupeKey, undefined);
  } catch (err) {
    deps.logger.warn(
      { err, dedupeKey },
      'Slack interaction: failed to mark dedupe claim processed (non-fatal)',
    );
  }
}

/**
 * Release the dedupe claim after a failed consumer so the immediate retry
 * re-attempts. A release failure only leaves the row reclaimable after the stale
 * window, so it is swallowed (the original error is still rethrown by the caller).
 */
async function releaseClaimBestEffort(
  deps: SlackInteractionDispatchDeps,
  dedupeKey: string,
): Promise<void> {
  try {
    await releaseInboundEventClaim(deps.db, dedupeKey, undefined);
  } catch (err) {
    deps.logger.warn(
      { err, dedupeKey },
      'Slack interaction: failed to release dedupe claim after consumer failure (non-fatal)',
    );
  }
}
