import { describe, expect, it, vi } from 'vitest';
import { createExternalDbProvider } from '../providers/external.js';

describe('createExternalDbProvider', () => {
  it('probes and returns the configured DATABASE_URL', async () => {
    const probe = vi.fn(async () => {});
    const provider = createExternalDbProvider({
      env: { DATABASE_URL: 'postgresql://u:p@host:5432/db' },
      probe,
    });
    const { databaseUrl } = await provider.ensureRunning();
    expect(databaseUrl).toBe('postgresql://u:p@host:5432/db');
    expect(probe).toHaveBeenCalledWith('postgresql://u:p@host:5432/db');
  });

  it('throws when DATABASE_URL is missing', async () => {
    const provider = createExternalDbProvider({ env: {}, probe: async () => {} });
    await expect(provider.ensureRunning()).rejects.toThrow(/requires DATABASE_URL/);
  });

  it('propagates probe failures', async () => {
    const provider = createExternalDbProvider({
      env: { DATABASE_URL: 'postgresql://u:p@host:5432/db' },
      probe: async () => {
        throw new Error('connection refused');
      },
    });
    await expect(provider.ensureRunning()).rejects.toThrow(/connection refused/);
  });

  it('stop is a no-op', async () => {
    const provider = createExternalDbProvider({ env: { DATABASE_URL: 'postgresql://u:p@host/db' } });
    await expect(provider.stop()).resolves.toBeUndefined();
  });
});
