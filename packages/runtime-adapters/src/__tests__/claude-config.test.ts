import { describe, expect, it } from 'vitest';
import { resolveClaudeAuthToken, resolveClaudeStartupConfig } from '../claude-config.js';

describe('resolveClaudeAuthToken', () => {
  it('uses ANTHROPIC_API_KEY when it is the only configured auth env', () => {
    expect(
      resolveClaudeAuthToken({
        ANTHROPIC_API_KEY: 'api-key-only',
      }),
    ).toBe('api-key-only');
  });

  it('uses ANTHROPIC_AUTH_TOKEN when it is the only configured auth env', () => {
    expect(
      resolveClaudeAuthToken({
        ANTHROPIC_AUTH_TOKEN: 'legacy-token',
      }),
    ).toBe('legacy-token');
  });

  it('prefers ANTHROPIC_API_KEY when both auth envs are configured', () => {
    expect(
      resolveClaudeAuthToken({
        ANTHROPIC_API_KEY: 'preferred-api-key',
        ANTHROPIC_AUTH_TOKEN: 'legacy-token',
      }),
    ).toBe('preferred-api-key');
  });

  it('returns an empty string when neither auth env is configured', () => {
    expect(resolveClaudeAuthToken({})).toBe('');
  });
});

describe('resolveClaudeStartupConfig', () => {
  it('forwards ANTHROPIC_BASE_URL and the resolved auth token', () => {
    expect(
      resolveClaudeStartupConfig({
        ANTHROPIC_BASE_URL: 'https://proxy.example',
        ANTHROPIC_API_KEY: 'preferred-api-key',
        ANTHROPIC_AUTH_TOKEN: 'legacy-token',
      }),
    ).toEqual({
      baseUrl: 'https://proxy.example',
      authToken: 'preferred-api-key',
    });
  });
});
