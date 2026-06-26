import { describe, it, expect } from 'vitest';
import { DAEMON_FEATURE_RUNTIME_ENV } from '@open-tag/daemon-protocol';
import { pair, pairUrl, describePairFailure, PairError } from '../pair.js';

const CAPS = {
  runtimes: ['claude_code'] as const,
  features: [DAEMON_FEATURE_RUNTIME_ENV],
  platform: 'linux',
  hostname: 'box',
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('pair', () => {
  it('builds the pairing URL tolerating a trailing slash', () => {
    expect(pairUrl('https://x')).toBe('https://x/daemon/pair');
    expect(pairUrl('https://x/')).toBe('https://x/daemon/pair');
  });

  it('returns the parsed credentials on success', async () => {
    const fetchFn = (async () =>
      jsonResponse(201, {
        machineId: 'm1',
        machineName: 'studio-mbp',
        machineSecret: 's1',
        serverProtocol: { min: 1, max: 1 },
        heartbeatSec: 15,
      })) as unknown as typeof fetch;
    const res = await pair(
      { serverUrl: 'https://x', token: 't', capabilities: { ...CAPS, runtimes: [...CAPS.runtimes] } },
      fetchFn,
    );
    expect(res.machineId).toBe('m1');
    expect(res.machineName).toBe('studio-mbp');
    expect(res.machineSecret).toBe('s1');
  });

  it('maps 401 to a friendly token message', async () => {
    const fetchFn = (async () => jsonResponse(401, { error: 'bad' })) as unknown as typeof fetch;
    const err = await pair(
      { serverUrl: 'https://x', token: 't', capabilities: { ...CAPS, runtimes: [...CAPS.runtimes] } },
      fetchFn,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(PairError);
    expect((err as PairError).status).toBe(401);
    expect((err as PairError).message).toMatch(/invalid, expired, or already used/);
  });

  it('maps 409 to a rename hint', async () => {
    const msg = describePairFailure(409, '');
    expect(msg).toMatch(/currently unavailable/);
    expect(msg).toMatch(/Retry/);
    expect(msg).toMatch(/--name/);
  });

  it('wraps network failures without leaking internals', async () => {
    const fetchFn = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const err = await pair(
      { serverUrl: 'https://x', token: 't', capabilities: { ...CAPS, runtimes: [...CAPS.runtimes] } },
      fetchFn,
    ).catch((e) => e);
    expect((err as PairError).message).toMatch(/Could not reach the server/);
  });
});
