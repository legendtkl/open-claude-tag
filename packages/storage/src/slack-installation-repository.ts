import { and, eq, sql } from 'drizzle-orm';
import type { Database } from './db.js';
import { slackInstallations } from './schema.js';

/** A row of the per-team Slack bot-token store (Slack Milestone 1a, ADR-0013). */
export type SlackInstallation = typeof slackInstallations.$inferSelect;

/** The credential fields {@link resolveSlackInstallationToken} reads off a row. */
export interface SlackInstallationTokenSource {
  botTokenRef: string;
  botToken: string | null;
}

/**
 * Resolve the usable bot token for an installation, mirroring the Feishu
 * env-ref-vs-stored precedence (worker `resolveSecretRef` + admin
 * `resolveFeishuAppSecret`): an env reference (`env:NAME` or `NAME`) wins when the
 * env var is set, else the stored `botToken`, else `null`. NEVER throws — the
 * API ACK resolver and worker registry treat a `null` as "skip this install"
 * rather than failing a request/task. `'stored'` (the default ref) means "no env
 * ref; use the stored token".
 */
export function resolveSlackInstallationToken(
  row: SlackInstallationTokenSource,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const ref = row.botTokenRef?.trim();
  if (ref && ref !== 'stored' && ref !== 'deleted') {
    const key = ref.startsWith('env:') ? ref.slice('env:'.length) : ref;
    const fromEnv = env[key]?.trim();
    if (fromEnv) return fromEnv;
  }
  const stored = row.botToken?.trim();
  return stored ? stored : null;
}

/**
 * Soft-delete sentinel: a deleted installation has its `team_id` rewritten to a
 * `__deleted__…` value AND its status set to `disabled` (mirrors
 * `admin-api.ts` `buildDeletedSlackTeamId` / `isDeletedSlackInstallationRow`). A
 * NON-deleted row is therefore anything that is NOT (`disabled` AND `__deleted__`-prefixed).
 */
const DELETED_SLACK_TEAM_ID_PREFIX = '__deleted__';

/**
 * Cheap existence probe: does ANY non-deleted `slack_installations` row exist,
 * regardless of status (enabled OR disabled)? This is the single-workspace gate
 * for both the API ACK resolver and the worker delivery registry: when it is
 * `false` the deploy has zero per-team installs, so the env `SLACK_BOT_TOKEN` may
 * act as a synthetic single-workspace install; when it is `true` the deploy is
 * multi-workspace and the env token is NEVER a cross-workspace fallback.
 *
 * Selects a constant (NOT `bot_token`) with `limit(1)`: it must never pull a
 * secret just to count, and must stay O(1) on the inbound hot path.
 */
export async function hasAnySlackInstallation(db: Database): Promise<boolean> {
  const [row] = await db
    .select({ exists: sql<number>`1` })
    .from(slackInstallations)
    .where(
      sql`not (${slackInstallations.status} = 'disabled' and left(${slackInstallations.teamId}, ${DELETED_SLACK_TEAM_ID_PREFIX.length}) = ${DELETED_SLACK_TEAM_ID_PREFIX})`,
    )
    .limit(1);
  return row !== undefined;
}

/**
 * Load the single enabled installation for a Slack `team_id`, or `null` when none
 * exists (or the only row is soft-deleted/disabled). The unique `team_id` index
 * guarantees at most one enabled row per workspace.
 */
export async function getSlackInstallationByTeamId(
  db: Database,
  teamId: string,
): Promise<SlackInstallation | null> {
  const [row] = await db
    .select()
    .from(slackInstallations)
    .where(and(eq(slackInstallations.teamId, teamId), eq(slackInstallations.status, 'enabled')))
    .limit(1);
  return row ?? null;
}

/**
 * Load every enabled installation. Both the API ACK resolver and the worker
 * terminal-delivery registry build their per-team `SlackChannel` map from this.
 */
export async function listEnabledSlackInstallations(db: Database): Promise<SlackInstallation[]> {
  return db
    .select()
    .from(slackInstallations)
    .where(eq(slackInstallations.status, 'enabled'))
    .orderBy(sql`${slackInstallations.updatedAt} desc`);
}
