/**
 * Resolve the per-team Slack bot identity for the API ACK path (Slack Milestone
 * 1a, ADR-0013). Two seams the inbound-dispatch wiring needs:
 *
 *  - {@link SlackInstallationResolver.resolveBotUserId} — the `bot_user_id` for the
 *    inbound @-mention addressing gate, keyed on the Slack `team_id`.
 *  - {@link SlackInstallationResolver.resolveSender} — a {@link SlackChannel} built
 *    from the team's stored/env bot token, doubling as the neutral ACK sender.
 *
 * Fallback rule (Copilot M1a review): the env defaults (`SLACK_BOT_TOKEN` /
 * `SLACK_BOT_USER_ID`) act as a SYNTHETIC single-workspace install ONLY in
 * single-workspace mode — defined as ZERO non-deleted `slack_installations` rows
 * of ANY status. The moment any non-deleted row exists (enabled OR disabled) the
 * deploy is multi-workspace, and the env token is NEVER a fallback: an unknown
 * team, an empty-string installation id, or a known-but-DISABLED team all resolve
 * to nothing (fail-closed) rather than borrowing some other workspace's token. A
 * known ENABLED team always uses its own row (never the env fallback).
 */
import {
  getSlackInstallationByTeamId,
  hasAnySlackInstallation,
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
  /** TTL for the cached "any non-deleted installation exists?" probe (default 5s). */
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

  let hasInstall: boolean | undefined;
  let hasInstallAt = 0;

  function channelFor(token: string): SlackChannel {
    let channel = channelsByToken.get(token);
    if (!channel) {
      channel = createChannel(token);
      channelsByToken.set(token, channel);
    }
    return channel;
  }

  /**
   * Whether ANY non-deleted installation row exists (enabled OR disabled) — gates
   * the env fallback (see the module header). Cached with a short TTL so the hot
   * inbound path does not query on every event. This is the cross-workspace SAFETY
   * gate, so it fails CLOSED: ANY probe error is treated as "rows exist"
   * (`true` ⇒ NO env fallback) regardless of any cached value, so a transient DB
   * error can never make an unknown team borrow the env token — not even right
   * after a cached single-workspace (`false`) answer once the first install lands
   * (Copilot M1a review). The cache is left untouched so the next call re-probes
   * and self-heals when the DB recovers.
   */
  async function anyInstallation(): Promise<boolean> {
    if (hasInstall !== undefined && Date.now() - hasInstallAt < ttl) return hasInstall;
    try {
      hasInstall = await hasAnySlackInstallation(options.getDb());
      hasInstallAt = Date.now();
    } catch (err) {
      options.logger?.warn({ err }, 'Slack installation probe failed; failing closed (no env fallback)');
      // Fail closed: assume multi-workspace on ANY error (never reuse a stale
      // `false`), so a DB blip cannot resurrect a cross-workspace env borrow.
      return true;
    }
    return hasInstall;
  }

  return {
    async resolveBotUserId(installationId) {
      const teamId = installationId?.trim();
      if (teamId) {
        try {
          const row = await getSlackInstallationByTeamId(options.getDb(), teamId);
          // An ENABLED row exists ⇒ use its bot user id ONLY (no env borrow).
          if (row) return row.botUserId?.trim() || undefined;
        } catch (err) {
          options.logger?.warn(
            { err, installationId },
            'Slack bot-user-id lookup failed; falling through to single-workspace rule',
          );
        }
      }
      // No enabled row for this team (unknown / disabled-only / empty id): env
      // fallback ONLY in single-workspace mode (zero non-deleted rows).
      return (await anyInstallation()) ? undefined : defaultBotUserId;
    },

    async resolveSender(installationId) {
      const teamId = installationId?.trim();
      if (teamId) {
        try {
          const row = await getSlackInstallationByTeamId(options.getDb(), teamId);
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
      }
      // No enabled row for this team (unknown / disabled-only / empty id): env
      // sender ONLY in single-workspace mode (zero non-deleted rows).
      return (await anyInstallation()) ? undefined : envSender;
    },
  };
}
