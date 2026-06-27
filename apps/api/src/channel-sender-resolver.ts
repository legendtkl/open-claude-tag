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
 * The per-request runtime context a sender factory resolves from. Today it only
 * carries the resolved Feishu app context (the lark factory reads its client). A
 * future Slack OAuth slice adds its own field here, so the resolution context
 * stays honest rather than pretending a Feishu context models every channel.
 */
export interface ChannelSenderResolutionContext {
  feishuAppContext: FeishuAppRuntimeContext;
}

/** Build a {@link FeedbackChannelSender} for one channel kind from the per-request context. */
type ChannelSenderFactory = (ctx: ChannelSenderResolutionContext) => FeedbackChannelSender;

/**
 * The registered sender factory per channel kind.
 *
 *  - `lark` yields exactly the prior `createFeishuChannelSender(appContext.client)`,
 *    so the Feishu dispatch path is byte-identical.
 *  - `slack` is a registered-but-unconfigured slot: it fails fast with a distinct
 *    "not configured yet" message until the Slack OAuth slice wires a real
 *    client/token into the resolution context.
 *
 * A reply must never silently drop or fall back to another vendor, so an
 * unregistered kind also throws (see {@link resolveChannelSender}).
 */
const CHANNEL_SENDER_FACTORIES: Partial<Record<ChannelKind, ChannelSenderFactory>> = {
  lark: (ctx) => createFeishuChannelSender(ctx.feishuAppContext.client),
  slack: () => {
    throw new Error('Channel sender for channel kind "slack" is not configured yet');
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
