import { createHash } from 'node:crypto';
import type { Database } from '@open-tag/storage';
import { channelObservations } from '@open-tag/storage';
import { containsSensitiveInfo } from '../sensitive-filter.js';

/** Bound stored gist size; reject sub-trivial fragments. */
const MAX_OBSERVATION_GIST_CHARS = 4000;
const MIN_OBSERVATION_CHARS = 2;

/**
 * The subset of channel-core's `InboundMessage` that channel-scoped observation
 * ingestion reads. Declared structurally (not imported) so `@open-tag/memory`
 * stays dependency-free of `@open-tag/channel-core`; a full `InboundMessage` is
 * assignable to this by TypeScript's structural typing, so the apps/api inbound
 * tap can pass one in directly when this is wired up.
 */
export interface ObservationInbound {
  /** InboundMessage.messageId — the source message this observation was lifted from. */
  messageId: string;
  /** InboundMessage.eventType — only `created`/`updated` are ingested. */
  eventType: string;
  /** InboundMessage.occurredAt, epoch ms — the row's `occurred_at` (never Date.now()). */
  occurredAt: number;
  /** The channel isolation key; `scopeId` is the unit of per-channel memory. */
  scope: { kind: string; scopeId: string };
  sender: { isBot: boolean };
  content: { type: string; text?: string };
}

export type IngestObservationResult = { written: boolean; reason?: string };

/** Collapse whitespace + trim so trivial formatting differences dedup together. */
function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Truncate at a word boundary when past the cap; keep short texts verbatim. */
function truncateAtWordBoundary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const slice = text.slice(0, maxChars);
  const lastSpace = slice.lastIndexOf(' ');
  return (lastSpace > maxChars * 0.6 ? slice.slice(0, lastSpace) : slice).trim();
}

/**
 * Stable, channel-scoped dedup key. `channelKind` and `scopeId` are folded into
 * the digest so identical text in different channels never collides — isolation
 * holds even before the DB-layer UNIQUE (channel_kind, scope_id, dedupe_hash).
 * The tuple is JSON-encoded so the three fields are unambiguously delimited (no
 * separator can be smuggled across fields) and the source stays plain ASCII.
 */
function computeDedupeHash(normalized: string, scopeId: string, channelKind: string): string {
  return createHash('sha256')
    .update(JSON.stringify([channelKind, scopeId, normalized]))
    .digest('hex');
}

/**
 * Channel-scoped observation ingestion — the always-on "following the channel"
 * write path. Un-addressed channel activity accumulates into per-channel memory
 * keyed by `scope.scopeId` (+ `channelKind`), distinct from the agent's own
 * task-result memory (`shared_context_entries` / `memory_entries`).
 *
 * This ingests human-stated facts, so — unlike the shared-context writer — it
 * does NOT run the agent-output evidence verifier (non-containment). It does keep
 * the same sensitive-content gate. Repeated identical content in a channel is a
 * no-op via an upsert on the dedupe key.
 *
 * // TODO(stage-1): cheaper LLM gist + decay
 */
export async function ingestObservation(
  db: Database,
  inbound: ObservationInbound,
): Promise<IngestObservationResult> {
  // Only substantive created/updated text from a human is observation-worthy.
  if (inbound.eventType !== 'created' && inbound.eventType !== 'updated') {
    return { written: false, reason: 'unsupported_event_type' };
  }
  if (inbound.content.type !== 'text') {
    return { written: false, reason: 'non_text_content' };
  }
  if (inbound.sender.isBot) {
    return { written: false, reason: 'bot_sender' };
  }

  const normalized = normalizeText(inbound.content.text ?? '');
  if (normalized.length === 0) {
    return { written: false, reason: 'empty_content' };
  }
  if (normalized.startsWith('/')) {
    return { written: false, reason: 'command' };
  }
  if (normalized.length < MIN_OBSERVATION_CHARS) {
    return { written: false, reason: 'trivial' };
  }
  // Human-stated facts still pass the sensitive gate (API keys / tokens leak in
  // chat too); skip the agent-output evidence verifier (this is not agent output).
  if (containsSensitiveInfo(normalized)) {
    return { written: false, reason: 'sensitive' };
  }

  const { kind: channelKind, scopeId } = inbound.scope;
  const dedupeHash = computeDedupeHash(normalized, scopeId, channelKind);
  const gist = truncateAtWordBoundary(normalized, MAX_OBSERVATION_GIST_CHARS);

  const inserted = await db
    .insert(channelObservations)
    .values({
      channelKind,
      scopeId,
      sourceMessageId: inbound.messageId,
      gist,
      // Timestamp comes from the inbound event, not wall-clock.
      occurredAt: new Date(inbound.occurredAt),
      dedupeHash,
    })
    .onConflictDoNothing({
      target: [
        channelObservations.channelKind,
        channelObservations.scopeId,
        channelObservations.dedupeHash,
      ],
    })
    .returning({ id: channelObservations.id });

  if (inserted.length === 0) {
    return { written: false, reason: 'duplicate' };
  }
  return { written: true };
}
