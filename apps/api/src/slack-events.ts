/**
 * Slack Events API inbound transport for the gateway. Composes the pure
 * `@open-tag/channel-slack` primitives (signature verify + handler core) with the
 * Fastify request lifecycle and the gateway's existing dedupe + observation seams.
 *
 * Security posture (verified in the Codex design gate):
 *  - The signature is verified over the RAW request bytes BEFORE any parsed JSON
 *    is trusted; a failing request is rejected 401 and never dispatched.
 *  - The `url_verification` challenge echo is itself behind verification — there
 *    is no unauthenticated echo endpoint.
 *  - The signing secret and the raw signature are never logged; only a coarse
 *    failure reason is.
 *
 * Dispatch boundedness (Stage-6 slice): an accepted Slack message is dispatched
 * into the CHANNEL-NEUTRAL observation-memory seam (`ingestObservation`), the part
 * of "the same pipeline Lark uses" that already consumes a structural
 * `InboundMessage`. The Feishu-native task-creation/reply/ambient path consumes a
 * `NormalizedEvent` and replies through a Feishu client; adapting it for Slack is
 * the pending Stage-1 `InboundMessage` orchestrator reshape and is intentionally
 * out of scope. This dispatch seam is where that future work attaches.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { InboundMessage } from '@open-tag/channel-core';
import { handleSlackEvent, verifySlackSignature } from '@open-tag/channel-slack';
import {
  checkAndRecordEvent,
  markEventProcessed,
  releaseInboundEventClaim,
} from '@open-tag/feishu-adapter';
import { ingestObservation } from '@open-tag/memory';
import type { Logger } from '@open-tag/observability';
import type { Database } from '@open-tag/storage';
import { CHANNEL_MEMORY_ENABLED } from './channel-observation-tap.js';
import { isMessageAddressedToBot } from './neutral-dispatch.js';

export const SLACK_EVENTS_PATH = '/slack/events';

/** Dispatches an accepted, verified Slack inbound message. Awaited before ack. */
export type SlackInboundDispatcher = (
  message: InboundMessage,
  ctx: { retryNum?: number },
) => Promise<void>;

