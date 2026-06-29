import { describe, it, expect } from 'vitest';
import { SlackChannel } from '../slack-channel.js';
import { handleSlackEvent } from '../events-handler.js';

const channel = new SlackChannel({ token: 'xoxb-test' });

/** A Slack `event_callback` envelope wrapping a plain user `message` event. */
function eventCallback(overrides: Record<string, unknown> = {}) {
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
      text: '<@U999> hello there',
      ts: '1710000000.000100',
      event_ts: '1710000000.000100',
      ...overrides,
    },
  };
}

describe('handleSlackEvent', () => {
  it('echoes the challenge for a url_verification handshake', () => {
    const outcome = handleSlackEvent({
      parsed: { type: 'url_verification', challenge: 'abc123', token: 'tok' },
      channel,
    });
    expect(outcome).toEqual({ type: 'url_verification', challenge: 'abc123' });
  });

  it('ignores a url_verification missing the challenge', () => {
    const outcome = handleSlackEvent({
      parsed: { type: 'url_verification' },
      channel,
    });
    expect(outcome).toEqual({ type: 'ignore', reason: 'missing_challenge' });
  });

  it('dispatches a normalized human message from an event_callback', () => {
    const outcome = handleSlackEvent({ parsed: eventCallback(), channel });
    expect(outcome.type).toBe('dispatch');
    if (outcome.type !== 'dispatch') throw new Error('expected dispatch');
    expect(outcome.message.scope.kind).toBe('slack');
    expect(outcome.message.dedupeKey).toBe('slack:Ev0001');
    expect(outcome.message.content.text).toContain('hello there');
  });

  it('surfaces the retry number on a dispatch outcome', () => {
    const outcome = handleSlackEvent({ parsed: eventCallback(), channel, retryNum: 2 });
    expect(outcome.type).toBe('dispatch');
    if (outcome.type !== 'dispatch') throw new Error('expected dispatch');
    expect(outcome.retryNum).toBe(2);
  });

  it('ignores a bot message (normalize → null)', () => {
    const outcome = handleSlackEvent({
      parsed: eventCallback({ bot_id: 'B123' }),
      channel,
    });
    expect(outcome).toEqual({ type: 'ignore', reason: 'non_dispatchable_event' });
  });

  it('ignores an edit/delete subtype event (normalize → null)', () => {
    const outcome = handleSlackEvent({
      parsed: eventCallback({ subtype: 'message_changed' }),
      channel,
    });
    expect(outcome).toEqual({ type: 'ignore', reason: 'non_dispatchable_event' });
  });

  it('ignores an unsupported envelope type', () => {
    const outcome = handleSlackEvent({ parsed: { type: 'app_rate_limited' }, channel });
    expect(outcome).toEqual({ type: 'ignore', reason: 'unsupported_type:app_rate_limited' });
  });

  it('ignores a non-object payload', () => {
    const outcome = handleSlackEvent({ parsed: 'not-json', channel });
    expect(outcome).toEqual({ type: 'ignore', reason: 'non_object_payload' });
  });

  it('emits a lifecycle outcome for an app_uninstalled event', () => {
    const outcome = handleSlackEvent({
      parsed: { type: 'event_callback', team_id: 'T999', event: { type: 'app_uninstalled' } },
      channel,
    });
    expect(outcome).toEqual({ type: 'lifecycle', lifecycle: 'app_uninstalled', teamId: 'T999' });
  });

  it('ignores app_uninstalled without a team_id', () => {
    const outcome = handleSlackEvent({
      parsed: { type: 'event_callback', event: { type: 'app_uninstalled' } },
      channel,
    });
    expect(outcome).toEqual({ type: 'ignore', reason: 'app_uninstalled_missing_team_id' });
  });

  it('emits a lifecycle outcome for tokens_revoked when the BOT token was revoked', () => {
    const outcome = handleSlackEvent({
      parsed: {
        type: 'event_callback',
        team_id: 'T999',
        event: { type: 'tokens_revoked', tokens: { oauth: ['U1'], bot: ['U_BOT'] } },
      },
      channel,
    });
    expect(outcome).toEqual({ type: 'lifecycle', lifecycle: 'tokens_revoked', teamId: 'T999' });
  });

  it('ignores tokens_revoked that only revokes user (oauth) tokens', () => {
    const outcome = handleSlackEvent({
      parsed: {
        type: 'event_callback',
        team_id: 'T999',
        event: { type: 'tokens_revoked', tokens: { oauth: ['U1'], bot: [] } },
      },
      channel,
    });
    expect(outcome).toEqual({ type: 'ignore', reason: 'tokens_revoked_no_bot_token' });
  });
});
