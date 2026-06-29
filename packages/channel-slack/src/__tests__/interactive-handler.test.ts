import { describe, it, expect } from 'vitest';
import {
  handleSlackInteraction,
  normalizeSlackInteraction,
} from '../interactive-handler.js';

/**
 * A Slack `block_actions` interaction payload (the JSON Slack POSTs, url-encoded
 * under the `payload` form field). `overrides` shallow-merges the top level so a
 * test can drop a required field (e.g. `{ team: undefined }`).
 */
function blockActions(overrides: Record<string, unknown> = {}) {
  return {
    type: 'block_actions',
    team: { id: 'T999' },
    user: { id: 'U777' },
    api_app_id: 'A111',
    container: { type: 'message', message_ts: '1710000000.000100', channel_id: 'C123' },
    channel: { id: 'C123', name: 'general' },
    message: { ts: '1710000000.000100', text: 'approve?' },
    trigger_id: 'trig-123',
    response_url: 'https://hooks.slack.com/actions/T999/123/abc',
    actions: [
      {
        action_id: 'approve_button',
        block_id: 'b1',
        type: 'button',
        value: 'task-42',
        action_ts: '1710000005.123456',
      },
    ],
    ...overrides,
  };
}

describe('handleSlackInteraction', () => {
  it('dispatches a normalized message for a block_actions payload', () => {
    const outcome = handleSlackInteraction({ parsed: blockActions() });
    expect(outcome.type).toBe('dispatch');
    if (outcome.type !== 'dispatch') throw new Error('expected dispatch');

    const { message } = outcome;
    expect(message.channel.kind).toBe('slack');
    expect(message.eventType).toBe('interaction');
    expect(message.content.type).toBe('interaction');
    // Source message ts is the message the button is on.
    expect(message.messageId).toBe('1710000000.000100');
    // eventId prefers trigger_id.
    expect(message.eventId).toBe('trig-123');
    // Composite dedupe key (MUST-FIX FLAW-2): team:channel:messageTs:user:action_id:action_ts.
    expect(message.dedupeKey).toBe(
      'slack:interaction:T999:C123:1710000000.000100:U777:approve_button:1710000005.123456',
    );
    // occurredAt is derived deterministically from action_ts (seconds.micros → ms).
    expect(message.occurredAt).toBe(1710000005123);

    expect(message.scope).toMatchObject({
      kind: 'slack',
      scopeId: 'C123',
      installationId: 'T999',
      isPrivate: false,
    });
    expect(message.conversation).toMatchObject({ kind: 'slack', scopeId: 'C123' });
    expect(message.sender).toMatchObject({ id: 'U777', isBot: false });
    expect((message.sender.native as { appId?: string }).appId).toBe('A111');

    const interaction = message.content.interaction;
    expect(interaction).toBeDefined();
    expect(interaction!.action).toBe('approve_button');
    expect(interaction!.value.value).toBe('task-42');
    expect(interaction!.value.response_url).toBe('https://hooks.slack.com/actions/T999/123/abc');
    expect(interaction!.value.trigger_id).toBe('trig-123');
    expect(interaction!.value.actionTs).toBe('1710000005.123456');
    expect(interaction!.value.rawAction).toMatchObject({
      action_id: 'approve_button',
      value: 'task-42',
    });

    // sourceRef points at the clicked message for a later targeted reply/update.
    expect(interaction!.sourceRef).toEqual({
      kind: 'slack',
      logicalMessageId: '1710000000.000100',
      revision: 0,
      physicalIds: ['1710000000.000100'],
      native: { channel: 'C123' },
    });

    expect(message.content.mentions).toEqual([]);
    expect(message.content.attachments).toEqual([]);
  });

  it('threads the interaction when the source message is in a thread', () => {
    const outcome = handleSlackInteraction({
      parsed: blockActions({
        message: { ts: '1710000000.000100', thread_ts: '1710000000.000050' },
      }),
    });
    expect(outcome.type).toBe('dispatch');
    if (outcome.type !== 'dispatch') throw new Error('expected dispatch');
    expect(outcome.message.conversation.threadId).toBe('1710000000.000050');
    expect(outcome.message.conversation.reply).toEqual({ rootId: '1710000000.000050' });
    expect(outcome.message.scope.threadId).toBe('1710000000.000050');
  });

  it('falls back to container channel_id / message_ts when the top-level fields are absent', () => {
    const outcome = handleSlackInteraction({
      parsed: blockActions({ channel: undefined, message: undefined }),
    });
    expect(outcome.type).toBe('dispatch');
    if (outcome.type !== 'dispatch') throw new Error('expected dispatch');
    expect(outcome.message.scope.scopeId).toBe('C123');
    expect(outcome.message.messageId).toBe('1710000000.000100');
  });

  it('falls back to action_ts for eventId when there is no trigger_id', () => {
    const outcome = handleSlackInteraction({ parsed: blockActions({ trigger_id: undefined }) });
    expect(outcome.type).toBe('dispatch');
    if (outcome.type !== 'dispatch') throw new Error('expected dispatch');
    expect(outcome.message.eventId).toBe('1710000005.123456');
  });

  it('ignores a view_submission with a typed reason', () => {
    const outcome = handleSlackInteraction({ parsed: { type: 'view_submission' } });
    expect(outcome).toEqual({
      type: 'ignore',
      reason: 'unsupported_interaction_type:view_submission',
    });
  });

  it('ignores a shortcut / message_action with a typed reason', () => {
    expect(handleSlackInteraction({ parsed: { type: 'shortcut' } })).toEqual({
      type: 'ignore',
      reason: 'unsupported_interaction_type:shortcut',
    });
    expect(handleSlackInteraction({ parsed: { type: 'message_action' } })).toEqual({
      type: 'ignore',
      reason: 'unsupported_interaction_type:message_action',
    });
  });

  it('ignores a non-object payload', () => {
    expect(handleSlackInteraction({ parsed: 'not-json' })).toEqual({
      type: 'ignore',
      reason: 'non_object_payload',
    });
    expect(handleSlackInteraction({ parsed: null })).toEqual({
      type: 'ignore',
      reason: 'non_object_payload',
    });
  });

  it.each([
    ['team', { team: undefined }],
    ['channel + container', { channel: undefined, container: { type: 'message', message_ts: '1.0' } }],
    ['user', { user: undefined }],
    ['action_id', { actions: [{ value: 'x', action_ts: '1710000005.123456' }] }],
    ['action_ts', { actions: [{ action_id: 'approve_button', value: 'x' }] }],
    ['actions (empty)', { actions: [] }],
  ])('ignores a block_actions missing %s as unnormalizable', (_label, overrides) => {
    const outcome = handleSlackInteraction({ parsed: blockActions(overrides) });
    expect(outcome).toEqual({ type: 'ignore', reason: 'unnormalizable_block_actions' });
  });
});

describe('normalizeSlackInteraction', () => {
  it('returns null for a non-block_actions payload', () => {
    expect(normalizeSlackInteraction({ type: 'view_submission' })).toBeNull();
    expect(normalizeSlackInteraction('nope')).toBeNull();
    expect(normalizeSlackInteraction(null)).toBeNull();
  });

  it('returns null when a routing/dedupe-critical field is missing', () => {
    expect(normalizeSlackInteraction(blockActions({ team: undefined }))).toBeNull();
    expect(normalizeSlackInteraction(blockActions({ user: undefined }))).toBeNull();
    expect(normalizeSlackInteraction(blockActions({ actions: [] }))).toBeNull();
  });

  it('omits undefined optional fields from the interaction value', () => {
    const message = normalizeSlackInteraction(
      blockActions({
        response_url: undefined,
        trigger_id: undefined,
        actions: [{ action_id: 'a1', action_ts: '1710000005.123456' }],
      }),
    );
    expect(message).not.toBeNull();
    const value = message!.content.interaction!.value;
    expect('response_url' in value).toBe(false);
    expect('trigger_id' in value).toBe(false);
    expect('value' in value).toBe(false);
    expect(value.actionTs).toBe('1710000005.123456');
  });
});