export interface SlackEventsHandlerDeps {
  /** Slack app signing secret; the route is only registered when this is set. */
  signingSecret: string;
  /** Channel adapter providing inbound normalization (a `SlackChannel`). */
  channel: { normalize(raw: unknown): InboundMessage | null };
  /** Side-effecting dispatch for accepted messages (dedupe + observation). */
  dispatch: SlackInboundDispatcher;
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

function parseRetryNum(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Build the Fastify handler for `POST /slack/events`. Extracted from `server.ts`
 * so the verify → handshake → ack → dispatch logic is unit-testable without
 * booting the full server.
 */
export function createSlackEventsHandler(deps: SlackEventsHandlerDeps) {
  return async function handleSlackEventsRequest(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<unknown> {
    // Slack Events API requests are always JSON; reject anything else outright.
    const contentType = String(request.headers['content-type'] ?? '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    if (contentType && contentType !== 'application/json') {
      reply.code(415);
      return 'Unsupported Media Type';
    }

    // The raw bytes are captured by the preParsing hook (server.ts). If they are
    // absent we MUST hard-reject rather than re-serialize the parsed body: a
    // signature can only be trusted over the exact bytes Slack sent, and trusting
    // reconstructed JSON would verify auth against bytes Slack never signed.
    const rawBody = (request as unknown as { rawBody?: Buffer }).rawBody;
    if (rawBody === undefined) {
      deps.logger.warn(
        { path: SLACK_EVENTS_PATH },
        'Rejected Slack request: raw body unavailable for signature verification',
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
        { reason: verification.reason, path: SLACK_EVENTS_PATH },
        'Rejected Slack request: signature verification failed',
      );
      reply.code(401);
      return 'Invalid signature';
    }

    const retryNum = parseRetryNum(getHeader(request, 'x-slack-retry-num'));
    const outcome = handleSlackEvent({ parsed: request.body, channel: deps.channel, retryNum });

    if (outcome.type === 'url_verification') {
      // Endpoint handshake — echo the challenge (already signature-verified above).
      return { challenge: outcome.challenge };
    }

    if (outcome.type === 'ignore') {
      deps.logger.info({ reason: outcome.reason, retryNum }, 'Slack event ignored');
      return { ok: true };
    }

    // Dispatch is a single durable dedupe claim plus one cheap observation insert,
    // so it is awaited BEFORE the 200 ack (well within Slack's ~3s budget). This
    // trades a literal fire-and-forget for durability: a crash can never ack an
    // event it then loses. Only an undeduped (durable-claim) failure surfaces as a
    // 500 so Slack retries; the observation write itself is best-effort.
    try {
      await deps.dispatch(outcome.message, { retryNum });
    } catch (err) {
      deps.logger.error(
        { err, retryNum, dedupeKey: outcome.message.dedupeKey },
        'Slack inbound dispatch failed before durable claim; returning 500 for retry',
      );
      reply.code(500);
      return { ok: false };
    }
    return { ok: true };
  };
}

export interface SlackInboundDispatchDeps {
  db: Database;
  logger: Logger;
  /** Defaults to {@link CHANNEL_MEMORY_ENABLED}; injectable for tests. */
  channelMemoryEnabled?: boolean;
  /**
   * Dispatch a task for a message addressed to the bot (the neutral path,
   * ADR-0005). Omitted ⇒ observation only (today's behavior). NOT wrapped in a
   * best-effort guard: a failure propagates so the route returns 500 and the
   * dedup claim stays open for a stale-claim redelivery to recover.
   */
  dispatchTask?: (message: InboundMessage) => Promise<void>;
  /**
   * Resolve the bot user id for the @-mention addressing gate, scoped to the
   * message's Slack `team_id` (Slack Milestone 1a). Returns the per-team
   * `bot_user_id` (env `SLACK_BOT_USER_ID` only as the single-workspace fallback,
   * see {@link createSlackInstallationResolver}). Unset, or resolving to
   * `undefined`, ⇒ no message is addressed, so no task is dispatched for that team
   * (safe-by-default opt-in + fail-closed for an un-onboarded workspace).
   */
  resolveBotUserId?: (installationId: string | undefined) => Promise<string | undefined>;
}

/**
 * Build the Slack inbound dispatch. It reuses the Lark dedupe store as an
 * idempotency guard so Slack's at-least-once redelivery (and explicit
 * `X-Slack-Retry-Num` retries) never double-dispatch, then folds the message into
 * channel-neutral observation memory.
 *
 * Double-dispatch safety is two-layered, so even a best-effort claim-close that
 * fails (leaving the row `received`) cannot produce a duplicate side effect:
 *  1. event-id claim — within the 5-minute stale window a redelivery of the same
 *     `dedupeKey` is reported duplicate and dropped before any side effect;
 *  2. content-hash — `ingestObservation` upserts on (channelKind, scopeId,
 *     dedupeHash), so should a very-late retry ever get past layer 1 (stale-claim
 *     takeover), it still writes no duplicate observation row.
 *
 * Dedupe namespace: the Slack `dedupeKey` (`slack:<event_id|channel:ts>`) is
 * stored under the NULL `feishu_app_id` scope. That scope is shared by all
 * non-Feishu sources, but the mandatory `slack:` prefix keeps Slack keys
 * collision-free from raw Feishu event ids. (A dedicated `source` column is the
 * cleaner long-term shape — tracked as a follow-up.)
 */
export function createSlackInboundDispatch(deps: SlackInboundDispatchDeps): SlackInboundDispatcher {
  const channelMemoryEnabled = deps.channelMemoryEnabled ?? CHANNEL_MEMORY_ENABLED;
  return async (message, ctx) => {
    // Durable, atomic claim. A failure here (e.g. DB down) propagates so the route
    // returns 500 and Slack retries the whole request later.
    const dedup = await checkAndRecordEvent(
      deps.db,
      message.dedupeKey,
      message.messageId,
      undefined,
    );
    if (dedup.isDuplicate) {
      deps.logger.info(
        { dedupeKey: message.dedupeKey, retryNum: ctx.retryNum },
        'Slack inbound deduped: duplicate delivery dropped',
      );
      return;
    }

    // Observe every accepted message (addressed or not), best-effort — mirroring
    // the Lark observation tap; a write must never block or fail the ack.
    if (channelMemoryEnabled) {
      try {
        const result = await ingestObservation(deps.db, message);
        deps.logger.info(
          {
            dedupeKey: message.dedupeKey,
            scopeId: message.scope.scopeId,
            written: result.written,
            reason: result.reason,
          },
          'Slack inbound observation ingested',
        );
      } catch (err) {
        deps.logger.warn(
          { err, dedupeKey: message.dedupeKey },
          'Slack inbound observation ingest failed (best-effort, non-fatal)',
        );
      }
    }

    // Addressed to the bot ⇒ dispatch a task through the neutral path. On failure
    // (e.g. enqueue down) RELEASE the dedup claim and rethrow: the route returns
    // 500 and the immediate Slack retry re-claims and re-attempts (idempotent on
    // the deterministic task id), instead of being dropped as an in-flight
    // duplicate while the task sits jobless until the 5-minute stale takeover —
    // by when Slack may have stopped retrying. dispatchNeutralMessage makes
    // enqueue the durable boundary, so the re-attempt cannot double-dispatch.
    if (deps.dispatchTask && deps.resolveBotUserId) {
      // Resolve the per-team bot user id before the gate (Slack Milestone 1a) so a
      // multi-workspace deploy addresses each message against ITS workspace's bot.
      const botUserId = await deps.resolveBotUserId(message.scope.installationId);
      if (isMessageAddressedToBot(message, botUserId)) {
        try {
          await deps.dispatchTask(message);
        } catch (err) {
          await releaseClaimBestEffort(deps, message.dedupeKey);
          throw err;
        }
      }
    }

    // Close the claim so the row does not sit `received` and look reclaimable.
    await markEventProcessedBestEffort(deps, message.dedupeKey);
  };
}

/** Close the dedupe claim; a failure here only leaves a reclaimable row, so swallow it. */
async function markEventProcessedBestEffort(
  deps: SlackInboundDispatchDeps,
  dedupeKey: string,
): Promise<void> {
  try {
    await markEventProcessed(deps.db, dedupeKey, undefined);
  } catch (err) {
    deps.logger.warn(
      { err, dedupeKey },
      'Slack inbound: failed to mark dedupe claim processed (non-fatal)',
    );
  }
}

/**
 * Release the dedupe claim after a failed task dispatch so the immediate retry
 * re-attempts. A release failure only leaves the row reclaimable after the stale
 * window, so it is swallowed (the original error is still rethrown by the caller).
 */
async function releaseClaimBestEffort(
  deps: SlackInboundDispatchDeps,
  dedupeKey: string,
): Promise<void> {
  try {
    await releaseInboundEventClaim(deps.db, dedupeKey, undefined);
  } catch (err) {
    deps.logger.warn(
      { err, dedupeKey },
      'Slack inbound: failed to release dedupe claim after dispatch failure (non-fatal)',
    );
  }
}
