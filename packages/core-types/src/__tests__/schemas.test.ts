import { describe, it, expect } from 'vitest';
import {
  normalizeRuntimeHint,
  NormalizedEventSchema,
  TaskSpecSchema,
  TaskResultSchema,
  RuntimeEventSchema,
  MemoryItemSchema,
  AgentProfileSchema,
  AgentSchema,
  FeishuAppRegistrationSchema,
  AgentBotBindingSchema,
  AgentSessionStateSchema,
  AgentDelegationSchema,
  DelegationTreeSchema,
} from '../schemas.js';
import { TaskStatus } from '../enums.js';
import { randomUUID } from 'crypto';

describe('NormalizedEventSchema', () => {
  it('parses a valid text event', () => {
    const event = {
      eventId: 'evt_001',
      messageId: 'msg_001',
      chatId: 'oc_abcdef',
      chatType: 'group' as const,
      senderOpenId: 'ou_123',
      senderUnionId: 'on_123',
      tenantKey: 'tenant_001',
      content: {
        type: 'text' as const,
        text: 'Hello world',
        raw: { original: true },
      },
      timestamp: Date.now(),
    };
    const result = NormalizedEventSchema.parse(event);
    expect(result.eventId).toBe('evt_001');
    expect(result.senderUnionId).toBe('on_123');
    expect(result.content.type).toBe('text');
  });

  it('parses a command event', () => {
    const event = {
      eventId: 'evt_002',
      messageId: 'msg_002',
      chatId: 'oc_abcdef',
      chatType: 'p2p' as const,
      senderOpenId: 'ou_123',
      tenantKey: 'tenant_001',
      content: {
        type: 'command' as const,
        command: '/new',
        args: 'my project',
        raw: {},
      },
      timestamp: Date.now(),
    };
    const result = NormalizedEventSchema.parse(event);
    expect(result.content.command).toBe('/new');
  });

  it('rejects invalid chatType', () => {
    const event = {
      eventId: 'evt_003',
      messageId: 'msg_003',
      chatId: 'oc_abcdef',
      chatType: 'invalid',
      senderOpenId: 'ou_123',
      tenantKey: 'tenant_001',
      content: { type: 'text', raw: {} },
      timestamp: Date.now(),
    };
    expect(() => NormalizedEventSchema.parse(event)).toThrow();
  });

  it('parses event with mentions', () => {
    const event = {
      eventId: 'evt_004',
      messageId: 'msg_004',
      chatId: 'oc_abcdef',
      chatType: 'group' as const,
      senderOpenId: 'ou_123',
      tenantKey: 'tenant_001',
      content: {
        type: 'text' as const,
        text: '@bot hello',
        mentions: [{ id: 'ou_bot', name: 'Bot', isBot: true }],
        raw: {},
      },
      timestamp: Date.now(),
    };
    const result = NormalizedEventSchema.parse(event);
    expect(result.content.mentions).toHaveLength(1);
    expect(result.content.mentions![0].isBot).toBe(true);
  });
});

describe('TaskSpecSchema', () => {
  it('parses a valid task spec with defaults', () => {
    const spec = {
      taskId: randomUUID(),
      sessionId: randomUUID(),
      taskType: 'chat_reply',
      goal: 'Write a hello world function',
      context: {
        systemPrompt: 'You are a coding assistant',
        recentTurns: [],
      },
    };
    const result = TaskSpecSchema.parse(spec);
    expect(result.runtimeHint).toBe('auto');
    expect(result.constraints.timeoutSec).toBe(1800);
    expect(result.constraints.networkPolicy).toBe('restricted');
  });

  it('preserves reply language in task constraints', () => {
    const spec = {
      taskId: randomUUID(),
      sessionId: randomUUID(),
      taskType: 'self_dev',
      goal: 'Mirror the user reply language in Feishu',
      constraints: {
        replyLanguage: 'zh-CN' as const,
      },
      context: {
        systemPrompt: 'You are a coding assistant',
        recentTurns: [],
      },
    };

    const result = TaskSpecSchema.parse(spec);
    expect(result.constraints.replyLanguage).toBe('zh-CN');
  });

  it('rejects invalid task type', () => {
    const spec = {
      taskId: randomUUID(),
      sessionId: randomUUID(),
      taskType: 'invalid_type',
      goal: 'Do something',
      context: { systemPrompt: '', recentTurns: [] },
    };
    expect(() => TaskSpecSchema.parse(spec)).toThrow();
  });
});

