import { canonicalizeSessionId } from '@open-tag/session';
import { tasks, type Database } from '@open-tag/storage';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { refreshTaskSessionCanonicalId } from '../task-session-canonicalization.js';

vi.mock('@open-tag/session', () => ({
  canonicalizeSessionId: vi.fn(),
}));

function createMockDb() {
  const where = vi.fn().mockResolvedValue([]);
  const set = vi.fn().mockReturnValue({ where });
  const update = vi.fn().mockReturnValue({ set });
  return {
    db: { update } as unknown as Database,
    update,
    set,
    where,
  };
}

describe('refreshTaskSessionCanonicalId', () => {
  const mockedCanonicalize = vi.mocked(canonicalizeSessionId);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the current session without updating the task when already canonical', async () => {
    const { db, update } = createMockDb();
    mockedCanonicalize.mockResolvedValue('session_current');

    const sessionId = await refreshTaskSessionCanonicalId({
      db,
      taskId: 'task_1',
      sessionId: 'session_current',
      stage: 'start',
    });

    expect(sessionId).toBe('session_current');
    expect(mockedCanonicalize).toHaveBeenCalledWith(db, 'session_current');
    expect(update).not.toHaveBeenCalled();
  });

  it('moves the task to the canonical session after a delayed alias merge', async () => {
    const { db, update, set, where } = createMockDb();
    const logger = { info: vi.fn() };
    mockedCanonicalize.mockResolvedValue('session_topic');

    const sessionId = await refreshTaskSessionCanonicalId({
      db,
      taskId: 'task_1',
      sessionId: 'session_message',
      logger,
      stage: 'pre-completion',
    });

    expect(sessionId).toBe('session_topic');
    expect(update).toHaveBeenCalledWith(tasks);
    expect(set).toHaveBeenCalledWith({ sessionId: 'session_topic' });
    expect(where).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      {
        taskId: 'task_1',
        from: 'session_message',
        to: 'session_topic',
        stage: 'pre-completion',
      },
      'Canonicalized task session',
    );
  });
});
