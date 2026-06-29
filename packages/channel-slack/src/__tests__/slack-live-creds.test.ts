import { describe, it, expect } from 'vitest';
import { slackLiveCredsPresent } from '../__e2e__/slack-live-creds.js';

/**
 * Unit-proves the self-skip predicate used by the opt-in live Slack e2e. Runs in
 * the DEFAULT suite (no network): the env is injected, never the host's real
 * credentials, and the predicate only reports PRESENCE — it never returns values.
 */
describe('slackLiveCredsPresent', () => {
  it('is true when both SLACK_BOT_TOKEN and SLACK_E2E_CHANNEL_ID are set', () => {
    expect(
      slackLiveCredsPresent({ env: { SLACK_BOT_TOKEN: 'xoxb-x', SLACK_E2E_CHANNEL_ID: 'C123' } }),
    ).toBe(true);
  });

  it('is false when SLACK_BOT_TOKEN is missing', () => {
    expect(slackLiveCredsPresent({ env: { SLACK_E2E_CHANNEL_ID: 'C123' } })).toBe(false);
  });

  it('is false when SLACK_E2E_CHANNEL_ID is missing', () => {
    expect(slackLiveCredsPresent({ env: { SLACK_BOT_TOKEN: 'xoxb-x' } })).toBe(false);
  });

  it('is false when neither is set', () => {
    expect(slackLiveCredsPresent({ env: {} })).toBe(false);
  });

  it('treats a blank SLACK_BOT_TOKEN as absent', () => {
    expect(
      slackLiveCredsPresent({ env: { SLACK_BOT_TOKEN: '   ', SLACK_E2E_CHANNEL_ID: 'C123' } }),
    ).toBe(false);
  });

  it('treats a blank SLACK_E2E_CHANNEL_ID as absent', () => {
    expect(
      slackLiveCredsPresent({ env: { SLACK_BOT_TOKEN: 'xoxb-x', SLACK_E2E_CHANNEL_ID: '' } }),
    ).toBe(false);
  });
});
