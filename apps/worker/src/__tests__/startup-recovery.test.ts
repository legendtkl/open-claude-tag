import { beforeEach, describe, expect, it, vi } from 'vitest';
import { recoverStaleRunningTasks } from '../startup-recovery.js';

describe('recoverStaleRunningTasks', () => {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('re-enqueues stale running tasks with failed or missing jobs', async () => {
    const db = {
      execute: vi
        .fn()
        .mockResolvedValueOnce([
          {
            taskId: 'task-1',
            sessionId: 'session-1',
            taskType: 'self_dev',
            goal: 'fix startup recovery',
            runtimeHint: 'codex',
            constraints: { replyLanguage: 'zh-CN' },
            chatId: 'oc_123',
            feedbackMessageId: 'om_ack_123',
            sdkSessionId: 'sdk-1',
            runtimeBackend: 'codex',
            latestJobState: 'failed',
          },
        ])
        .mockResolvedValueOnce([]),
    };
    const queue = {
      enqueue: vi.fn(async () => 'job-1'),
    };

    const result = await recoverStaleRunningTasks({
      db: db as any,
      queue: queue as any,
      logger: logger as any,
    });

    expect(result).toEqual({ inspected: 1, requeued: 1, failed: 0 });
    expect(queue.enqueue).toHaveBeenCalledWith({
      taskId: 'task-1',
      sessionId: 'session-1',
      taskType: 'self_dev',
      goal: 'fix startup recovery',
      runtimeHint: 'codex',
      constraints: {
        replyLanguage: 'zh-CN',
        chatId: 'oc_123',
        ackMessageId: 'om_ack_123',
      },
      sdkSessionId: 'sdk-1',
      runtimeBackend: 'codex',
    });
  });

  it('preserves existing job feedback constraints when already present', async () => {
    const db = {
      execute: vi
        .fn()
        .mockResolvedValueOnce([
          {
            taskId: 'task-keep',
            sessionId: 'session-keep',
            taskType: 'chat_reply',
            goal: 'resume task',
            runtimeHint: 'codex',
            constraints: {
              chatId: 'oc_existing',
              ackMessageId: 'om_existing',
              replyToMessageId: 'omt_123',
            },
            chatId: 'oc_fallback',
            feedbackMessageId: 'om_fallback',
            sdkSessionId: null,
            runtimeBackend: 'codex',
            latestJobState: 'failed',
          },
        ])
        .mockResolvedValueOnce([]),
    };
    const queue = {
      enqueue: vi.fn(async () => 'job-keep'),
    };

    await recoverStaleRunningTasks({
      db: db as any,
      queue: queue as any,
      logger: logger as any,
    });

    expect(queue.enqueue).toHaveBeenCalledWith({
      taskId: 'task-keep',
      sessionId: 'session-keep',
      taskType: 'chat_reply',
      goal: 'resume task',
      runtimeHint: 'codex',
      constraints: {
        chatId: 'oc_existing',
        ackMessageId: 'om_existing',
        replyToMessageId: 'omt_123',
      },
      runtimeBackend: 'codex',
    });
  });

  it('marks the task failed when startup re-enqueue fails', async () => {
    const db = {
      execute: vi
        .fn()
        .mockResolvedValueOnce([
          {
            taskId: 'task-2',
            sessionId: 'session-2',
            taskType: 'chat_reply',
            goal: 'answer user',
            runtimeHint: null,
            constraints: {},
            chatId: 'oc_456',
            feedbackMessageId: 'om_ack_456',
            sdkSessionId: null,
            runtimeBackend: null,
            latestJobState: null,
          },
        ])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]),
    };
    const queue = {
      enqueue: vi.fn(async () => {
        throw new Error('Failed to enqueue task task-2 for session session-2');
      }),
    };

    const result = await recoverStaleRunningTasks({
      db: db as any,
      queue: queue as any,
      logger: logger as any,
    });

    expect(result).toEqual({ inspected: 1, requeued: 0, failed: 1 });
    expect(queue.enqueue).toHaveBeenCalledTimes(1);
    expect(db.execute).toHaveBeenCalledTimes(3);
  });
});
