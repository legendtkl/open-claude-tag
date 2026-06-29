import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Channel, ConversationRef } from '@open-tag/channel-core';
import { SlackChannel } from '../slack-channel.js';

const TO: ConversationRef = { kind: 'slack', scopeId: 'C123' };

/** A Slack `event_callback` envelope wrapping a plain user `message` event. */
function makeRawEvent() {
  return {
    type: 'event_callback',
    team_id: 'T999',
    api_app_id: 'A111',
    event_id: 'Ev0001',
    event_time: 1710000000,
    event: {
      type: 'message',
      channel: 'C123',
      channel_type: 'channel',
      user: 'U777',
      text: '<@U999> hello there <@U888|alice>',
      ts: '1710000000.000100',
      thread_ts: '1710000000.000050',
      event_ts: '1710000000.000100',
    },
  };
}

/** A mock `fetch` that records calls and returns a fixed Slack API JSON body. */
function mockFetch(json: Record<string, unknown>) {
  const calls = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => ({
    ok: true,
    status: 200,
    json: async () => json,
  }));
  return { fetch: calls as unknown as typeof fetch, calls };
}

function lastBody(calls: ReturnType<typeof mockFetch>['calls']): Record<string, unknown> {
  const [, init] = calls.mock.calls[calls.mock.calls.length - 1];
  return JSON.parse((init as RequestInit).body as string);
}

/** A mock `fetch` that returns each queued JSON body on successive calls. */
function mockFetchSeq(responses: Record<string, unknown>[]) {
  let i = 0;
  const calls = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
    const body = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return {
      ok: true,
      status: 200,
      json: async () => body,
      arrayBuffer: async () => new TextEncoder().encode('payload').buffer,
    };
  });
  return { fetch: calls as unknown as typeof fetch, calls };
}

