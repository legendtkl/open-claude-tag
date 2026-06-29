/**
 * ChannelSender — a neutral seam the worker uses to send/update outbound
 * messages, decoupling task-feedback delivery from a concrete vendor client.
 *
 * {@link LarkChannelSender} backs the seam with a {@link LarkChannel} (which
 * already wraps the per-app {@link FeishuClient} the registry resolves), so the
 * actual REST calls are byte-identical to talking to the client directly.
 *
 * The neutral message/handle types are derived from the {@link LarkChannel}
 * contract on purpose: the worker stays free of a direct `@open-tag/channel-core`
 * dependency while still speaking the same vendor-neutral shapes.
 */
import {
  LarkChannel,
  buildRunningCard,
  type ConversationRef,
  type FeishuClient,
  type InteractiveCard,
  type NormalizerConfig,
} from '@open-tag/feishu-adapter';
import type { Logger } from 'pino';
import { resolveTaskFeishuClient, type TaskFeishuClientResolver } from './agent-runtime.js';

/** The vendor-neutral outbound render model the channel speaks. */
export type OutboundMessage = Parameters<LarkChannel['send']>[1];
/** A handle over the physical message(s) a logical send produced. */
export type DeliveryRef = Awaited<ReturnType<LarkChannel['send']>>;
/** Optional send controls; carries the exactly-once `idempotencyKey`. */
export type SendOptions = Parameters<LarkChannel['send']>[2];
type UpdateOptions = Parameters<LarkChannel['update']>[2];
/** The removable reaction handle a {@link ChannelSender.removeReaction} consumes. */
export type ReactionRef = Parameters<NonNullable<LarkChannel['removeReaction']>>[0];

/** The neutral conversation handle a fresh send targets. */
export type { ConversationRef };

const LARK_KIND = 'lark' as const;

/**
 * Build the conversation a task's auxiliary cards (e.g. the live checklist) are
 * posted into: the task's chat, threaded under the same reply target the
 * feedback cards use. `replyToMessageId` is only set inside topic threads, so a
 * non-threaded task posts a fresh top-level message.
 */
export function buildTaskConversationRef(
  chatId: string,
  replyToMessageId?: string,
): ConversationRef {
  return {
    kind: LARK_KIND,
    scopeId: chatId,
    ...(replyToMessageId ? { reply: { parentId: replyToMessageId } } : {}),
  };
}

/** The thin surface the worker uses to deliver/edit outbound messages. */
export interface ChannelSender {
  send(to: ConversationRef, msg: OutboundMessage, opts?: SendOptions): Promise<DeliveryRef>;
  update(ref: DeliveryRef, msg: OutboundMessage, opts?: UpdateOptions): Promise<DeliveryRef>;
  /**
   * Remove a reaction the channel placed on a message, identified by the
   * {@link ReactionRef}. Optional so send/update-only senders stay conformant;
   * {@link LarkChannelSender} implements it. Best-effort — see
   * {@link removeAckReactionViaChannel}.
   */
  removeReaction?(ref: ReactionRef): Promise<void>;
}

/** A {@link ChannelSender} backed by a {@link LarkChannel}. */
export class LarkChannelSender implements ChannelSender {
  constructor(private readonly channel: LarkChannel) {}

  send(to: ConversationRef, msg: OutboundMessage, opts?: SendOptions): Promise<DeliveryRef> {
    return this.channel.send(to, msg, opts);
  }

  update(ref: DeliveryRef, msg: OutboundMessage, opts?: UpdateOptions): Promise<DeliveryRef> {
    return this.channel.update(ref, msg, opts);
  }

  removeReaction(ref: ReactionRef): Promise<void> {
    return this.channel.removeReaction(ref);
  }
}

// LarkChannel.normalize() is the only consumer of NormalizerConfig; send/update
// never read it, so a send-only sender uses an empty bot identity.
const SEND_ONLY_NORMALIZER_CONFIG: NormalizerConfig = { botOpenId: '' };

export function createLarkChannelSender(
  client: FeishuClient,
  normalizerConfig: NormalizerConfig = SEND_ONLY_NORMALIZER_CONFIG,
): LarkChannelSender {
  return new LarkChannelSender(new LarkChannel(client, normalizerConfig));
}

