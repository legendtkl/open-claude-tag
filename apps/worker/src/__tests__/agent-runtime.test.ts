import { describe, expect, it, vi } from 'vitest';
import type { FeishuClient } from '@open-tag/feishu-adapter';
import type { TaskJobData } from '@open-tag/queue';
import type { AgentSessionStateRecord } from '@open-tag/storage';
import {
  buildAgentIdentityPrompt,
  buildAgentSystemPrompt,
  buildWorkerWorkspaceKey,
  mergeAgentProfileSystemPrompt,
  normalizeRuntimeEnv,
  resolveEffectiveRuntimeState,
  resolveTaskAgentIdentity,
  resolveTaskFeishuClient,
  shouldClearSdkSessionForRuntimeSwitch,
} from '../agent-runtime.js';

function makeJob(overrides: Partial<TaskJobData> = {}): TaskJobData {
  return {
    taskId: 'task_1',
    sessionId: 'session_1',
    taskType: 'chat_reply',
    goal: 'continue',
    runtimeHint: 'auto',
    constraints: {},
    ...overrides,
  };
}

function makeAgentState(
  overrides: Partial<AgentSessionStateRecord>,
): AgentSessionStateRecord {
  return {
    id: 'state_1',
    agentId: 'agent_1',
    sessionId: 'session_1',
    runtimeBackend: null,
    sdkSessionId: null,
    sdkSessionMachineId: null,
    workspacePath: null,
    worktreeBranch: null,
    adhocWorkDir: null,
    summary: null,
    lastRunAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('resolveTaskAgentIdentity', () => {
  it('prefers task row identity over queued job and constraints identity', () => {
    const identity = resolveTaskAgentIdentity(
      makeJob({
        agentId: 'agent_from_job',
        feishuAppId: 'app_from_job',
        constraints: {
          agentId: 'agent_from_constraints',
          feishuAppId: 'app_from_constraints',
        },
      }),
      { agentId: 'agent_from_task', feishuAppId: 'app_from_task' },
    );

    expect(identity).toEqual({
      agentId: 'agent_from_task',
      feishuAppId: 'app_from_task',
    });
  });

  it('falls back to queued job identity and then constraints identity', () => {
    expect(
      resolveTaskAgentIdentity(
        makeJob({
          agentId: 'agent_from_job',
          constraints: { feishuAppId: 'app_from_constraints' },
        }),
        null,
      ),
    ).toEqual({
      agentId: 'agent_from_job',
      feishuAppId: 'app_from_constraints',
    });
  });
});

describe('resolveEffectiveRuntimeState', () => {
  it('uses legacy queued runtime state when no agent owns the task', () => {
    const state = resolveEffectiveRuntimeState({
      jobData: makeJob({
        runtimeBackend: 'claude_code',
        sdkSessionId: 'session_sdk',
      }),
    });

    expect(state.runtimeBackend).toBe('claude_code');
    expect(state.sdkSessionId).toBe('session_sdk');
  });

  it('uses agent session state and does not reuse session-level SDK state', () => {
    const jobData = makeJob({
      runtimeBackend: 'claude_code',
      sdkSessionId: 'session_sdk',
    });
    const state = resolveEffectiveRuntimeState({
      agentId: 'agent_a',
      agentSessionState: makeAgentState({
        agentId: 'agent_a',
        runtimeBackend: 'codex',
        sdkSessionId: 'agent_sdk',
        workspacePath: '/tmp/agent-a',
      }),
      jobData,
    });
    const emptyAgentState = resolveEffectiveRuntimeState({
      agentId: 'agent_b',
      agentSessionState: null,
      jobData,
    });

    expect(state.runtimeBackend).toBe('codex');
    expect(state.sdkSessionId).toBe('agent_sdk');
    expect(state.sdkSessionMachineId).toBeNull();
    expect(state.workspacePath).toBe('/tmp/agent-a');
    expect(emptyAgentState.sdkSessionId).toBeNull();
    expect(emptyAgentState.runtimeBackend).toBeNull();
  });

  it('carries the stored SDK machine id for agent-owned runtime state', () => {
    const state = resolveEffectiveRuntimeState({
      agentId: 'agent_a',
      agentSessionState: makeAgentState({
        agentId: 'agent_a',
        runtimeBackend: 'claude_code',
        sdkSessionId: 'sdk-agent',
        sdkSessionMachineId: 'machine-a',
      }),
      jobData: makeJob(),
    });

    expect(state.sdkSessionMachineId).toBe('machine-a');
  });
});

describe('runtime switch and workspace locality', () => {
  it('clears SDK session only when the selected runtime differs from previous runtime', () => {
    expect(shouldClearSdkSessionForRuntimeSwitch('claude_code', 'codex')).toBe(true);
    expect(shouldClearSdkSessionForRuntimeSwitch('codex', 'codex')).toBe(false);
    expect(shouldClearSdkSessionForRuntimeSwitch(null, 'codex')).toBe(false);
  });

  it('keeps legacy workspace key unchanged and derives different keys for different agents', () => {
    const sessionId = 'session-abcdef12-rest';
    expect(buildWorkerWorkspaceKey(sessionId)).toBe(sessionId);
    expect(buildWorkerWorkspaceKey(sessionId, 'aaaaaaaa-1111-2222-3333-444444444444')).not.toBe(
      buildWorkerWorkspaceKey(sessionId, 'bbbbbbbb-1111-2222-3333-444444444444'),
    );
  });
});

describe('buildAgentSystemPrompt', () => {
  it('orders platform, agent identity, agent system prompt, and workflow prompt', () => {
    expect(
      buildAgentSystemPrompt({
        platformPrompt: 'platform',
        identityPrompt: 'identity',
        agentSystemPrompt: 'agent system',
        workflowPrompt: 'workflow',
      }),
    ).toBe('platform\n\n---\n\nidentity\n\n---\n\nagent system\n\n---\n\nworkflow');
  });

  it('builds an explicit agent identity prompt with mention aliases', () => {
    const prompt = buildAgentIdentityPrompt({
      agentId: 'agent-1',
      handle: 'Developer',
      displayName: 'Developer',
    });

    expect(prompt).toContain('<agent_identity>');
    expect(prompt).toContain('"agentId": "agent-1"');
    expect(prompt).toContain('"@Developer"');
    expect(prompt).toContain('Keep this identity separate from other agents');
    expect(prompt).toContain('already been routed to this agent by the server');
    expect(prompt).toContain('Do not refuse the task solely because');
  });

  it('merges legacy style prompt into the unified agent system prompt', () => {
    expect(
      mergeAgentProfileSystemPrompt({
        systemPrompt: 'agent system',
        legacyStylePrompt: 'legacy style',
      }),
    ).toBe('agent system\n\nlegacy style');
  });
});

describe('normalizeRuntimeEnv', () => {
  it('keeps string env values and drops non-string values', () => {
    expect(normalizeRuntimeEnv({ a: 'b', FLAG: '1', 'bad-key': 'no', nested: { value: 'nope' } })).toEqual({
      a: 'b',
      FLAG: '1',
    });
    expect(normalizeRuntimeEnv(null)).toEqual({});
  });
});

describe('resolveTaskFeishuClient', () => {
  it('does not fall back to the default client when task Feishu app client is missing', async () => {
    const defaultClient = {} as FeishuClient;
    const resolver = { getClient: vi.fn().mockResolvedValue(null) };

    const result = await resolveTaskFeishuClient({
      feishuAppId: 'app_missing',
      resolver,
      defaultClient,
    });

    expect(result.client).toBeNull();
    expect(result.missingAppClient).toBe(true);
    expect(resolver.getClient).toHaveBeenCalledWith('app_missing');
  });

  it('uses default client only for legacy tasks without Feishu app identity', async () => {
    const defaultClient = {} as FeishuClient;

    await expect(
      resolveTaskFeishuClient({
        resolver: null,
        defaultClient,
      }),
    ).resolves.toEqual({ client: defaultClient, missingAppClient: false });
  });

  it('uses the resolver primary client for legacy tasks when registry is available', async () => {
    const defaultClient = { id: 'stale' } as unknown as FeishuClient;
    const primaryClient = { id: 'fresh' } as unknown as FeishuClient;
    const resolver = { getClient: vi.fn().mockResolvedValue(primaryClient) };

    await expect(
      resolveTaskFeishuClient({
        resolver,
        defaultClient,
      }),
    ).resolves.toEqual({ client: primaryClient, missingAppClient: false });
    expect(resolver.getClient).toHaveBeenCalledWith(null);
  });
});
