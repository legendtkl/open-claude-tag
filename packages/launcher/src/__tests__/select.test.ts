import { describe, expect, it } from 'vitest';
import { DEFAULT_DB_MODE, resolveDbMode, resolveDbProvider } from '../select.js';

describe('resolveDbMode', () => {
  it('defaults to embedded when unset', () => {
    expect(resolveDbMode({})).toBe(DEFAULT_DB_MODE);
    expect(resolveDbMode({ OPEN_TAG_DB_MODE: '  ' })).toBe('embedded');
  });

  it('passes through valid modes', () => {
    expect(resolveDbMode({ OPEN_TAG_DB_MODE: 'embedded' })).toBe('embedded');
    expect(resolveDbMode({ OPEN_TAG_DB_MODE: 'docker' })).toBe('docker');
    expect(resolveDbMode({ OPEN_TAG_DB_MODE: 'external' })).toBe('external');
  });

  it('fails closed on an unknown mode', () => {
    expect(() => resolveDbMode({ OPEN_TAG_DB_MODE: 'sqlite' })).toThrow(/Invalid OPEN_TAG_DB_MODE/);
  });
});

describe('resolveDbProvider', () => {
  it('returns a provider implementing the lifecycle contract for each mode', () => {
    for (const mode of ['embedded', 'docker', 'external'] as const) {
      const provider = resolveDbProvider(mode, {});
      expect(typeof provider.ensureRunning).toBe('function');
      expect(typeof provider.stop).toBe('function');
    }
  });
});
