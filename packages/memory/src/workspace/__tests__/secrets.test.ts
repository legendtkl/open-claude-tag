import { describe, expect, it } from 'vitest';
import { containsHighConfidenceSecret } from '../secrets.js';

describe('containsHighConfidenceSecret', () => {
  it.each([
    ['OpenAI-style key', `the key is sk-${'a'.repeat(32)}`],
    ['private key block', '-----BEGIN RSA PRIVATE KEY-----\nMIIE...'],
    ['password assignment', 'password=hunter2x'],
    ['api key assignment', 'API_KEY: abc123def456'],
    ['token assignment with long value', `token = ${'t'.repeat(24)}`],
    ['github pat', `ghp_${'A1'.repeat(18)}`],
    ['slack token', 'xoxb-1234567890-abcdef'],
    ['aws access key id', 'AKIAIOSFODNN7EXAMPLE'],
    ['signed jwt', `eyJ${'a'.repeat(24)}.eyJ${'b'.repeat(24)}.${'c'.repeat(16)}`],
  ])('flags %s', (_label, text) => {
    expect(containsHighConfidenceSecret(text)).toBe(true);
  });

  it.each([
    ['a git commit SHA', 'reverted in a94a8fe5ccb19ba61c4c0873d391e987982fbbd3 yesterday'],
    ['a long ordinary word run', 'y'.repeat(200)],
    ['prose with hashes and urls', 'see https://example.com/very/long/path/abcdef1234567890abcdef1234567890 for details'],
    ['markdown notes', '# Work log\n- merged PR #12\n- pnpm install fixed by clearing the store\n'],
    ['mention of the word token', 'the design uses a token budget of 2k for memory'],
  ])('does not flag %s', (_label, text) => {
    expect(containsHighConfidenceSecret(text)).toBe(false);
  });
});
