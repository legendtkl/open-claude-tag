import type { DueChatMemoryConfig } from '@open-tag/storage';
import { describe, expect, it, vi } from 'vitest';
import {
  buildChatMemorySummaryGoal,
  handleChatMemorySummaryCompletion,
  handleChatMemorySummaryFailure,
  runChatMemorySummarySchedulerOnce,
} from '../chat-memory-summary.js';

function makeDueConfig(overrides: Partial<DueChatMemoryConfig> = {}): DueChatMemoryConfig {
  return {
    id: 'config_1',
    tenantKey: 'tenant_1',
    chatId: 'oc_chat_1',
    memorySummaryAgentId: 'agent_1',
    memorySummaryTime: '09:30',
    memorySummaryTimezone: 'Asia/Shanghai',
    memorySummaryNextRunAt: new Date('2026-06-24T01:30:00.000Z'),
    agentStatus: 'active',
    agentDefaultRuntime: 'codex',
    feishuAppId: 'app_1',
    ...overrides,
  };
}

function makeSchedulerDeps(configs: DueChatMemoryConfig[]) {
  return {
    listDueConfigs: vi.fn(async () => configs),
    markEnqueued: vi.fn(async () => {}),
    markResult: vi.fn(async () => {}),
    createSummaryTask: vi.fn(async () => {}),
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  };
}

describe('runChatMemorySummarySchedulerOnce', () => {
  it('claims a due config and creates a summary task for an active agent', async () => {
    const deps = makeSchedulerDeps([makeDueConfig()]);

    const result = await runChatMemorySummarySchedulerOnce(deps, {
      now: new Date('2026-06-24T00:00:00.000Z'),
      limit: 25,
    });

    expect(result).toEqual({ due: 1, enqueued: 1, failed: 0 });
    expect(deps.markEnqueued).toHaveBeenCalledWith({
      tenantKey: 'tenant_1',
      chatId: 'oc_chat_1',
      nextRunAt: new Date('2026-06-24T01:30:00.000Z'),
    });
    expect(deps.createSummaryTask).toHaveBeenCalledWith({
      config: expect.objectContaining({ chatId: 'oc_chat_1', memorySummaryAgentId: 'agent_1' }),
      now: new Date('2026-06-24T00:00:00.000Z'),
      nextRunAt: new Date('2026-06-24T01:30:00.000Z'),
    });
  });

  it('uses the default daily schedule when the config has no explicit summary time', async () => {
    const deps = makeSchedulerDeps([makeDueConfig({ memorySummaryTime: null })]);

    const result = await runChatMemorySummarySchedulerOnce(deps, {
      now: new Date('2026-06-24T00:00:00.000Z'),
      limit: 25,
    });

    expect(result).toEqual({ due: 1, enqueued: 1, failed: 0 });
    expect(deps.markEnqueued).toHaveBeenCalledWith({
      tenantKey: 'tenant_1',
      chatId: 'oc_chat_1',
      nextRunAt: new Date('2026-06-24T01:30:00.000Z'),
    });
    expect(deps.createSummaryTask).toHaveBeenCalledWith({
      config: expect.objectContaining({ chatId: 'oc_chat_1', memorySummaryAgentId: 'agent_1' }),
      now: new Date('2026-06-24T00:00:00.000Z'),
      nextRunAt: new Date('2026-06-24T01:30:00.000Z'),
    });
  });

  it('does not enqueue when no active chat agent is available', async () => {
    const deps = makeSchedulerDeps([makeDueConfig({ memorySummaryAgentId: null })]);

    const result = await runChatMemorySummarySchedulerOnce(deps, {
      now: new Date('2026-06-24T00:00:00.000Z'),
      limit: 25,
    });

    expect(result).toEqual({ due: 1, enqueued: 0, failed: 1 });
    expect(deps.createSummaryTask).not.toHaveBeenCalled();
    expect(deps.markResult).toHaveBeenCalledWith({
      tenantKey: 'tenant_1',
      chatId: 'oc_chat_1',
      status: 'failed',
      error: 'No active chat agent is available for chat memory summary',
      ranAt: new Date('2026-06-24T00:00:00.000Z'),
    });
  });

  it('disables the next run when the schedule is invalid', async () => {
    const deps = makeSchedulerDeps([makeDueConfig({ memorySummaryTime: '99:99' })]);

    const result = await runChatMemorySummarySchedulerOnce(deps, {
      now: new Date('2026-06-24T00:00:00.000Z'),
      limit: 25,
    });

    expect(result).toEqual({ due: 1, enqueued: 0, failed: 1 });
    expect(deps.markEnqueued).toHaveBeenCalledWith({
      tenantKey: 'tenant_1',
      chatId: 'oc_chat_1',
      nextRunAt: null,
    });
    expect(deps.markResult).toHaveBeenCalledWith({
      tenantKey: 'tenant_1',
      chatId: 'oc_chat_1',
      status: 'failed',
      error: 'Chat memory summary schedule is invalid',
      ranAt: new Date('2026-06-24T00:00:00.000Z'),
    });
  });
});

