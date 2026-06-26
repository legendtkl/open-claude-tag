import { describe, it, expect, vi } from 'vitest';
import { closeSession, listSessions, useSession } from '../commands.js';

function makeDb(selectRows: unknown[] = []) {
  const updateChain = {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(undefined),
  };
  const deleteChain = {
    where: vi.fn().mockResolvedValue(undefined),
  };
  const selectChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockResolvedValue(selectRows),
    limit: vi.fn().mockResolvedValue(selectRows),
  };
  return {
    select: vi.fn(() => selectChain),
    update: vi.fn(() => updateChain),
    delete: vi.fn(() => deleteChain),
    insert: vi.fn(),
    _selectChain: selectChain,
    _updateChain: updateChain,
    _deleteChain: deleteChain,
  };
}

describe('closeSession', () => {
  it('sets session status to archived and removes chatActiveSessions pointer', async () => {
    const db = makeDb();

    await closeSession(db as any, 'session-abc');

    expect(db.update).toHaveBeenCalledOnce();
    expect(db._updateChain.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'archived', updatedAt: expect.any(Date) }),
    );
    expect(db._updateChain.where).toHaveBeenCalledOnce();
    expect(db.delete).toHaveBeenCalledOnce();
    expect(db._deleteChain.where).toHaveBeenCalledOnce();
  });

  it('is a no-op when session does not exist (does not throw)', async () => {
    const db = makeDb();

    await expect(closeSession(db as any, 'nonexistent-id')).resolves.toBeUndefined();
  });
});

describe('session command visibility', () => {
  it('filters internal discussion sessions from list results', async () => {
    const db = makeDb([]);

    await listSessions(db as any, 'chat_1');

    expect(db.select).toHaveBeenCalledOnce();
    expect(db._selectChain.where).toHaveBeenCalledOnce();
  });

  it('does not allow using an internal discussion session', async () => {
    const db = makeDb([]);

    const result = await useSession(db as any, 'chat_1', 'session_discussion');

    expect(result).toEqual({ success: false, error: 'Session not found in this chat' });
    expect(db.insert).not.toHaveBeenCalled();
  });
});
