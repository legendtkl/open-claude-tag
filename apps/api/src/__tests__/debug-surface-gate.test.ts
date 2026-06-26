import { describe, expect, it } from 'vitest';
import { isLoopbackAddress } from '../admin-api.js';

// Mirrors the onRequest gate's effective-loopback predicate (server.ts):
// peer must be loopback AND, behind a same-host proxy, the first XFF hop too.
function isEffectivelyLoopback(ip: string | undefined, xff?: string | string[]): boolean {
  if (!isLoopbackAddress(ip)) return false;
  if (!xff) return true;
  const first = (Array.isArray(xff) ? xff[0] : xff).split(',')[0]?.trim();
  return isLoopbackAddress(first || undefined);
}

describe('debug surface effective-loopback gate', () => {
  it('allows a true local caller (loopback peer, no proxy)', () => {
    expect(isEffectivelyLoopback('127.0.0.1', undefined)).toBe(true);
  });

  it('denies a proxied remote caller (loopback peer, remote XFF)', () => {
    // The critical bypass: same-host reverse proxy makes request.ip loopback.
    expect(isEffectivelyLoopback('127.0.0.1', '203.0.113.7')).toBe(false);
    expect(isEffectivelyLoopback('127.0.0.1', '203.0.113.7, 127.0.0.1')).toBe(false);
  });

  it('allows a proxied local caller (loopback peer and loopback XFF)', () => {
    expect(isEffectivelyLoopback('127.0.0.1', '127.0.0.1')).toBe(true);
  });

  it('denies a non-loopback peer outright', () => {
    expect(isEffectivelyLoopback('10.0.0.5', undefined)).toBe(false);
  });
});
