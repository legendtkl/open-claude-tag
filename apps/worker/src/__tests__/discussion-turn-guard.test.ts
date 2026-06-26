import { TaskStatus } from '@open-tag/core-types';
import { describe, expect, it, vi } from 'vitest';
import { skipInactiveDiscussionTurnIfNeeded } from '../discussion-turn-guard.js';
import type { DiscussionRecord } from '@open-tag/storage';

function makeDiscussion(overrides: Partial<DiscussionRecord> = {}): DiscussionRecord {
  return {
    id: 'discussion_1',
    tenantKey: 'default',
    chatId: 'chat_1',
    rootThreadId: 'om_root',
    feishuAppId: null,
    sessionId: 'session_1',
    topic: 'Topic',
    status: 'active',
    roundLimit: 2,
    currentRound: 1,
    currentTurnIndex: 0,
    version: 0,
    completedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function makeDeps(discussion: DiscussionRecord | null) {
  return {
    findDiscussionById: vi.fn().mockResolvedValue(discussion),
    transitionTask: vi.fn().mockResolvedValue(undefined),
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
    },
  };
}

function makeInput(overrides: Record<string, unknown> = {}) {
  return {
    taskId: 'task_1',
    constraints: {
      discussionId: 'discussion_1',
      discussionRound: 1,
      discussionTurnIndex: 0,
      ...overrides,
    },
  };
}

describe('discussion turn guard', () => {
  it('allows active discussion turns within budget to run', async () => {
    const deps = makeDeps(makeDiscussion());

    await expect(skipInactiveDiscussionTurnIfNeeded(deps, makeInput())).resolves.toBe(false);

    expect(deps.transitionTask).not.toHaveBeenCalled();
  });

  it('ordinary-cancels queued turn tasks when the discussion is cancelled', async () => {
    const deps = makeDeps(makeDiscussion({ status: 'cancelled' }));

    await expect(skipInactiveDiscussionTurnIfNeeded(deps, makeInput())).resolves.toBe(true);

    expect(deps.transitionTask).toHaveBeenCalledWith('task_1', TaskStatus.CANCELLED, {
      errorMessage: 'Discussion is cancelled',
    });
  });

  it('ordinary-cancels over-budget stale turn tasks before runtime execution', async () => {
    const deps = makeDeps(makeDiscussion({ roundLimit: 1 }));

    await expect(
      skipInactiveDiscussionTurnIfNeeded(deps, makeInput({ discussionRound: 2 })),
    ).resolves.toBe(true);

    expect(deps.transitionTask).toHaveBeenCalledWith('task_1', TaskStatus.CANCELLED, {
      errorMessage: 'Discussion round 2 exceeds round limit 1',
    });
  });
});