/**
 * Rebuild the {@link ReactionRef} the worker needs to REMOVE the inbound-dispatch
 * ack reaction from the ids it stored on the task (`constraints.userMessageId`,
 * `constraints.userMessageReactionId`). Lark removal needs BOTH the owning message
 * id and the provider reaction id; the reaction id is the first-class `reactionId`
 * field and the message id rides the `native` escape hatch, exactly what
 * {@link LarkChannel.removeReaction} reads to call
 * `FeishuClient.removeReaction(messageId, reactionId)` — byte-identical to the
 * worker's prior direct client call. This mirrors {@link reconstructAckDeliveryRef}
 * for the ack-update handle.
 */
export function reconstructLarkReactionRef(messageId: string, reactionId: string): ReactionRef {
  return { kind: LARK_KIND, reactionId, native: { messageId } };
}

/**
 * Remove a task's ack reaction through the neutral {@link ChannelSender}, the
 * mirror of the API's add side (`addDispatchReactionViaChannel`). Best-effort: a
 * sender without `removeReaction`, a missing id, or a send error is skipped (a
 * send error is warned), never crashing the already-finished task. For a Lark task
 * this resolves to exactly today's
 * `client.removeReaction(userMessageId, userMessageReactionId)`.
 *
 * The worker still triggers this only under its lark-shaped id guard (the ack
 * reaction is Feishu-only today); a non-lark kind with no reaction id simply never
 * reaches here. Routing it through the neutral contract makes a future Slack
 * reaction-removal (reconstructing a slack-shaped ref) a drop-in.
 */
export async function removeAckReactionViaChannel(
  sender: ChannelSender | null,
  args: { messageId?: string; reactionId?: string; reason: string },
  logger?: Logger,
): Promise<void> {
  const { messageId, reactionId, reason } = args;
  if (!sender?.removeReaction || !messageId || !reactionId) return;
  try {
    await sender.removeReaction(reconstructLarkReactionRef(messageId, reactionId));
  } catch (err) {
    logger?.warn(
      { err, userMessageId: messageId, userMessageReactionId: reactionId },
      `Failed to remove reaction ${reason}`,
    );
  }
}

/** Resolves a {@link ChannelSender} for a task's Feishu app, reusing the registry. */
export interface ChannelSenderResolver {
  getChannelSender(feishuAppId?: string | null): Promise<ChannelSender | null>;
}

export function createWorkerChannelSenderResolver(options: {
  feishuClientResolver: TaskFeishuClientResolver | null;
  defaultClient: FeishuClient | null;
  normalizerConfig?: NormalizerConfig;
}): ChannelSenderResolver {
  return {
    getChannelSender: async (feishuAppId) => {
      const { client } = await resolveTaskFeishuClient({
        feishuAppId,
        resolver: options.feishuClientResolver,
        defaultClient: options.defaultClient,
      });
      if (!client) return null;
      return createLarkChannelSender(client, options.normalizerConfig);
    },
  };
}

/**
 * The per-kind delivery context {@link resolveTaskChannelSender} resolves from.
 * Each field is the input ONE kind needs (mirrors the API's
 * `ChannelSenderResolutionContext`): the `lark` factory reads `feishuClient`, the
 * `slack` factory reads the injected `slackSender`.
 */
export interface TaskChannelSenderContext {
  /** The task's resolved per-app Feishu client; required for the `lark` kind. */
  feishuClient?: FeishuClient | null;
  /**
   * The worker's Slack sender (a `SlackChannel`, built from `SLACK_BOT_TOKEN`),
   * or a recording stub in tests. Absent ⇒ the `slack` slot is unconfigured.
   */
  slackSender?: ChannelSender | null;
}

/**
 * Resolve the worker's terminal-feedback sender BY the task's channel kind — the
 * worker mirror of the API's `resolveChannelSender` (apps/api/src/
 * channel-sender-resolver.ts), so a Slack-dispatched task's done/failed delivery
 * reaches Slack instead of being hardcoded to Lark.
 *
 *  - `lark` yields exactly `createLarkChannelSender(feishuClient)` (or `null` when
 *    no client) — the same expression/calls the worker used before, so Lark
 *    delivery is unchanged.
 *  - `slack` returns the injected `slackSender` (or `null` when unconfigured).
 *  - any other/unknown kind returns `null`.
 *
 * Deliberate divergence from the API resolver (which throws): worker terminal
 * delivery is best-effort and MUST NOT crash an otherwise-completed task, so an
 * unresolved/unknown kind returns `null` (the caller logs + skips delivery). A
 * `null` here NEVER falls back to another vendor — it only skips.
 */
