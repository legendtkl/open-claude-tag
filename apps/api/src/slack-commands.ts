/**
 * Slack slash-command (`/slack/commands`) inbound transport for the gateway.
 * Composes the pure `@open-tag/channel-slack` primitives (signature verify +
 * slash-command handler core) with the Fastify request lifecycle. It is the
 * `/opentag` command surface — Milestone 4 (decisions D-M4S-1..5).
 *
 * Unlike `/slack/interactive` (a callback) and `/slack/events` (an inbound
 * observation), a slash command for `help`/`status` is OPEN, cheap, idempotent,
 * and read-only, so this transport answers SYNCHRONOUSLY in the 200 body with an
 * ephemeral message — no async `response_url`, no task dispatch, no dedupe.
 *
 * Security posture (mirrors slack-interactive.ts, verified in the Codex gate):
 *  - The signature is verified over the RAW request bytes BEFORE any decoded form
 *    is trusted; a failing request is rejected 401 and never acted on
 *    (rawBody-before-trust).
 *  - The signing secret, the raw signature, and the `response_url` are NEVER
 *    logged; only coarse, non-sensitive fields are.
 *
 * Wire format: Slack POSTs slash commands as `application/x-www-form-urlencoded`
 * with DIRECT fields (`command`, `text`, `team_id`, …) — NOT a JSON `payload`
 * field (that is the interactivity shape). So this transport reads the urlencoded
 * fields straight off `request.rawBody`.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { handleSlackCommand, verifySlackSignature } from '@open-tag/channel-slack';
import type { Logger } from '@open-tag/observability';
import { getSlackInstallationByTeamId } from '@open-tag/storage';
import type { Database } from '@open-tag/storage';

export const SLACK_COMMANDS_PATH = '/slack/commands';

/** The basic line shown whenever OpenClaudeTag is reachable in this workspace. */
const STATUS_CONNECTED_LINE = '✅ OpenClaudeTag is connected to this workspace.';

export interface SlackCommandsHandlerDeps {
  /** Slack app signing secret; the route is only registered when this is set. */
  signingSecret: string;
  /** Read-only DB handle for the `status` workspace lookup. */
  db: Database;
  logger: Logger;
  /** Injectable clock (epoch ms) for tests. */
  now?: () => number;
  /** Replay tolerance in seconds (default 300, Slack's recommendation). */
  replayWindowSeconds?: number;
}

/** Slack's synchronous slash-command response: an ephemeral message in the 200 body. */
interface SlackEphemeralResponse {
  response_type: 'ephemeral';
  text: string;
}

function ephemeral(text: string): SlackEphemeralResponse {
  return { response_type: 'ephemeral', text };
}

/**
 * Escape Slack's documented text control characters (`&`, `<`, `>`) before
 * interpolating untrusted text (a workspace name) into an mrkdwn message, so the
 * name can never be parsed as a Slack link/entity. We intentionally do NOT wrap
 * the name in emphasis (`*…*`), so a stray mrkdwn char in the name only ever
 * renders as harmless inline formatting rather than breaking the line.
 */
function escapeSlackText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function getHeader(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Compose the ephemeral `status` text. Best-effort by design (D-M4S-4): the
 * connected line is always truthful (the request reached us and verified), and a
 * DB lookup only ENRICHES it with an onboarded line when an enabled install for
 * this `team_id` exists. A lookup failure degrades to the basic connected line so
 * a transient DB blip never 5xxs the user — it never exposes a token or any other
 * workspace's data (the lookup is scoped to this request's `team_id`).
 */
async function composeStatusText(
  deps: SlackCommandsHandlerDeps,
  teamId: string,
): Promise<string> {
  if (!teamId) return STATUS_CONNECTED_LINE;
  try {
    const install = await getSlackInstallationByTeamId(deps.db, teamId);
    if (!install) return STATUS_CONNECTED_LINE;
    const name = install.teamName?.trim();
    const workspace = name ? `“${escapeSlackText(name)}”` : 'this workspace';
    return `${STATUS_CONNECTED_LINE}\nThis workspace is onboarded (${workspace}).`;
  } catch (err) {
    // Best-effort: never 5xx the user-facing status on a DB blip.
    deps.logger.warn(
      { err, path: SLACK_COMMANDS_PATH },
      'Slack /opentag status: installation lookup failed; returning basic connected status',
    );
    return STATUS_CONNECTED_LINE;
  }
}

/**
 * Build the Fastify handler for `POST /slack/commands`. Extracted from `server.ts`
 * so the verify → parse-form → respond logic is unit-testable without booting the
 * full server.
 *
 * Always returns 200 EXCEPT a genuine signature failure (or absent raw body),
 * which is 401: a slash command should rarely hard-fail the user, so even an
 * unexpected command or subcommand gets a polite ephemeral 200.
 */
export function createSlackCommandsHandler(deps: SlackCommandsHandlerDeps) {
  return async function handleSlackCommandRequest(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<unknown> {
    // The raw bytes are captured by the preParsing hook (server.ts). If they are
    // absent we MUST hard-reject: a signature can only be trusted over the exact
    // bytes Slack sent, and re-encoding the parsed form would verify auth against
    // bytes Slack never signed.
    const rawBody = (request as unknown as { rawBody?: Buffer }).rawBody;
    if (rawBody === undefined) {
      deps.logger.warn(
        { path: SLACK_COMMANDS_PATH },
        'Rejected Slack command: raw body unavailable for signature verification',
      );
      reply.code(401);
      return 'Invalid signature';
    }

    const verification = verifySlackSignature({
      signingSecret: deps.signingSecret,
      signatureHeader: getHeader(request, 'x-slack-signature'),
      timestampHeader: getHeader(request, 'x-slack-request-timestamp'),
      rawBody,
      now: deps.now?.() ?? Date.now(),
      ...(deps.replayWindowSeconds !== undefined
        ? { replayWindowSeconds: deps.replayWindowSeconds }
        : {}),
    });
    if (!verification.ok) {
      // Never log the secret or the raw signature — only the coarse reason.
      deps.logger.warn(
        { reason: verification.reason, path: SLACK_COMMANDS_PATH },
        'Rejected Slack command: signature verification failed',
      );
      reply.code(401);
      return 'Invalid signature';
    }

    // Slash commands ride DIRECT urlencoded fields (NOT a JSON `payload`).
    const form = new URLSearchParams(rawBody.toString('utf8'));
    const command = form.get('command') ?? '';
    const text = form.get('text') ?? undefined;
    const teamId = form.get('team_id') ?? '';

    const outcome = handleSlackCommand({ command, text });

    reply.code(200);

    if (outcome.type === 'ignore') {
      // Coarse, secret-free reason (e.g. unexpected_command:<command>).
      deps.logger.info({ reason: outcome.reason }, 'Slack command ignored');
      return ephemeral('Unknown command. Try `/opentag help`.');
    }

    if (outcome.type === 'reply') {
      return ephemeral(outcome.text);
    }

    // outcome.type === 'status' — compose the DB-backed text here (best-effort).
    return ephemeral(await composeStatusText(deps, teamId));
  };
}
