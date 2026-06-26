import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../db.js';
import { loadChatDefaultWorkDir } from '../chat-config-repository.js';

function makeDbStub(limitResult: unknown[]) {
  const calls = { where: undefined as unknown };
  const chain = {
    from: () => chain,
    where: (cond: unknown) => {
      calls.where = cond;
      return chain;
    },
    limit: async () => limitResult,
  };
  return {
    db: { select: vi.fn(() => chain) } as unknown as Database,
    calls,
  };
}

describe('loadChatDefaultWorkDir', () => {
  it('returns the chat-level default workdir when present', async () => {
    const { db } = makeDbStub([{ defaultWorkDir: '/repos/web' }]);
    await expect(loadChatDefaultWorkDir(db, 'default', 'oc_chat')).resolves.toBe('/repos/web');
  });

  it('returns null when no chat config row exists', async () => {
    const { db } = makeDbStub([]);
    await expect(loadChatDefaultWorkDir(db, 'default', 'oc_chat')).resolves.toBeNull();
  });

  it('returns null when the row has no default workdir', async () => {
    const { db } = makeDbStub([{ defaultWorkDir: null }]);
    await expect(loadChatDefaultWorkDir(db, 'default', 'oc_chat')).resolves.toBeNull();
  });
});
