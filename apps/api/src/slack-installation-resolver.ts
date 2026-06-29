/**
 * Resolve the per-team Slack bot identity for the API ACK path (Slack Milestone
 * 1a, ADR-0013). Two seams the inbound-dispatch wiring needs:
 *
 *  - {@link SlackInstallationResolver.resolveBotUserId} — the `bot_user_id` for the
 *    inbound @-mention addressing gate, keyed on the Slack `team_id`.
 *  - {@link SlackInstallationResolver.resolveSender} — a {@link SlackChannel} built
 *    from the team's stored/env bot token, doubling as the neutral ACK sender.
 *
 * Fallback rule (Codex M1a design-gate finding 1): the env defaults
 * (`SLACK_BOT_TOKEN` / `SLACK_BOT_USER_ID`) act as a SYNTHETIC single-workspace
 * install, but ONLY when there are zero enabled `slack_installations` rows. Once
 * any per-team row exists the deploy is multi-workspace, so an unknown team
 * resolves to nothing (fail-closed) rather than borrowing the env token of some
 * other workspace. A known team always uses its own row (never the env fallback).
 */
import {
  getSlackInstallationByTeamId,
  listEnabledSlackInstallations,
  resolveSlackInstallationToken,
} from '@open-tag/storage';
import type { Database } from '@open-tag/storage';
import type { Logger } from '@open-tag/observability';
import { SlackChannel } from '@open-tag/channel-slack';

export interface SlackInstallationResolver {
  resolveBotUserId(installationId: string | undefined): Promise<string | undefined>;
  resolveSender(installationId: string | undefined): Promise<SlackChannel | undefined>;
}

export interface SlackInstallationResolverOptions {
  /** Read at call time (the API assigns `db` during async startup). */
  getDb: () => Database;
  env?: NodeJS.ProcessEnv;
  /** Single-workspace fallback bot token (`SLACK_BOT_TOKEN`); absent ⇒ no env sender. */
  defaultBotToken?: string;
  /** Single-workspace fallback bot user id (`SLACK_BOT_USER_ID`). */
  defaultBotUserId?: string;
  /** Override channel construction in tests. */
  createChannel?: (token: string) => SlackChannel;
  logger?: Logger;
  /** TTL for the cached "any enabled installation exists?" probe (default 5s). */
  enabledProbeTtlMs?: number;
}

export function createSlackInstallationResolver(
  options: SlackInstallationResolverOptions,
): SlackInstallationResolver {
  const env = options.env ?? process.env;
  const createChannel = options.createChannel ?? ((token: string) => new SlackChannel({ token }));
  const ttl = options.enabledProbeTtlMs ?? 5_000;
  const defaultBotUserId = options.defaultBotUserId?.trim() || undefined;
  // Cache SlackChannel instances by token so repeated ACKs reuse one client.
  const channelsByToken = new Map<string, SlackChannel>();
  const envSender = options.defaultBotToken?.trim()
    ? channelFor(options.defaultBotToken.trim())
    : undefined;

  let hasEnabled: boolean | undefined;
  let hasEnabledAt = 0;

  function channelFor(token: string): SlackChannel {
    let channel = channelsByToken.get(token);
    if (!channel) {
      channel = createChannel(token);
      channelsByToken.set(token, channel);
    }
    return channel;
  }

  /**
   * Whether ANY enabled installation row exists — gates the env fallback (see the
   * module header). Cached with a short TTL so the hot inbound path does not query
   * on every event. This is the cross-workspace SAFETY gate, so it fails CLOSED: a
   * probe failure with no prior successful answer is treated as "rows exist"
   * (`true` ⇒ NO env fallback for an unknown team), so a transient DB error can
   * never make an unknown team borrow the env token. A previously-known answer is
   * kept on failure (Codex impl-gate finding 2).
   */
  async function anyEnabledInstallation(): Promise<boolean> {
    if (hasEnabled !== undefined && Date.now() - hasEnabledAt < ttl) return hasEnabled;
    try {
      const rows = await listEnabledSlackInstallations(options.getDb());
      hasEnabled = rows.length > 0;
      hasEnabledAt = Date.now();
    } catch (err) {
      options.logger?.warn({ err }, 'Slack installation probe failed; failing closed (no env fallback)');
      // Fail closed: assume multi-workspace until a probe succeeds.
      return hasEnabled ?? true;
    }
    return hasEnabled;
  }

  return {
    async resolveBotUserId(installationId) {
      if (!installationId) return defaultBotUserId;
      try {
        const row = await getSlackInstallationByTeamId(options.getDb(), installationId);
        // A row exists ⇒ use its bot user id ONLY (no env borrow across workspaces).
        if (row) return row.botUserId?.trim() || undefined;
      } catch (err) {
        options.logger?.warn(
          { err, installationId },
          'Slack bot-user-id lookup failed; falling through to single-workspace rule',
        );
      }
      // No row: env fallback only in single-workspace mode (no enabled rows).
      return (await anyEnabledInstallation()) ? undefined : defaultBotUserId;
    },

    async resolveSender(installationId) {
      if (!installationId) return envSender;
      try {
        const row = await getSlackInstallationByTeamId(options.getDb(), installationId);
        if (row) {
          const token = resolveSlackInstallationToken(row, env);
          return token ? channelFor(token) : undefined;
        }
      } catch (err) {
        options.logger?.warn(
          { err, installationId },
          'Slack sender lookup failed; falling through to single-workspace rule',
        );
      }
      return (await anyEnabledInstallation()) ? undefined : envSender;
    },
  };
}
