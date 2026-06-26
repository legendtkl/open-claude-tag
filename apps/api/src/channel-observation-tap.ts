import type { NormalizedEvent } from '@open-tag/core-types';
import { adaptNormalizedEvent } from '@open-tag/feishu-adapter';
import { ingestObservation } from '@open-tag/memory';
import { createLogger } from '@open-tag/observability';
import type { Database } from '@open-tag/storage';

const logger = createLogger('channel-observation');

/**
 * Always-on channel observation memory toggle (Stage 1, "following the
 * channel"). Default **ON**; only `OPEN_TAG_CHANNEL_MEMORY=disabled` turns it
 * off. A finer per-channel toggle (via `chatConfigs`) is a later refinement — a
 * single global default-on flag is sufficient for now.
 */
export const CHANNEL_MEMORY_ENABLED = process.env.OPEN_TAG_CHANNEL_MEMORY !== 'disabled';

/**
 * Hard cap on concurrent in-flight observation writes. The tap fires detached
 * (fire-and-forget) writes against the *same* DB pool as the critical inbound
 * pipeline, so an unbounded backlog of slow observation inserts could otherwise
 * consume pool connections and delay the awaited routing/session/dispatch work.
 * Capping in-flight writes bounds observations to a small constant slice of the
 * pool (<=8 of the default 20 connections), so a backlog can never grow
 * unbounded and starve the primary pipeline. Excess messages are shed
 * (best-effort memory) — protecting dispatch always wins over a single
 * observation row. A dedicated pool / async write-queue is the stronger
 * isolation and is tracked as a later refinement.
 */
const MAX_INFLIGHT_OBSERVATIONS = 8;
let inflightObservations = 0;

/**
 * Fold one inbound human message into per-channel observation memory.
 *
 * This is the always-on "following the channel" write tap: it runs for every
 * normalized inbound message — addressed (`@mention`) *and* un-addressed — so a
 * channel accumulates context regardless of whether a task was ever dispatched.
 *
 * Strictly non-blocking and error-isolated by construction:
 *  - it returns synchronously (`void`); the DB write is fire-and-forget, so it
 *    can never delay ACK, routing, or task dispatch;
 *  - in-flight writes are capped (see {@link MAX_INFLIGHT_OBSERVATIONS}) so a
 *    slow/backlogged DB can never let observations starve the shared pool;
 *  - the synchronous adapt step is wrapped in try/catch and the async write is
 *    `.catch()`-guarded — neither a throw nor a rejection can escape into the
 *    caller's message-handling pipeline.
 *
 * All filtering (bots / commands / sensitive / empty / dedup) lives inside
 * {@link ingestObservation}; the tap intentionally does not duplicate it, so it
 * can be called for every normalized human message verbatim.
 */
export function tapChannelObservation(
  db: Database,
  event: NormalizedEvent,
  enabled: boolean = CHANNEL_MEMORY_ENABLED,
): void {
  if (!enabled) {
    return;
  }
  if (inflightObservations >= MAX_INFLIGHT_OBSERVATIONS) {
    // Shed under backlog rather than pile onto the shared pool. Best-effort
    // memory must never throttle the primary task pipeline.
    logger.warn(
      { eventId: event.eventId, inflight: inflightObservations },
      'Channel observation shed (max in-flight reached)',
    );
    return;
  }
  let inbound;
  try {
    inbound = adaptNormalizedEvent(event);
  } catch (err) {
    // Defensive: adaptNormalizedEvent is pure mapping and should not throw, but
    // the tap must never surface an error into the inbound message pipeline.
    logger.warn(
      { err, eventId: event.eventId },
      'Channel observation tap failed before ingest (isolated, non-fatal)',
    );
    return;
  }
  inflightObservations += 1;
  void ingestObservation(db, inbound)
    .catch((err) => {
      logger.warn(
        { err, eventId: event.eventId, chatId: event.chatId },
        'Channel observation ingest failed (isolated, non-fatal)',
      );
    })
    .finally(() => {
      inflightObservations -= 1;
    });
}
