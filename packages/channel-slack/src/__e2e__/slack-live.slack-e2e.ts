import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConversationRef } from '@open-tag/channel-core';
import { SlackChannel } from '../slack-channel.js';
import { slackLiveCredsPresent } from './slack-live-creds.js';

/**
 * OPT-IN live Slack e2e. NOT part of the default suite — runs ONLY via the
 * `test:slack:e2e` command (explicit `--config vitest.slack-e2e.config.ts`). The
 * filename uses `.slack-e2e.ts` (not `.test.ts`/`.spec.ts`) so vitest's default
 * include never picks it up. It makes REAL Slack Web API calls against a live
 * workspace + test channel, so it is kept out of CI.
 *
 * It self-skips when credentials are absent (see slack-live-creds.ts): without
 * BOTH `SLACK_BOT_TOKEN` and `SLACK_E2E_CHANNEL_ID` the single `it` is reported
 * as skipped, not failed (exit 0).
 *
 * Network is the operator's responsibility and is NEVER set in code: slack.com
 * is on the public internet, so a host behind the bytedance intranet must export
 * an HTTPS proxy reachable to slack.com. When `HTTPS_PROXY`/`https_proxy` is set
 * the injected fetch routes through undici's ProxyAgent (Node's global fetch does
 * NOT honor proxy env); otherwise it talks to slack.com directly.
 */

/** The `dispatcher` field @types/node merges onto `RequestInit` from undici. */
type Dispatcher = NonNullable<RequestInit['dispatcher']>;

/**
 * Build the `fetch` injected into {@link SlackChannel}. Node's global fetch
 * (undici) ignores `HTTPS_PROXY`, so when a proxy is configured we route through
 * undici's `ProxyAgent`. The import specifier is held in a variable so `tsc` does
 * not statically resolve `undici` — it is a transitive dependency this package
 * does not declare, so a literal `import('undici')` would break typecheck. When
 * the proxy env is unset we use the global fetch directly; when it IS set but the
 * `undici` import fails we warn and fall back to the global fetch (the operator
 * is then responsible for direct reachability to slack.com).
 */
async function buildProxyFetch(): Promise<typeof fetch> {
  const proxyUrl = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? '';
  if (!proxyUrl) return fetch;
  try {
    const moduleName = 'undici';
    const undici = (await import(moduleName)) as {
      ProxyAgent: new (uri: string) => Dispatcher;
    };
    const dispatcher = new undici.ProxyAgent(proxyUrl);
    return (input, init) => fetch(input, { ...init, dispatcher });
  } catch (err) {
    console.warn(
      `[slack-e2e] HTTPS proxy is set but undici ProxyAgent is unavailable; ` +
        `falling back to the global fetch (direct reachability to slack.com is ` +
        `now the operator's responsibility): ${err instanceof Error ? err.message : String(err)}`,
    );
    return fetch;
  }
}

/**
 * Best-effort `chat.delete` via a direct Slack Web API call, reusing the same
 * proxy-aware fetch + bot token so cleanup honors the proxy too. Slack identifies
 * a message to delete by its `{ channel, ts }` tuple. Any failure is surfaced by
 * the caller as a warning only — cleanup is NEVER an assertion failure.
 */
async function deleteMessage(
  fetchImpl: typeof fetch,
  token: string,
  channel: string,
  ts: string,
): Promise<void> {
  const res = await fetchImpl('https://slack.com/api/chat.delete', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ channel, ts }),
  });
  const json = (await res.json()) as { ok?: boolean; error?: string };
  if (!json.ok) {
    throw new Error(`chat.delete returned ok=false: ${json.error ?? 'unknown_error'}`);
  }
}

describe('slack live e2e (opt-in; real Slack API calls)', () => {
  it.skipIf(!slackLiveCredsPresent())(
    'exercises the real Slack outbound stack end-to-end (send, update, upload-in-thread, react)',
    async () => {
      // Non-null asserted: the skipIf gate guarantees both are present and
      // non-empty here. Read only inside the test body (never at module load).
      const token = process.env.SLACK_BOT_TOKEN!;
      const channelId = process.env.SLACK_E2E_CHANNEL_ID!;
      const marker = `SLACK_E2E_${randomUUID()}`;

      const proxyFetch = await buildProxyFetch();
      const channel = new SlackChannel({ token, fetch: proxyFetch });
      const conv: ConversationRef = { kind: 'slack', scopeId: channelId };

      // a. healthcheck (auth.test) — proves the token + transport reach Slack.
      const health = await channel.healthcheck();
      expect(health.healthy, `healthcheck failed: ${health.detail ?? 'unknown'}`).toBe(true);

      // b. send a `result` message carrying the unique marker.
      const ref = await channel.send(conv, { kind: 'result', markdown: marker });
      const ts = ref.physicalIds[0];
      expect(ts, 'send returned no physicalIds[0] (message ts)').toBeTruthy();
      const sentChannel = (ref.native as { channel?: string } | undefined)?.channel;
      expect(sentChannel, 'send DeliveryRef.native carried no channel id').toBeTruthy();
      const channelFromRef = sentChannel as string;

      let tempFile: string | undefined;
      try {
        // c. update the message in place (simulates running → done).
        await channel.update(ref, { kind: 'result', markdown: `${marker} (updated)` });

        // d. upload a tiny artifact INTO the message's thread (M3b: the bytes
        //    must land in-thread, not just the workspace).
        tempFile = join(tmpdir(), `${marker}.txt`);
        await writeFile(tempFile, `${marker}\n`, 'utf8');
        const uploaded = await channel.uploadArtifact(
          { path: tempFile, name: `${marker}.txt`, mimeType: 'text/plain' },
          { channel: channelFromRef, threadTs: ts },
        );
        expect(uploaded.ref, 'uploadArtifact returned an empty ref').toBeTruthy();

        // e. react, then remove the reaction (both round-trip the tuple identity).
        const reaction = await channel.react(ref, 'white_check_mark');
        await channel.removeReaction(reaction);
      } finally {
        // f. best-effort cleanup — must NEVER fail the test. We assert outbound
        //    CAPABILITY, not teardown; a leftover artifact/message only warns.
        if (tempFile) {
          await unlink(tempFile).catch(() => {});
        }
        await deleteMessage(proxyFetch, token, channelFromRef, ts).catch((err) => {
          console.warn(
            `[slack-e2e] best-effort chat.delete failed (left ${marker} in the channel): ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        });
      }
    },
  );
});
