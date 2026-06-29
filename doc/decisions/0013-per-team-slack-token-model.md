# 0013. Per-team Slack bot-token model (one app, one signing secret, many bot tokens)

| Field | Value |
|-------|-------|
| Status | Accepted |
| Date | 2026-06-29 |

## Context

Slack support (issue #21) shipped against a SINGLE global bot identity: the API
read `SLACK_BOT_TOKEN` / `SLACK_BOT_USER_ID` and the worker read `SLACK_BOT_TOKEN`,
each baked in once at startup (`apps/api/src/server.ts`, `apps/worker/src/main.ts`).
That ties the deployment to exactly one Slack workspace: the @-mention addressing
gate compares against one bot user id, the inbound ACK posts with one token, and the
worker's terminal-delivery posts with one token. A second workspace cannot work —
its `team_id` has no token and its bot user id never matches the gate.

Feishu already solved the equivalent multi-tenant problem with a per-app credential
table (`feishu_apps`) plus a fail-closed, per-creator console-ownership model and a
worker per-app client registry. Slack should mirror that precedent rather than
inventing a new shape.

Slack differs from Feishu in one structural way: ONE Slack app (one `client_id` /
`signing_secret`) installs into MANY workspaces, each install minting its own bot
token + bot user id keyed on `team_id`. The signing secret is app-level (it verifies
inbound request signatures, `verify-signature.ts`); the bot token is install-level
(per workspace). So the two levels must not be collapsed into one row the way Feishu
collapses app == install.

This ADR covers Milestone 1a only: the per-team bot-token STORE plus its resolution
and admin CRUD. OAuth auto-provisioning (`oauth.v2.access` code exchange, the
install-start/callback routes) and `app_uninstalled` handling are deferred to a
separate Milestone 1b.

> **Update (Milestone 1b, DELIVERED):** the deferred OAuth install flow and
> `app_uninstalled` / `tokens_revoked` handling have shipped — see
> [ADR-0014](0014-slack-oauth-install-and-app-uninstall.md). It adds the
> `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET`-gated install-start + callback routes
> (signed-state CSRF, owner-preserving upsert) and the lifecycle disable path,
> building on this store.

## Decision

1. **One app, one signing secret, many per-team bot tokens.** Keep
   `SLACK_SIGNING_SECRET` in env, untouched — there is exactly one Slack app, so the
   request-signature verify path is unchanged and NO `slack_apps` table is added in
   M1a. Add a `slack_installations` table keyed on a unique `team_id`, modeled
   cell-for-cell on `feishu_apps`: `bot_token` (text, nullable) + `bot_token_ref`
   (NOT NULL, default `'stored'`) reuse the `appSecret`/`appSecretRef` env-ref-vs-
   stored convention; `platform_owner_id` (FK → `platform_users`, ON DELETE SET NULL)
   reuses the fail-closed ownership model; `bot_user_id`, `team_name`, `bot_name`,
   `status`, plus an audit `installation` jsonb for the future OAuth payload.

2. **Rows are admin-CRUD managed in M1a.** `GET/POST/PATCH/DELETE
   /admin/slack-installations` clone the Feishu-app routes and ownership helpers
   (`slackInstallationOwnerFilter` / `visibleSlackInstallationFilter`,
   `assertOwnsRow`, the soft-delete sentinel). A creating SSO user is stamped as
   `platform_owner_id`; a token/loopback admin creates an ops-owned (NULL) row.

3. **Token never leaves the store.** The DTO exposes `hasStoredToken`
   (`Boolean(bot_token)`) and NEVER the token itself — the mirror of
   `FeishuAppDto.hasStoredSecret`.

4. **Env vars are a synthetic single-workspace install (fallback), gated on zero
   rows.** `SLACK_BOT_TOKEN` / `SLACK_BOT_USER_ID` keep working for an existing
   single-workspace deploy, but ONLY when there are zero enabled `slack_installations`
   rows. Once any per-team row exists the deploy is multi-workspace, so an unknown
   `team_id` resolves to NOTHING (fail-closed) rather than borrowing another
   workspace's token. A known team always uses its own row. This was tightened from a
   blanket "fall back to env on any miss" after the Codex design gate flagged that a
   blanket fallback could post into the wrong workspace once per-team rows exist.

5. **Both the API and the worker resolve from the SAME store.** Unlike Feishu — where
   the central API owns the only WSClient and daemons hold nothing — Slack has no
   central socket, so the worker reads the bot token directly to deliver terminal
   feedback. The API ACK path resolves per request (`slack-installation-resolver.ts`:
   per-team bot user id for the @-mention gate + per-team `SlackChannel` for the ACK);
   the worker resolves per task by `constraints.tenantKey` (the Slack `team_id`)
   through a `WorkerSlackClientRegistry` that mirrors the Feishu client registry. The
   worker's terminal-delivery contract stays no-throw / null-skip: a missing install
   logs and skips, never failing a completed task.

## Consequences

- More than one Slack workspace now works: each `team_id`'s @-mention gate, inbound
  ACK, and terminal delivery use that workspace's own bot identity.
- A single-workspace deploy is unchanged: with no rows, the env vars still serve as
  the one install (and the existing no-token → no-ACK degradation + startup warning
  are preserved).
- Ownership is per-creator and fail-closed, consistent with the Server-Centralized
  Invariants: a user sees/mutates only their own installations; NULL-owner rows are
  superadmin-only.
- The signing path and the Lark path are untouched.
- A stored bot token is cheaply format-checked (`xoxb-` prefix) on create/patch to
  catch paste errors. Live `auth.test` validation, `team_id`-match enforcement, and
  bot-user-id derivation are deferred to M1b, where OAuth's `oauth.v2.access` returns
  the token + `team_id` + `bot_user_id` together and validates them authoritatively
  (this matches the Feishu precedent, which does not live-validate a secret on
  create). An enabled installation is still required to carry a usable token source,
  re-checked on patch, so a row cannot be left "enabled but dead".

## Alternatives Considered

- **A sibling `slack_apps` table now (app-level client_id/secret/signing_secret) that
  installations FK to.** Cleaner once OAuth and multiple Slack apps exist, but M1a
  has exactly one app and keeps the signing secret in env, so the extra table would
  be unused scaffolding. Deferred to M1b when OAuth actually needs `client_id` /
  `client_secret`.
- **Build OAuth auto-provisioning now.** Out of scope for M1a; it is a distinct,
  larger surface (redirect/callback, code exchange, state signing, `app_uninstalled`)
  and is explicitly Milestone 1b.
- **Blanket env fallback on any team miss.** Rejected per the Codex design gate: once
  per-team rows exist it could deliver into the wrong workspace. Restricted to the
  zero-rows (true single-workspace) case.
- **Team-scoping the inbound dedupe key.** Considered, but Slack `event_id` and
  channel ids are globally unique and the neutral task id already includes
  `installationId`, so no collision exists; left unchanged to avoid touching the
  channel adapter outside the token-store scope.