describe('SlackChannel', () => {
  let fetchMock: ReturnType<typeof mockFetch>;
  let channel: SlackChannel;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock = mockFetch({ ok: true, channel: 'C123', ts: '1710000000.000999' });
    channel = new SlackChannel({ token: 'xoxb-test', fetch: fetchMock.fetch });
  });

  it('satisfies the vendor-neutral Channel abstraction (type-level proof)', () => {
    // The annotation is the proof: SlackChannel must structurally implement Channel.
    const c: Channel = new SlackChannel({ token: 'x' });
    expect(c.kind).toBe('slack');
  });

  it('exposes the Slack capability flags', () => {
    const caps = channel.capabilities();
    expect(caps.supportsCards).toBe(true);
    expect(caps.supportsStreamingEdit).toBe(true);
    expect(caps.supportsThreads).toBe(true);
    expect(caps.supportsReactions).toBe(true);
    // Honest until the stage-6 Slack interactive work lands (#13).
    expect(caps.supportsForms).toBe(false);
    expect(caps.supportsApprovalButtons).toBe(false);
    expect(caps.supportsAttachmentsIn).toEqual(['image', 'file', 'audio']);
    // M3b: outbound artifacts now reach the conversation thread.
    expect(caps.supportsAttachmentsOut).toEqual(['image', 'file']);
    expect(caps.maxOutboundChars).toBe(40000);
    expect(caps.maxOutboundElements).toBe(50);
    expect(caps.maxUpdateRateHz).toBe(1);
  });

  it('normalizes a Slack message event into a neutral slack InboundMessage', () => {
    const inbound = channel.normalize(makeRawEvent());
    expect(inbound).not.toBeNull();
    expect(inbound!.channel.kind).toBe('slack');
    expect(inbound!.messageId).toBe('1710000000.000100');
    expect(inbound!.dedupeKey).toBe('slack:Ev0001');
    expect(inbound!.conversation.scopeId).toBe('C123');
    expect(inbound!.conversation.threadId).toBe('1710000000.000050');
    expect(inbound!.scope.scopeId).toBe('C123');
    expect(inbound!.scope.installationId).toBe('T999');
    expect(inbound!.scope.threadId).toBe('1710000000.000050');
    expect(inbound!.sender.id).toBe('U777');
    expect(inbound!.sender.isBot).toBe(false);
    expect(inbound!.content.type).toBe('text');
    expect(inbound!.content.text).toBe('<@U999> hello there <@U888|alice>');
    expect(inbound!.content.mentions).toEqual([
      { id: 'U999', type: 'user', raw: '<@U999>' },
      { id: 'U888', type: 'user', raw: '<@U888|alice>' },
    ]);
  });

  it('returns null for a non-message or bot-edit subtype it does not handle', () => {
    expect(channel.normalize({ event: { type: 'reaction_added' } })).toBeNull();
    expect(
      channel.normalize({
        event: { type: 'message', subtype: 'message_changed', channel: 'C1', user: 'U1', ts: '1.2' },
      }),
    ).toBeNull();
    expect(
      channel.normalize({ event: { type: 'message', bot_id: 'B1', channel: 'C1', user: 'U1', ts: '1.2' } }),
    ).toBeNull();
    expect(channel.normalize({})).toBeNull();
  });

  it('parses <@U…> mention tokens into neutral addressing signals', () => {
    const inbound = channel.normalize(makeRawEvent());
    const signals = channel.extractAddressingSignals(inbound!);
    expect(signals).toEqual([
      { kind: 'user', id: 'U999', raw: '<@U999>' },
      { kind: 'user', id: 'U888', raw: '<@U888|alice>' },
    ]);
  });

  it('sends a text message via chat.postMessage and returns a slack DeliveryRef', async () => {
    const ref = await channel.send(TO, { kind: 'text', markdown: 'hello' });

    expect(fetchMock.calls).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.calls.mock.calls[0];
    expect(url).toBe('https://slack.com/api/chat.postMessage');
    expect((init as RequestInit).method).toBe('POST');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.channel).toBe('C123');
    expect(body.text).toBe('hello');

    expect(ref.kind).toBe('slack');
    expect(ref.revision).toBe(0);
    expect(ref.physicalIds).toEqual(['1710000000.000999']);
    expect(ref.logicalMessageId).toBe('1710000000.000999');
  });

  it('posts into a thread when the conversation carries a thread root', async () => {
    await channel.send(
      { kind: 'slack', scopeId: 'C123', threadId: '1710000000.000050' },
      { kind: 'text', markdown: 'reply' },
    );
    const body = lastBody(fetchMock.calls);
    expect(body.thread_ts).toBe('1710000000.000050');
  });

  it('renders a checklist as Block Kit blocks', async () => {
    await channel.send(TO, {
      kind: 'checklist',
      title: 'Run',
      status: 'running',
      steps: [
        { id: 's1', title: 'step one', status: 'done' },
        { id: 's2', title: 'step two', status: 'running' },
      ],
    });
    const body = lastBody(fetchMock.calls);
    expect(Array.isArray(body.blocks)).toBe(true);
    const blocks = body.blocks as { type: string }[];
    expect(blocks[0].type).toBe('header');
    expect(blocks.filter((b) => b.type === 'section')).toHaveLength(2);
  });

  it('renders a result as Block Kit blocks', async () => {
    await channel.send(TO, { kind: 'result', markdown: '# Answer\nAll done' });
    const body = lastBody(fetchMock.calls);
    expect(Array.isArray(body.blocks)).toBe(true);
    expect(body.text).toBe('# Answer\nAll done');
  });

  it('passes a native payload through to chat.postMessage', async () => {
    await channel.send(TO, { kind: 'native', payload: { text: 'raw', unfurl_links: false } });
    const body = lastBody(fetchMock.calls);
    expect(body.channel).toBe('C123');
    expect(body.text).toBe('raw');
    expect(body.unfurl_links).toBe(false);
  });

  it('updates an existing message via chat.update and bumps the revision', async () => {
    const ref = {
      kind: 'slack' as const,
      logicalMessageId: '1710000000.000999',
      revision: 0,
      physicalIds: ['1710000000.000999'],
      native: { ok: true, channel: 'C123', ts: '1710000000.000999' },
    };
    const next = await channel.update(ref, {
      kind: 'checklist',
      title: 'Run',
      status: 'done',
      steps: [{ id: 's1', title: 'step one', status: 'done' }],
    });

    const [url, init] = fetchMock.calls.mock.calls[0];
    expect(url).toBe('https://slack.com/api/chat.update');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.channel).toBe('C123');
    expect(body.ts).toBe('1710000000.000999');
    expect(next.revision).toBe(1);
  });

  it('reacts via reactions.add and returns a slack ReactionRef carrying the tuple identity', async () => {
    fetchMock = mockFetch({ ok: true });
    channel = new SlackChannel({ token: 'xoxb-test', fetch: fetchMock.fetch });
    const ref = {
      kind: 'slack' as const,
      logicalMessageId: '1710000000.000999',
      revision: 0,
      physicalIds: ['1710000000.000999'],
      native: { ok: true, channel: 'C123', ts: '1710000000.000999' },
    };

    const reaction = await channel.react(ref, ':white_check_mark:');

    const [url, init] = fetchMock.calls.mock.calls[0];
    expect(url).toBe('https://slack.com/api/reactions.add');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({ channel: 'C123', timestamp: '1710000000.000999', name: 'white_check_mark' });
    // Slack has no per-reaction id, so reactionId is empty but the removable
    // {channel, timestamp, name} tuple identity is preserved under native.
    expect(reaction.kind).toBe('slack');
    expect(reaction.reactionId).toBe('');
    expect(reaction.native).toMatchObject({
      channel: 'C123',
      timestamp: '1710000000.000999',
      name: 'white_check_mark',
    });
  });

  it('removes a reaction via reactions.remove using the tuple under native', async () => {
    fetchMock = mockFetch({ ok: true });
    channel = new SlackChannel({ token: 'xoxb-test', fetch: fetchMock.fetch });

    await channel.removeReaction({
      kind: 'slack',
      reactionId: '',
      native: { channel: 'C123', timestamp: '1710000000.000999', name: 'white_check_mark' },
    });

    const [url, init] = fetchMock.calls.mock.calls[0];
    expect(url).toBe('https://slack.com/api/reactions.remove');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({ channel: 'C123', timestamp: '1710000000.000999', name: 'white_check_mark' });
  });

  it('removeReaction is a no-op when native lacks the removable tuple', async () => {
    fetchMock = mockFetch({ ok: true });
    channel = new SlackChannel({ token: 'xoxb-test', fetch: fetchMock.fetch });

    // A Lark-shaped ref carries no Slack tuple, so there is nothing to remove.
    await channel.removeReaction({ kind: 'slack', reactionId: '', native: { messageId: 'om_1' } });
    await channel.removeReaction({ kind: 'slack', reactionId: '' });

    expect(fetchMock.calls).not.toHaveBeenCalled();
  });

  it('removeReaction skips a foreign-kind ref even if its native looks like a tuple', async () => {
    fetchMock = mockFetch({ ok: true });
    channel = new SlackChannel({ token: 'xoxb-test', fetch: fetchMock.fetch });

    await channel.removeReaction({
      kind: 'lark',
      reactionId: 'r1',
      native: { channel: 'C123', timestamp: '1710000000.000999', name: 'white_check_mark' },
    });

    expect(fetchMock.calls).not.toHaveBeenCalled();
  });

  it('resolves the neutral scope from an inbound message', () => {
    const inbound = channel.normalize(makeRawEvent());
    expect(channel.resolveScope(inbound!)).toBe(inbound!.scope);
  });

  it('reports healthy when auth.test returns ok', async () => {
    fetchMock = mockFetch({ ok: true, team: 'T999', user: 'open-tag' });
    channel = new SlackChannel({ token: 'xoxb-test', fetch: fetchMock.fetch });
    await expect(channel.healthcheck()).resolves.toEqual({ healthy: true });
    const [url] = fetchMock.calls.mock.calls[0];
    expect(url).toBe('https://slack.com/api/auth.test');
  });

  it('reports unhealthy when auth.test returns an error', async () => {
    fetchMock = mockFetch({ ok: false, error: 'invalid_auth' });
    channel = new SlackChannel({ token: 'bad', fetch: fetchMock.fetch });
    await expect(channel.healthcheck()).resolves.toEqual({
      healthy: false,
      detail: 'invalid_auth',
    });
  });

  it('start returns a session whose stop is a no-op', async () => {
    const session = await channel.start(async () => {});
    await expect(session.stop()).resolves.toBeUndefined();
  });

  it('uploads an artifact through the external-upload flow (no sunset files.upload)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'slack-up-'));
    const src = join(dir, 'note.txt');
    await writeFile(src, 'payload');

    const seq = mockFetchSeq([
      { ok: true, upload_url: 'https://files.slack.com/upload/v1/ABC', file_id: 'F123' },
      { ok: true },
      { ok: true, files: [{ id: 'F123', name: 'note.txt' }] },
    ]);
    const ch = new SlackChannel({ token: 'xoxb-test', fetch: seq.fetch });

    const ref = await ch.uploadArtifact({ path: src, name: 'note.txt' });
    expect(ref).toEqual({ type: 'file', ref: 'F123', native: { id: 'F123', name: 'note.txt' } });

    const urls = seq.calls.mock.calls.map((c) => String(c[0]));
    expect(urls[0]).toContain('https://slack.com/api/files.getUploadURLExternal?');
    expect(urls[1]).toBe('https://files.slack.com/upload/v1/ABC');
    expect(urls[2]).toBe('https://slack.com/api/files.completeUploadExternal');

    // With no target the completeUploadExternal body never associates a
    // conversation: no `channel_id`/`thread_ts` (file stays workspace-private).
    const completeBody = new URLSearchParams(
      (seq.calls.mock.calls[2][1] as RequestInit).body as string,
    );
    expect(completeBody.has('channel_id')).toBe(false);
    expect(completeBody.has('thread_ts')).toBe(false);
    expect(completeBody.has('channels')).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });

  it('shares the artifact into a conversation thread when a target is given (M3b)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'slack-up-'));
    const src = join(dir, 'note.txt');
    await writeFile(src, 'payload');

    const seq = mockFetchSeq([
      { ok: true, upload_url: 'https://files.slack.com/upload/v1/ABC', file_id: 'F123' },
      { ok: true },
      { ok: true, files: [{ id: 'F123', name: 'note.txt' }] },
    ]);
    const ch = new SlackChannel({ token: 'xoxb-test', fetch: seq.fetch });

    await ch.uploadArtifact(
      { path: src, name: 'note.txt' },
      { channel: 'C_chat', threadTs: '1710000000.000050' },
    );

    // The modern external flow uses `channel_id` (singular) + `thread_ts`, NOT the
    // legacy `files.upload` `channels` (plural).
    const completeBody = new URLSearchParams(
      (seq.calls.mock.calls[2][1] as RequestInit).body as string,
    );
    expect(completeBody.get('channel_id')).toBe('C_chat');
    expect(completeBody.get('thread_ts')).toBe('1710000000.000050');
    expect(completeBody.has('channels')).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });

  it('shares into the conversation without a thread_ts when none is given', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'slack-up-'));
    const src = join(dir, 'note.txt');
    await writeFile(src, 'payload');

    const seq = mockFetchSeq([
      { ok: true, upload_url: 'https://files.slack.com/upload/v1/ABC', file_id: 'F123' },
      { ok: true },
      { ok: true, files: [{ id: 'F123', name: 'note.txt' }] },
    ]);
    const ch = new SlackChannel({ token: 'xoxb-test', fetch: seq.fetch });

    await ch.uploadArtifact({ path: src, name: 'note.txt' }, { channel: 'C_chat' });

    const completeBody = new URLSearchParams(
      (seq.calls.mock.calls[2][1] as RequestInit).body as string,
    );
    expect(completeBody.get('channel_id')).toBe('C_chat');
    expect(completeBody.has('thread_ts')).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });

  it('renders a result with artifacts as :paperclip: reference blocks + fallback names', async () => {
    await channel.send(TO, {
      kind: 'result',
      markdown: 'All done',
      artifacts: [
        { type: 'file', ref: 'F1', native: { id: 'F1', name: 'report.md' } },
        { type: 'image', ref: 'F2', native: { id: 'F2', title: 'chart.png' } },
        // No native name/title → falls back to the opaque ref id.
        { type: 'file', ref: 'F3' },
      ],
    });
    const body = lastBody(fetchMock.calls);
    const blocks = body.blocks as { type: string; text?: { text: string } }[];
    // body block + one section per artifact.
    expect(blocks).toHaveLength(4);
    expect(blocks[0].text?.text).toBe('All done');
    expect(blocks[1].text?.text).toBe(':paperclip: report.md');
    expect(blocks[2].text?.text).toBe(':paperclip: chart.png');
    expect(blocks[3].text?.text).toBe(':paperclip: F3');
    // Fallback text lists the file names so notification surfaces stay readable.
    expect(body.text).toContain('All done');
    expect(body.text).toContain('report.md');
    expect(body.text).toContain('chart.png');
  });

  it('leaves a result without artifacts unchanged (regression)', async () => {
    await channel.send(TO, { kind: 'result', markdown: '# Answer\nAll done' });
    const body = lastBody(fetchMock.calls);
    const blocks = body.blocks as unknown[];
    expect(blocks).toHaveLength(1);
    expect(body.text).toBe('# Answer\nAll done');
  });

  it('truncates a large artifact set against the ~50-block cap with a visible (+N more) note', async () => {
    const artifacts = Array.from({ length: 60 }, (_, i) => ({
      type: 'file' as const,
      ref: `F${i}`,
      native: { id: `F${i}`, name: `file-${i}.txt` },
    }));
    await channel.send(TO, { kind: 'result', markdown: 'Done', artifacts });
    const body = lastBody(fetchMock.calls);
    const blocks = body.blocks as { type: string; text?: { text: string } }[];
    // Never exceeds the Block Kit cap.
    expect(blocks.length).toBeLessThanOrEqual(50);
    expect(blocks).toHaveLength(50);
    // body(1) + shown refs(48) + overflow note(1) = 50; 60 - 48 = 12 hidden.
    const note = blocks[blocks.length - 1].text?.text ?? '';
    expect(note).toContain('+12 more');
    expect(body.text).toContain('(+12 more)');
  });

  it('fetchAttachment downloads url_private and sanitizes a traversal-laden name', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'slack-att-'));
    const seq = mockFetchSeq([{}]);
    const ch = new SlackChannel({ token: 'xoxb-test', fetch: seq.fetch });

    const local = await ch.fetchAttachment(
      {
        type: 'file',
        id: 'F999',
        name: '../../escape.txt',
        native: { id: 'F999', url_private: 'https://files.slack.com/files-pri/T/F999/x.txt' },
      },
      dir,
    );

    expect(local.name).toBe('escape.txt');
    expect(local.path).toBe(join(dir, 'escape.txt'));
    expect(await readFile(local.path, 'utf8')).toBe('payload');
    // The private URL download carries the bearer token.
    const [, init] = seq.calls.mock.calls[0];
    expect((init as RequestInit | undefined)?.headers).toMatchObject({
      Authorization: 'Bearer xoxb-test',
    });
    await rm(dir, { recursive: true, force: true });
  });
});
