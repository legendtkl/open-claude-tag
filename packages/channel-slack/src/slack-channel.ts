/**
 * {@link SlackChannel} — the Slack implementation of the vendor-neutral
 * {@link Channel} contract. It proves the channel abstraction is pluggable: the
 * core holds it behind the SAME interface as {@link @open-tag/channel-core}'s
 * `LarkChannel`, with only the internals and capability flags differing.
 *
 * The client is a thin fetch-based wrapper over the Slack Web API — no
 * `@slack/web-api` SDK — so tests can inject a mock `fetch`. Slack-specific
 * payloads retreat into the typed `native` escape hatch on every surface.
 */
import { writeFile, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type {
  AddressingSignal,
  AttachmentRef,
  Channel,
  ChannelCapabilities,
  ChannelScope,
  ChannelSession,
  ChecklistStep,
  ConversationRef,
  DeliveryRef,
  HealthStatus,
  InboundMessage,
  LocalFile,
  Mention,
  OutboundMessage,
  ReactionRef,
  RemoteAttachmentRef,
  SendOptions,
} from '@open-tag/channel-core';

const SLACK = 'slack' as const;
const DEFAULT_API_BASE = 'https://slack.com/api';
// Block Kit caps a message at ~50 blocks (mirrors capabilities().maxOutboundElements).
// The result body owns one block; the rest are available for artifact references.
const MAX_BLOCKS = 50;

/** Injected construction options. `fetch` is overridable so tests mock the wire. */
export interface SlackChannelOptions {
  token: string;
  /** Defaults to the global `fetch`; tests inject a mock. */
  fetch?: typeof fetch;
  /** Override the Slack Web API base (default {@link DEFAULT_API_BASE}). */
  apiBaseUrl?: string;
}

/** Slack `message` event (Events API inner event shape). */
interface SlackMessageEvent {
  type?: string;
  subtype?: string;
  channel?: string;
  channel_type?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  event_ts?: string;
  files?: SlackFile[];
}

/** The `event_callback` envelope Slack POSTs to the Events API request URL. */
interface SlackEventEnvelope {
  type?: string;
  team_id?: string;
  api_app_id?: string;
  event_id?: string;
  event_time?: number;
  event?: SlackMessageEvent;
}

interface SlackFile {
  id: string;
  name?: string;
  title?: string;
  mimetype?: string;
  filetype?: string;
  url_private?: string;
}

/** Every Slack Web API method returns `{ ok, ... }`; `error` is set when `ok=false`. */
interface SlackApiResponse {
  ok: boolean;
  error?: string;
  ts?: string;
  channel?: string;
  file?: SlackFile;
  [key: string]: unknown;
}

/** A minimal Block Kit block; the union is open via the index signature. */
interface SlackBlock {
  type: string;
  [key: string]: unknown;
}

const STEP_ICONS: Record<ChecklistStep['status'], string> = {
  pending: '⬜',
  running: '🔄',
  done: '✅',
  failed: '❌',
  skipped: '⏭️',
};

function stepLine(step: ChecklistStep): string {
  return `${STEP_ICONS[step.status]} ${step.title}`;
}

/** Slack mention token: `<@U123>` or `<@U123|display>`. */
const MENTION_RE = /<@([A-Z0-9]+)(?:\|[^>]*)?>/g;

function parseMentions(text: string | undefined): Mention[] {
  if (!text) return [];
  const mentions: Mention[] = [];
  for (const match of text.matchAll(MENTION_RE)) {
    // We cannot tell a bot user from a human from the token alone; the core does
    // roster matching, so default to 'user' and let it reclassify.
    mentions.push({ id: match[1], type: 'user', raw: match[0] });
  }
  return mentions;
}

/**
 * Slack `ts` is a `"seconds.microseconds"` string. Derive `occurredAt` (ms) from
 * it deterministically — never a wall clock, so re-normalizing the same event is
 * stable.
 */
function tsToMillis(ts: string | undefined): number {
  const seconds = Number.parseFloat(ts ?? '');
  return Number.isFinite(seconds) ? Math.round(seconds * 1000) : 0;
}

/**
 * Slack file names are user-controlled, so strip any directory component before
 * joining onto a download dir — a raw `../x` or `/etc/x` must never escape
 * `destDir`. Falls back when the basename is empty or a `.`/`..` segment.
 */
function safeFileName(raw: string, fallback: string): string {
  const base = basename(raw);
  if (!base || base === '.' || base === '..') {
    return basename(fallback) || 'attachment';
  }
  return base;
}

function attachmentsFromFiles(files: SlackFile[] | undefined): AttachmentRef[] {
  if (!files) return [];
  return files.map((file) => ({
    type: file.mimetype?.startsWith('image/') ? 'image' : 'file',
    id: file.id,
    ...(file.name ? { name: file.name } : {}),
    ...(file.mimetype ? { mimeType: file.mimetype } : {}),
    native: file,
  }));
}

// --- Block Kit builders ------------------------------------------------------

function headerBlock(text: string): SlackBlock {
  // header blocks only accept plain_text and cap at 150 chars.
  return { type: 'header', text: { type: 'plain_text', text: text.slice(0, 150), emoji: true } };
}

function sectionBlock(markdown: string): SlackBlock {
  return { type: 'section', text: { type: 'mrkdwn', text: markdown } };
}

function actionsBlock(actions: { id: string; label: string }[]): SlackBlock {
  return {
    type: 'actions',
    elements: actions.map((action) => ({
      type: 'button',
      text: { type: 'plain_text', text: action.label, emoji: true },
      action_id: action.id,
      value: action.id,
    })),
  };
}

/** A `text` fallback + optional Block Kit `blocks` for a non-native outbound. */
interface RenderedContent {
  text: string;
  blocks?: SlackBlock[];
}

/**
 * A human-readable name for an uploaded artifact reference. `RemoteAttachmentRef`
 * carries no `name` field, so prefer the Slack file's `name`/`title` stashed under
 * `native`, falling back to the opaque `ref` id.
 */
function artifactDisplayName(att: RemoteAttachmentRef): string {
  const native = (att.native ?? {}) as { name?: string; title?: string };
  return native.name || native.title || att.ref;
}

/**
 * Render the result body PLUS a `:paperclip:`-prefixed reference per artifact (the
 * bytes already posted into the thread via {@link SlackChannel.uploadArtifact};
 * this is just a readable index). Each reference is its own Block Kit section, so
 * the list is bounded by the ~50-block cap: when there are more artifacts than fit,
 * the overflow is truncated with a VISIBLE `(+N more)` note — never a silent drop.
 */
function renderResult(markdown: string, artifacts: RemoteAttachmentRef[]): RenderedContent {
  const bodyBlock = sectionBlock(markdown);
  if (artifacts.length === 0) {
    return { text: markdown, blocks: [bodyBlock] };
  }
  const names = artifacts.map(artifactDisplayName);
  // Blocks left for references after the body; reserve one for the overflow note
  // when the set does not fit.
  const refBudget = MAX_BLOCKS - 1;
  const truncated = names.length > refBudget;
  const shown = truncated ? names.slice(0, refBudget - 1) : names;
  const hidden = names.length - shown.length;

  const blocks: SlackBlock[] = [bodyBlock, ...shown.map((name) => sectionBlock(`:paperclip: ${name}`))];
  const fallbackLines = [markdown, ...shown.map((name) => `📎 ${name}`)];
  if (truncated) {
    const note = `_(+${hidden} more attachment${hidden === 1 ? '' : 's'})_`;
    blocks.push(sectionBlock(note));
    fallbackLines.push(`(+${hidden} more)`);
  }
  return { text: fallbackLines.join('\n'), blocks };
}

/** Render a neutral {@link OutboundMessage} (sans `native`) to Slack text+blocks. */
function renderContent(msg: Exclude<OutboundMessage, { kind: 'native' }>): RenderedContent {
  switch (msg.kind) {
    case 'text':
    case 'discussion':
      return { text: msg.markdown, blocks: [sectionBlock(msg.markdown)] };
    case 'result':
      return renderResult(msg.markdown, msg.artifacts ?? []);
    case 'error':
      return { text: msg.message, blocks: [sectionBlock(`:warning: ${msg.message}`)] };
    case 'checklist': {
      const blocks: SlackBlock[] = [headerBlock(msg.title)];
      for (const step of msg.steps) blocks.push(sectionBlock(stepLine(step)));
      const fallback = [msg.title, ...msg.steps.map(stepLine)].join('\n');
      return { text: fallback, blocks };
    }
    case 'approval': {
      const { prompt } = msg;
      const blocks: SlackBlock[] = [headerBlock(prompt.title)];
      if (prompt.detail) blocks.push(sectionBlock(prompt.detail));
      blocks.push(actionsBlock(prompt.actions));
      return { text: prompt.detail ?? prompt.title, blocks };
    }
    case 'form': {
      // TODO(stage-6): render a Block Kit modal/input form; summarize as a
      // section list + action buttons for now.
      const lines = msg.fields.map((field) => `• *${field.label}* (${field.type})`).join('\n');
      const blocks: SlackBlock[] = [headerBlock(msg.title), sectionBlock(lines)];
      if (msg.actions.length > 0) blocks.push(actionsBlock(msg.actions));
      return { text: msg.title, blocks };
    }
    case 'comment':
      // TODO(stage-6): Slack has no doc-anchored comment surface; post the body
      // as a section block referencing the anchor.
      return {
        text: msg.markdown,
        blocks: [sectionBlock(`*comment on ${msg.anchor.docId}*\n${msg.markdown}`)],
      };
    case 'handoff': {
      // TODO(stage-6): structured agent handoff; announce via a section for now.
      const name = msg.to.displayName ?? msg.to.id;
      const body = `:twisted_rightwards_arrows: *Handoff to ${name}*\n${msg.markdown}`;
      return { text: body, blocks: [sectionBlock(body)] };
    }
    default: {
      const _exhaustive: never = msg;
      return { text: JSON.stringify(_exhaustive) };
    }
  }
}

export class SlackChannel implements Channel {
  readonly kind = SLACK;

  private readonly baseUrl: string;

  constructor(private readonly opts: SlackChannelOptions) {
    this.baseUrl = (opts.apiBaseUrl ?? DEFAULT_API_BASE).replace(/\/+$/, '');
  }

  capabilities(): ChannelCapabilities {
    return {
      supportsCards: true, // Block Kit
      supportsStreamingEdit: true, // chat.update
      supportsThreads: true,
      supportsReactions: true,
      // Honest about what actually round-trips today (Milestone 3a):
      //  - The `/slack/interactive` callback transport now EXISTS and normalizes a
      //    Block Kit `block_actions` click into a neutral inbound `interaction`.
      //    But `supportsApprovalButtons` stays FALSE until a neutral approval
      //    CONSUMER consumes that inbound interaction (Codex FLAW-1): advertising
      //    true while no consumer acts on the click would falsely promise the core
      //    that an approval round-trips.
      //  - `supportsForms` stays false: a submittable modal is a separate
      //    `views.open`/`trigger_id` flow (deferred to M4), and form render here is
      //    still a read-only summary, not an input surface.
      //  - uploadArtifact now reaches the thread (M3b): completeUploadExternal
      //    shares the file into the target conversation/thread, so result
      //    artifacts round-trip as in-thread files — hence supportsAttachmentsOut
      //    advertises image+file.
      supportsForms: false,
      supportsApprovalButtons: false,
      supportsAttachmentsIn: ['image', 'file', 'audio'],
      supportsAttachmentsOut: ['image', 'file'],
      maxOutboundChars: 40000, // chat.postMessage text ~40k chars
      maxOutboundElements: 50, // Block Kit caps ~50 blocks per message
      maxUpdateRateHz: 1, // Slack chat.update ~1/s
    };
  }

  async start(sink: (msg: InboundMessage) => Promise<void>): Promise<ChannelSession> {
    // TODO(stage-6): wire the inbound event source (Socket Mode / Events API)
    // in the gateway. The gateway owns the WS/HTTP receiver, calls normalize(),
    // then invokes this sink; the channel only holds the contract for now.
    void sink;
    return { stop: async () => {} };
  }

  normalize(raw: unknown): InboundMessage | null {
    const envelope = (raw ?? {}) as SlackEventEnvelope;
    // Accept either the `event_callback` envelope or a bare message event.
    const event: SlackMessageEvent = envelope.event ?? (envelope as SlackMessageEvent);

    if (event.type !== 'message') return null;
    // We only handle plain user messages this cut. Bot posts and edit/delete
    // subtypes (bot_message, message_changed, message_deleted, …) are skipped.
    // TODO(stage-6): map message_changed → 'updated', message_deleted → 'deleted'.
    if (event.subtype || event.bot_id) return null;
    if (!event.channel || !event.user || !event.ts) return null;

    const channelId = event.channel;
    const ts = event.ts;
    const teamId = envelope.team_id ?? '';
    const eventId = envelope.event_id ?? event.event_ts ?? ts;
    // Slack `ts` is unique only per-channel, so when the envelope carries no
    // globally-unique `event_id`, dedupe on channel+ts (never bare `ts`).
    const dedupeBasis = envelope.event_id ?? `${channelId}:${ts}`;
    const channelType = event.channel_type;

    return {
      channel: { kind: SLACK, native: raw },
      eventId,
      messageId: ts,
      // TODO(stage-6): edit/delete/reaction/interaction subtypes are not yet
      // mapped; a plain message event is always a new message.
      eventType: 'created',
      occurredAt: tsToMillis(ts),
      dedupeKey: `${SLACK}:${dedupeBasis}`,
      conversation: {
        kind: SLACK,
        scopeId: channelId,
        ...(event.thread_ts ? { threadId: event.thread_ts } : {}),
        // In Slack a reply is posted with `thread_ts` = the root message ts.
        ...(event.thread_ts ? { reply: { rootId: event.thread_ts } } : {}),
      },
      scope: {
        kind: SLACK,
        scopeId: channelId,
        installationId: teamId,
        ...(event.thread_ts ? { threadId: event.thread_ts } : {}),
        // DMs, group DMs and private channels (`group`) are private; only public
        // channels (`channel`) are shared by default.
        isPrivate: channelType === 'im' || channelType === 'mpim' || channelType === 'group',
      },
      sender: {
        id: event.user,
        isBot: Boolean(event.bot_id),
        native: { botId: event.bot_id, appId: envelope.api_app_id },
      },
      content: {
        type: 'text',
        ...(event.text ? { text: event.text } : {}),
        mentions: parseMentions(event.text),
        attachments: attachmentsFromFiles(event.files),
      },
    };
  }

  extractAddressingSignals(msg: InboundMessage): AddressingSignal[] {
    return msg.content.mentions.map((mention) => ({
      kind: mention.type === 'bot' ? 'bot' : 'user',
      id: mention.id,
      raw: mention.raw ?? `<@${mention.id}>`,
    }));
  }

  async send(to: ConversationRef, msg: OutboundMessage, opts?: SendOptions): Promise<DeliveryRef> {
    const channel = to.scopeId;
    const threadTs = this.threadTarget(to);
    let body: Record<string, unknown>;

    if (msg.kind === 'native') {
      // The native escape hatch: the payload is already a chat.postMessage body;
      // pass it through, defaulting channel/thread but letting the payload win.
      const payload = isRecord(msg.payload) ? msg.payload : {};
      body = {
        channel,
        ...(threadTs ? { thread_ts: threadTs } : {}),
        ...payload,
      };
    } else {
      const { text, blocks } = renderContent(msg);
      body = {
        channel,
        text,
        ...(blocks ? { blocks } : {}),
        ...(threadTs ? { thread_ts: threadTs } : {}),
      };
    }

    // Slack's idempotency key for chat.postMessage is the `client_msg_id`-style
    // dedupe is not exposed; thread the caller token through `metadata` so a
    // retry is at least traceable. TODO(stage-6): real exactly-once dedupe.
    if (opts?.idempotencyKey && !('metadata' in body)) {
      body.metadata = {
        event_type: 'open_tag_send',
        event_payload: { idempotency_key: opts.idempotencyKey },
      };
    }

    const res = await this.callJson('chat.postMessage', body);
    const ts = res.ts ?? '';
    return {
      kind: SLACK,
      logicalMessageId: ts,
      revision: 0,
      physicalIds: [ts],
      native: res,
    };
  }

  async update(
    ref: DeliveryRef,
    msg: OutboundMessage,
    opts?: { revision?: number },
  ): Promise<DeliveryRef> {
    const channel = this.channelFromRef(ref);
    let last: SlackApiResponse | undefined;

    for (const ts of ref.physicalIds) {
      let body: Record<string, unknown>;
      if (msg.kind === 'native') {
        const payload = isRecord(msg.payload) ? msg.payload : {};
        body = { channel, ts, ...payload };
      } else {
        const { text, blocks } = renderContent(msg);
        body = { channel, ts, text, ...(blocks ? { blocks } : {}) };
      }
      last = await this.callJson('chat.update', body);
    }

    const revision = opts?.revision ?? ref.revision + 1;
    return { ...ref, revision, native: last ?? ref.native };
  }

  async react(ref: DeliveryRef, emoji: string): Promise<ReactionRef> {
    const [ts] = ref.physicalIds;
    if (!ts) return { kind: SLACK, reactionId: '' };
    const channel = this.channelFromRef(ref);
    const name = emoji.replace(/^:|:$/g, '');
    const res = await this.callJson('reactions.add', { channel, timestamp: ts, name });
    // Slack's reactions.add returns no per-reaction id — a reaction is identified
    // by its `{channel, timestamp, name}` tuple, which is also what reactions.remove
    // takes. So `reactionId` stays empty and the removable identity is preserved
    // under `native` for any later removal.
    return { kind: SLACK, reactionId: '', native: { channel, timestamp: ts, name, response: res } };
  }

  async removeReaction(ref: ReactionRef): Promise<void> {
    // Skip a foreign-kind ref: a registry could route a non-slack ReactionRef
    // here, and its native fields must never be misread as a Slack tuple.
    if (ref.kind !== SLACK) return;
    // Slack identifies a reaction by the `{channel, timestamp, name}` tuple the
    // matching `react` stashed under `native`; reactions.remove takes the same
    // tuple. A ref without that tuple has nothing Slack can remove, so no-op.
    const native = ref.native as
      | { channel?: string; timestamp?: string; name?: string }
      | undefined;
    if (!native?.channel || !native.timestamp || !native.name) return;
    // Symmetric with `react`: a provider error throws and the caller isolates it
    // best-effort (the worker's removeAckReactionViaChannel seam), so the contract
    // stays uniform across kinds rather than swallowing only on Slack.
    await this.callJson('reactions.remove', {
      channel: native.channel,
      timestamp: native.timestamp,
      name: native.name,
    });
  }

  async uploadArtifact(
    file: LocalFile,
    target?: { channel?: string; threadTs?: string },
  ): Promise<RemoteAttachmentRef> {
    // The modern Slack upload is a three-step external flow; `files.upload` was
    // sunset (2025-11-12). When a `target.channel` is threaded in (M3b), step 3
    // associates the file with that conversation (+ thread) so the bytes land in
    // the thread, not just the workspace. With no target the file stays
    // workspace-private (back-compat — satisfies the single-arg Channel contract).
    const buffer = await readFile(file.path);

    // 1) Reserve a signed upload URL + the pending file id.
    const reserved = await this.callGet('files.getUploadURLExternal', {
      filename: file.name,
      length: String(buffer.byteLength),
    });
    const uploadUrl = reserved.upload_url as string | undefined;
    const fileId = reserved.file_id as string | undefined;
    if (!uploadUrl || !fileId) {
      throw new Error('SlackChannel.uploadArtifact: getUploadURLExternal returned no upload_url/file_id');
    }

    // 2) POST the raw bytes to the issued URL (it is pre-signed — no bearer).
    const put = await this.fetchImpl(uploadUrl, { method: 'POST', body: new Uint8Array(buffer) });
    if (!put.ok) {
      throw new Error(`SlackChannel.uploadArtifact: byte upload failed with HTTP ${put.status}`);
    }

    // 3) Finalize: associate the uploaded bytes with the file id, and — when a
    // target is given — share it into that conversation/thread. The modern
    // external-upload flow uses `channel_id` (a SINGULAR conversation id) plus an
    // optional `thread_ts`, NOT the legacy `files.upload` `channels` (plural).
    // Source: https://docs.slack.dev/reference/methods/files.completeUploadExternal
    const completeParams: Record<string, string> = {
      files: JSON.stringify([{ id: fileId, ...(file.name ? { title: file.name } : {}) }]),
    };
    if (target?.channel) {
      completeParams.channel_id = target.channel;
      if (target.threadTs) completeParams.thread_ts = target.threadTs;
    }
    const completed = await this.callFormEncoded('files.completeUploadExternal', completeParams);
    const uploaded = Array.isArray(completed.files)
      ? (completed.files[0] as SlackFile | undefined)
      : undefined;

    return {
      type: file.mimeType?.startsWith('image/') ? 'image' : 'file',
      ref: uploaded?.id ?? fileId,
      native: uploaded ?? completed,
    };
  }

  async fetchAttachment(att: AttachmentRef, destDir: string): Promise<LocalFile> {
    const native = (att.native ?? {}) as SlackFile;
    let url = native.url_private;
    if (!url) {
      // files.info is a read method — call it with GET + query params.
      const info = await this.callGet('files.info', { file: att.id });
      url = info.file?.url_private;
    }
    if (!url) {
      throw new Error(`fetchAttachment: Slack file ${att.id} has no downloadable url_private`);
    }

    // The private URL requires the bot token as a bearer; it is not a public CDN.
    const res = await this.fetchImpl(url, {
      headers: { Authorization: `Bearer ${this.opts.token}` },
    });
    if (!res.ok) {
      throw new Error(`fetchAttachment: download for ${att.id} failed with HTTP ${res.status}`);
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    const name = safeFileName(att.name ?? native.name ?? att.id, att.id);
    const path = join(destDir, name);
    await writeFile(path, buffer);
    return { path, name, ...(att.mimeType ? { mimeType: att.mimeType } : {}) };
  }

  resolveScope(msg: InboundMessage): ChannelScope {
    return msg.scope;
  }

  async healthcheck(): Promise<HealthStatus> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/auth.test`, {
        method: 'POST',
        headers: this.authHeaders('application/json; charset=utf-8'),
        body: '{}',
      });
      const json = (await res.json()) as SlackApiResponse;
      return json.ok ? { healthy: true } : { healthy: false, detail: json.error ?? 'auth_test_failed' };
    } catch (error) {
      return { healthy: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  // --- internals -------------------------------------------------------------

  private get fetchImpl(): typeof fetch {
    return this.opts.fetch ?? fetch;
  }

  private authHeaders(contentType?: string): Record<string, string> {
    return {
      Authorization: `Bearer ${this.opts.token}`,
      ...(contentType ? { 'Content-Type': contentType } : {}),
    };
  }

  /** The thread root a reply targets: explicit threadId, else the reply root/parent. */
  private threadTarget(to: ConversationRef): string | undefined {
    return to.threadId ?? to.reply?.rootId ?? to.reply?.parentId;
  }

  /** Recover the Slack channel id for an update/react from the send response. */
  private channelFromRef(ref: DeliveryRef): string {
    const channel = (ref.native as SlackApiResponse | undefined)?.channel;
    if (!channel) {
      throw new Error('SlackChannel.update/react: DeliveryRef.native carries no channel id');
    }
    return channel;
  }

  /** POST a JSON body to a Slack Web API method; throws when `ok=false`. */
  private async callJson(method: string, body: Record<string, unknown>): Promise<SlackApiResponse> {
    const res = await this.fetchImpl(`${this.baseUrl}/${method}`, {
      method: 'POST',
      headers: this.authHeaders('application/json; charset=utf-8'),
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as SlackApiResponse;
    if (!json.ok) {
      throw new Error(`Slack ${method} failed: ${json.error ?? 'unknown_error'}`);
    }
    return json;
  }

  /** GET a Slack read method with query params; throws when `ok=false`. */
  private async callGet(method: string, params: Record<string, string>): Promise<SlackApiResponse> {
    const query = new URLSearchParams(params).toString();
    const res = await this.fetchImpl(`${this.baseUrl}/${method}?${query}`, {
      method: 'GET',
      headers: this.authHeaders(),
    });
    const json = (await res.json()) as SlackApiResponse;
    if (!json.ok) {
      throw new Error(`Slack ${method} failed: ${json.error ?? 'unknown_error'}`);
    }
    return json;
  }

  /** POST a `application/x-www-form-urlencoded` body; throws when `ok=false`. */
  private async callFormEncoded(
    method: string,
    params: Record<string, string>,
  ): Promise<SlackApiResponse> {
    const res = await this.fetchImpl(`${this.baseUrl}/${method}`, {
      method: 'POST',
      headers: this.authHeaders('application/x-www-form-urlencoded'),
      body: new URLSearchParams(params).toString(),
    });
    const json = (await res.json()) as SlackApiResponse;
    if (!json.ok) {
      throw new Error(`Slack ${method} failed: ${json.error ?? 'unknown_error'}`);
    }
    return json;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
