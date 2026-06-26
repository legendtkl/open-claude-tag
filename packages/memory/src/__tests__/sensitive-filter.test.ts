import { describe, it, expect } from 'vitest';
import { containsSensitiveInfo, filterSensitiveContent } from '../sensitive-filter.js';

describe('containsSensitiveInfo', () => {
  it('detects API keys (sk- pattern)', () => {
    expect(containsSensitiveInfo('my key is sk-abcdefghijklmnopqrstuvwxyz1234567890')).toBe(true);
  });

  it('detects password patterns', () => {
    expect(containsSensitiveInfo('password: mySecret123')).toBe(true);
    expect(containsSensitiveInfo('password=mySecret123')).toBe(true);
  });

  it('detects token patterns', () => {
    expect(containsSensitiveInfo('token: abc123def456')).toBe(true);
  });

  it('detects GitHub tokens', () => {
    expect(containsSensitiveInfo('ghp_abcdefghijklmnopqrstuvwxyz1234567890')).toBe(true);
  });

  it('detects private keys', () => {
    expect(containsSensitiveInfo('-----BEGIN RSA PRIVATE KEY-----')).toBe(true);
  });

  it('allows normal text', () => {
    expect(containsSensitiveInfo('I prefer TypeScript for development')).toBe(false);
  });

  it('allows normal code snippets', () => {
    expect(containsSensitiveInfo('const x = 42; function hello() {}')).toBe(false);
  });

  it('detects api_key patterns', () => {
    expect(containsSensitiveInfo('api_key: sk123456')).toBe(true);
  });
});

describe('filterSensitiveContent', () => {
  it('redacts API keys', () => {
    const filtered = filterSensitiveContent(
      'Use key sk-abcdefghijklmnopqrstuvwxyz1234567890 for auth',
    );
    expect(filtered).toContain('[REDACTED]');
    expect(filtered).not.toContain('sk-');
  });

  it('keeps non-sensitive text intact', () => {
    const text = 'I prefer TypeScript';
    expect(filterSensitiveContent(text)).toBe(text);
  });
});
