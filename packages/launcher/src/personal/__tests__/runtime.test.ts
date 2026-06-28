import { describe, expect, it, vi } from 'vitest';
import { resolveConsoleUp } from '../runtime.js';

describe('resolveConsoleUp', () => {
  it('accepts a live launcher-owned console pid without probing HTTP', async () => {
    const http = vi.fn(async () => false);

    await expect(
      resolveConsoleUp('/tmp/console.pid.json', 'http://127.0.0.1:8080', {
        pidAlive: () => true,
        isHttpEndpointReachable: http,
      }),
    ).resolves.toBe(true);
    expect(http).not.toHaveBeenCalled();
  });

  it('falls back to the console URL when the pid file is stale', async () => {
    await expect(
      resolveConsoleUp('/tmp/console.pid.json', 'http://127.0.0.1:8080', {
        pidAlive: () => false,
        isHttpEndpointReachable: async () => true,
      }),
    ).resolves.toBe(true);
  });

  it('returns false when neither the pid nor console URL is reachable', async () => {
    await expect(
      resolveConsoleUp('/tmp/console.pid.json', 'http://127.0.0.1:8080', {
        pidAlive: () => false,
        isHttpEndpointReachable: async () => false,
      }),
    ).resolves.toBe(false);
  });
});