describe('Agent identity schemas', () => {
  it('parses a first-class agent profile with defaults', () => {
    const profile = AgentProfileSchema.parse({
      name: 'reviewer',
      displayName: 'Reviewer',
    });

    expect(profile.skillRefs).toEqual([]);
    expect(profile.sourceType).toBe('builtin');
    expect(profile.status).toBe('active');
  });

  it('parses a routable private agent', () => {
    const agent = AgentSchema.parse({
      handle: 'reviewer',
      displayName: 'Reviewer',
      profileId: randomUUID(),
      visibility: 'private',
    });

    expect(agent.tenantKey).toBe('default');
    expect(agent.scopeType).toBe('system');
    expect(agent.visibility).toBe('private');
    expect(agent.accessPolicy).toEqual({});
  });

  it('parses Feishu app, bot binding, session state, and delegation records', () => {
    const agentId = randomUUID();
    const sessionId = randomUUID();
    const feishuAppId = randomUUID();

    expect(
      FeishuAppRegistrationSchema.parse({
        appId: 'cli_primary',
        appSecretRef: 'FEISHU_APP_SECRET',
      }).eventMode,
    ).toBe('websocket');

    expect(
      FeishuAppRegistrationSchema.parse({
        appId: 'cli_webhook',
        appSecretRef: 'FEISHU_WEBHOOK_APP_SECRET',
        eventMode: 'webhook',
      }).eventMode,
    ).toBe('webhook');

    expect(
      AgentBotBindingSchema.parse({
        agentId,
        feishuAppId,
      }).status,
    ).toBe('active');

    expect(
      AgentSessionStateSchema.parse({
        agentId,
        sessionId,
        runtimeBackend: 'claude_code',
      }).runtimeBackend,
    ).toBe('claude_code');

    expect(
      AgentDelegationSchema.parse({
        treeId: randomUUID(),
        parentTaskId: randomUUID(),
        callerAgentId: agentId,
        calleeAgentId: randomUUID(),
        goal: 'Review this patch',
        depth: 1,
      }).status,
    ).toBe('pending');

    expect(
      DelegationTreeSchema.parse({
        rootTaskId: randomUUID(),
        totalBudget: 12,
        fanoutBudget: 3,
      }).tasksUsed,
    ).toBe(0);
  });
});

describe('TaskResultSchema', () => {
  it('parses a completed task result', () => {
    const result = TaskResultSchema.parse({
      taskId: randomUUID(),
      status: 'completed',
      output: {
        text: 'Task done',
        artifacts: [
          {
            name: 'output.ts',
            path: '/workspaces/run1/output.ts',
            mimeType: 'text/typescript',
            sha256: 'abc123',
          },
        ],
      },
      metrics: {
        durationMs: 5000,
        tokenIn: 1000,
        tokenOut: 500,
        estimatedCostUsd: 0.01,
      },
    });
    expect(result.status).toBe('completed');
    expect(result.output.artifacts).toHaveLength(1);
  });
});