describe('handleChatMemorySummaryCompletion', () => {
  it('commits a valid structured update and marks the config completed', async () => {
    const deps = {
      commitUpdate: vi.fn(async () => ({})),
      markResult: vi.fn(async () => {}),
      logger: { warn: vi.fn() },
    };

    const result = await handleChatMemorySummaryCompletion(deps, {
      taskId: 'task_1',
      taskType: 'chat_memory_summary',
      constraints: { tenantKey: 'tenant_1', chatId: 'oc_chat_1', chatMemorySummary: true },
      outputText: [
        'Done.',
        '<open_claude_tag_chat_memory_update>',
        '{"index":{"content":"Project map"},"details":[{"title":"Decision","content":"Use topic memory","keywords":["memory"],"importanceScore":2}]}',
        '</open_claude_tag_chat_memory_update>',
      ].join('\n'),
      now: new Date('2026-06-24T02:00:00.000Z'),
    });

    expect(result).toBe('completed');
    expect(deps.commitUpdate).toHaveBeenCalledWith({
      tenantKey: 'tenant_1',
      chatId: 'oc_chat_1',
      rawUpdate: expect.objectContaining({ details: expect.any(Array) }),
      sourceTaskId: 'task_1',
    });
    expect(deps.markResult).toHaveBeenCalledWith({
      tenantKey: 'tenant_1',
      chatId: 'oc_chat_1',
      status: 'completed',
      error: null,
      ranAt: new Date('2026-06-24T02:00:00.000Z'),
    });
  });

  it('preserves existing memory when the structured update is missing', async () => {
    const deps = {
      commitUpdate: vi.fn(async () => ({})),
      markResult: vi.fn(async () => {}),
    };

    const result = await handleChatMemorySummaryCompletion(deps, {
      taskId: 'task_1',
      taskType: 'chat_memory_summary',
      constraints: { tenantKey: 'tenant_1', chatId: 'oc_chat_1', chatMemorySummary: true },
      outputText: 'No structured block here.',
    });

    expect(result).toBe('invalid_update');
    expect(deps.commitUpdate).not.toHaveBeenCalled();
    expect(deps.markResult).toHaveBeenCalledWith({
      tenantKey: 'tenant_1',
      chatId: 'oc_chat_1',
      status: 'invalid_update',
      error: 'Missing or invalid <open_claude_tag_chat_memory_update> JSON block',
      ranAt: undefined,
    });
  });

  it('skips non-summary tasks', async () => {
    const deps = {
      commitUpdate: vi.fn(async () => ({})),
      markResult: vi.fn(async () => {}),
    };

    const result = await handleChatMemorySummaryCompletion(deps, {
      taskId: 'task_1',
      taskType: 'chat_reply',
      constraints: { tenantKey: 'tenant_1', chatId: 'oc_chat_1' },
      outputText: 'Done',
    });

    expect(result).toBe('skipped');
    expect(deps.commitUpdate).not.toHaveBeenCalled();
    expect(deps.markResult).not.toHaveBeenCalled();
  });
});

describe('handleChatMemorySummaryFailure', () => {
  it('marks summary tasks failed', async () => {
    const deps = {
      markResult: vi.fn(async () => {}),
      logger: { warn: vi.fn() },
    };

    const result = await handleChatMemorySummaryFailure(deps, {
      taskId: 'task_1',
      taskType: 'chat_memory_summary',
      constraints: { tenantKey: 'tenant_1', chatId: 'oc_chat_1', chatMemorySummary: true },
      errorMessage: 'runtime failed',
      now: new Date('2026-06-24T03:00:00.000Z'),
    });

    expect(result).toBe('failed');
    expect(deps.markResult).toHaveBeenCalledWith({
      tenantKey: 'tenant_1',
      chatId: 'oc_chat_1',
      status: 'failed',
      error: 'runtime failed',
      ranAt: new Date('2026-06-24T03:00:00.000Z'),
    });
  });
});

describe('buildChatMemorySummaryGoal', () => {
  it('includes recent group transcript and structured output instructions', () => {
    const goal = buildChatMemorySummaryGoal({
      tenantKey: 'tenant_1',
      chatId: 'oc_chat_1',
      generatedAt: new Date('2026-06-24T00:00:00.000Z'),
      recentMessages: [
        {
          role: 'user',
          content: 'Please remember that deploys happen every Friday.',
          createdAt: new Date('2026-06-23T12:00:00.000Z'),
        },
      ],
    });

    expect(goal).toContain('Feishu group chat oc_chat_1');
    expect(goal).toContain('Please remember that deploys happen every Friday.');
    expect(goal).toContain('<open_claude_tag_chat_memory_update>');
  });
});
