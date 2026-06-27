import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { isEffectivelyLoopback } from '../admin-api.js';

// Exercise the REAL shared predicate (used by both the debug-surface onRequest
// gate in server.ts and the admin break-glass guard) so the test cannot drift
// from production. A minimal request carries only what the predicate reads: the
// unspoofable TCP peer (request.socket.remoteAddress) and the XFF header.
function makeRequest(remoteAddress: string | undefined, xff?: string | string[]): FastifyRequest {
  const headers: Record<string, string | string[]> = {};
  if (xff !== undefined) headers['x-forwarded-for'] = xff;
  return { socket: { remoteAddress }, headers } as unknown as FastifyRequest;
}

describe('debug surface effective-loopback gate', () => {
  it('allows a true local caller (loopback peer, no proxy)', () => {
    expect(isEffectivelyLoopback(makeRequest('127.0.0.1'))).toBe(true);
    expect(isEffectivelyLoopback(makeRequest('::1'))).toBe(true);
    expect(isEffectivelyLoopback(makeRequest('::ffff:127.0.0.1'))).toBe(true);
  });

  it('denies a non-loopback peer outright, even with a forged loopback XFF', () => {
    expect(isEffectivelyLoopback(makeRequest('10.0.0.5'))).toBe(false);
    expect(isEffectivelyLoopback(makeRequest('203.0.113.7', '127.0.0.1'))).toBe(false);
  });

  it('fails closed when the peer is absent', () => {
    expect(isEffectivelyLoopback(makeRequest(undefined))).toBe(false);
  });

  it('denies the append-proxy spoof that forges a loopback first hop', () => {
    // The critical bypass: a same-host append-style proxy keeps the attacker's
    // leftmost hop and appends the real client, so the FIRST hop is forgeable.
    expect(isEffectivelyLoopback(makeRequest('127.0.0.1', '127.0.0.1, 203.0.113.7'))).toBe(false);
    expect(
      isEffectivelyLoopback(makeRequest('127.0.0.1', '127.0.0.1, 127.0.0.1, 203.0.113.7')),
    ).toBe(false);
  });

  it('denies a proxied remote caller (loopback peer, remote last hop)', () => {
    expect(isEffectivelyLoopback(makeRequest('127.0.0.1', '203.0.113.7'))).toBe(false);
  });

  it('allows a proxied local caller (loopback peer, loopback last hop)', () => {
    expect(isEffectivelyLoopback(makeRequest('127.0.0.1', '127.0.0.1'))).toBe(true);
    expect(isEffectivelyLoopback(makeRequest('127.0.0.1', '::1'))).toBe(true);
    // Forged/earlier prefix is ignored; the proxy-appended last hop is loopback.
    expect(isEffectivelyLoopback(makeRequest('127.0.0.1', '203.0.113.7, 127.0.0.1'))).toBe(true);
  });

  it('uses the last hop when duplicate XFF headers arrive as an array', () => {
    expect(isEffectivelyLoopback(makeRequest('127.0.0.1', ['127.0.0.1', '203.0.113.7']))).toBe(
      false,
    );
    expect(isEffectivelyLoopback(makeRequest('127.0.0.1', ['203.0.113.7', '127.0.0.1']))).toBe(
      true,
    );
  });

  it('rejects malformed chains with empty segments (fail closed)', () => {
    expect(isEffectivelyLoopback(makeRequest('127.0.0.1', '127.0.0.1, '))).toBe(false);
    expect(isEffectivelyLoopback(makeRequest('127.0.0.1', ', 127.0.0.1'))).toBe(false);
    expect(isEffectivelyLoopback(makeRequest('127.0.0.1', '   '))).toBe(false);
  });

  it('rejects a "localhost" hostname hop (proxies forward IP literals, not names)', () => {
    expect(isEffectivelyLoopback(makeRequest('127.0.0.1', 'localhost'))).toBe(false);
    expect(isEffectivelyLoopback(makeRequest('127.0.0.1', '203.0.113.7, localhost'))).toBe(false);
  });
});
