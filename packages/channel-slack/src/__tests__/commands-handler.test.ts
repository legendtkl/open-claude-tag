import { describe, it, expect } from 'vitest';
import {
  handleSlackCommand,
  parseSlackSubcommand,
  SLACK_HELP_TEXT,
} from '../commands-handler.js';

describe('parseSlackSubcommand', () => {
  it('treats empty/absent text as help', () => {
    expect(parseSlackSubcommand(undefined)).toBe('help');
    expect(parseSlackSubcommand('')).toBe('help');
    expect(parseSlackSubcommand('   ')).toBe('help');
  });

  it('parses help and status case-insensitively', () => {
    expect(parseSlackSubcommand('help')).toBe('help');
    expect(parseSlackSubcommand('HELP')).toBe('help');
    expect(parseSlackSubcommand('status')).toBe('status');
    expect(parseSlackSubcommand('Status')).toBe('status');
  });

  it('takes the first whitespace token after trimming', () => {
    expect(parseSlackSubcommand('  status extra  ')).toBe('status');
    expect(parseSlackSubcommand('help me please')).toBe('help');
  });

  it('reports anything else as unknown', () => {
    expect(parseSlackSubcommand('chat')).toBe('unknown');
    expect(parseSlackSubcommand('project foo')).toBe('unknown');
  });
});

describe('handleSlackCommand', () => {
  it('replies with the help text for an empty subcommand', () => {
    const outcome = handleSlackCommand({ command: '/opentag', text: '' });
    expect(outcome).toEqual({ type: 'reply', text: SLACK_HELP_TEXT, ephemeral: true });
  });

  it('replies with the help text for `help`', () => {
    const outcome = handleSlackCommand({ command: '/opentag', text: 'help' });
    expect(outcome).toEqual({ type: 'reply', text: SLACK_HELP_TEXT, ephemeral: true });
  });

  it('returns a status outcome for `status` (transport composes the text)', () => {
    expect(handleSlackCommand({ command: '/opentag', text: 'status' })).toEqual({
      type: 'status',
    });
  });

  it('returns a status outcome for `status` with trailing tokens (first token wins)', () => {
    expect(handleSlackCommand({ command: '/opentag', text: '  status extra  ' })).toEqual({
      type: 'status',
    });
  });

  it('politely rejects an unknown subcommand', () => {
    const outcome = handleSlackCommand({ command: '/opentag', text: 'frobnicate' });
    expect(outcome.type).toBe('reply');
    if (outcome.type !== 'reply') throw new Error('expected reply');
    expect(outcome.ephemeral).toBe(true);
    expect(outcome.text).toContain('Unknown subcommand');
    expect(outcome.text).toContain('/opentag help');
  });

  it('ignores a command other than /opentag (defensive against app misconfig)', () => {
    const outcome = handleSlackCommand({ command: '/something-else', text: 'help' });
    expect(outcome).toEqual({
      type: 'ignore',
      reason: 'unexpected_command:/something-else',
    });
  });
});

describe('SLACK_HELP_TEXT honesty', () => {
  it('lists only the commands actually available today', () => {
    expect(SLACK_HELP_TEXT).toContain('/opentag help');
    expect(SLACK_HELP_TEXT).toContain('/opentag status');
  });

  it('does not over-promise unwired commands', () => {
    for (const unwired of ['/opentag chat', '/opentag project', '/opentag schedule']) {
      expect(SLACK_HELP_TEXT).not.toContain(unwired);
    }
  });
});
