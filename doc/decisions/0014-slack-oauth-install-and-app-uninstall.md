# 0014. Slack OAuth install flow + app_uninstalled auto-provisioning (Milestone 1b)

| Field | Value |
|-------|-------|
| Status | Accepted |
| Date | 2026-06-29 |

## Context

ADR-0013 (Milestone 1a) added the per-team `slack_installations` bot-token store
and its admin CRUD, but explicitly deferred the OAuth surface: minting a token via
`oauth.v2.access`, the install-start / callback routes, and `app_uninstalled`
handling. Until now a workspace was onboarded by an operator hand-pasting a
`xoxb-` token into the admin console.

Milestone 1b delivers the self-service path: ONE Slack app (`client_id` /
`client_secret`) installed into MANY workspaces, each install minting its own bot
token keyed on `team_id`, with the install owned (fail-closed) by the platform
user who started it — mirroring the Feishu one-click registration precedent.

## Decision

1. **Gate on `SLACK_CLIENT_ID` + `SLACK_CLIENT_SECRET`.** Both must be set for the
   `GET /slack/oauth/install` and `GET /slack/oauth/callback` routes to be
   registered; otherwise they 404 (like other unconfigured gated features), and
   the M1a admin-CRUD path keeps working regardless. server.ts reads the env and
   passes a `slackOAuth` config into `registerAdminApiRoutes`; the routes live
   there so they reuse the admin guard, `requireIdentity`, and the store.

2. **Code exchange in `@open-tag/channel-slack`.** `exchangeSlackOAuthCode` POSTs
   `application/x-www-form-urlencoded` to `oauth.v2.access` and parses
   `{ access_token (xoxb), team:{id,name}, bot_user_id, app_id, scope, authed_user }`.
   `oauth.v2.access` already returns `bot_user_id` + `team`, so NO separate
   `auth.test` is needed. It throws on `ok:false` carrying ONLY the Slack error
   CODE (never a token), and on any missing required field.

3. **Stateless, HMAC-signed `state` for CSRF + ownership.** The install-start
   route (behind the admin guard) signs a state token
   `base64url(payload).base64url(HMAC_SHA256(secret, payload))` carrying the
   initiating platform user id (`requireIdentity().scope.platformUserId`, `null`
   for a token/loopback superadmin), a random nonce, and an issued-at. The
   callback constant-time-verifies the HMAC and rejects a token older than a
   10-minute TTL (or future-dated beyond a 60s skew). The signing key is
   `SLACK_STATE_SECRET`, falling back to `SLACK_SIGNING_SECRET`, then
   `SLACK_CLIENT_SECRET` (always present when OAuth is enabled) — all server-only
   secrets. An attacker cannot forge a valid state without the secret, so the
   callback needs no console session and is registered PUBLIC (Slack's browser
   redirect carries no guaranteed cookie). The state user id stamps
   `platform_owner_id` on a fresh install.

4. **Upsert keyed on `team_id`, owner-preserving, ownership-enforced.**
   `upsertSlackInstallationFromOAuth` runs in a transaction that locks the live
   row (`SELECT … FOR UPDATE`). A re-install UPDATES the existing row (rotates the
   bot token + identity, re-enables it, refreshes the sanitized `installation`
   audit payload) instead of creating a duplicate, and NEVER changes
   `platform_owner_id` — the original owner is preserved. Before updating, a
   non-superadmin caller must already own the row, else
   `SlackInstallationOwnershipError` is thrown and NOTHING is mutated (the callback
   maps it to 403). This closes the cross-owner hijack/rotation hole the Codex
   design gate flagged: user B cannot re-enable or rotate user A's workspace.

5. **`app_uninstalled` / bot `tokens_revoked` disable the install.** The pure
   `handleSlackEvent` decision function emits a `lifecycle` outcome for an
   `app_uninstalled` event, or a `tokens_revoked` event whose `tokens.bot` array
   is non-empty (a USER-token-only revocation is ignored, so it cannot take the
   bot install down). The signature-verified + dedupe-contract events handler then
   calls `disableSlackInstallationByTeamId`, which sets `status='disabled'` and
   WIPES the stored bot token but KEEPS the `team_id` (and owner) — so a later
   OAuth re-install re-enables the SAME row and preserves the owner. This is
   distinct from the admin soft-delete, which mangles `team_id` for a
   user-initiated removal. Disabling is idempotent; a failure returns 500 so Slack
   retries.

6. **Token hygiene.** A bot token, the authorizing user's token, an OAuth `code`,
   the `state`, or a rotation `refresh_token` is NEVER logged or placed in a
   response body. The persisted `installation` jsonb is built by
   `buildSanitizedSlackInstallation`, which omits every token. The DTO continues to
   mask the bot token (`hasStoredToken` only, ADR-0013). Only coarse outcomes (a
   failure reason, the `team_id`) are logged.

## Consequences

- A workspace can self-install via OAuth; the initiating console user owns the
  install (fail-closed), consistent with the Server-Centralized Invariants.
- Re-install is safe and idempotent: it rotates the token in place, preserves the
  owner, and a different non-superadmin user is rejected.
- Uninstalling the app (or revoking the bot token) fail-closes that workspace:
  the enabled-only resolver returns nothing, so no ACK/dispatch happens, while the
  non-deleted row keeps the env single-workspace fallback OFF (ADR-0013).
- The signing path, the M1a admin-CRUD path, and the Lark path are untouched.

## Alternatives Considered

- **A server-side one-use nonce store for `state`.** Strictly stronger against a
  leaked-state replay within the TTL window, but it adds a table + cleanup for a
  human-paced, short-lived (10-min), HMAC-unforgeable flow. Deferred as a future
  hardening (Codex M1b design gate finding 4); the stateless signed state with a
  short TTL and a strict never-log rule is the accepted M1b trade-off.
- **Treat every `tokens_revoked` as an uninstall.** Rejected per the Codex design
  gate: `tokens_revoked` separates `oauth` (user) from `bot` tokens, so a
  user-token-only revocation must not disable the bot install. We disable only when
  `tokens.bot` is non-empty.
- **`onConflictDoUpdate` without an ownership check.** Rejected: preserving
  `platform_owner_id` alone still lets user B silently re-enable/rotate user A's
  install. The explicit `SELECT … FOR UPDATE` + ownership assert is required.
- **OAuth token rotation (xoxe / `refresh_token` / `expires_in`).** Out of scope
  for M1b. The helper surfaces rotation fields but the callback persists only the
  bot `access_token` and never stores/refreshes a `refresh_token`. Refresh support
  is deferred.
- **A sibling `slack_apps` table for the app-level client credentials.** Still not
  needed — there is exactly one Slack app, and `client_id` / `client_secret` live
  in env (the M1a ADR-0013 deferral). Revisit if multiple Slack apps are required.
