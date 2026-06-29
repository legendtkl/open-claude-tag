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
 * Fallback rule (Codex M1a design-gate finding 1): the env `SLACK_BOT_TOKEN`
 * (`primarySender`) is a SYNTHETIC single-workspace install used ONLY when there
 * are zero enabled rows. Once any per-team row exists the deploy is
 * multi-workspace, so an unknown team resolves to `null` (skip — never borrow
 * another workspace's token). A `null` here NEVER fails a completed task: the
 * caller (`resolveTaskChannelSender`) logs and skips delivery.
 */
import type { Logger } from 'pino';
import type { Database } from '@open-tag/storage';
import { listEnabledSlackInstallations, resolveSlackInstallationToken } from '@open-tag/storage';
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
  // The COUNT of enabled rows (independent of how many resolved to a usable
  // token): the cross-workspace fallback gate keys on this, NOT on the client map
  // size, so an enabled-but-tokenless row still suppresses the env fallback rather
  // than letting an unknown team borrow the env token (Codex impl-gate finding 1).
  let enabledRowCount = 0;
  let lastRefreshAt = 0;
  let refreshPromise: Promise<void> | null = null;
  const refreshIntervalMs = options.refreshIntervalMs ?? 5_000;

  async function reload(): Promise<void> {
    if (refreshPromise) {
      await refreshPromise;
      return;
    }
    refreshPromise = (async () => {
      const rows = await listEnabledSlackInstallations(options.db);
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
      enabledRowCount = rows.length;
      lastRefreshAt = Date.now();
    })().finally(() => {
      refreshPromise = null;
    });
    await refreshPromise;
  }

  // Best-effort refresh: a reload failure keeps the previous map (never throws at
  // delivery time so a transient DB blip cannot fail an already-completed task).
  async function ensureFresh(force = false): Promise<void> {
    const isStale = Date.now() - lastRefreshAt >= refreshIntervalMs;
    if (!force && !isStale) return;
    try {
      await reload();
    } catch (err) {
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
      // No team ⇒ legacy/no-team job: only the env fallback can serve it.
      if (!teamId) return primarySender;
      const hit = clientsByTeamId.get(teamId);
      if (hit) return hit;
      // A miss may mean an install added after startup — force one refresh.
      await ensureFresh(true);
      const refreshed = clientsByTeamId.get(teamId);
      if (refreshed) return refreshed;
      // Env fallback only in single-workspace mode (zero ENABLED rows); otherwise a
      // genuine unknown team — or an enabled row whose token did not resolve — must
      // NOT borrow another workspace's token (Codex impl-gate finding 1).
      return enabledRowCount === 0 ? primarySender : null;
    },
  };
}
