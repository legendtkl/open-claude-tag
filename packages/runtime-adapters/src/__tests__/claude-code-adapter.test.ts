import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { ClaudeCodeAdapter } from '../claude-code-adapter.js';
import { createWorkspace, cleanupWorkspace } from '../workspace.js';
import { randomUUID } from 'crypto';
import type { RuntimeEvent } from '@open-tag/core-types';

// Mock the SDK query function
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

import { query as mockQuery } from '@anthropic-ai/claude-agent-sdk';

function makeSpec(taskId: string, goal: string) {
  return {
    taskId,
    sessionId: 'test-session',
    taskType: 'chat_reply' as const,
    goal,
    runtimeHint: 'claude_code' as const,
    constraints: {
      timeoutSec: 30,
      approvalRequired: false,
      writeScope: [] as string[],
      networkPolicy: 'restricted' as const,
    },
    context: { systemPrompt: '', recentTurns: [] as unknown[] },
  };
}

async function* fakeStream(messages: any[]): AsyncGenerator<any> {
  for (const msg of messages) {
    yield msg;
  }
}

describe('ClaudeCodeAdapter', () => {
  let adapter: ClaudeCodeAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new ClaudeCodeAdapter({
      baseUrl: 'http://localhost:8080',
      authToken: 'test-token',
      model: 'claude-sonnet-4-20250514',
    });
  });

  it('yields completed event with result from SDK on success', async () => {
    const runId = `test-${randomUUID()}`;
    const workspace = await createWorkspace(runId);

    try {
      (mockQuery as any).mockReturnValue(
        fakeStream([
          {
            type: 'result',
            subtype: 'success',
            session_id: 'sdk-session-123',
            result: '你好！我是 Claude，一个 AI 助手。',
            duration_ms: 3200,
            total_cost_usd: 0.005,
            usage: { input_tokens: 100, output_tokens: 50 },
          },
        ]),
      );

      const spec = makeSpec('task-ok-1', '你好，介绍一下自己');
      const handle = await adapter.prepare(spec, workspace);

      const events: RuntimeEvent[] = [];
      for await (const event of adapter.execute(handle, spec)) {
        events.push(event);
      }

      // Should have session_created event
      const sessionEvent = events.find((e) => e.type === 'session_created');
      expect(sessionEvent).toBeDefined();
      expect((sessionEvent as any).sdkSessionId).toBe('sdk-session-123');

      // Should have completed event
      const completedEvent = events.find((e) => e.type === 'completed');
      expect(completedEvent).toBeDefined();
      const result = (completedEvent as any).result;
      expect(result.status).toBe('completed');
      expect(result.output.text).toContain('你好');
      expect(result.metrics.tokenIn).toBe(100);
      expect(result.metrics.tokenOut).toBe(50);
      expect(result.metrics.estimatedCostUsd).toBe(0.005);
      expect(result.metrics.durationMs).toBe(3200);
    } finally {
      await cleanupWorkspace(runId).catch(() => {});
    }
  });

  it('yields failed event on SDK error result', async () => {
    const runId = `test-${randomUUID()}`;
    const workspace = await createWorkspace(runId);

    try {
      (mockQuery as any).mockReturnValue(
        fakeStream([
          {
            type: 'result',
            subtype: 'error',
            session_id: 'sdk-session-err',
            duration_ms: 500,
            total_cost_usd: 0.002,
            usage: { input_tokens: 10, output_tokens: 5 },
            errors: ['Rate limit exceeded', 'Try again later'],
          },
        ]),
      );

      const spec = makeSpec('task-err-1', '你好');
      const handle = await adapter.prepare(spec, workspace);

      const events: RuntimeEvent[] = [];
      for await (const event of adapter.execute(handle, spec)) {
        events.push(event);
      }

      const failedEvent = events.find((e) => e.type === 'failed');
      expect(failedEvent).toBeDefined();
      expect((failedEvent as any).error).toContain('Rate limit exceeded');
      // The usage read from the error `result` message rides on the failure
      // event so the worker can charge the spent tokens against the budget.
      expect((failedEvent as any).metrics).toEqual({
        tokenIn: 10,
        tokenOut: 5,
        estimatedCostUsd: 0.002,
      });
    } finally {
      await cleanupWorkspace(runId).catch(() => {});
    }
  });

  it('yields failed event when SDK throws', async () => {
    const runId = `test-${randomUUID()}`;
    const workspace = await createWorkspace(runId);

    try {
      (mockQuery as any).mockReturnValue(
        (async function* () {
          yield { type: 'status', message: 'starting' } as any;
          throw new Error('Network connection failed');
        })(),
      );

      const spec = makeSpec('task-throw-1', '你好');
      const handle = await adapter.prepare(spec, workspace);

      const events: RuntimeEvent[] = [];
      for await (const event of adapter.execute(handle, spec)) {
        events.push(event);
      }

      const failedEvent = events.find((e) => e.type === 'failed');
      expect(failedEvent).toBeDefined();
      expect((failedEvent as any).error).toContain('Network connection failed');
    } finally {
      await cleanupWorkspace(runId).catch(() => {});
    }
  });

  it('honors configured maxTurnCount over the systemPromptAppend default', async () => {
    const runId = `test-${randomUUID()}`;
    const workspace = await createWorkspace(runId);

    try {
      const limitedAdapter = new ClaudeCodeAdapter({
        baseUrl: 'http://localhost:8080',
        authToken: 'test-token',
        model: 'claude-sonnet-4-20250514',
        maxTurnCount: 25,
      });
      (mockQuery as any).mockReturnValue(
        fakeStream([
          {
            type: 'result',
            subtype: 'success',
            session_id: 'sdk-session-turns',
            result: 'done',
            duration_ms: 100,
            total_cost_usd: 0.001,
            usage: { input_tokens: 10, output_tokens: 5 },
          },
        ]),
      );

      const spec = makeSpec('task-maxturns-1', 'limited turns task');
      const handle = await limitedAdapter.prepare(spec, workspace);
      const events: RuntimeEvent[] = [];
      // Every production task carries a workflow/system prompt append; the
      // configured turn limit must still win over the 200-turn default.
      for await (const event of limitedAdapter.execute(handle, spec, 'WORKFLOW PROMPT')) {
        events.push(event);
      }

      const callArgs = (mockQuery as any).mock.calls[0][0];
      expect(callArgs.options.maxTurns).toBe(25);
    } finally {
      await cleanupWorkspace(runId).catch(() => {});
    }
  });

  it('passes resume session ID to SDK options', async () => {
    const runId = `test-${randomUUID()}`;
    const workspace = await createWorkspace(runId);

    try {
      (mockQuery as any).mockReturnValue(
        fakeStream([
          {
            type: 'result',
            subtype: 'success',
            session_id: 'sdk-session-resumed',
            result: '继续上次的对话。',
            duration_ms: 2000,
            total_cost_usd: 0.003,
            usage: { input_tokens: 80, output_tokens: 30 },
          },
        ]),
      );

      const events: RuntimeEvent[] = [];
      for await (const event of adapter.resume('sdk-session-123', '继续', workspace)) {
        events.push(event);
      }

      // Verify SDK was called with resume option
      expect(mockQuery).toHaveBeenCalledTimes(1);
      const callArgs = (mockQuery as any).mock.calls[0][0];
      expect(callArgs.options.resume).toBe('sdk-session-123');

      const completedEvent = events.find((e) => e.type === 'completed');
      expect(completedEvent).toBeDefined();
      expect((completedEvent as any).result.output.text).toContain('继续');
    } finally {
      await cleanupWorkspace(runId).catch(() => {});
    }
  });

  it('passes resumed image paths to Claude SDK as image content', async () => {
    const runId = `test-resume-img-${randomUUID()}`;
    const workspace = await createWorkspace(runId);

    try {
      await writeFile(
        join(workspace.workspacePath, 'image.jpg'),
        Buffer.from([0xff, 0xd8, 0xff, 0xdb]),
      );
      (mockQuery as any).mockReturnValue(
        fakeStream([
          {
            type: 'result',
            subtype: 'success',
            session_id: 'sdk-session-resumed',
            result: '看到了图片',
            duration_ms: 1000,
            total_cost_usd: 0.001,
            usage: { input_tokens: 10, output_tokens: 5 },
          },
        ]),
      );

      const events: RuntimeEvent[] = [];
      for await (const event of adapter.resume(
        'sdk-session-123',
        '继续分析这张图片',
        workspace,
        undefined,
        {
          executionId: 'resume-img-task-1',
          imagePaths: [join(workspace.workspacePath, 'image.jpg')],
        },
      )) {
        events.push(event);
      }

      const callArgs = (mockQuery as any).mock.calls[0][0];
      expect(callArgs.options.resume).toBe('sdk-session-123');
      expect(typeof callArgs.prompt).not.toBe('string');
      const iterator = callArgs.prompt[Symbol.asyncIterator]();
      const first = await iterator.next();
      expect(first.done).toBe(false);
      expect(first.value.message.content[0]).toMatchObject({
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg' },
      });
      expect(first.value.message.content[1]).toEqual({
        type: 'text',
        text: '继续分析这张图片',
      });
      expect(events.find((event) => event.type === 'completed')).toBeDefined();
    } finally {
      await cleanupWorkspace(runId).catch(() => {});
    }
  });

  it('passes correct SDK options (model, cwd, env, permissionMode)', async () => {
    const runId = `test-${randomUUID()}`;
    const workspace = await createWorkspace(runId);
    workspace.runtimeEnv = { a: 'b', FEATURE_FLAG: 'enabled' };

    try {
      (mockQuery as any).mockReturnValue(
        fakeStream([
          {
            type: 'result',
            subtype: 'success',
            session_id: 'sdk-session-opts',
            result: 'ok',
            duration_ms: 1000,
            total_cost_usd: 0.001,
            usage: { input_tokens: 10, output_tokens: 5 },
          },
        ]),
      );

      const spec = makeSpec('task-opts-1', 'test');
      const handle = await adapter.prepare(spec, workspace);

      const events: RuntimeEvent[] = [];
      for await (const event of adapter.execute(handle, spec)) {
        events.push(event);
      }

      expect(mockQuery).toHaveBeenCalledTimes(1);
      const callArgs = (mockQuery as any).mock.calls[0][0];
      expect(callArgs.prompt).toBe('test');
      expect(callArgs.options.cwd).toBe(workspace.workspacePath);
      expect(callArgs.options.model).toBe('claude-sonnet-4-20250514');
      expect(callArgs.options.permissionMode).toBe('bypassPermissions');
      expect(callArgs.options.maxTurns).toBe(10);
      expect(callArgs.options.env.ANTHROPIC_BASE_URL).toBe('http://localhost:8080');
      expect(callArgs.options.env.ANTHROPIC_API_KEY).toBe('test-token');
      expect(callArgs.options.env.a).toBe('b');
      expect(callArgs.options.env.FEATURE_FLAG).toBe('enabled');
    } finally {
      await cleanupWorkspace(runId).catch(() => {});
    }
  });

  // Regression for #7: the adapter declares modelSelection: true, so the per-task
  // model must reach the SDK. Production registration builds the adapter WITHOUT a
  // global model, so previously the per-task model was silently dropped.
  const okResult = [
    {
      type: 'result',
      subtype: 'success',
      session_id: 's',
      result: 'ok',
      duration_ms: 1,
      total_cost_usd: 0,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  ];

  it('forwards per-task spec.model to the SDK even with no global model configured', async () => {
    const runId = `test-${randomUUID()}`;
    const workspace = await createWorkspace(runId);
    try {
      const noModelAdapter = new ClaudeCodeAdapter({
        baseUrl: 'http://localhost:8080',
        authToken: 'test-token',
      });
      (mockQuery as any).mockReturnValue(fakeStream(okResult));
      const spec = { ...makeSpec('task-model-1', 'hi'), model: 'claude-opus-4-20250514' };
      const handle = await noModelAdapter.prepare(spec, workspace);
      const events: RuntimeEvent[] = [];
      for await (const event of noModelAdapter.execute(handle, spec)) events.push(event);
      const callArgs = (mockQuery as any).mock.calls[0][0];
      expect(callArgs.options.model).toBe('claude-opus-4-20250514');
    } finally {
      await cleanupWorkspace(runId).catch(() => {});
    }
  });

  it('prefers per-task spec.model over the global config model', async () => {
    const runId = `test-${randomUUID()}`;
    const workspace = await createWorkspace(runId);
    try {
      // `adapter` (beforeEach) has global model claude-sonnet-4-20250514.
      (mockQuery as any).mockReturnValue(fakeStream(okResult));
      const spec = { ...makeSpec('task-model-2', 'hi'), model: 'claude-opus-4-20250514' };
      const handle = await adapter.prepare(spec, workspace);
      const events: RuntimeEvent[] = [];
      for await (const event of adapter.execute(handle, spec)) events.push(event);
      const callArgs = (mockQuery as any).mock.calls[0][0];
      expect(callArgs.options.model).toBe('claude-opus-4-20250514');
    } finally {
      await cleanupWorkspace(runId).catch(() => {});
    }
  });

  it('falls back to the global config model when the task has none', async () => {
    const runId = `test-${randomUUID()}`;
    const workspace = await createWorkspace(runId);
    try {
      (mockQuery as any).mockReturnValue(fakeStream(okResult));
      const spec = makeSpec('task-model-3', 'hi'); // no per-task model
      const handle = await adapter.prepare(spec, workspace);
      const events: RuntimeEvent[] = [];
      for await (const event of adapter.execute(handle, spec)) events.push(event);
      const callArgs = (mockQuery as any).mock.calls[0][0];
      expect(callArgs.options.model).toBe('claude-sonnet-4-20250514');
    } finally {
      await cleanupWorkspace(runId).catch(() => {});
    }
  });

  it('forwards the resume options.model to the SDK', async () => {
    const runId = `test-${randomUUID()}`;
    const workspace = await createWorkspace(runId);
    try {
      const noModelAdapter = new ClaudeCodeAdapter({
        baseUrl: 'http://localhost:8080',
        authToken: 'test-token',
      });
      (mockQuery as any).mockReturnValue(fakeStream(okResult));
      const events: RuntimeEvent[] = [];
      for await (const event of noModelAdapter.resume('sdk-session-1', 'continue', workspace, undefined, {
        model: 'claude-opus-4-20250514',
      })) {
        events.push(event);
      }
      const callArgs = (mockQuery as any).mock.calls[0][0];
      expect(callArgs.options.model).toBe('claude-opus-4-20250514');
    } finally {
      await cleanupWorkspace(runId).catch(() => {});
    }
  });

  it('reports healthy even without global credentials (per-agent supplies them)', async () => {
    const credlessAdapter = new ClaudeCodeAdapter({ baseUrl: '', authToken: '' });
    const health = await credlessAdapter.healthcheck();
    // The adapter is always available now that registration is decoupled from
    // global env; per-agent credentials are validated at execution time.
    expect(health.healthy).toBe(true);
    expect(health.name).toBe('claude_code');
  });

  it('lets per-agent runtimeEnv ANTHROPIC_* override adapter config (per-agent wins)', async () => {
    const runId = `test-${randomUUID()}`;
    const workspace = await createWorkspace(runId);
    workspace.runtimeEnv = {
      ANTHROPIC_BASE_URL: 'http://agent-gateway:9000',
      ANTHROPIC_API_KEY: 'agent-scoped-key',
    };

    try {
      (mockQuery as any).mockReturnValue(
        fakeStream([
          {
            type: 'result',
            subtype: 'success',
            session_id: 'sdk-session-peragent',
            result: 'ok',
            duration_ms: 100,
            total_cost_usd: 0.001,
            usage: { input_tokens: 10, output_tokens: 5 },
          },
        ]),
      );

      const spec = makeSpec('task-peragent-1', 'test');
      const handle = await adapter.prepare(spec, workspace);

      const events: RuntimeEvent[] = [];
      for await (const event of adapter.execute(handle, spec)) {
        events.push(event);
      }

      // adapter is constructed with baseUrl http://localhost:8080 / authToken
      // test-token, but the per-agent runtimeEnv must take precedence.
      const callArgs = (mockQuery as any).mock.calls[0][0];
      expect(callArgs.options.env.ANTHROPIC_BASE_URL).toBe('http://agent-gateway:9000');
      expect(callArgs.options.env.ANTHROPIC_API_KEY).toBe('agent-scoped-key');
    } finally {
      await cleanupWorkspace(runId).catch(() => {});
    }
  });

  it('launches Claude Code without API credential env so local login can authenticate', async () => {
    const runId = `test-${randomUUID()}`;
    const workspace = await createWorkspace(runId);
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', '');
    vi.stubEnv('ANTHROPIC_BASE_URL', '');
    const credlessAdapter = new ClaudeCodeAdapter({ baseUrl: '', authToken: '' });

    try {
      (mockQuery as any).mockReturnValue(
        fakeStream([
          {
            type: 'result',
            subtype: 'success',
            session_id: 'sdk-session-local-login',
            result: 'ok',
            duration_ms: 100,
            total_cost_usd: 0.001,
            usage: { input_tokens: 10, output_tokens: 5 },
          },
        ]),
      );
      const spec = makeSpec('task-nocred-1', 'test');
      const handle = await credlessAdapter.prepare(spec, workspace);

      const events: RuntimeEvent[] = [];
      for await (const event of credlessAdapter.execute(handle, spec)) {
        events.push(event);
      }

      expect(mockQuery).toHaveBeenCalledTimes(1);
      const callArgs = (mockQuery as any).mock.calls[0][0];
      expect(callArgs.options.env.ANTHROPIC_BASE_URL).toBe('');
      expect(callArgs.options.env.ANTHROPIC_API_KEY).toBe('');
      expect(events.find((e) => e.type === 'completed')).toBeDefined();
    } finally {
      vi.unstubAllEnvs();
      await cleanupWorkspace(runId).catch(() => {});
    }
  });

  it('allows Bash while denying direct file-editing tools for readonly turns', async () => {
    const runId = `test-${randomUUID()}`;
    const workspace = await createWorkspace(runId);
    workspace.readOnly = true;

    try {
      (mockQuery as any).mockReturnValue(
        fakeStream([
          {
            type: 'result',
            subtype: 'success',
            session_id: 'sdk-session-readonly',
            result: 'ok',
            duration_ms: 1000,
            total_cost_usd: 0.001,
            usage: { input_tokens: 10, output_tokens: 5 },
          },
        ]),
      );

      const spec = makeSpec('task-readonly-1', 'inspect project');
      const handle = await adapter.prepare(spec, workspace);

      const events: RuntimeEvent[] = [];
      for await (const event of adapter.execute(handle, spec)) {
        events.push(event);
      }

      const callArgs = (mockQuery as any).mock.calls[0][0];
      expect(callArgs.options.permissionMode).toBe('default');
      expect(callArgs.options.disallowedTools).toEqual([
        'Edit',
        'Write',
        'MultiEdit',
        'NotebookEdit',
      ]);
      expect(callArgs.options.disallowedTools).not.toContain('Bash');
      expect(events.some((event) => event.type === 'completed')).toBe(true);
    } finally {
      await cleanupWorkspace(runId).catch(() => {});
    }
  });

  it('passes systemPromptAppend to SDK options when provided', async () => {
    const runId = `test-${randomUUID()}`;
    const workspace = await createWorkspace(runId);

    try {
      (mockQuery as any).mockReturnValue(
        fakeStream([
          {
            type: 'result',
            subtype: 'success',
            session_id: 'sdk-session-sp',
            result: 'done',
            duration_ms: 1000,
            total_cost_usd: 0.001,
            usage: { input_tokens: 10, output_tokens: 5 },
          },
        ]),
      );

      const spec = makeSpec('task-sp-1', 'test');
      const handle = await adapter.prepare(spec, workspace);

      const events: RuntimeEvent[] = [];
      for await (const event of adapter.execute(handle, spec, 'You are a OpenClaudeTag developer')) {
        events.push(event);
      }

      const callArgs = (mockQuery as any).mock.calls[0][0];
      expect(callArgs.options.systemPrompt).toEqual({
        type: 'preset',
        preset: 'claude_code',
        append: 'You are a OpenClaudeTag developer',
      });
      expect(callArgs.options.settingSources).toEqual(['project']);
    } finally {
      await cleanupWorkspace(runId).catch(() => {});
    }
  });

  it('omits systemPrompt when not provided', async () => {
    const runId = `test-${randomUUID()}`;
    const workspace = await createWorkspace(runId);

    try {
      (mockQuery as any).mockReturnValue(
        fakeStream([
          {
            type: 'result',
            subtype: 'success',
            session_id: 'sdk-session-nsp',
            result: 'done',
            duration_ms: 1000,
            total_cost_usd: 0.001,
            usage: { input_tokens: 10, output_tokens: 5 },
          },
        ]),
      );

      const spec = makeSpec('task-nsp-1', 'test');
      const handle = await adapter.prepare(spec, workspace);

      const events: RuntimeEvent[] = [];
      for await (const event of adapter.execute(handle, spec)) {
        events.push(event);
      }

      const callArgs = (mockQuery as any).mock.calls[0][0];
      expect(callArgs.options.systemPrompt).toBeUndefined();
    } finally {
      await cleanupWorkspace(runId).catch(() => {});
    }
  });

  describe('prepare() with imageAttachment', () => {
    it('downloads image and writes to workspace when imageAttachment provided', async () => {
      const runId = `test-img-${randomUUID()}`;
      const workspace = await createWorkspace(runId);

      try {
        const imageBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG header
        const mockDownloader = { downloadImage: vi.fn().mockResolvedValue(imageBuffer) };

        const adapterWithDownloader = new ClaudeCodeAdapter({
          baseUrl: 'http://localhost:8080',
          authToken: 'test-token',
          imageDownloader: mockDownloader,
        });

        const spec = {
          ...makeSpec('task-img-1', '请分析这张图片'),
          context: {
            systemPrompt: '',
            recentTurns: [] as unknown[],
            imageAttachment: { imageKey: 'img_v2_abc', messageId: 'msg_001' },
          },
        };

        await adapterWithDownloader.prepare(spec, workspace);

        expect(mockDownloader.downloadImage).toHaveBeenCalledWith('msg_001', 'img_v2_abc');

        const savedImage = await readFile(join(workspace.workspacePath, 'image.png'));
        expect(savedImage[0]).toBe(0x89);

        const taskMd = await readFile(join(workspace.workspacePath, 'TASK.md'), 'utf-8');
        expect(taskMd).toContain('Image: ./image.png (请分析这张图片)');
      } finally {
        await cleanupWorkspace(runId).catch(() => {});
      }
    });

    it('continues without image when download fails', async () => {
      const runId = `test-img-fail-${randomUUID()}`;
      const workspace = await createWorkspace(runId);

      try {
        const mockDownloader = { downloadImage: vi.fn().mockRejectedValue(new Error('HTTP 403')) };

        const adapterWithDownloader = new ClaudeCodeAdapter({
          baseUrl: 'http://localhost:8080',
          authToken: 'test-token',
          imageDownloader: mockDownloader,
        });

        const spec = {
          ...makeSpec('task-img-fail-1', '请分析这张图片'),
          context: {
            systemPrompt: '',
            recentTurns: [] as unknown[],
            imageAttachment: { imageKey: 'img_v2_bad', messageId: 'msg_fail' },
          },
        };

        // Should not throw
        await expect(adapterWithDownloader.prepare(spec, workspace)).resolves.toBeDefined();

        const taskMd = await readFile(join(workspace.workspacePath, 'TASK.md'), 'utf-8');
        expect(taskMd).not.toContain('Image:');
      } finally {
        await cleanupWorkspace(runId).catch(() => {});
      }
    });

    it('skips image download when no imageDownloader configured', async () => {
      const runId = `test-img-no-dl-${randomUUID()}`;
      const workspace = await createWorkspace(runId);

      try {
        const spec = {
          ...makeSpec('task-img-nodl-1', '请分析这张图片'),
          context: {
            systemPrompt: '',
            recentTurns: [] as unknown[],
            imageAttachment: { imageKey: 'img_v2_abc', messageId: 'msg_001' },
          },
        };

        // adapter without imageDownloader - should not throw
        await expect(adapter.prepare(spec, workspace)).resolves.toBeDefined();

        const taskMd = await readFile(join(workspace.workspacePath, 'TASK.md'), 'utf-8');
        expect(taskMd).not.toContain('Image:');
      } finally {
        await cleanupWorkspace(runId).catch(() => {});
      }
    });
  });

  it('yields progress events from intermediate assistant messages with tool_use blocks', async () => {
    const runId = `test-${randomUUID()}`;
    const workspace = await createWorkspace(runId);

    try {
      (mockQuery as any).mockReturnValue(
        fakeStream([
          {
            type: 'assistant',
            message: {
              content: [
                { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'pnpm test' } },
              ],
            },
            session_id: 'sdk-stream-1',
          },
          {
            type: 'assistant',
            message: {
              content: [
                {
                  type: 'tool_use',
                  id: 'tu_2',
                  name: 'Edit',
                  input: { file_path: 'src/index.ts' },
                },
              ],
            },
            session_id: 'sdk-stream-1',
          },
          {
            type: 'assistant',
            message: {
              content: [{ type: 'tool_use', id: 'tu_3', name: 'Grep', input: { pattern: 'TODO' } }],
            },
            session_id: 'sdk-stream-1',
          },
          {
            type: 'result',
            subtype: 'success',
            session_id: 'sdk-stream-1',
            result: 'done',
            duration_ms: 5000,
            total_cost_usd: 0.01,
            usage: { input_tokens: 200, output_tokens: 100 },
          },
        ]),
      );

      const spec = makeSpec('task-stream-1', 'fix the tests');
      const handle = await adapter.prepare(spec, workspace);

      const events: RuntimeEvent[] = [];
      for await (const event of adapter.execute(handle, spec)) {
        events.push(event);
      }

      const progressEvents = events.filter((e) => e.type === 'progress');
      // Initial 10%, then 18% (Bash), 21% (Edit), 24% (Grep), then 90% (collecting)
      expect(progressEvents.length).toBe(5);
      expect(progressEvents[0]).toEqual({
        type: 'progress',
        percent: 10,
        message: 'Claude Code processing...',
      });
      expect(progressEvents[1]).toEqual({
        type: 'progress',
        percent: 18,
        message: 'Running: pnpm test',
      });
      expect(progressEvents[2]).toEqual({
        type: 'progress',
        percent: 21,
        message: 'Editing: src/index.ts',
      });
      expect(progressEvents[3]).toEqual({
        type: 'progress',
        percent: 24,
        message: 'Searching: TODO',
      });
      expect(progressEvents[4]).toEqual({
        type: 'progress',
        percent: 90,
        message: 'Collecting results...',
      });
    } finally {
      await cleanupWorkspace(runId).catch(() => {});
    }
  });

  it('emits a plan_update event when a TodoWrite tool_use is seen', async () => {
    const runId = `test-${randomUUID()}`;
    const workspace = await createWorkspace(runId);

    try {
      (mockQuery as any).mockReturnValue(
        fakeStream([
          {
            type: 'assistant',
            message: {
              content: [
                {
                  type: 'tool_use',
                  id: 'tu_todo',
                  name: 'TodoWrite',
                  input: {
                    todos: [
                      {
                        content: 'Write failing tests',
                        status: 'completed',
                        activeForm: 'Writing failing tests',
                      },
                      {
                        content: 'Implement feature',
                        status: 'in_progress',
                        activeForm: 'Implementing feature',
                      },
                      { content: 'Run build', status: 'pending', activeForm: 'Running build' },
                    ],
                  },
                },
              ],
            },
            session_id: 'sdk-plan-1',
          },
          {
            type: 'assistant',
            message: {
              content: [
                { type: 'tool_use', id: 'tu_bash', name: 'Bash', input: { command: 'pnpm test' } },
              ],
            },
            session_id: 'sdk-plan-1',
          },
          {
            type: 'result',
            subtype: 'success',
            session_id: 'sdk-plan-1',
            result: 'done',
            duration_ms: 4000,
            total_cost_usd: 0.01,
            usage: { input_tokens: 200, output_tokens: 100 },
          },
        ]),
      );

      const spec = makeSpec('task-plan-1', 'do the work');
      const handle = await adapter.prepare(spec, workspace);

      const events: RuntimeEvent[] = [];
      for await (const event of adapter.execute(handle, spec)) {
        events.push(event);
      }

      const planEvents = events.filter((e) => e.type === 'plan_update');
      expect(planEvents).toHaveLength(1);
      expect((planEvents[0] as any).steps).toEqual([
        { id: 'step-0', title: 'Write failing tests', status: 'done' },
        { id: 'step-1', title: 'Implement feature', status: 'running' },
        { id: 'step-2', title: 'Run build', status: 'pending' },
      ]);

      // Non-TodoWrite tool calls produce a structured tool_use event...
      const toolUseEvents = events.filter((e) => e.type === 'tool_use');
      expect(toolUseEvents).toEqual([
        { type: 'tool_use', name: 'Bash', summary: 'Running: pnpm test', status: 'running' },
      ]);
      // ...while the existing progress emission is preserved (additive).
      expect(events.filter((e) => e.type === 'progress').length).toBeGreaterThan(0);
    } finally {
      await cleanupWorkspace(runId).catch(() => {});
    }
  });

  it('yields status events from tool_use_summary messages', async () => {
    const runId = `test-${randomUUID()}`;
    const workspace = await createWorkspace(runId);

    try {
      (mockQuery as any).mockReturnValue(
        fakeStream([
          {
            type: 'tool_use_summary',
            summary: 'Read 3 files and edited 2',
            preceding_tool_use_ids: ['tu_1', 'tu_2'],
            session_id: 'sdk-summary-1',
          },
          {
            type: 'tool_use_summary',
            summary: '   ',
            preceding_tool_use_ids: [],
            session_id: 'sdk-summary-1',
          },
          {
            type: 'result',
            subtype: 'success',
            session_id: 'sdk-summary-1',
            result: 'done',
            duration_ms: 2000,
            total_cost_usd: 0.005,
            usage: { input_tokens: 100, output_tokens: 50 },
          },
        ]),
      );

      const spec = makeSpec('task-summary-1', 'review code');
      const handle = await adapter.prepare(spec, workspace);

      const events: RuntimeEvent[] = [];
      for await (const event of adapter.execute(handle, spec)) {
        events.push(event);
      }

      const statusEvents = events.filter((e) => e.type === 'status');
      // 'Starting Claude Code...' from execute(), then 'Read 3 files and edited 2'
      // The whitespace-only summary should be skipped
      expect(statusEvents).toEqual([
        { type: 'status', message: 'Starting Claude Code...' },
        { type: 'status', message: 'Read 3 files and edited 2' },
      ]);
    } finally {
      await cleanupWorkspace(runId).catch(() => {});
    }
  });

  it('yields reasoning events from thinking blocks in assistant messages', async () => {
    const runId = `test-${randomUUID()}`;
    const workspace = await createWorkspace(runId);

    try {
      (mockQuery as any).mockReturnValue(
        fakeStream([
          {
            type: 'assistant',
            message: {
              content: [
                {
                  type: 'thinking',
                  thinking:
                    'Let me analyze the test failures. The issue seems to be in the import path.',
                },
                {
                  type: 'tool_use',
                  id: 'tu_1',
                  name: 'Read',
                  input: { file_path: 'src/index.ts' },
                },
              ],
            },
            session_id: 'sdk-thinking-1',
          },
          {
            type: 'assistant',
            message: {
              content: [{ type: 'thinking', thinking: '   ' }],
            },
            session_id: 'sdk-thinking-1',
          },
          {
            type: 'result',
            subtype: 'success',
            session_id: 'sdk-thinking-1',
            result: 'done',
            duration_ms: 3000,
            total_cost_usd: 0.01,
            usage: { input_tokens: 200, output_tokens: 100 },
          },
        ]),
      );

      const spec = makeSpec('task-thinking-1', 'debug the issue');
      const handle = await adapter.prepare(spec, workspace);

      const events: RuntimeEvent[] = [];
      for await (const event of adapter.execute(handle, spec)) {
        events.push(event);
      }

      const reasoningEvents = events.filter((e) => e.type === 'reasoning');
      // Only the non-empty thinking block should yield a reasoning event
      expect(reasoningEvents).toEqual([
        {
          type: 'reasoning',
          summary: 'Let me analyze the test failures. The issue seems to be in the import path.',
        },
      ]);

      // tool_use should still produce a progress event
      const progressEvents = events.filter((e) => e.type === 'progress');
      expect(progressEvents[1]).toEqual({
        type: 'progress',
        percent: 18,
        message: 'Reading: src/index.ts',
      });
    } finally {
      await cleanupWorkspace(runId).catch(() => {});
    }
  });

  it('caps progress at 80% with many tool calls', async () => {
    const runId = `test-${randomUUID()}`;
    const workspace = await createWorkspace(runId);

    try {
      const assistantMessages = Array.from({ length: 25 }, (_, i) => ({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: `tu_${i}`, name: 'Read', input: { file_path: `file${i}.ts` } },
          ],
        },
        session_id: 'sdk-cap-1',
      }));

      (mockQuery as any).mockReturnValue(
        fakeStream([
          ...assistantMessages,
          {
            type: 'result',
            subtype: 'success',
            session_id: 'sdk-cap-1',
            result: 'done',
            duration_ms: 10000,
            total_cost_usd: 0.02,
            usage: { input_tokens: 500, output_tokens: 200 },
          },
        ]),
      );

      const spec = makeSpec('task-cap-1', 'read many files');
      const handle = await adapter.prepare(spec, workspace);

      const events: RuntimeEvent[] = [];
      for await (const event of adapter.execute(handle, spec)) {
        events.push(event);
      }

      const progressEvents = events.filter((e) => e.type === 'progress');
      // All tool progress events after the 22nd should be capped at 80
      const toolProgressEvents = progressEvents.slice(1, -1); // skip initial 10% and final 90%
      expect(toolProgressEvents.length).toBe(25);
      // 15 + 22*3 = 81, capped to 80. Items 22-25 (index 21-24) should all be 80.
      const cappedEvents = toolProgressEvents.filter((e) => (e as any).percent === 80);
      expect(cappedEvents.length).toBeGreaterThanOrEqual(3);
      // First event: 15+1*3=18, last event should be capped at 80
      expect((toolProgressEvents[0] as any).percent).toBe(18);
      expect((toolProgressEvents[toolProgressEvents.length - 1] as any).percent).toBe(80);
    } finally {
      await cleanupWorkspace(runId).catch(() => {});
    }
  });

  it('formats tool previews correctly for known and unknown tools', async () => {
    const runId = `test-${randomUUID()}`;
    const workspace = await createWorkspace(runId);

    try {
      (mockQuery as any).mockReturnValue(
        fakeStream([
          {
            type: 'assistant',
            message: {
              content: [
                {
                  type: 'tool_use',
                  id: 'tu_1',
                  name: 'Write',
                  input: { file_path: '/tmp/out.txt' },
                },
              ],
            },
            session_id: 'sdk-fmt-1',
          },
          {
            type: 'assistant',
            message: {
              content: [
                { type: 'tool_use', id: 'tu_2', name: 'Glob', input: { pattern: '**/*.ts' } },
              ],
            },
            session_id: 'sdk-fmt-1',
          },
          {
            type: 'assistant',
            message: {
              content: [
                {
                  type: 'tool_use',
                  id: 'tu_3',
                  name: 'Agent',
                  input: { description: 'explore codebase' },
                },
              ],
            },
            session_id: 'sdk-fmt-1',
          },
          {
            type: 'assistant',
            message: {
              content: [
                { type: 'tool_use', id: 'tu_4', name: 'WebSearch', input: { query: 'test' } },
              ],
            },
            session_id: 'sdk-fmt-1',
          },
          {
            type: 'result',
            subtype: 'success',
            session_id: 'sdk-fmt-1',
            result: 'done',
            duration_ms: 3000,
            total_cost_usd: 0.008,
            usage: { input_tokens: 150, output_tokens: 80 },
          },
        ]),
      );

      const spec = makeSpec('task-fmt-1', 'multi-tool task');
      const handle = await adapter.prepare(spec, workspace);

      const events: RuntimeEvent[] = [];
      for await (const event of adapter.execute(handle, spec)) {
        events.push(event);
      }

      const progressEvents = events.filter((e) => e.type === 'progress');
      expect(progressEvents[1]).toEqual({
        type: 'progress',
        percent: 18,
        message: 'Writing: /tmp/out.txt',
      });
      expect(progressEvents[2]).toEqual({
        type: 'progress',
        percent: 21,
        message: 'Finding files: **/*.ts',
      });
      expect(progressEvents[3]).toEqual({
        type: 'progress',
        percent: 24,
        message: 'Running agent: explore codebase',
      });
      expect(progressEvents[4]).toEqual({
        type: 'progress',
        percent: 27,
        message: 'Using: WebSearch',
      });
    } finally {
      await cleanupWorkspace(runId).catch(() => {});
    }
  });

  it('cancel aborts the SDK query via AbortController', async () => {
    const runId = `test-${randomUUID()}`;
    const workspace = await createWorkspace(runId);

    try {
      let capturedAbortController: AbortController | undefined;

      (mockQuery as any).mockImplementation((args: any) => {
        capturedAbortController = args.options.abortController;
        return (async function* () {
          yield { type: 'status', message: 'waiting for abort' } as any;
          // Block until we unblock it
          await new Promise<void>((resolve) => {
            // Also resolve on abort so the test doesn't hang
            args.options.abortController?.signal?.addEventListener('abort', () => resolve());
          });
        })();
      });

      const spec = makeSpec('task-cancel-1', 'long task');
      const handle = await adapter.prepare(spec, workspace);

      // Start execution in background — collect events until it's done
      const eventsPromise = (async () => {
        const events: RuntimeEvent[] = [];
        for await (const event of adapter.execute(handle, spec)) {
          events.push(event);
        }
        return events;
      })();

      // Wait a tick for the generator to reach the mock
      await new Promise((r) => setTimeout(r, 50));

      // Verify abort controller was captured by the mock
      expect(capturedAbortController).toBeDefined();
      expect(capturedAbortController!.signal.aborted).toBe(false);

      // Cancel should abort the controller
      await adapter.cancel('task-cancel-1');
      expect(capturedAbortController!.signal.aborted).toBe(true);

      // Let the execution finish
      await eventsPromise;
    } finally {
      await cleanupWorkspace(runId).catch(() => {});
    }
  });

  it('cancel aborts resumed SDK query by provided execution id', async () => {
    const runId = `test-${randomUUID()}`;
    const workspace = await createWorkspace(runId);

    try {
      let capturedAbortController: AbortController | undefined;

      (mockQuery as any).mockImplementation((args: any) => {
        capturedAbortController = args.options.abortController;
        return (async function* () {
          yield { type: 'status', message: 'waiting for abort' } as any;
          await new Promise<void>((resolve) => {
            args.options.abortController?.signal?.addEventListener('abort', () => resolve());
          });
          throw new Error('Aborted');
        })();
      });

      const eventsPromise = (async () => {
        const events: RuntimeEvent[] = [];
        for await (const event of adapter.resume(
          'sdk-session-123',
          'continue',
          workspace,
          undefined,
          { executionId: 'resume-task-1' },
        )) {
          events.push(event);
        }
        return events;
      })();

      await new Promise((r) => setTimeout(r, 50));

      expect(capturedAbortController).toBeDefined();
      expect(capturedAbortController!.signal.aborted).toBe(false);

      await adapter.cancel('resume-task-1');
      expect(capturedAbortController!.signal.aborted).toBe(true);

      const events = await eventsPromise;
      const failedEvent = events.find((e) => e.type === 'failed');
      expect(failedEvent).toBeDefined();
      expect((failedEvent as any).error).toContain('Aborted');
      expect((failedEvent as any).reason).toBe('cancelled');
    } finally {
      await cleanupWorkspace(runId).catch(() => {});
    }
  });

  it('reuses the same resume execution id without cancelling a completed previous round', async () => {
    const runId = `test-${randomUUID()}`;
    const workspace = await createWorkspace(runId);

    try {
      const controllers: AbortController[] = [];

      (mockQuery as any).mockImplementation((args: any) => {
        controllers.push(args.options.abortController);
        if (controllers.length === 1) {
          return fakeStream([
            {
              type: 'result',
              subtype: 'success',
              session_id: 'sdk-session-123',
              result: 'first resume done',
              duration_ms: 100,
              total_cost_usd: 0,
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          ]);
        }

        return (async function* () {
          yield { type: 'status', message: 'second resume waiting for abort' } as any;
          await new Promise<void>((resolve) => {
            args.options.abortController?.signal?.addEventListener('abort', () => resolve());
          });
          throw new Error('Aborted');
        })();
      });

      const firstEvents: RuntimeEvent[] = [];
      for await (const event of adapter.resume(
        'sdk-session-123',
        'continue first',
        workspace,
        undefined,
        { executionId: 'same-task-id' },
      )) {
        firstEvents.push(event);
      }

      expect(firstEvents.find((e) => e.type === 'completed')).toBeDefined();
      expect(controllers).toHaveLength(1);
      expect(controllers[0]!.signal.aborted).toBe(false);

      const secondEventsPromise = (async () => {
        const events: RuntimeEvent[] = [];
        for await (const event of adapter.resume(
          'sdk-session-123',
          'continue second',
          workspace,
          undefined,
          { executionId: 'same-task-id' },
        )) {
          events.push(event);
        }
        return events;
      })();

      await new Promise((r) => setTimeout(r, 50));

      expect(controllers).toHaveLength(2);
      expect(controllers[0]!.signal.aborted).toBe(false);
      expect(controllers[1]!.signal.aborted).toBe(false);

      await adapter.cancel('same-task-id');

      expect(controllers[0]!.signal.aborted).toBe(false);
      expect(controllers[1]!.signal.aborted).toBe(true);

      const secondEvents = await secondEventsPromise;
      const failedEvent = secondEvents.find((e) => e.type === 'failed');
      expect(failedEvent).toBeDefined();
      expect((failedEvent as any).reason).toBe('cancelled');
    } finally {
      await cleanupWorkspace(runId).catch(() => {});
    }
  });

  describe('artifact collection (issue #9 — scratch artifactsDir alignment)', () => {
    it('emits artifact events ONLY for the scratch artifactsDir, never cwd/artifacts', async () => {
      const runId = `test-${randomUUID()}`;
      const workspace = await createWorkspace(runId);
      // Diverge cwd from the scratch workspacePath (mirrors every real worker
      // mode: worktree / external repo / agent home). cwd/artifacts holds an
      // unrelated pre-existing file that must NOT be surfaced as an artifact.
      workspace.cwd = workspace.repoDir;
      try {
        await mkdir(join(workspace.cwd, 'artifacts'), { recursive: true });
        await writeFile(join(workspace.cwd, 'artifacts', 'decoy.txt'), 'pre-existing repo file');
        await writeFile(join(workspace.artifactsDir, 'deliverable.txt'), 'real output');

        (mockQuery as any).mockReturnValue(fakeStream(okResult));
        const spec = makeSpec('task-artifact-1', 'produce a file');
        const handle = await adapter.prepare(spec, workspace);
        expect(handle.artifactsDir).toBe(workspace.artifactsDir);

        const events: RuntimeEvent[] = [];
        for await (const event of adapter.execute(handle, spec)) events.push(event);

        const artifactRefs = events
          .filter((e): e is Extract<RuntimeEvent, { type: 'artifact' }> => e.type === 'artifact')
          .map((e) => e.ref);
        expect(artifactRefs.map((r) => r.name)).toEqual(['deliverable.txt']);
        expect(artifactRefs.map((r) => r.path)).toEqual([
          join(workspace.artifactsDir, 'deliverable.txt'),
        ]);
      } finally {
        await cleanupWorkspace(runId).catch(() => {});
      }
    });

    it('emits no artifact events when the scratch artifactsDir is empty', async () => {
      const runId = `test-${randomUUID()}`;
      const workspace = await createWorkspace(runId);
      // A decoy under cwd/artifacts must still be ignored even when the scratch
      // dir is empty (proves the scan target, not just dedupe).
      workspace.cwd = workspace.repoDir;
      try {
        await mkdir(join(workspace.cwd, 'artifacts'), { recursive: true });
        await writeFile(join(workspace.cwd, 'artifacts', 'decoy.txt'), 'pre-existing repo file');

        (mockQuery as any).mockReturnValue(fakeStream(okResult));
        const spec = makeSpec('task-artifact-2', 'no deliverable');
        const handle = await adapter.prepare(spec, workspace);

        const events: RuntimeEvent[] = [];
        for await (const event of adapter.execute(handle, spec)) events.push(event);

        expect(events.filter((e) => e.type === 'artifact')).toHaveLength(0);
      } finally {
        await cleanupWorkspace(runId).catch(() => {});
      }
    });

    it('writes the absolute scratch artifactsDir hint into TASK.md', async () => {
      const runId = `test-${randomUUID()}`;
      const workspace = await createWorkspace(runId);
      try {
        const spec = makeSpec('task-artifact-3', 'hint check');
        await adapter.prepare(spec, workspace);
        const taskMd = await readFile(join(workspace.workspacePath, 'TASK.md'), 'utf8');
        expect(taskMd).toContain(
          `Place any deliverable files you want surfaced as task artifacts under: ${workspace.artifactsDir}`,
        );
      } finally {
        await cleanupWorkspace(runId).catch(() => {});
      }
    });
  });
});
