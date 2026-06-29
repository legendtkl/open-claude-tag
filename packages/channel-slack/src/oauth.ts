/**
 * Slack OAuth v2 code exchange — the install-time `oauth.v2.access` call that
 * mints a workspace's bot token (Slack Milestone 1b, ADR-0014). A thin
 * fetch-based wrapper (no `@slack/*` SDK) so tests inject a mock `fetch`.
 *
 * `oauth.v2.access` already returns `bot_user_id` + `team` + `app_id` alongside
 * the bot token, so NO separate `auth.test` is needed.
 *
 * SECURITY: a token (bot `access_token`, or a rotation `refresh_token`) is NEVER
 * placed in a thrown error message or otherwise returned for logging. On a Slack
 * application error (`ok:false`) we surface only the coarse Slack `error` CODE
 * (e.g. `invalid_code`), which carries no secret. The caller persists ONLY the
 * bot token and a sanitized payload (see {@link buildSanitizedSlackInstallation}).
 */

const SLACK_OAUTH_ACCESS_URL = 'https://slack.com/api/oauth.v2.access';

/** The `oauth.v2.access` JSON response (the fields M1b reads). */
interface SlackOAuthAccessResponse {
  ok: boolean;
  error?: string;
  access_token?: string;
  token_type?: string;
  scope?: string;
  bot_user_id?: string;
  app_id?: string;
  team?: { id?: string; name?: string } | null;
  authed_user?: { id?: string; scope?: string; access_token?: string; token_type?: string } | null;
  // Token-rotation fields (present only when the app enables rotation). NOT
  // persisted by M1b; surfaced so a caller can detect rotation.
  expires_in?: number;
  refresh_token?: string;
  is_enterprise_install?: boolean;
}

/** The authorizing Slack user, reduced to NON-secret fields (no user token). */
export interface SlackOAuthAuthedUser {
  id?: string;
  scope?: string;
}

/** Parsed, non-secret-except-`accessToken` result of a successful code exchange. */
export interface SlackOAuthResult {
  /** The bot token (`xoxb-…`, or `xoxe-…` when rotation is enabled). */
  accessToken: string;
  tokenType?: string;
  scope?: string;
  botUserId: string;
  appId: string;
  team: { id: string; name?: string };
  authedUser?: SlackOAuthAuthedUser;
  /** Rotation: seconds until the bot token expires (rotation-enabled apps only). */
  expiresIn?: number;
  isEnterpriseInstall?: boolean;
}

export interface ExchangeSlackOAuthCodeInput {
  /** The temporary authorization `code` from the OAuth redirect. */
  code: string;
  clientId: string;
  clientSecret: string;
  /**
   * MUST be byte-identical to the `redirect_uri` used in the authorize step (or
   * omitted in BOTH when the app has a single configured redirect). Slack rejects
   * a mismatch.
   */
  redirectUri?: string;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

/**
 * Exchange an OAuth authorization `code` for a workspace bot token via
 * `POST https://slack.com/api/oauth.v2.access` (`application/x-www-form-urlencoded`).
 *
 * Throws (never returning a token in the message) when:
 *  - the HTTP request itself fails (`res.ok === false`),
 *  - Slack returns `ok:false` (message carries only the Slack `error` code), or
 *  - a required field (`access_token` / `bot_user_id` / `app_id` / `team.id`) is
 *    absent.
 */
export async function exchangeSlackOAuthCode(
  input: ExchangeSlackOAuthCodeInput,
): Promise<SlackOAuthResult> {
  const fetchImpl = input.fetch ?? fetch;
  const params = new URLSearchParams({
    code: input.code,
    client_id: input.clientId,
    client_secret: input.clientSecret,
  });
  if (input.redirectUri) params.set('redirect_uri', input.redirectUri);

  const res = await fetchImpl(SLACK_OAUTH_ACCESS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  // A non-2xx is a transport-level failure; never include the request body.
  if (!res.ok) {
    throw new Error(`Slack oauth.v2.access request failed with HTTP ${res.status}`);
  }

  const json = (await res.json()) as SlackOAuthAccessResponse;
  if (!json.ok) {
    // Only the coarse Slack error code — no token can appear here.
    throw new Error(`Slack oauth.v2.access failed: ${json.error ?? 'unknown_error'}`);
  }

  const accessToken = json.access_token;
  const botUserId = json.bot_user_id;
  const appId = json.app_id;
  const teamId = json.team?.id;
  if (!accessToken || !botUserId || !appId || !teamId) {
    // Do NOT echo the (partial) payload — it may contain a token.
    throw new Error('Slack oauth.v2.access response missing required fields');
  }

  const authedUser: SlackOAuthAuthedUser | undefined = json.authed_user
    ? {
        ...(json.authed_user.id ? { id: json.authed_user.id } : {}),
        ...(json.authed_user.scope ? { scope: json.authed_user.scope } : {}),
      }
    : undefined;

  return {
    accessToken,
    ...(json.token_type ? { tokenType: json.token_type } : {}),
    ...(json.scope ? { scope: json.scope } : {}),
    botUserId,
    appId,
    team: { id: teamId, ...(json.team?.name ? { name: json.team.name } : {}) },
    ...(authedUser ? { authedUser } : {}),
    ...(typeof json.expires_in === 'number' ? { expiresIn: json.expires_in } : {}),
    ...(typeof json.is_enterprise_install === 'boolean'
      ? { isEnterpriseInstall: json.is_enterprise_install }
      : {}),
  };
}

/**
 * Build the audit `installation` jsonb persisted on the `slack_installations`
 * row: the non-secret facts about an install. It DELIBERATELY omits every token
 * (`access_token`, the authorizing user's `access_token`, and any
 * `refresh_token`) — only `bot_token` is persisted, in its own column.
 */
export function buildSanitizedSlackInstallation(result: SlackOAuthResult): Record<string, unknown> {
  return {
    team: result.team,
    bot_user_id: result.botUserId,
    app_id: result.appId,
    ...(result.scope ? { scope: result.scope } : {}),
    ...(result.tokenType ? { token_type: result.tokenType } : {}),
    ...(result.authedUser ? { authed_user: result.authedUser } : {}),
    ...(typeof result.isEnterpriseInstall === 'boolean'
      ? { is_enterprise_install: result.isEnterpriseInstall }
      : {}),
  };
}