export function resolveTaskChannelSender(
  kind: string,
  ctx: TaskChannelSenderContext,
): ChannelSender | null {
  switch (kind) {
    case LARK_KIND:
      return ctx.feishuClient ? createLarkChannelSender(ctx.feishuClient) : null;
    case 'slack':
      return ctx.slackSender ?? null;
    default:
      return null;
  }
}

/** The result a terminal `updateDone` reports back (mirrors the Lark shape). */
export interface TaskFeedbackDoneResult {
  sentMessageIds: string[];
  completionMessageId?: string;
}

/** Options a terminal `updateDone` accepts (mirrors the Lark `UpdateDoneOptions`). */
export interface TaskFeedbackDoneOptions {
  completionText?: string;
  allowedMentions?: Array<{ openId: string; name: string; isBot?: boolean }>;
}

/**
 * The terminal-feedback surface `processTask()` drives. Both the Lark
 * {@link ThreePhaseFeedback} (structurally) and the neutral
 * {@link NeutralChannelFeedback} satisfy it, so `processTask` calls one object
 * regardless of channel.
 */
export interface TaskFeedback {
  updateDone(
    description: string,
    result?: string,
    options?: TaskFeedbackDoneOptions,
  ): Promise<TaskFeedbackDoneResult | undefined>;
  updateFailed(description: string, error: string): Promise<void>;
  notifyQuotaExceeded(description: string, error: string): Promise<void>;
}

// A single Slack Block Kit section's text field caps near 3000 chars; keep the
// neutral terminal body comfortably under that (full segmentation is deferred).
const NEUTRAL_FEEDBACK_MAX_CHARS = 2800;
const NEUTRAL_FEEDBACK_TRUNCATION_SUFFIX = '... (truncated)';

function truncateNeutralBody(text: string): string {
  if (text.length <= NEUTRAL_FEEDBACK_MAX_CHARS) return text;
  return `${text.slice(0, NEUTRAL_FEEDBACK_MAX_CHARS - NEUTRAL_FEEDBACK_TRUNCATION_SUFFIX.length)}${NEUTRAL_FEEDBACK_TRUNCATION_SUFFIX}`;
}

export interface NeutralChannelFeedbackOptions {
  sender: ChannelSender;
  conversation: ConversationRef;
  /**
   * The threaded ack-message handle (ADR-0008). When present, the terminal
   * outcome UPDATES that same message in place (UX parity with lark's live card)
   * instead of posting a fresh one. Absent ⇒ a fresh terminal message is sent
   * (back-compat: older queued jobs / a failed ACK carry no handle).
   */
  ackRef?: DeliveryRef;
  logger?: Logger;
  /**
   * Clock (epoch ms) for the running-update rate gate; injectable so tests drive a
   * deterministic window. Defaults to wall-clock {@link Date.now} (not a monotonic
   * source). The gate only needs the elapsed ms between calls, so wall-clock is
   * fine: a backward clock step at worst delays one cosmetic running update by up
   * to the window — it never over-sends.
   */
  now?: () => number;
}

/** The live running-phase snapshot {@link NeutralChannelFeedback.updateRunning} renders. */
export interface NeutralRunningFeedbackInput {
  description: string;
  progress?: number;
  recentActivity?: string[];
  workDir?: string;
}

/**
 * Coalesce neutral running-card updates. This is a FIXED 1000ms constant chosen
 * for the only neutral channel today, Slack, whose `chat.update` cap is 1Hz
 * (`SlackChannel.capabilities().maxUpdateRateHz` = 1 ⇒ 1000ms). It does NOT
 * auto-adapt per channel; if another neutral channel with a different cap is
 * added, derive the interval from its capability instead. A leading-edge gate
 * sends at most one running update per window and DROPS intermediate updates
 * inside it (no trailing timer), mirroring the lark running card's
 * `RUNNING_CARD_UPDATE_INTERVAL_MS` time-gate. The terminal update bypasses this
 * gate and always flushes the final state (see {@link ThreePhaseFeedback}).
 */
export const NEUTRAL_RUNNING_UPDATE_MIN_INTERVAL_MS = 1000;

/**
 * Render the running-phase snapshot as a neutral markdown body (the same content
 * the lark running card carries: description, progress, recent activity, workdir).
 * Truncated to the single-message budget; delivered as a `text` outbound so the
 * channel renders it through its existing markdown section path (no channel
 * adapter change). Mirrors the terminal bodies built in {@link NeutralChannelFeedback}.
 */
