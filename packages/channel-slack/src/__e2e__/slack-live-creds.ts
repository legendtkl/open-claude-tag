/**
 * Credential-presence detection for the opt-in live Slack e2e command. Pure and
 * injectable (env) so it is unit-testable without touching the host. NEVER
 * reads, logs, or returns credential VALUES — only WHETHER both required env
 * vars are present, which gates the self-skip in the live e2e.
 */
export interface SlackCredProbe {
  env?: NodeJS.ProcessEnv;
}

function hasValue(value: string | undefined): boolean {
  return (value ?? '').trim().length > 0;
}

/**
 * The live Slack e2e has credentials when BOTH `SLACK_BOT_TOKEN` (an `xoxb-…`
 * bot token) and `SLACK_E2E_CHANNEL_ID` (a channel the bot is a member of) are
 * set and non-empty. Missing or blank either one → absent → the live test
 * self-skips (exit 0, not failed).
 *
 * Network is the operator's responsibility and is NEVER set here: Slack's API
 * lives on the public internet, so a host behind the bytedance intranet needs
 * an HTTPS proxy reachable to slack.com (mirrors the Claude Code note in
 * runtime-live-creds.ts). Credentials present but no reachable network is an
 * operator misconfiguration that surfaces as a test failure, not a skip.
 */
export function slackLiveCredsPresent(probe: SlackCredProbe = {}): boolean {
  const env = probe.env ?? process.env;
  return hasValue(env.SLACK_BOT_TOKEN) && hasValue(env.SLACK_E2E_CHANNEL_ID);
}
