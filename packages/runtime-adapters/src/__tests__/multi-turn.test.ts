import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ClaudeCodeAdapter } from '../claude-code-adapter.js';
import { CodexAdapter } from '../codex-adapter.js';
import { RuntimeManager } from '../runtime-manager.js';
import { createWorkspace } from '../workspace.js';
import { randomUUID } from 'crypto';
import type { RuntimeEvent } from '@open-tag/core-types';

// ── Mock SDKs ──
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

const mockCodexRunStreamed = vi.fn();
const mockCodexThreadId = vi.fn<() => string | null>().mockReturnValue('codex-thread-1');
const mockCodexStartThread = vi.fn().mockReturnValue({
  runStreamed: mockCodexRunStreamed,
  get id() {
    return mockCodexThreadId();
  },
});
const mockCodexResumeThread = vi.fn().mockReturnValue({
  runStreamed: mockCodexRunStreamed,
  get id() {
    return mockCodexThreadId();
  },
});

vi.mock('@openai/codex-sdk', () => ({
  Codex: vi.fn().mockImplementation(() => ({
    startThread: mockCodexStartThread,
    resumeThread: mockCodexResumeThread,
  })),
}));

import { query as mockClaudeQuery } from '@anthropic-ai/claude-agent-sdk';

// ── Helpers ──
async function* fakeClaudeStream(messages: any[]): AsyncGenerator<any> {
  for (const msg of messages) yield msg;
}

function makeClaudeResult(sessionId: string, result: string) {
  return {
    type: 'result',
    subtype: 'success',
    session_id: sessionId,
    result,
    duration_ms: 2000,
    total_cost_usd: 0.005,
    usage: { input_tokens: 100, output_tokens: 50 },
  };
}

/** Create a streaming event generator that simulates a Codex turn. */
function makeCodexStreamedTurn(response: string) {
  async function* events() {
    yield { type: 'thread.started', thread_id: 'codex-thread-1' };
    yield { type: 'turn.started' };
    yield { type: 'item.completed', item: { id: 'msg-1', type: 'agent_message', text: response } };
    yield { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 50 } };
  }
  return { events: events() };
}