function buildNeutralRunningBody(input: NeutralRunningFeedbackInput): string {
  const lines: string[] = ['Working on the task...'];
  const description = input.description?.trim();
  lines.push(`Task: ${description || '(in progress)'}`);
  if (typeof input.progress === 'number' && Number.isFinite(input.progress)) {
    lines.push(`Progress: ${Math.round(input.progress)}%`);
  }
  const activity = (input.recentActivity ?? []).filter((line) => line && line.trim());
  if (activity.length > 0) {
    lines.push('', 'Recent activity:', ...activity.map((line) => `• ${line}`));
  }
  if (input.workDir?.trim()) {
    lines.push('', `Working dir: ${input.workDir.trim()}`);
  }
  return truncateNeutralBody(lines.join('\n'));
}

/**
 * Rebuild the channel {@link DeliveryRef} the worker needs to UPDATE a threaded
 * ack message from its serialized `constraints.ackDelivery` form
 * (`{ kind, scopeId, messageId }`, see the API's `NeutralAckDelivery`). The
 * physical id list + a `native.channel` (the conversation scope) are exactly what
 * `SlackChannel.update` reads. Returns `undefined` for a missing/malformed handle
 * so the caller falls back to a fresh send.
 */
export function reconstructAckDeliveryRef(value: unknown): DeliveryRef | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const { kind, scopeId, messageId } = record;
  if (typeof kind !== 'string' || !kind) return undefined;
  if (typeof scopeId !== 'string' || !scopeId) return undefined;
  if (typeof messageId !== 'string' || !messageId) return undefined;
  return {
    kind,
    logicalMessageId: messageId,
    revision: 0,
    physicalIds: [messageId],
    // Channels recover the destination from the handle's native escape hatch
    // (Slack's update reads `native.channel`); the conversation scope is it.
    native: { channel: scopeId },
  };
}

/**
 * A vendor-neutral {@link TaskFeedback} for non-Lark channels (e.g. Slack). It
 * delivers a task's terminal outcome as a NEUTRAL {@link OutboundMessage}
 * (`result` / `error` / `text`) through the kind-resolved {@link ChannelSender},
 * which the channel adapter renders natively (Slack → Block Kit section).
 *
 * Both a running phase and the terminal outcome share the in-place update
 * (ADR-0008, Slack Milestone 2). When an {@link DeliveryRef} `ackRef` is threaded
 * in, {@link updateRunning} edits that same ack message to a live progress card
 * while the task runs (rate-limited to the channel cap), then the terminal
 * `updateDone` / `updateFailed` edits it to the result/error — like the Lark
 * {@link ThreePhaseFeedback} PATCHing its ack card — so a neutral task shows one
 * live-updating message instead of a separate terminal post. With no `ackRef`
 * (older jobs, or the ACK send failed) running updates are skipped and the
 * terminal falls back to posting a single fresh message into the task's own
 * conversation. Delivery is best-effort either way — a failure is logged and
 * swallowed so it never fails the already-completed task. It reports no
 * `sentMessageIds` on purpose: those ids must not enter the Lark-shaped
 * thread-key aliasing (neutral aliasing is deferred).
 */
export class NeutralChannelFeedback implements TaskFeedback {
  private readonly sender: ChannelSender;
  private readonly conversation: ConversationRef;
  private readonly ackRef?: DeliveryRef;
  private readonly logger?: Logger;
  private readonly now: () => number;
  /** Last running-update timestamp; `null` until the first one (which always flushes). */
  private lastRunningUpdateAt: number | null = null;

  constructor(options: NeutralChannelFeedbackOptions) {
    this.sender = options.sender;
    this.conversation = options.conversation;
    this.ackRef = options.ackRef;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
  }

