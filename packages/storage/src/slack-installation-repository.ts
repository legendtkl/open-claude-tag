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

/**
 * Raised when an OAuth re-install targets a `team_id` already owned by a
 * DIFFERENT platform user. The OAuth callback maps this to a 403 and performs NO
 * mutation, so user B can never re-enable, rotate, or hijack user A's workspace
 * install (Codex M1b design-gate finding 1, ADR-0014).
 */
export class SlackInstallationOwnershipError extends Error {
  constructor(readonly teamId: string) {
    super('Slack workspace is already connected by another owner');
    this.name = 'SlackInstallationOwnershipError';
  }
}

/** Input for {@link upsertSlackInstallationFromOAuth}; carries NO user token. */
export interface UpsertSlackInstallationFromOAuthInput {
  teamId: string;
  teamName?: string | null;
  /** The bot token (`xoxb-…`) to store at rest. */
  botToken: string;
  botUserId?: string | null;
  slackAppId?: string | null;
  tenantKey?: string | null;
  /** Sanitized audit payload (NO tokens) — see `buildSanitizedSlackInstallation`. */
  installation?: Record<string, unknown> | null;
  /**
   * The platform user that initiated the install (from the signed OAuth state).
   * `null` ⇒ a token/loopback SUPERADMIN-initiated install: it may update ANY
   * existing row, and a fresh insert is ops-owned (NULL owner). A non-null user
   * may only update a row they already own (mirrors `assertOwnsRow`).
   */
  ownerPlatformUserId: string | null;
}

export interface UpsertSlackInstallationFromOAuthResult {
  teamId: string;
  teamName: string | null;
  /** `true` ⇒ a new install row was created; `false` ⇒ an existing row updated. */
  created: boolean;
}

/**
 * Provision (or re-provision) a workspace's bot install from a completed OAuth
 * exchange (ADR-0014). Atomic on the unique `team_id`, so a re-install UPDATES
 * the existing row instead of creating a duplicate:
 *
 *  - INSERT (new team): stamps `platform_owner_id` from the initiating user;
 *    `status='enabled'`, `bot_token_ref='stored'`.
 *  - UPDATE (existing team, incl. a previously-uninstalled/disabled row): rotates
 *    the bot token + identity, re-enables it, and refreshes the audit payload —
 *    but NEVER changes `platform_owner_id`, so the ORIGINAL owner is preserved.
 *
 * Ownership is enforced BEFORE the update under a row lock: a non-superadmin user
 * may only touch a row they own, else {@link SlackInstallationOwnershipError} is
 * thrown and nothing is mutated.
 */
export async function upsertSlackInstallationFromOAuth(
  db: Database,
  input: UpsertSlackInstallationFromOAuthInput,
): Promise<UpsertSlackInstallationFromOAuthResult> {
  return db.transaction(async (tx) => {
    // Lock the live row for this team (deleted rows carry a mangled team_id, so a
    // real team_id only ever matches the single non-deleted row, if any).
    const [existing] = await tx
      .select()
      .from(slackInstallations)
      .where(eq(slackInstallations.teamId, input.teamId))
      .for('update')
      .limit(1);

    if (existing) {
      const isSuperadmin = input.ownerPlatformUserId === null;
      const ownsRow =
        existing.platformOwnerId !== null &&
        existing.platformOwnerId === input.ownerPlatformUserId;
      if (!isSuperadmin && !ownsRow) {
        throw new SlackInstallationOwnershipError(input.teamId);
      }

      await tx
        .update(slackInstallations)
        .set({
          botToken: input.botToken,
          botTokenRef: 'stored',
          // Write-through on re-install: an omitted optional field PRESERVES the
          // existing value rather than clobbering it (so re-auth never silently
          // drops the audit `installation` payload, the `tenantKey`, or a
          // previously-resolved bot user id). teamName/slackAppId already do this.
          botUserId: input.botUserId ?? existing.botUserId,
          teamName: input.teamName ?? existing.teamName,
          slackAppId: input.slackAppId ?? existing.slackAppId,
          tenantKey: input.tenantKey ?? existing.tenantKey,
          status: 'enabled',
          installation: input.installation ?? existing.installation,
          updatedAt: new Date(),
          // platform_owner_id intentionally omitted: re-install keeps the
          // original owner (Codex M1b design-gate finding 1).
        })
        .where(eq(slackInstallations.id, existing.id));

      return {
        teamId: input.teamId,
        teamName: input.teamName ?? existing.teamName,
        created: false,
      };
    }

    const [row] = await tx
      .insert(slackInstallations)
      .values({
        teamId: input.teamId,
        botToken: input.botToken,
        botTokenRef: 'stored',
        botUserId: input.botUserId ?? undefined,
        teamName: input.teamName ?? undefined,
        slackAppId: input.slackAppId ?? undefined,
        tenantKey: input.tenantKey ?? input.teamId,
        status: 'enabled',
        installation: input.installation ?? undefined,
        platformOwnerId: input.ownerPlatformUserId ?? undefined,
      })
      .returning({ teamName: slackInstallations.teamName });

    return { teamId: input.teamId, teamName: row?.teamName ?? null, created: true };
  });
}

/**
 * Disable a workspace's install when its Slack app is uninstalled or its bot
 * token is revoked (ADR-0014). Sets `status='disabled'` and WIPES the stored bot
 * token, but KEEPS the `team_id` (and `platform_owner_id`) so a later OAuth
 * re-install re-enables the SAME row and preserves the original owner.
 *
 * Distinct from the admin soft-delete, which mangles `team_id` to free the unique
 * index for a user-initiated removal. Idempotent — a missing/already-disabled row
 * is a no-op. Returns whether a row was affected. The unique `team_id` (deleted
 * rows are mangled) means a real `team_id` only ever targets the live row.
 *
 * `opts.eventTimeMs` (the lifecycle event's `event_time`): Slack does NOT
 * guarantee lifecycle ordering, so a stale `app_uninstalled`/`tokens_revoked` can
 * arrive AFTER an OAuth re-install. When provided, this STALE-GUARDS the disable:
 * if the live row was last written in a strictly later second than the event, the
 * event is stale (the row was re-installed after it) and the disable is skipped.
 * The second granularity matches Slack's integer `event_time`, so a sub-second
 * newer legitimate uninstall still fires.
 */
export async function disableSlackInstallationByTeamId(
  db: Database,
  teamId: string,
  opts: { eventTimeMs?: number } = {},
): Promise<boolean> {
  // Single conditional UPDATE (atomic; no read-then-write TOCTOU). The stale guard
  // is a WHERE clause: when an event_time is given, only disable a row whose
  // last-write SECOND is not after the event (second granularity matches Slack's
  // integer event_time, so a sub-second-newer legitimate uninstall still fires).
  const conds = [eq(slackInstallations.teamId, teamId)];
  if (typeof opts.eventTimeMs === 'number') {
    const eventSec = Math.floor(opts.eventTimeMs / 1000);
    conds.push(
      sql`date_trunc('second', ${slackInstallations.updatedAt}) <= to_timestamp(${eventSec})`,
    );
  }
  const [row] = await db
    .update(slackInstallations)
    .set({ status: 'disabled', botToken: null, updatedAt: new Date() })
    .where(and(...conds))
    .returning({ id: slackInstallations.id });
  return row !== undefined;
}
