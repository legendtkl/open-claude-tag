/**
 * Slack interactivity (Block Kit `block_actions`) handler core — a pure,
 * transport-agnostic decision function mirroring {@link ./events-handler}. Given
 * an ALREADY-signature-verified, parsed interaction payload it returns a typed
 * {@link SlackInteractionOutcome} the HTTP transport acts on. It performs no IO
 * and holds no socket, so it is fully unit-testable with fixtures.
 *
 * It deliberately does NOT verify the signature itself: verification runs on the
 * raw request bytes in the transport BEFORE the form is parsed and handed here,
 * so an interaction is authenticated before it is ever normalized or dispatched.
 *
 * Scope (Milestone 3a): this is the callback TRANSPORT only. It normalizes a
 * button click into a neutral inbound `interaction`; it does not (yet) drive an
 * approval/answer consumer. Only `block_actions` is handled — `view_submission`,
 * `shortcut`, and `message_action` are reported as ignored, not normalized.
 */
import type { DeliveryRef, InboundMessage } from '@open-tag/channel-core';

const SLACK = 'slack' as const;

export type SlackInteractionOutcome =
  /** A normalized neutral interaction the transport should dispatch (then ack 200). */
  | { type: 'dispatch'; message: InboundMessage }
  /** Nothing to do (non-object, unsupported interaction type, unnormalizable). Ack 200. */
  | { type: 'ignore'; reason: string };

export interface HandleSlackInteractionInput {
  /** The parsed interaction payload (decoded from the `payload` form field). */
  parsed: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Slack `ts`/`action_ts` is a `"seconds.microseconds"` string. Derive a
 * timestamp (ms) from it deterministically — never a wall clock, so
 * re-normalizing the same interaction is stable (mirrors `tsToMillis` in
 * slack-channel.ts).
 */
function tsToMillis(ts: string | undefined): number {
  const seconds = Number.parseFloat(ts ?? '');
  return Number.isFinite(seconds) ? Math.round(seconds * 1000) : 0;
}

/**
 * Normalize a Slack `block_actions` interaction into a neutral
 * {@link InboundMessage}. Returns `null` for any non-`block_actions` payload, a
 * non-object, or one missing a field needed to safely route or build the
 * composite dedupe key ({team, channel, user, action_id, action_ts}).
 *
 * The dedupe key is composite — `slack:interaction:<team>:<channel>:<messageTs>:
 * <user>:<action_id>:<action_ts>` — so two DIFFERENT buttons on the same message,
 * or the same user clicking twice, are never collapsed (MUST-FIX FLAW-2).
 * `action_ts` is unique per click, so the key stays unique even when the source
 * message ts is absent.
 *
 * `scope.isPrivate` defaults to `false`: a `block_actions` payload carries no
 * `channel_type`, so we cannot tell a DM/private channel from a public one here.
 * A public action is the safe default; a private-only consumer must re-derive
 * privacy from the bound message/scope, not trust this flag.
 */
export function normalizeSlackInteraction(payload: unknown): InboundMessage | null {
  if (!isRecord(payload)) return null;
  if (payload.type !== 'block_actions') return null;

  const team = asString(isRecord(payload.team) ? payload.team.id : undefined);
  const user = asString(isRecord(payload.user) ? payload.user.id : undefined);

  const container = isRecord(payload.container) ? payload.container : undefined;
  const channelObj = isRecord(payload.channel) ? payload.channel : undefined;
  const channelId =
    asString(channelObj?.id) ?? asString(container?.channel_id);

  const messageObj = isRecord(payload.message) ? payload.message : undefined;
  const messageTs = asString(messageObj?.ts) ?? asString(container?.message_ts) ?? '';
  const threadTs = asString(messageObj?.thread_ts);

  const actions = Array.isArray(payload.actions) ? payload.actions : [];
  const action = isRecord(actions[0]) ? actions[0] : undefined;
  const actionId = asString(action?.action_id);
  const actionTs = asString(action?.action_ts);

  const responseUrl = asString(payload.response_url);
  const triggerId = asString(payload.trigger_id);
  const apiAppId = asString(payload.api_app_id);

  // A safe dedupe key + routing require all of these; otherwise we cannot
  // confidently de-duplicate or address the interaction, so we drop it.
  if (!team || !channelId || !user || !actionId || !actionTs) return null;

  const actionValue = action?.value;

  const interactionValue: Record<string, unknown> = {
    actionTs,
    rawAction: action,
    ...(actionValue !== undefined ? { value: actionValue } : {}),
    ...(responseUrl !== undefined ? { response_url: responseUrl } : {}),
    ...(triggerId !== undefined ? { trigger_id: triggerId } : {}),
  };

  const sourceRef: DeliveryRef = {
    kind: SLACK,
    logicalMessageId: messageTs,
    revision: 0,
    physicalIds: [messageTs],
    native: { channel: channelId },
  };

  return {
    channel: { kind: SLACK, native: payload },
    eventId: triggerId ?? actionTs,
    messageId: messageTs,
    eventType: 'interaction',
    occurredAt: tsToMillis(actionTs),
    dedupeKey: `slack:interaction:${team}:${channelId}:${messageTs}:${user}:${actionId}:${actionTs}`,
    conversation: {
      kind: SLACK,
      scopeId: channelId,
      ...(threadTs ? { threadId: threadTs } : {}),
      // In Slack a reply is posted with `thread_ts` = the root message ts.
      ...(threadTs ? { reply: { rootId: threadTs } } : {}),
    },
    scope: {
      kind: SLACK,
      scopeId: channelId,
      installationId: team,
      ...(threadTs ? { threadId: threadTs } : {}),
      isPrivate: false,
    },
    sender: {
      id: user,
      isBot: false,
      native: { appId: apiAppId },
    },
    content: {
      type: 'interaction',
      interaction: { action: actionId, value: interactionValue, sourceRef },
      mentions: [],
      attachments: [],
    },
  };
}

/**
 * Decide what to do with a verified Slack interactivity request.
 *
 * - `block_actions` → `normalize`; a normalizable click dispatches, an
 *   unnormalizable one (missing routing/dedupe fields) is ignored.
 * - `view_submission` / `shortcut` / `message_action` / any other type → ignored
 *   with `unsupported_interaction_type:<type>` (modals/forms are a later flow).
 * - a non-object payload → ignored.
 */
export function handleSlackInteraction(input: HandleSlackInteractionInput): SlackInteractionOutcome {
  const { parsed } = input;
  if (!isRecord(parsed)) {
    return { type: 'ignore', reason: 'non_object_payload' };
  }

  const type = typeof parsed.type === 'string' ? parsed.type : undefined;
  if (type !== 'block_actions') {
    return { type: 'ignore', reason: `unsupported_interaction_type:${type ?? 'unknown'}` };
  }

  const message = normalizeSlackInteraction(parsed);
  if (!message) {
    return { type: 'ignore', reason: 'unnormalizable_block_actions' };
  }
  return { type: 'dispatch', message };
}