  /**
   * Edit the in-place ACK message to a live RUNNING snapshot (Slack Milestone 2).
   * Skips entirely when there is no `ackRef`: running updates need a handle to
   * edit, and the terminal path already owns the fresh-message fallback — so a
   * running update NEVER posts a new message (no `chat.postMessage`). Coalesced to
   * the channel cap by {@link NEUTRAL_RUNNING_UPDATE_MIN_INTERVAL_MS}: a
   * leading-edge gate drops updates that arrive inside the open window (keeping the
   * first of each window, not a trailing-latest). Best-effort / no-throw via the
   * shared {@link deliver} — a thrown or rate-limited running update never fails
   * the task and never blocks the terminal update.
   */
  async updateRunning(input: NeutralRunningFeedbackInput): Promise<void> {
    if (!this.ackRef) return;
    const now = this.now();
    if (
      this.lastRunningUpdateAt !== null &&
      now - this.lastRunningUpdateAt < NEUTRAL_RUNNING_UPDATE_MIN_INTERVAL_MS
    ) {
      return;
    }
    await this.deliver(
      { kind: 'text', markdown: buildNeutralRunningBody(input) },
      'running',
      input.description,
    );
    // Advance the window on every gated ATTEMPT (success or swallowed failure),
    // not only on success: each `deliver` is a real `chat.update` call against the
    // cap, and the common failure here is being rate-limited — retrying it at the
    // full runtime-event rate would hammer the very endpoint the cap protects. The
    // worst case is a ~1s cosmetic delay before the next attempt; the terminal
    // update always flushes the true final state regardless.
    this.lastRunningUpdateAt = now;
  }

  async updateDone(
    description: string,
    result?: string,
    options: TaskFeedbackDoneOptions = {},
  ): Promise<TaskFeedbackDoneResult | undefined> {
    const body =
      options.completionText?.trim() || result?.trim() || `Task complete\nTask: ${description}`;
    await this.deliver({ kind: 'result', markdown: truncateNeutralBody(body) }, 'done', description);
    return { sentMessageIds: [] };
  }

  async updateFailed(description: string, error: string): Promise<void> {
    const detail = error?.trim();
    const body = `Task failed\nTask: ${description}${detail ? `\n\n${detail}` : ''}`;
    await this.deliver({ kind: 'error', message: truncateNeutralBody(body) }, 'failed', description);
  }

  async notifyQuotaExceeded(description: string, error: string): Promise<void> {
    const detail = error?.trim();
    const body = `Usage limit reached\nTask: ${description}${detail ? `\n\n${detail}` : ''}`;
    await this.deliver({ kind: 'text', markdown: truncateNeutralBody(body) }, 'quota', description);
  }

  private async deliver(
    msg: OutboundMessage,
    phase: 'running' | 'done' | 'failed' | 'quota',
    description: string,
  ): Promise<void> {
    try {
      // With a threaded ack handle, update that message in place (single live
      // message); otherwise post a fresh terminal message. An update failure is
      // swallowed (not retried as a send) so a partial edit can't double-post.
      // (A `running` phase only reaches here with an ackRef — updateRunning
      // returns early without one — so running never posts a fresh message.)
      if (this.ackRef) {
        await this.sender.update(this.ackRef, msg);
      } else {
        await this.sender.send(this.conversation, msg);
      }
    } catch (err) {
      this.logger?.warn(
        { err, phase, channelKind: this.conversation.kind, hasAckRef: Boolean(this.ackRef), description },
        'Failed to deliver neutral task feedback',
      );
    }
  }
}

function ackCardDeliveryRef(ackMessageId: string): DeliveryRef {
  return {
    kind: LARK_KIND,
    // One ack card maps to a single physical message; the physical id doubles
    // as the logical handle here.
    logicalMessageId: ackMessageId,
    revision: 0,
    physicalIds: [ackMessageId],
  };
}

export interface RunningFeedbackCardInput {
  ackMessageId?: string | null;
  description: string;
  progress?: number;
  recentActivity?: string[];
  workDir?: string;
}

/**
 * Update the primary task-feedback "running" card through the neutral
 * {@link ChannelSender}. This is behavior-identical to
 * ThreePhaseFeedback.updateRunning: it builds the same `buildRunningCard(...)`
 * and PATCHes the same ack message — the `native` outbound carries that card so
 * LarkChannel.update calls FeishuClient.updateMessage with the same arguments.
 * Card-update failures are swallowed (warn) so they never crash task execution.
 */
export async function updateRunningFeedbackCard(
  sender: ChannelSender | null,
  input: RunningFeedbackCardInput,
  logger?: Logger,
): Promise<void> {
  if (!sender || !input.ackMessageId) return;
  try {
    const card: InteractiveCard = buildRunningCard(
      input.description,
      input.progress,
      input.recentActivity,
      input.workDir,
    );
    const msg: OutboundMessage = { kind: 'native', payload: card };
    await sender.update(ackCardDeliveryRef(input.ackMessageId), msg);
  } catch (err) {
    logger?.warn(
      { err, ackMessageId: input.ackMessageId, description: input.description },
      'Failed to update running card',
    );
  }
}
