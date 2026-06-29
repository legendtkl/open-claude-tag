/**
 * Slack slash-command handler core — a pure, transport-agnostic decision function
 * mirroring {@link ./interactive-handler}. Given an ALREADY-signature-verified,
 * parsed slash-command form it returns a typed {@link SlackCommandOutcome} the HTTP
 * transport acts on. It performs no IO and holds no socket, so it is fully
 * unit-testable with fixtures.
 *
 * Design (#21 Milestone 4, decisions D-M4S-1..5):
 *  - We register exactly ONE Slack slash command, `/opentag`, and use the `text`
 *    field as the subcommand (`help` | `status` | empty→help). Registering a
 *    separate slash per Feishu command would collide with Slack built-ins and is
 *    meaningless for most Feishu commands.
 *  - Only `help` and `status` are wired. Both are OPEN (not owner-only), cheap,
 *    idempotent, and read-only, so the transport answers synchronously in the 200
 *    body with an ephemeral message — no async `response_url`, no dedupe.
 *  - `status` needs a DB lookup, so the handler only DECIDES it is a status
 *    request ({@link SlackCommandOutcome} `status`); the transport (which holds the
 *    DB) composes the user-facing text.
 *
 * It deliberately does NOT verify the signature itself: verification runs on the
 * raw request bytes in the transport BEFORE the form is parsed and handed here.
 */

/** The single Slack slash command this app registers. */
export const SLACK_COMMAND_NAME = '/opentag';

/**
 * The Slack-specific help text. HONEST by design (D-M4S-5): it lists ONLY the
 * subcommands that are actually wired today (`help`, `status`) and notes that more
 * will arrive in later milestones — it never advertises an unwired command. This
 * is intentionally NOT the Feishu `slash-command-help` text (that surface is
 * Feishu-flavored and lists Feishu-only commands). English only for now.
 */
export const SLACK_HELP_TEXT = [
  '*OpenClaudeTag* — available commands:',
  '• `/opentag help` — show this help',
  '• `/opentag status` — show this workspace’s connection status',
  '',
  '_More commands will arrive in later milestones._',
].join('\n');

export type SlackCommandSubcommand = 'help' | 'status' | 'unknown';

export type SlackCommandOutcome =
  /** Answer synchronously with an ephemeral message in the 200 body. */
  | { type: 'reply'; text: string; ephemeral: true }
  /** A status request; the transport composes the text (it needs the DB). Ack 200. */
  | { type: 'status' }
  /** Unexpected command (app misconfig); the transport answers politely. Ack 200. */
  | { type: 'ignore'; reason: string };

export interface HandleSlackCommandInput {
  /** The Slack `command` field, e.g. `/opentag`. */
  command: string;
  /** The Slack `text` field (everything after the command); the subcommand. */
  text?: string;
}

/**
 * Resolve the subcommand from the slash command's `text` field: trim, take the
 * first whitespace-delimited token, lowercase it. Empty/absent text → `help`;
 * `help`/`status` map to themselves; anything else is `unknown`.
 */
export function parseSlackSubcommand(text: string | undefined): SlackCommandSubcommand {
  const first = (text ?? '').trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  if (first === '' || first === 'help') return 'help';
  if (first === 'status') return 'status';
  return 'unknown';
}

/**
 * Decide what to do with a verified Slack slash-command request.
 *
 * - `command` other than `/opentag` → `ignore` with `unexpected_command:<command>`
 *   (defensive: the app should only ever route `/opentag` here).
 * - subcommand `help` (or empty) → `reply` with {@link SLACK_HELP_TEXT}.
 * - subcommand `status` → `status` (the transport composes the DB-backed text).
 * - subcommand `unknown` → `reply` with a polite hint pointing at `/opentag help`.
 */
export function handleSlackCommand(input: HandleSlackCommandInput): SlackCommandOutcome {
  if (input.command !== SLACK_COMMAND_NAME) {
    return { type: 'ignore', reason: `unexpected_command:${input.command}` };
  }

  const sub = parseSlackSubcommand(input.text);
  if (sub === 'status') return { type: 'status' };
  if (sub === 'unknown') {
    return {
      type: 'reply',
      text: 'Unknown subcommand. Try `/opentag help`.',
      ephemeral: true,
    };
  }
  return { type: 'reply', text: SLACK_HELP_TEXT, ephemeral: true };
}
