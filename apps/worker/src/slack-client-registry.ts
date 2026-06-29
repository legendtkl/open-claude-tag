/**
 * Per-team Slack sender registry for the worker's terminal-feedback delivery
 * (Slack Milestone 1a, ADR-0013). The worker mirror of
 * {@link createWorkerFeishuClientRegistry}: it loads the enabled
 * `slack_installations` rows into a `Map<team_id, SlackChannel>` and resolves a
 * task's sender by its `team_id` (the neutral dispatch stamps it as
 * `constraints.tenantKey`), so a Slack-dispatched task's done/failed delivery
 * reaches ITS OWN workspace's channel instead of a single global token.
 *
 * Unlike the Feishu registry there is NO "primary required" invariant: a worker
 * with no Slack token at all is valid (Slack delivery just skips). And unlike
 * Feishu (where the central API owns the only WS client), the worker reads the
 * Slack bot token directly — Slack has no central socket, so both API and worker
 * resolve from the SAME store.
 *
 * Fallback rule (Copilot M1a review): the env `SLACK_BOT_TOKEN`
 * (`primarySender`) is a SYNTHETIC single-workspace install used ONLY in
 * single-workspace mode — defined as ZERO non-deleted rows of ANY status
 * (enabled OR disabled). The moment any non-deleted row exists the deploy is
 * multi-workspace, so an unknown team — or a known-but-disabled team — resolves
 * to `null` (skip — never borrow another workspace's token). A `null` here NEVER
 * fails a completed task: the caller (`resolveTaskChannelSender`) logs and skips
 * delivery.
 */
import type { Logger } from 'pino';
import type { Database } from '@open-tag/storage';
import {
  hasAnySlackInstallation,
  listEnabledSlackInstallations,
  resolveSlackInstallationToken,
} from '@open-tag/storage';
import { SlackChannel } from '@open-tag/channel-slack';

export interface WorkerSlackClientRegistryOptions {
  db: Database;
  /** Env `SLACK_BOT_TOKEN`; the single-workspace fallback sender. Empty ⇒ none. */
  primaryToken: string;
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  createChannel?: (token: string) => SlackChannel;
  refreshIntervalMs?: number;
}

export interface WorkerSlackClientRegistry {
  /** The env-built single-workspace fallback sender (or null when no env token). */
  primarySender: SlackChannel | null;
  registeredTeamIds(): string[];
  /** Resolve the sender for a team id; see the module header for the fallback rule. */
  getClient(teamId?: string | null): Promise<SlackChannel | null>;
  reload(): Promise<void>;
}

export async function createWorkerSlackClientRegistry(
  options: WorkerSlackClientRegistryOptions,
): Promise<WorkerSlackClientRegistry> {
  const createChannel =
    options.createChannel ?? ((token: string) => new SlackChannel({ token }));
  const primaryToken = options.primaryToken?.trim() ?? '';
  const primarySender = primaryToken ? createChannel(primaryToken) : null;

  const clientsByTeamId = new Map<string, SlackChannel>();
  // Whether ANY non-deleted row exists (enabled OR disabled), independent of how
  // many enabled rows resolved to a usable token: the cross-workspace fallback
  // gate keys on this, NOT on the client map size, so an enabled-but-tokenless row
  // OR a disabled-only row still suppresses the env fallback rather than letting an
  // unknown team borrow the env token (Copilot M1a review).
  let hasAnyInstall = false;
  let lastRefreshAt = 0;
  let refreshPromise: Promise<void> | null = null;
  const refreshIntervalMs = options.refreshIntervalMs ?? 5_000;

  async function reload(): Promise<void> {
    if (refreshPromise) {
      await refreshPromise;
      return;
    }
    refreshPromise = (async () => {
      // Read BOTH queries BEFORE mutating any shared state. The gate flag and the
      // client map must move together: if either query throws, neither is applied,
      // so a failure truly keeps the PREVIOUS consistent snapshot (no torn refresh
      // where a new map pairs with a stale gate flag — Copilot M1a review).
      const rows = await listEnabledSlackInstallations(options.db);
      // Gate on ANY non-deleted row (enabled OR disabled), not just the enabled
      // rows loaded above, so a disabled-only deploy still suppresses env fallback.
      const anyInstall = await hasAnySlackInstallation(options.db);
      const next = new Map<string, SlackChannel>();
      for (const row of rows) {
        const token = resolveSlackInstallationToken(row, options.env);
        if (!token) {
          options.logger?.warn(
            { slackInstallationId: row.id, teamId: row.teamId, botTokenRef: row.botTokenRef },
            'Skipping Slack installation because its bot token is unavailable',
          );
          continue;
        }
        next.set(row.teamId, createChannel(token));
      }
      clientsByTeamId.clear();
      for (const [teamId, channel] of next) clientsByTeamId.set(teamId, channel);
      hasAnyInstall = anyInstall;
      lastRefreshAt = Date.now();
    })().finally(() => {
      refreshPromise = null;
    });
    await refreshPromise;
  }

  // Best-effort refresh: a reload failure keeps the previous client map (never
  // throws at delivery time so a transient DB blip cannot fail an already-completed
  // task) AND fails CLOSED on the env-fallback gate — a reload error may hide a
  // freshly-added install, so assume multi-workspace until a reload succeeds rather
  // than risk borrowing the env token for an unknown team (Copilot M1a review).
  async function ensureFresh(force = false): Promise<void> {
    const isStale = Date.now() - lastRefreshAt >= refreshIntervalMs;
    if (!force && !isStale) return;
    try {
      await reload();
    } catch (err) {
      hasAnyInstall = true;
      options.logger?.warn({ err }, 'Keeping previous Slack client registry after reload failed');
    }
  }

  await reload();

  return {
    primarySender,
    registeredTeamIds: () => [...clientsByTeamId.keys()],
    reload,
    getClient: async (teamId) => {
      await ensureFresh();
      const key = teamId?.trim();
      if (key) {
        const hit = clientsByTeamId.get(key);
        if (hit) return hit;
        // A miss may mean an install added after startup — force one refresh.
        await ensureFresh(true);
        const refreshed = clientsByTeamId.get(key);
        if (refreshed) return refreshed;
      }
      // No enabled per-team channel for this team (unknown / disabled-only / no
      // team id): env fallback ONLY in single-workspace mode (zero non-deleted
      // rows). Otherwise a genuine unknown team — or an enabled row whose token did
      // not resolve — must NOT borrow another workspace's token (Copilot M1a review).
      return hasAnyInstall ? null : primarySender;
    },
  };
}
