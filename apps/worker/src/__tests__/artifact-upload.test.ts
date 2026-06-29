import { describe, expect, it, vi } from 'vitest';
import type { ArtifactRef } from '@open-tag/core-types';
import type { Logger } from 'pino';
import { selectUploadableArtifacts } from '../artifact-upload.js';

function artifact(name: string, path: string, mimeType = 'text/plain'): ArtifactRef {
  return { name, path, mimeType, sha256: 'deadbeef', sizeBytes: 3 };
}

describe('selectUploadableArtifacts', () => {
  it('maps readable artifacts to LocalFile shape (path, name, mimeType)', async () => {
    const canRead = vi.fn(async () => true);
    const files = await selectUploadableArtifacts(
      [artifact('a.txt', '/w/a.txt'), artifact('b.md', '/w/b.md', 'text/markdown')],
      { canRead },
    );

    expect(files).toEqual([
      { path: '/w/a.txt', name: 'a.txt', mimeType: 'text/plain' },
      { path: '/w/b.md', name: 'b.md', mimeType: 'text/markdown' },
    ]);
    expect(canRead).toHaveBeenCalledTimes(2);
  });

  it('skips + logs an unreadable (e.g. remote-dispatch) path instead of throwing', async () => {
    const canRead = vi.fn(async (path: string) => path === '/w/local.txt');
    const warn = vi.fn();
    const files = await selectUploadableArtifacts(
      [artifact('local.txt', '/w/local.txt'), artifact('remote.bin', '/daemon/remote.bin')],
      { canRead, logger: { warn } as unknown as Logger },
    );

    expect(files).toEqual([{ path: '/w/local.txt', name: 'local.txt', mimeType: 'text/plain' }]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatchObject({ path: '/daemon/remote.bin', name: 'remote.bin' });
  });

  it('returns an empty list for no artifacts', async () => {
    expect(await selectUploadableArtifacts([], { canRead: vi.fn(async () => true) })).toEqual([]);
  });
});
