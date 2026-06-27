/**
 * Resolve the inbound-dispatch ACK/feedback sender BY the inbound message's
 * channel kind (ADR-0004 Stage 1a-iii). The dispatch path used to hardcode the
 * Feishu sender, so a non-Feishu (Slack) inbound would still have been answered
 * through a Feishu client. This seam keys the choice on the neutral
 * {@link ChannelKind} instead, with a clean registered slot per kind.
 *
 * The seam is vendor-neutral (keyed by {@link ChannelKind}); the Feishu sender is
 * still built through `createFeishuChannelSender`, which stays in
 * `@open-tag/feishu-adapter`. No new core->vendor coupling: this lives in the API
 * composition root, which already depends on both packages.
 *
 * Per-app reality: `feishuAppContext.client` is a per-request Feishu client (one
 * per enabled Feishu app), so resolution is `kind -> (context -> sender)`, built
 * fresh per call — never a cached/static sender instance.
 */
import type { ChannelKind } from '@open-tag/channel-core';
import { createFeishuChannelSender } from '@open-tag/feishu-adapter';
import type { FeedbackChannelSender } from '@open-tag/feishu-adapter';
import type { FeishuAppRuntimeContext } from './feishu-app-runtime.js';

/**
 * The per-request runtime context a sender factory resolves from. Each field is
 * the input ONE kind needs, so the context stays honest rather than pretending a
 * Feishu context models every channel: the `lark` factory reads
 * `feishuAppContext.client`; the `slack` factory reads the injected
 * `slackSender`. Both are optional and each factory fails closed when its own
 * input is absent (see {@link CHANNEL_SENDER_FACTORIES}).
 */
export interface ChannelSenderResolutionContext {
  /** Per-request Feishu app context; required to resolve the `lark` sender. */
  feishuAppContext?: FeishuAppRuntimeContext;
  /**
   * The injected `slack` sender (ADR-0005). A `SlackChannel` doubles as a
   * {@link FeedbackChannelSender}; production wires one when a bot token is set,
   * tests inject a recording stub. Absent ⇒ the `slack` slot stays unconfigured.
   */
  slackSender?: FeedbackChannelSender;
}

/** Build a {@link FeedbackChannelSender} for one channel kind from the per-request context. */
type ChannelSenderFactory = (ctx: ChannelSenderResolutionContext) => FeedbackChannelSender;

/**
 * The registered sender factory per channel kind.
 *
 *  - `lark` yields exactly the prior `createFeishuChannelSender(appContext.client)`
 *    (byte-identical), and fails closed when no `feishuAppContext` is supplied —
 *    every lark call site passes one, so lark resolution is unchanged.
 *  - `slack` returns the injected `slackSender` when present, else fails fast with
 *    a distinct "not configured yet" message until a token/sender is wired.
 *
 * A reply must never silently drop or fall back to another vendor, so an
 * unregistered kind also throws (see {@link resolveChannelSender}).
 */
const CHANNEL_SENDER_FACTORIES: Partial<Record<ChannelKind, ChannelSenderFactory>> = {
  lark: (ctx) => {
    if (!ctx.feishuAppContext) {
      throw new Error('Channel sender for channel kind "lark" requires a feishuAppContext');
    }
    return createFeishuChannelSender(ctx.feishuAppContext.client);
  },
  slack: (ctx) => {
    if (!ctx.slackSender) {
      throw new Error('Channel sender for channel kind "slack" is not configured yet');
    }
    return ctx.slackSender;
  },
};

/**
 * Resolve the dispatch-path outbound sender for `kind` from the per-request
 * context. Fails fast (never returns a wrong-vendor or null sender) when no
 * factory is registered for the kind.
 */
export function resolveChannelSender(
  kind: ChannelKind,
  ctx: ChannelSenderResolutionContext,
): FeedbackChannelSender {
  const factory = CHANNEL_SENDER_FACTORIES[kind];
  if (!factory) {
    throw new Error(`No channel sender registered for channel kind "${kind}"`);
  }
  return factory(ctx);
}
