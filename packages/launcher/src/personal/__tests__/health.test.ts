import { describe, expect, it, vi } from 'vitest';
import {
  isHttpEndpointReachable,
  isPersonalHealthReady,
  waitForPersonalHealth,
  type HealthSnapshot,
} from '../health.js';

const ready: HealthSnapshot = {
  status: 'ok',
  db: 'connected',
  instanceId: 'personal',
  worker: { status: 'healthy' },
};

describe('isPersonalHealthReady', () => {
  it('accepts a healthy personal stack', () => {
    expect(isPersonalHealthReady(ready)).toBe(true);
  });

  it('rejects null', () => {
    expect(isPersonalHealthReady(null)).toBe(false);
  });

  it('rejects a foreign instance answering on the same port', () => {
    expect(isPersonalHealthReady({ ...ready, instanceId: 'primary' })).toBe(false);
  });

  it('rejects a disconnected DB', () => {
    expect(isPersonalHealthReady({ ...ready, db: 'disconnected' })).toBe(false);
  });

  it('rejects a down worker', () => {
    expect(isPersonalHealthReady({ ...ready, worker: { status: 'down' } })).toBe(false);
  });

  it('rejects degraded status', () => {
    expect(isPersonalHealthReady({ ...ready, status: 'degraded' })).toBe(false);
  });
});

describe('waitForPersonalHealth', () => {
  it('resolves once health becomes ready', async () => {
    let calls = 0;
    const fetch = vi.fn(async () => {
      calls += 1;
      return {
        ok: true,
        json: async () => (calls >= 3 ? ready : { status: 'degraded', db: 'disconnected', instanceId: 'personal' }),
      };
    });
    const health = await waitForPersonalHealth('http://x/health', 10_000, {
      fetch,
      wait: async () => {},
      now: (() => {
        let t = 0;
        return () => (t += 100);
      })(),
    });
    expect(health).toEqual(ready);
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it('returns the last snapshot on timeout', async () => {
    const fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ status: 'degraded', db: 'disconnected', instanceId: 'personal' }),
    }));
    let t = 0;
    const health = await waitForPersonalHealth('http://x/health', 500, {
      fetch,
      wait: async () => {},
      now: () => (t += 300),
    });
    expect(isPersonalHealthReady(health)).toBe(false);
  });
});

describe('isHttpEndpointReachable', () => {
  it('returns true for an ok response', async () => {
    const fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({}),
    }));

    await expect(isHttpEndpointReachable('http://console', { fetch })).resolves.toBe(true);
  });

  it('returns false for non-ok responses and network errors', async () => {
    await expect(
      isHttpEndpointReachable('http://console', {
        fetch: vi.fn(async () => ({
          ok: false,
          json: async () => ({}),
        })),
      }),
    ).resolves.toBe(false);

    await expect(
      isHttpEndpointReachable('http://console', {
        fetch: vi.fn(async () => {
          throw new Error('down');
        }),
      }),
    ).resolves.toBe(false);
  });
});
