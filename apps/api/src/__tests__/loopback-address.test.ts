import { describe, expect, it } from 'vitest';
import { isLoopbackAddress } from '../admin-api.js';

describe('isLoopbackAddress', () => {
  it('accepts real loopback addresses', () => {
    for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost']) {
      expect(isLoopbackAddress(ip)).toBe(true);
    }
  });

  it('fails closed on an absent address', () => {
    // Regression: undefined previously granted loopback trust (fail-open).
    expect(isLoopbackAddress(undefined)).toBe(false);
    expect(isLoopbackAddress('')).toBe(false);
  });

  it('rejects non-loopback addresses', () => {
    expect(isLoopbackAddress('10.0.0.5')).toBe(false);
    expect(isLoopbackAddress('203.0.113.7')).toBe(false);
  });
});