async function collectEvents(gen: AsyncGenerator<RuntimeEvent>): Promise<RuntimeEvent[]> {
  const events: RuntimeEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

// ── Tests ──
describe('Multi-turn session resume', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCodexThreadId.mockReturnValue('codex-thread-1');
  });

  describe('ClaudeCodeAdapter resume flow', () => {
    it('first turn yields session_created, resume reuses same session', async () => {
      const adapter = new ClaudeCodeAdapter({ baseUrl: 'http://proxy', authToken: 'key' });
      const sessionId = randomUUID();
      const workspace = await createWorkspace(`session-${sessionId}`);

      // First turn
      (mockClaudeQuery as any).mockReturnValue(
        fakeClaudeStream([makeClaudeResult('sdk-sess-001', 'Hello!')]),
      );
      const spec = {
        taskId: randomUUID(),
        sessionId,
        taskType: 'chat_reply' as const,
        goal: 'hi',
        runtimeHint: 'claude_code' as const,
        constraints: {
          timeoutSec: 30,
          approvalRequired: false,
          writeScope: [] as string[],
          networkPolicy: 'restricted' as const,
        },
        context: { systemPrompt: '', recentTurns: [] as unknown[] },
      };
      const handle = await adapter.prepare(spec, workspace);
      const events1 = await collectEvents(adapter.execute(handle, spec));

      const sessionEvent = events1.find((e) => e.type === 'session_created');
      expect(sessionEvent).toBeDefined();
      expect((sessionEvent as any).sdkSessionId).toBe('sdk-sess-001');
      expect(events1.find((e) => e.type === 'completed')).toBeDefined();

      // Verify first call did NOT use resume
      const firstCall = (mockClaudeQuery as any).mock.calls[0][0];
      expect(firstCall.options.resume).toBeUndefined();

      // Resume turn
      (mockClaudeQuery as any).mockReturnValue(
        fakeClaudeStream([makeClaudeResult('sdk-sess-001', 'Continued!')]),
      );
      const events2 = await collectEvents(adapter.resume('sdk-sess-001', 'continue', workspace));

      // Verify resume call used the session ID
      const resumeCall = (mockClaudeQuery as any).mock.calls[1][0];
      expect(resumeCall.options.resume).toBe('sdk-sess-001');
      expect(resumeCall.options.cwd).toBe(workspace.workspacePath);

      const completed2 = events2.find((e) => e.type === 'completed');
      expect((completed2 as any).result.output.text).toBe('Continued!');
    });

    it('resume uses same cwd as original execution for session lookup', async () => {
      const adapter = new ClaudeCodeAdapter({ baseUrl: 'http://proxy', authToken: 'key' });
      const sessionId = randomUUID();
      // Both execute and resume use same session-stable workspace
      const workspace = await createWorkspace(`session-${sessionId}`);

      (mockClaudeQuery as any).mockReturnValue(
        fakeClaudeStream([makeClaudeResult('sdk-sess-002', 'ok')]),
      );
      const spec = {
        taskId: randomUUID(),
        sessionId,
        taskType: 'chat_reply' as const,
        goal: 'first',
        runtimeHint: 'claude_code' as const,
        constraints: {
          timeoutSec: 30,
          approvalRequired: false,
          writeScope: [] as string[],
          networkPolicy: 'restricted' as const,
        },
        context: { systemPrompt: '', recentTurns: [] as unknown[] },
      };
      const handle = await adapter.prepare(spec, workspace);
      await collectEvents(adapter.execute(handle, spec));
      const executeCwd = (mockClaudeQuery as any).mock.calls[0][0].options.cwd;

      (mockClaudeQuery as any).mockReturnValue(
        fakeClaudeStream([makeClaudeResult('sdk-sess-002', 'resumed')]),
      );
      await collectEvents(adapter.resume('sdk-sess-002', 'second', workspace));
      const resumeCwd = (mockClaudeQuery as any).mock.calls[1][0].options.cwd;

      // Critical: same cwd so SDK can find session data in ~/.claude/projects/{cwd}/
      expect(resumeCwd).toBe(executeCwd);
      expect(resumeCwd).toBe(workspace.workspacePath);
    });
  });

  describe('CodexAdapter resume flow', () => {
    it('first turn uses startThread, resume uses resumeThread', async () => {
      const adapter = new CodexAdapter({ apiKey: 'key', model: 'codex-mini' });
      const sessionId = randomUUID();
      const workspace = await createWorkspace(`session-${sessionId}`);

      // First turn
      mockCodexRunStreamed.mockResolvedValue(makeCodexStreamedTurn('Hello from Codex!'));
      const spec = {
        taskId: randomUUID(),
        sessionId,
        taskType: 'chat_reply' as const,
        goal: 'write code',
        runtimeHint: 'codex' as const,
        constraints: {
          timeoutSec: 30,
          approvalRequired: false,
          writeScope: [] as string[],
          networkPolicy: 'restricted' as const,
        },
        context: { systemPrompt: '', recentTurns: [] as unknown[] },
      };
      const handle = await adapter.prepare(spec, workspace);
      const events1 = await collectEvents(adapter.execute(handle, spec));

      expect(mockCodexStartThread).toHaveBeenCalledTimes(1);
      expect(mockCodexResumeThread).not.toHaveBeenCalled();
      expect(events1.find((e) => e.type === 'session_created')).toBeDefined();

      // Resume turn
      mockCodexRunStreamed.mockResolvedValue(makeCodexStreamedTurn('Continued from Codex!'));
      const events2 = await collectEvents(adapter.resume('codex-thread-1', 'continue', workspace));

      expect(mockCodexResumeThread).toHaveBeenCalledTimes(1);
      expect(mockCodexResumeThread).toHaveBeenCalledWith(
        'codex-thread-1',
        expect.objectContaining({
          workingDirectory: workspace.workspacePath,
        }),
      );

      const completed2 = events2.find((e) => e.type === 'completed');
      expect((completed2 as any).result.output.text).toBe('Continued from Codex!');
    });
  });

  describe('RuntimeManager routing', () => {
    const healthy = (name: string) =>
      ({
        name: () => name,
        healthcheck: vi
          .fn()
          .mockResolvedValue({ healthy: true, name, lastCheckedAt: new Date() }),
      }) as any;
    const unhealthy = (name: string) =>
      ({
        name: () => name,
        healthcheck: vi
          .fn()
          .mockResolvedValue({ healthy: false, name, lastCheckedAt: new Date() }),
      }) as any;

    it('returns the preferred adapter without fallback when it is live-healthy', async () => {
      const manager = new RuntimeManager();
      const claude = healthy('claude_code');
      const codex = healthy('codex');
      manager.register(claude);
      manager.register(codex);

      const claudeResult = await manager.getHealthyFallback('claude_code');
      expect(claudeResult?.adapter).toBe(claude);
      expect(claudeResult?.usedFallback).toBe(false);

      const codexResult = await manager.getHealthyFallback('codex');
      expect(codexResult?.adapter).toBe(codex);
      expect(codexResult?.usedFallback).toBe(false);
    });

    it('live-checks and falls back only when the preferred adapter is unhealthy', async () => {
      const manager = new RuntimeManager();
      const claude = healthy('claude_code');
      const codex = unhealthy('codex');
      manager.register(claude);
      manager.register(codex);

      // codex unhealthy → fallback to claude
      const fellBack = await manager.getHealthyFallback('codex');
      expect(fellBack?.adapter).toBe(claude);
      expect(fellBack?.usedFallback).toBe(true);

      // claude healthy → stays
      const stayed = await manager.getHealthyFallback('claude_code');
      expect(stayed?.adapter).toBe(claude);
      expect(stayed?.usedFallback).toBe(false);
    });
  });

  describe('Healthcheck reflects SDK config', () => {
    it('ClaudeCodeAdapter healthy when authToken is set', async () => {
      const adapter = new ClaudeCodeAdapter({ baseUrl: 'http://proxy', authToken: 'my-key' });
      const health = await adapter.healthcheck();
      expect(health.healthy).toBe(true);
    });

    it('ClaudeCodeAdapter stays healthy without a global authToken (per-agent supplies creds)', async () => {
      // Registration is decoupled from global env: the adapter is always
      // available and per-agent BASE_URL/API_KEY (runtimeEnv) supply credentials
      // at execution time (a credential-less run fails loud in execute()).
      const adapter = new ClaudeCodeAdapter({ baseUrl: '', authToken: '' });
      const health = await adapter.healthcheck();
      expect(health.healthy).toBe(true);
      expect(health.name).toBe('claude_code');
    });

    it('CodexAdapter healthy when apiKey is set', async () => {
      const adapter = new CodexAdapter({ apiKey: 'my-key' });
      const health = await adapter.healthcheck();
      expect(health.healthy).toBe(true);
    });

    it('CodexAdapter healthy when ~/.codex/config.toml exists (no explicit apiKey)', async () => {
      // On this machine ~/.codex/config.toml exists, so adapter should be healthy
      const adapter = new CodexAdapter({});
      const health = await adapter.healthcheck();
      // Result depends on host: healthy if config.toml exists
      expect(typeof health.healthy).toBe('boolean');
      expect(health.name).toBe('codex');
    });
  });

  describe('Session-stable workspace', () => {
    it('createWorkspace with same runId returns same path', async () => {
      const sessionId = randomUUID();
      const ws1 = await createWorkspace(`session-${sessionId}`);
      const ws2 = await createWorkspace(`session-${sessionId}`);

      // Same session → same workspace path (for SDK session data persistence)
      expect(ws1.workspacePath).toBe(ws2.workspacePath);
    });
  });
});