describe('RuntimeEventSchema', () => {
  it('parses status event', () => {
    const event = RuntimeEventSchema.parse({ type: 'status', message: 'Starting...' });
    expect(event.type).toBe('status');
  });

  it('parses runtime_started event', () => {
    const event = RuntimeEventSchema.parse({
      type: 'runtime_started',
      executionId: 'task_123',
    });
    expect(event.type).toBe('runtime_started');
  });

  it('parses progress event', () => {
    const event = RuntimeEventSchema.parse({ type: 'progress', percent: 50, message: 'Halfway' });
    expect(event.type).toBe('progress');
  });

  it('parses reasoning event', () => {
    const event = RuntimeEventSchema.parse({
      type: 'reasoning',
      summary: 'Inspecting task requirements before running commands',
    });
    expect(event.type).toBe('reasoning');
  });

  it('parses plan_update event with structured steps', () => {
    const event = RuntimeEventSchema.parse({
      type: 'plan_update',
      steps: [
        { id: 'step-0', title: 'Write failing tests', status: 'done' },
        { id: 'step-1', title: 'Implement feature', status: 'running' },
        { id: 'step-2', title: 'Run build', status: 'pending' },
      ],
    });
    expect(event.type).toBe('plan_update');
    expect((event as any).steps).toHaveLength(3);
    expect((event as any).steps[1].status).toBe('running');
  });

  it('accepts the full plan-step status set', () => {
    for (const status of ['pending', 'running', 'done', 'failed', 'skipped'] as const) {
      const event = RuntimeEventSchema.parse({
        type: 'plan_update',
        steps: [{ id: 's', title: 't', status }],
      });
      expect((event as any).steps[0].status).toBe(status);
    }
  });

  it('rejects plan_update steps with an invalid status', () => {
    expect(() =>
      RuntimeEventSchema.parse({
        type: 'plan_update',
        steps: [{ id: 's', title: 't', status: 'bogus' }],
      }),
    ).toThrow();
  });

  it('parses tool_use event', () => {
    const event = RuntimeEventSchema.parse({
      type: 'tool_use',
      name: 'Bash',
      summary: 'Running: pnpm test',
      status: 'running',
    });
    expect(event.type).toBe('tool_use');
    expect((event as any).name).toBe('Bash');
  });

  it('rejects tool_use with skipped status (not in the tool-use status set)', () => {
    expect(() =>
      RuntimeEventSchema.parse({
        type: 'tool_use',
        name: 'Bash',
        summary: 'x',
        status: 'skipped',
      }),
    ).toThrow();
  });

  it('rejects unknown event type', () => {
    expect(() => RuntimeEventSchema.parse({ type: 'unknown' })).toThrow();
  });
});

describe('MemoryItemSchema', () => {
  it('parses a valid memory item with defaults', () => {
    const item = MemoryItemSchema.parse({
      id: randomUUID(),
      scopeType: 'user',
      scopeId: 'user_123',
      memoryType: 'preference',
      content: 'Prefers TypeScript',
    });
    expect(item.confidence).toBe(1.0);
    expect(item.importanceScore).toBe(0.5);
    expect(item.status).toBe('active');
    expect(item.tags).toEqual([]);
  });

  it('parses agent-scoped memory items', () => {
    const item = MemoryItemSchema.parse({
      id: randomUUID(),
      scopeType: 'agent_session',
      scopeId: `${randomUUID()}:${randomUUID()}`,
      memoryType: 'instruction',
      content: 'Prefer concise review summaries',
    });

    expect(item.scopeType).toBe('agent_session');
  });

  it('validates confidence range', () => {
    expect(() =>
      MemoryItemSchema.parse({
        id: randomUUID(),
        scopeType: 'user',
        scopeId: 'user_123',
        memoryType: 'fact',
        content: 'test',
        confidence: 1.5,
      }),
    ).toThrow();
  });
});

describe('Enum consistency', () => {
  it('TaskStatus has all expected values', () => {
    const values = Object.values(TaskStatus);
    expect(values).toContain('pending');
    expect(values).toContain('queued');
    expect(values).toContain('running');
    expect(values).toContain('waiting_approval');
    expect(values).toContain('waiting_delegation');
    expect(values).toContain('completed');
    expect(values).toContain('failed');
    expect(values).toContain('cancelled');
  });
});

describe('RuntimeEventSchema', () => {
  it('allows cancelled failed events to distinguish intentional aborts', () => {
    const event = RuntimeEventSchema.parse({
      type: 'failed',
      error: 'Cancelled',
      reason: 'cancelled',
    });

    expect((event as any).reason).toBe('cancelled');
  });
});

describe('normalizeRuntimeHint (#12)', () => {
  it('collapses the auto/unspecified runtime to null for persistence', () => {
    expect(normalizeRuntimeHint('auto')).toBeNull();
    expect(normalizeRuntimeHint(null)).toBeNull();
    expect(normalizeRuntimeHint(undefined)).toBeNull();
    expect(normalizeRuntimeHint('')).toBeNull();
  });

  it('passes a concrete runtime name through unchanged', () => {
    expect(normalizeRuntimeHint('codex')).toBe('codex');
    expect(normalizeRuntimeHint('claude_code')).toBe('claude_code');
  });
});
