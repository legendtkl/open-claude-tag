import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CodexAdapter, buildCodexExecEnv, prependPathDirs } from '../codex-adapter.js';
import { createWorkspace, cleanupWorkspace } from '../workspace.js';
import { randomUUID } from 'crypto';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import type { RuntimeEvent } from '@open-tag/core-types';

// Helper: create an async generator from an array of ThreadEvent-like objects
async function* makeEventStream(
  events: Array<Record<string, unknown>>,
): AsyncGenerator<Record<string, unknown>> {
  for (const e of events) {
    yield e;
  }
}

// Mock the Codex SDK
const { mockRunStreamed, mockCodexCtor } = vi.hoisted(() => ({
  mockRunStreamed: vi.fn(),
  mockCodexCtor: vi.fn(),
}));
const mockThreadId = vi.fn<() => string | null>().mockReturnValue('thread-123');
const mockStartThread = vi.fn().mockReturnValue({
  runStreamed: mockRunStreamed,
  get id() {
    return mockThreadId();
  },
});
const mockResumeThread = vi.fn().mockReturnValue({
  runStreamed: mockRunStreamed,
  get id() {
    return mockThreadId();
  },
});

vi.mock('@openai/codex-sdk', () => ({
  Codex: mockCodexCtor.mockImplementation(() => ({
    startThread: mockStartThread,
    resumeThread: mockResumeThread,
  })),
}));

/** Build a standard stream of events that simulates a successful Codex turn. */
function successEvents(
  finalResponse: string,
  usage?: { input_tokens: number; cached_input_tokens: number; output_tokens: number },
) {
  return [
    { type: 'thread.started', thread_id: 'thread-123' },
    { type: 'turn.started' },
    {
      type: 'item.started',
      item: {
        id: 'cmd-1',
        type: 'command_execution',
        command: 'echo hello',
        aggregated_output: '',
        status: 'in_progress',
      },
    },
    {
      type: 'item.completed',
      item: {
        id: 'cmd-1',
        type: 'command_execution',
        command: 'echo hello',
        aggregated_output: 'hello\n',
        exit_code: 0,
        status: 'completed',
      },
    },
    { type: 'item.completed', item: { id: 'msg-1', type: 'agent_message', text: finalResponse } },
    ...(usage
      ? [{ type: 'turn.completed', usage }]
      : [
          {
            type: 'turn.completed',
            usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 },
          },
        ]),
  ];
}

function makeSpec(taskId: string, goal: string) {
  return {
    taskId,
    sessionId: 'test-session',
    taskType: 'chat_reply' as const,
    goal,
    runtimeHint: 'codex' as const,
    constraints: {
      timeoutSec: 30,
      approvalRequired: false,
      writeScope: [] as string[],
      networkPolicy: 'restricted' as const,
    },
    context: { systemPrompt: '', recentTurns: [] as unknown[] },
  };
}

describe('CodexAdapter', () => {
  let adapter: CodexAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    mockThreadId.mockReturnValue('thread-123');
    adapter = new CodexAdapter({
      baseUrl: 'http://localhost:8080',
      apiKey: 'test-key',
      model: 'codex-mini',
    });
  });

  it('merges per-task runtime env into the Codex exec environment', () => {
    const env = buildCodexExecEnv({
      baseEnv: {
        PATH: '/usr/bin',
        a: 'from-process',
        CODEX_API_KEY: 'process-key',
      },
      runtimeEnv: {
        a: 'b',
        FEATURE_FLAG: 'enabled',
      },
      apiKey: 'adapter-key',
      pathDirs: ['/vendor/bin'],
      platform: 'linux',
    });

    expect(env.a).toBe('b');
    expect(env.FEATURE_FLAG).toBe('enabled');
    expect(env.CODEX_API_KEY).toBe('adapter-key');
    expect(env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE).toBe('codex_sdk_ts');
    expect(env.PATH).toBe('/vendor/bin:/usr/bin');
  });

  it('yields completed event with result from streamed SDK on success', async () => {
    const runId = `test-${randomUUID()}`;
    const workspace = await createWorkspace(runId);

    try {
      const streamEvents = successEvents('function quickSort(arr) { return arr; }', {
        input_tokens: 200,
        cached_input_tokens: 0,
        output_tokens: 80,
      });
      mockRunStreamed.mockResolvedValue({ events: makeEventStream(streamEvents) });

      const spec = makeSpec('task-ok-1', '编写一个快排代码');
      const handle = await adapter.prepare(spec, workspace);

      const events: RuntimeEvent[] = [];
      for await (const event of adapter.execute(handle, spec)) {
        events.push(event);
      }

      // Should have session_created event with thread ID
      const sessionEvent = events.find((e) => e.type === 'session_created');
      expect(sessionEvent).toBeDefined();
      expect((sessionEvent as any).sdkSessionId).toBe('thread-123');

      // Should have progress events from command execution
      const progressEvents = events.filter((e) => e.type === 'progress');
      expect(progressEvents.length).toBeGreaterThanOrEqual(2); // initial 10% + command + collecting

      // Should have completed event
      const completedEvent = events.find((e) => e.type === 'completed');
      expect(completedEvent).toBeDefined();
      const result = (completedEvent as any).result;
      expect(result.status).toBe('completed');
      expect(result.output.text).toContain('quickSort');
      expect(result.metrics.tokenIn).toBe(200);
      expect(result.metrics.tokenOut).toBe(80);
    } finally {
      await cleanupWorkspace(runId).catch(() => {});
    }
  });

  it('yields failed event when SDK stream throws', async () => {
    const runId = `test-${randomUUID()}`;
    const workspace = await createWorkspace(runId);

    try {
      mockRunStreamed.mockRejectedValue(new Error('API rate limit exceeded'));

      const spec = makeSpec('task-err-1', '编写一个快排代码');
      const handle = await adapter.prepare(spec, workspace);

      const events: RuntimeEvent[] = [];
      for await (const event of adapter.execute(handle, spec)) {
        events.push(event);
      }

      const failedEvent = events.find((e) => e.type === 'failed');
      expect(failedEvent).toBeDefined();
      expect((failedEvent as any).error).toContain('API rate limit exceeded');
    } finally {
      await cleanupWorkspace(runId).catch(() => {});
    }
  });

  it('yields failed event on turn.failed stream event', async () => {
    const runId = `test-${randomUUID()}`;
    const workspace = await createWorkspace(runId);

    try {
      const streamEvents = [
        { type: 'thread.started', thread_id: 'thread-123' },
        { type: 'turn.started' },
        { type: 'turn.failed', error: { message: 'Context window exceeded' } },
      ];
      mockRunStreamed.mockResolvedValue({ events: makeEventStream(streamEvents) });

      const spec = makeSpec('task-turnfail-1', 'test');
      const handle = await adapter.prepare(spec, workspace);

      const events: RuntimeEvent[] = [];
      for await (const event of adapter.execute(handle, spec)) {
        events.push(event);
      }

      const failedEvent = events.find((e) => e.type === 'failed');
      expect(failedEvent).toBeDefined();
      expect((failedEvent as any).error).toContain('Context window exceeded');
    } finally {
      await cleanupWorkspace(runId).catch(() => {});
    }
  });

  describe('prepare() with imageAttachment', () => {
    it('downloads image and writes to workspace when imageAttachment is provided', async () => {
      const runId = `test-img-${randomUUID()}`;
      const workspace = await createWorkspace(runId);

      try {
        const imageBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
        const imageDownloader = { downloadImage: vi.fn().mockResolvedValue(imageBuffer) };
        const adapterWithDownloader = new CodexAdapter({
          baseUrl: 'http://localhost:8080',
          apiKey: 'test-key',
          imageDownloader,
        });
        const spec = {
          ...makeSpec('task-img-1', '请分析这张图片'),
          context: {
            systemPrompt: '',
            recentTurns: [] as unknown[],
            imageAttachment: { imageKey: 'img_v2_abc', messageId: 'msg_001' },
          },
        };

        const handle = await adapterWithDownloader.prepare(spec, workspace);

        expect(imageDownloader.downloadImage).toHaveBeenCalledWith('msg_001', 'img_v2_abc');
        expect(handle.imagePaths).toEqual([join(workspace.workspacePath, 'image.png')]);
        const savedImage = await readFile(join(workspace.workspacePath, 'image.png'));
        expect(savedImage[0]).toBe(0x89);
        const taskMd = await readFile(join(workspace.workspacePath, 'TASK.md'), 'utf-8');
        expect(taskMd).toContain('Image: ./image.png (请分析这张图片)');
      } finally {
        await cleanupWorkspace(runId).catch(() => {});
      }
    });

    it('downloads file attachment and writes it to the workspace', async () => {
      const runId = `test-file-${randomUUID()}`;
      const workspace = await createWorkspace(runId);

      try {
        const fileBuffer = Buffer.from('%PDF test');
        const imageDownloader = {
          downloadImage: vi.fn(),
          downloadFile: vi.fn().mockResolvedValue(fileBuffer),
        };
        const adapterWithDownloader = new CodexAdapter({
          baseUrl: 'http://localhost:8080',
          apiKey: 'test-key',
          imageDownloader,
        });
        const spec = {
          ...makeSpec('task-file-1', '请分析这个文件'),
          context: {
            systemPrompt: '',
            recentTurns: [] as unknown[],
            fileAttachment: {
              resourceKey: 'file_v2_abc',
              messageId: 'msg_file_001',
              resourceType: 'file' as const,
              fileName: 'report.pdf',
              mimeType: 'application/pdf',
            },
          },
        };

        await adapterWithDownloader.prepare(spec, workspace);

        expect(imageDownloader.downloadFile).toHaveBeenCalledWith(
          'msg_file_001',
          'file_v2_abc',
          'file',
        );
        const savedFile = await readFile(
          join(workspace.workspacePath, 'attachments', 'file_v2_abc-report.pdf'),
          'utf-8',
        );
        expect(savedFile).toBe('%PDF test');
        const taskMd = await readFile(join(workspace.workspacePath, 'TASK.md'), 'utf-8');
        expect(taskMd).toContain('Attachment: ./attachments/file_v2_abc-report.pdf (report.pdf)');
      } finally {
        await cleanupWorkspace(runId).catch(() => {});
      }
    });

    it('does not overwrite workspace files with matching attachment names', async () => {
      const runId = `test-file-clobber-${randomUUID()}`;
      const workspace = await createWorkspace(runId);

      try {
        await writeFile(join(workspace.workspacePath, 'report.pdf'), 'existing workspace file');
        const imageDownloader = {
          downloadImage: vi.fn(),
          downloadFile: vi.fn().mockResolvedValue(Buffer.from('downloaded file')),
        };
        const adapterWithDownloader = new CodexAdapter({
          baseUrl: 'http://localhost:8080',
          apiKey: 'test-key',
          imageDownloader,
        });
        const spec = {
          ...makeSpec('task-file-clobber-1', '请分析这个文件'),
          context: {
            systemPrompt: '',
            recentTurns: [] as unknown[],
            fileAttachment: {
              resourceKey: 'file_v2_abc',
              messageId: 'msg_file_001',
              resourceType: 'file' as const,
              fileName: 'report.pdf',
              mimeType: 'application/pdf',
            },
          },
        };

        await adapterWithDownloader.prepare(spec, workspace);

        await expect(readFile(join(workspace.workspacePath, 'report.pdf'), 'utf-8')).resolves.toBe(
          'existing workspace file',
        );
        await expect(
          readFile(
            join(workspace.workspacePath, 'attachments', 'file_v2_abc-report.pdf'),
            'utf-8',
          ),
        ).resolves.toBe('downloaded file');
      } finally {
        await cleanupWorkspace(runId).catch(() => {});
      }
    });

    it('passes media attachment type to the downloader', async () => {
      const runId = `test-media-${randomUUID()}`;
      const workspace = await createWorkspace(runId);

      try {
        const imageDownloader = {
          downloadImage: vi.fn(),
          downloadFile: vi.fn().mockResolvedValue(Buffer.from('video bytes')),
        };
        const adapterWithDownloader = new CodexAdapter({
          baseUrl: 'http://localhost:8080',
          apiKey: 'test-key',
          imageDownloader,
        });
        const spec = {
          ...makeSpec('task-media-1', '请分析这个视频'),
          context: {
            systemPrompt: '',
            recentTurns: [] as unknown[],
            fileAttachment: {
              resourceKey: 'media_v2_abc',
              messageId: 'msg_media_001',
              resourceType: 'media' as const,
              fileName: 'demo.mp4',
              mimeType: 'video/mp4',
            },
          },
        };

        await adapterWithDownloader.prepare(spec, workspace);

        expect(imageDownloader.downloadFile).toHaveBeenCalledWith(
          'msg_media_001',
          'media_v2_abc',
          'media',
        );
      } finally {
        await cleanupWorkspace(runId).catch(() => {});
      }
    });

    it('records file attachment download failures in task context', async () => {
      const runId = `test-file-fail-${randomUUID()}`;
      const workspace = await createWorkspace(runId);

      try {
        const imageDownloader = {
          downloadImage: vi.fn(),
          downloadFile: vi.fn().mockRejectedValue(new Error('HTTP 403')),
        };
        const adapterWithDownloader = new CodexAdapter({
          baseUrl: 'http://localhost:8080',
          apiKey: 'test-key',
          imageDownloader,
        });
        const spec = {
          ...makeSpec('task-file-fail-1', '请分析这个文件'),
          context: {
            systemPrompt: '',
            recentTurns: [] as unknown[],
            fileAttachment: {
              resourceKey: 'file_v2_bad',
              messageId: 'msg_file_bad',
              resourceType: 'file' as const,
              fileName: 'report.pdf',
              mimeType: 'application/pdf',
            },
          },
        };

        await expect(adapterWithDownloader.prepare(spec, workspace)).resolves.toBeDefined();

        const taskMd = await readFile(join(workspace.workspacePath, 'TASK.md'), 'utf-8');
        expect(taskMd).toContain('Attachment download failed: report.pdf (HTTP 403)');
      } finally {
        await cleanupWorkspace(runId).catch(() => {});
      }
    });

    it('passes downloaded image to Codex SDK as structured input', async () => {
      const runId = `test-img-sdk-${randomUUID()}`;
      const workspace = await createWorkspace(runId);

      try {
        const imageBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
        const imageDownloader = { downloadImage: vi.fn().mockResolvedValue(imageBuffer) };
        const adapterWithDownloader = new CodexAdapter({
          baseUrl: 'http://localhost:8080',
          apiKey: 'test-key',
          imageDownloader,
        });
        const streamEvents = successEvents('看到了图片');
        mockRunStreamed.mockResolvedValue({ events: makeEventStream(streamEvents) });
        const spec = {
          ...makeSpec('task-img-sdk-1', '请分析这张图片'),
          context: {
            systemPrompt: '',
            recentTurns: [] as unknown[],
            imageAttachment: { imageKey: 'img_v2_abc', messageId: 'msg_001' },
          },
        };

        const handle = await adapterWithDownloader.prepare(spec, workspace);

        const events: RuntimeEvent[] = [];
        for await (const event of adapterWithDownloader.execute(handle, spec)) {
          events.push(event);
        }

        expect(mockRunStreamed).toHaveBeenCalledWith(
          [
            { type: 'text', text: '请分析这张图片' },
            { type: 'local_image', path: join(workspace.workspacePath, 'image.png') },
          ],
          expect.objectContaining({
            signal: expect.any(AbortSignal),
          }),
        );
        expect(events.find((event) => event.type === 'completed')).toBeDefined();
      } finally {
        await cleanupWorkspace(runId).catch(() => {});
      }
    });

    it('continues without image when download fails', async () => {
      const runId = `test-img-fail-${randomUUID()}`;
      const workspace = await createWorkspace(runId);

      try {
        const imageDownloader = { downloadImage: vi.fn().mockRejectedValue(new Error('HTTP 403')) };
        const adapterWithDownloader = new CodexAdapter({
          baseUrl: 'http://localhost:8080',
          apiKey: 'test-key',
          imageDownloader,
        });
        const spec = {
          ...makeSpec('task-img-fail-1', '请分析这张图片'),
          context: {
            systemPrompt: '',
            recentTurns: [] as unknown[],
            imageAttachment: { imageKey: 'img_v2_bad', messageId: 'msg_fail' },
          },
        };

        const handle = await adapterWithDownloader.prepare(spec, workspace);
        expect(handle.imagePaths).toBeUndefined();
        const taskMd = await readFile(join(workspace.workspacePath, 'TASK.md'), 'utf-8');
        expect(taskMd).not.toContain('Image:');
      } finally {
        await cleanupWorkspace(runId).catch(() => {});
      }
    });

    it('uses detected image extension when downloaded image is not PNG', async () => {
      const runId = `test-img-jpeg-${randomUUID()}`;
      const workspace = await createWorkspace(runId);

      try {
        const imageBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xdb]);
        const imageDownloader = { downloadImage: vi.fn().mockResolvedValue(imageBuffer) };
        const adapterWithDownloader = new CodexAdapter({
          baseUrl: 'http://localhost:8080',
          apiKey: 'test-key',
          imageDownloader,
        });
        const spec = {
          ...makeSpec('task-img-jpeg-1', '请分析这张图片'),
          context: {
            systemPrompt: '',
            recentTurns: [] as unknown[],
            imageAttachment: { imageKey: 'img_v2_jpeg', messageId: 'msg_jpeg' },
          },
        };

        const handle = await adapterWithDownloader.prepare(spec, workspace);

        expect(handle.imagePaths).toEqual([join(workspace.workspacePath, 'image.jpg')]);
        const savedImage = await readFile(join(workspace.workspacePath, 'image.jpg'));
        expect(savedImage[0]).toBe(0xff);
        const taskMd = await readFile(join(workspace.workspacePath, 'TASK.md'), 'utf-8');
        expect(taskMd).toContain('Image: ./image.jpg (请分析这张图片)');
      } finally {
        await cleanupWorkspace(runId).catch(() => {});
      }
    });
  });

  it('emits progress events for command executions', async () => {
    const runId = `test-${randomUUID()}`;
    const workspace = await createWorkspace(runId);

    try {
      const streamEvents = [
        { type: 'thread.started', thread_id: 'thread-123' },
        { type: 'turn.started' },
        {
          type: 'item.started',
          item: {
            id: 'c1',
            type: 'command_execution',
            command: 'pnpm build',
            aggregated_output: '',
            status: 'in_progress',
          },
        },
        {
          type: 'item.completed',
          item: {
            id: 'c1',
            type: 'command_execution',
            command: 'pnpm build',
            aggregated_output: '',
            exit_code: 0,
            status: 'completed',
          },
        },
        {
          type: 'item.started',
          item: {
            id: 'c2',
            type: 'command_execution',
            command: 'pnpm test',
            aggregated_output: '',
            status: 'in_progress',
          },
        },
        {
          type: 'item.completed',
          item: {
            id: 'c2',
            type: 'command_execution',
            command: 'pnpm test',
            aggregated_output: '',
            exit_code: 0,
            status: 'completed',
          },
        },
        {
          type: 'item.started',
          item: {
            id: 'fc1',
            type: 'file_change',
            changes: [{ path: 'src/index.ts', kind: 'update' }],
            status: 'completed',
          },
        },
        {
          type: 'item.completed',
          item: {
            id: 'fc1',
            type: 'file_change',
            changes: [{ path: 'src/index.ts', kind: 'update' }],
            status: 'completed',
          },
        },
        { type: 'item.completed', item: { id: 'msg-1', type: 'agent_message', text: 'Done' } },
        {
          type: 'turn.completed',
          usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 50 },
        },
      ];
      mockRunStreamed.mockResolvedValue({ events: makeEventStream(streamEvents) });

      const spec = makeSpec('task-progress-1', 'build and test');
      const handle = await adapter.prepare(spec, workspace);

      const events: RuntimeEvent[] = [];
      for await (const event of adapter.execute(handle, spec)) {
        events.push(event);
      }

      const progressEvents = events.filter((e) => e.type === 'progress');
      // Should have: initial 10%, pnpm build (18%), pnpm test (21%), file change, collecting 90%
      expect(progressEvents.length).toBeGreaterThanOrEqual(4);
      // First progress is 10% initial
      expect((progressEvents[0] as any).percent).toBe(10);
      // Command progress should include command preview
      const buildProgress = progressEvents.find((e) => (e as any).message?.includes('pnpm build'));
      expect(buildProgress).toBeDefined();
    } finally {
      await cleanupWorkspace(runId).catch(() => {});
    }
  });

  it('emits reasoning events from streamed reasoning items', async () => {
    const runId = `test-${randomUUID()}`;
    const workspace = await createWorkspace(runId);

    try {
      const streamEvents = [
        { type: 'thread.started', thread_id: 'thread-123' },
        { type: 'turn.started' },
        {
          type: 'item.updated',
          item: { id: 'r1', type: 'reasoning', text: 'Inspecting worker feedback flow' },
        },
        { type: 'item.completed', item: { id: 'msg-1', type: 'agent_message', text: 'Done' } },
        {
          type: 'turn.completed',
          usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 50 },
        },
      ];
      mockRunStreamed.mockResolvedValue({ events: makeEventStream(streamEvents) });

      const spec = makeSpec('task-reasoning-1', 'inspect streaming updates');
      const handle = await adapter.prepare(spec, workspace);

      const events: RuntimeEvent[] = [];
      for await (const event of adapter.execute(handle, spec)) {
        events.push(event);
      }

      expect(events).toContainEqual({
        type: 'reasoning',
        summary: 'Inspecting worker feedback flow',
      });
    } finally {
      await cleanupWorkspace(runId).catch(() => {});
    }
  });

  it('emits reasoning events for reasoning-only turns before any tool call starts', async () => {
    const runId = `test-${randomUUID()}`;
    const workspace = await createWorkspace(runId);

    try {
      const streamEvents = [
        { type: 'thread.started', thread_id: 'thread-123' },
        { type: 'turn.started' },
        {
          type: 'item.started',
          item: { id: 'r1', type: 'reasoning', text: 'Reviewing proposal and test cases' },
        },
        { type: 'item.completed', item: { id: 'msg-1', type: 'agent_message', text: 'Done' } },
        {
          type: 'turn.completed',
          usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 50 },
        },
      ];
      mockRunStreamed.mockResolvedValue({ events: makeEventStream(streamEvents) });

      const spec = makeSpec('task-reasoning-only-1', 'inspect streaming updates');
      const handle = await adapter.prepare(spec, workspace);

      const events: RuntimeEvent[] = [];
      for await (const event of adapter.execute(handle, spec)) {
        events.push(event);
      }

      expect(events).toContainEqual({
        type: 'reasoning',
        summary: 'Reviewing proposal and test cases',
      });
    } finally {
      await cleanupWorkspace(runId).catch(() => {});
    }
  });

  it('preserves reasoning updates between command progress events', async () => {
    const runId = `test-${randomUUID()}`;
    const workspace = await createWorkspace(runId);

    try {
      const streamEvents = [
        { type: 'thread.started', thread_id: 'thread-123' },
        { type: 'turn.started' },
        {
          type: 'item.started',
          item: {
            id: 'cmd-1',
            type: 'command_execution',
            command: 'pnpm build',
            aggregated_output: '',
            status: 'in_progress',
          },
        },
        {
          type: 'item.updated',
          item: {
            id: 'r1',
            type: 'reasoning',
            text: 'Checking failing tests before editing files',
          },
        },
        {
          type: 'item.started',
          item: {
            id: 'cmd-2',
            type: 'command_execution',
            command: 'pnpm test',
            aggregated_output: '',
            status: 'in_progress',
          },
        },
        { type: 'item.completed', item: { id: 'msg-1', type: 'agent_message', text: 'Done' } },
        {
          type: 'turn.completed',
          usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 50 },
        },
      ];
      mockRunStreamed.mockResolvedValue({ events: makeEventStream(streamEvents) });

      const spec = makeSpec('task-reasoning-interleaved-1', 'inspect streaming updates');
      const handle = await adapter.prepare(spec, workspace);

      const events: RuntimeEvent[] = [];
      for await (const event of adapter.execute(handle, spec)) {
        events.push(event);
      }

      const condensed = events
        .filter((event) => event.type === 'progress' || event.type === 'reasoning')
        .map((event) =>
          event.type === 'progress' ? `progress:${event.message}` : `reasoning:${event.summary}`,
        );

      expect(condensed).toContain('reasoning:Checking failing tests before editing files');
      expect(condensed.indexOf('progress:Running: pnpm build')).toBeLessThan(
        condensed.indexOf('reasoning:Checking failing tests before editing files'),
      );
      expect(
        condensed.indexOf('reasoning:Checking failing tests before editing files'),
      ).toBeLessThan(condensed.indexOf('progress:Running: pnpm test'));
    } finally {
      await cleanupWorkspace(runId).catch(() => {});
    }
  });

  it('drops blank reasoning payloads', async () => {
    const runId = `test-${randomUUID()}`;
    const workspace = await createWorkspace(runId);

    try {
      const streamEvents = [
        { type: 'thread.started', thread_id: 'thread-123' },
        { type: 'turn.started' },
        { type: 'item.updated', item: { id: 'r1', type: 'reasoning', text: '   \n   ' } },
        { type: 'item.completed', item: { id: 'msg-1', type: 'agent_message', text: 'Done' } },
        {
          type: 'turn.completed',
          usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 50 },
        },
      ];
      mockRunStreamed.mockResolvedValue({ events: makeEventStream(streamEvents) });

      const spec = makeSpec('task-reasoning-empty-1', 'inspect streaming updates');
      const handle = await adapter.prepare(spec, workspace);

      const events: RuntimeEvent[] = [];
      for await (const event of adapter.execute(handle, spec)) {
        events.push(event);
      }

      expect(events.find((event) => event.type === 'reasoning')).toBeUndefined();
    } finally {
      await cleanupWorkspace(runId).catch(() => {});
    }
  });

  it('emits at most one reasoning event per identical item lifecycle payload', async () => {
    const runId = `test-${randomUUID()}`;
    const workspace = await createWorkspace(runId);

    try {
      const streamEvents = [
        { type: 'thread.started', thread_id: 'thread-123' },
        { type: 'turn.started' },
        {
          type: 'item.started',
          item: { id: 'r1', type: 'reasoning', text: 'Reviewing worker pipeline' },
        },
        {
          type: 'item.updated',
          item: { id: 'r1', type: 'reasoning', text: 'Reviewing worker pipeline' },
        },
        {
          type: 'item.completed',
          item: { id: 'r1', type: 'reasoning', text: 'Reviewing worker pipeline' },
        },
        { type: 'item.completed', item: { id: 'msg-1', type: 'agent_message', text: 'Done' } },
        {
          type: 'turn.completed',
          usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 50 },
        },
      ];
      mockRunStreamed.mockResolvedValue({ events: makeEventStream(streamEvents) });

      const spec = makeSpec('task-reasoning-dedupe-1', 'inspect streaming updates');
      const handle = await adapter.prepare(spec, workspace);

      const events: RuntimeEvent[] = [];
      for await (const event of adapter.execute(handle, spec)) {
        events.push(event);
      }

      expect(
        events.filter(
          (event) => event.type === 'reasoning' && event.summary === 'Reviewing worker pipeline',
        ),
      ).toHaveLength(1);
    } finally {
      await cleanupWorkspace(runId).catch(() => {});
    }
  });

  it('passes resume thread ID to SDK', async () => {
    const runId = `test-${randomUUID()}`;
    const workspace = await createWorkspace(runId);

    try {
      const streamEvents = successEvents('继续上次的对话。', {
        input_tokens: 50,
        cached_input_tokens: 0,
        output_tokens: 20,
      });
      mockRunStreamed.mockResolvedValue({ events: makeEventStream(streamEvents) });

      const events: RuntimeEvent[] = [];
      for await (const event of adapter.resume('thread-old-123', '继续', workspace)) {
        events.push(event);
      }

      // Verify resumeThread was called with the correct thread ID
      expect(mockResumeThread).toHaveBeenCalledTimes(1);
      expect(mockResumeThread).toHaveBeenCalledWith(
        'thread-old-123',
        expect.objectContaining({
          workingDirectory: workspace.workspacePath,
          sandboxMode: 'danger-full-access',
          skipGitRepoCheck: true,
        }),
      );

      // Verify runStreamed was called with the prompt
      expect(mockRunStreamed).toHaveBeenCalledWith(
        '继续',
        expect.objectContaining({
          signal: expect.any(AbortSignal),
        }),
      );

      const completedEvent = events.find((e) => e.type === 'completed');
      expect(completedEvent).toBeDefined();
      expect((completedEvent as any).result.output.text).toContain('继续');
    } finally {
      await cleanupWorkspace(runId).catch(() => {});
    }
  });

  it('passes correct SDK options (model, cwd, sandboxMode)', async () => {
    const runId = `test-${randomUUID()}`;
    const workspace = await createWorkspace(runId);

    try {
      const streamEvents = successEvents('ok');
      mockRunStreamed.mockResolvedValue({ events: makeEventStream(streamEvents) });

      const spec = makeSpec('task-opts-1', 'test');
      const handle = await adapter.prepare(spec, workspace);

      const events: RuntimeEvent[] = [];
      for await (const event of adapter.execute(handle, spec)) {
        events.push(event);
      }

      // Verify startThread was called with correct options
      expect(mockStartThread).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'codex-mini',
          workingDirectory: workspace.workspacePath,
          sandboxMode: 'danger-full-access',
          skipGitRepoCheck: true,
        }),
      );

      // When usage has zeros, metrics should be 0
      const completedEvent = events.find((e) => e.type === 'completed');
      expect((completedEvent as any).result.metrics.tokenIn).toBe(0);
      expect((completedEvent as any).result.metrics.tokenOut).toBe(0);
    } finally {
      await cleanupWorkspace(runId).catch(() => {});
    }
  });

  it('keeps full sandbox access for readonly turns so inspection commands can run', async () => {
    const runId = `test-${randomUUID()}`;
    const workspace = await createWorkspace(runId);
    workspace.readOnly = true;

    try {
      const streamEvents = successEvents('ok');
      mockRunStreamed.mockResolvedValue({ events: makeEventStream(streamEvents) });

      const spec = makeSpec('task-readonly-1', 'inspect project');
      const handle = await adapter.prepare(spec, workspace);

      const events: RuntimeEvent[] = [];
      for await (const event of adapter.execute(handle, spec)) {
        events.push(event);
      }

      expect(mockStartThread).toHaveBeenCalledWith(
        expect.objectContaining({
          workingDirectory: workspace.workspacePath,
          sandboxMode: 'danger-full-access',
        }),
      );
      expect(events.some((event) => event.type === 'completed')).toBe(true);
    } finally {
      await cleanupWorkspace(runId).catch(() => {});
    }
  });

  it('forces raw agent reasoning off in the Codex SDK config', async () => {
    const runId = `test-${randomUUID()}`;
    const workspace = await createWorkspace(runId);

    try {
      const streamEvents = successEvents('ok');
      mockRunStreamed.mockResolvedValue({ events: makeEventStream(streamEvents) });

      const spec = makeSpec('task-safe-reasoning-1', 'test');
      const handle = await adapter.prepare(spec, workspace);

      const events: RuntimeEvent[] = [];
      for await (const event of adapter.execute(handle, spec)) {
        events.push(event);
      }

      expect(mockCodexCtor).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            show_raw_agent_reasoning: false,
          }),
        }),
      );
      expect(events.find((event) => event.type === 'completed')).toBeDefined();
    } finally {
      await cleanupWorkspace(runId).catch(() => {});
    }
  });

  it('prepends workflow instructions to execute prompts when provided', async () => {
    const runId = `test-${randomUUID()}`;
    const workspace = await createWorkspace(runId);

    try {
      const streamEvents = successEvents('ok');
      mockRunStreamed.mockResolvedValue({ events: makeEventStream(streamEvents) });

      const spec = makeSpec('task-prompt-1', '实现 self-dev codex runtime');
      const handle = await adapter.prepare(spec, workspace);

      const events: RuntimeEvent[] = [];
      for await (const event of adapter.execute(handle, spec, 'SELF DEV WORKFLOW')) {
        events.push(event);
      }

      expect(mockRunStreamed).toHaveBeenCalledWith(
        expect.stringContaining('SELF DEV WORKFLOW'),
        expect.objectContaining({
          signal: expect.any(AbortSignal),
        }),
      );
      expect(mockRunStreamed).toHaveBeenCalledWith(
        expect.stringContaining(
          '<current_request>\n实现 self-dev codex runtime\n</current_request>',
        ),
        expect.any(Object),
      );
      expect(events.find((e) => e.type === 'completed')).toBeDefined();
    } finally {
      await cleanupWorkspace(runId).catch(() => {});
    }
  });

  it('prepends workflow instructions to resume prompts when provided', async () => {
    const runId = `test-${randomUUID()}`;
    const workspace = await createWorkspace(runId);

    try {
      const streamEvents = successEvents('继续完成 self-dev', {
        input_tokens: 20,
        cached_input_tokens: 0,
        output_tokens: 10,
      });
      mockRunStreamed.mockResolvedValue({ events: makeEventStream(streamEvents) });

      const events: RuntimeEvent[] = [];
      for await (const event of adapter.resume(
        'thread-old-123',
        '继续修复 critical 问题',
        workspace,
        'SELF DEV WORKFLOW',
      )) {
        events.push(event);
      }

      expect(mockRunStreamed).toHaveBeenCalledWith(
        expect.stringContaining('SELF DEV WORKFLOW'),
        expect.objectContaining({
          signal: expect.any(AbortSignal),
        }),
      );
      expect(mockRunStreamed).toHaveBeenCalledWith(
        expect.stringContaining('<current_request>\n继续修复 critical 问题\n</current_request>'),
        expect.any(Object),
      );
      expect(events.find((e) => e.type === 'completed')).toBeDefined();
    } finally {
      await cleanupWorkspace(runId).catch(() => {});
    }
  });

  it('passes resumed image paths to Codex SDK as structured input', async () => {
    const runId = `test-resume-img-${randomUUID()}`;
    const workspace = await createWorkspace(runId);

    try {
      const streamEvents = successEvents('看到了图片', {
        input_tokens: 20,
        cached_input_tokens: 0,
        output_tokens: 10,
      });
      mockRunStreamed.mockResolvedValue({ events: makeEventStream(streamEvents) });

      const events: RuntimeEvent[] = [];
      for await (const event of adapter.resume(
        'thread-old-123',
        '继续分析这张图片',
        workspace,
        undefined,
        {
          executionId: 'resume-img-task-1',
          imagePaths: [join(workspace.workspacePath, 'image.png')],
        },
      )) {
        events.push(event);
      }

      expect(mockRunStreamed).toHaveBeenCalledWith(
        [
          { type: 'text', text: '继续分析这张图片' },
          { type: 'local_image', path: join(workspace.workspacePath, 'image.png') },
        ],
        expect.objectContaining({
          signal: expect.any(AbortSignal),
        }),
      );
      expect(events.find((event) => event.type === 'completed')).toBeDefined();
    } finally {
      await cleanupWorkspace(runId).catch(() => {});
    }
  });

  it('does not double-wrap already structured prompts', async () => {
    const runId = `test-${randomUUID()}`;
    const workspace = await createWorkspace(runId);

    try {
      const streamEvents = successEvents('ok');
      mockRunStreamed.mockResolvedValue({ events: makeEventStream(streamEvents) });

      const spec = makeSpec('task-structured-1', 'plain fallback');
      const handle = await adapter.prepare(spec, workspace);
      const structuredPrompt = [
        '<session_memory>',
        'summary',
        '</session_memory>',
        '',
        '<conversation_history>',
        '<turn role="user">hi</turn>',
        '</conversation_history>',
        '',
        '<current_request>',
        '继续修复 critical 问题',
        '</current_request>',
      ].join('\n');

      const events: RuntimeEvent[] = [];
      for await (const event of adapter.execute(
        handle,
        { ...spec, goal: structuredPrompt },
        'SELF DEV WORKFLOW',
      )) {
        events.push(event);
      }

      expect(mockRunStreamed).toHaveBeenCalledWith(
        `SELF DEV WORKFLOW\n\n${structuredPrompt}`,
        expect.objectContaining({
          signal: expect.any(AbortSignal),
        }),
      );
      expect(events.find((e) => e.type === 'completed')).toBeDefined();
    } finally {
      await cleanupWorkspace(runId).catch(() => {});
    }
  });

  it('cancel aborts the SDK turn via AbortController', async () => {
    const runId = `test-${randomUUID()}`;
    const workspace = await createWorkspace(runId);

    try {
      let capturedSignal: AbortSignal | undefined;
      mockRunStreamed.mockImplementation((_input: any, opts: any) => {
        capturedSignal = opts?.signal;
        // Return a stream that hangs until aborted
        return new Promise((_, reject) => {
          opts?.signal?.addEventListener('abort', () => reject(new Error('Aborted')));
        });
      });

      const spec = makeSpec('task-cancel-1', 'long task');
      const handle = await adapter.prepare(spec, workspace);

      const eventsPromise = (async () => {
        const events: RuntimeEvent[] = [];
        for await (const event of adapter.execute(handle, spec)) {
          events.push(event);
        }
        return events;
      })();

      // Wait for the mock to be called
      await new Promise((r) => setTimeout(r, 50));

      expect(capturedSignal).toBeDefined();
      expect(capturedSignal!.aborted).toBe(false);

      await adapter.cancel('task-cancel-1');
      expect(capturedSignal!.aborted).toBe(true);

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
      const signals: AbortSignal[] = [];
      mockRunStreamed.mockImplementation((_input: any, opts: any) => {
        signals.push(opts?.signal);
        if (signals.length === 1) {
          return Promise.resolve({ events: makeEventStream(successEvents('first resume done')) });
        }

        return new Promise((_, reject) => {
          opts?.signal?.addEventListener('abort', () => reject(new Error('Aborted')));
        });
      });

      const firstEvents: RuntimeEvent[] = [];
      for await (const event of adapter.resume(
        'thread-old-123',
        'continue first',
        workspace,
        undefined,
        { executionId: 'same-task-id' },
      )) {
        firstEvents.push(event);
      }

      expect(firstEvents.find((e) => e.type === 'completed')).toBeDefined();
      expect(signals).toHaveLength(1);
      expect(signals[0]!.aborted).toBe(false);

      const secondEventsPromise = (async () => {
        const events: RuntimeEvent[] = [];
        for await (const event of adapter.resume(
          'thread-old-123',
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

      expect(signals).toHaveLength(2);
      expect(signals[0]!.aborted).toBe(false);
      expect(signals[1]!.aborted).toBe(false);

      await adapter.cancel('same-task-id');

      expect(signals[0]!.aborted).toBe(false);
      expect(signals[1]!.aborted).toBe(true);

      const secondEvents = await secondEventsPromise;
      const failedEvent = secondEvents.find((e) => e.type === 'failed');
      expect(failedEvent).toBeDefined();
      expect((failedEvent as any).reason).toBe('cancelled');
    } finally {
      await cleanupWorkspace(runId).catch(() => {});
    }
  });

  it('cancel aborts resumed SDK turn by provided execution id', async () => {
    const runId = `test-${randomUUID()}`;
    const workspace = await createWorkspace(runId);

    try {
      let capturedSignal: AbortSignal | undefined;
      mockRunStreamed.mockImplementation((_input: any, opts: any) => {
        capturedSignal = opts?.signal;
        return new Promise((_, reject) => {
          opts?.signal?.addEventListener('abort', () => reject(new Error('Aborted')));
        });
      });

      const eventsPromise = (async () => {
        const events: RuntimeEvent[] = [];
        for await (const event of adapter.resume(
          'thread-old-123',
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

      expect(capturedSignal).toBeDefined();
      expect(capturedSignal!.aborted).toBe(false);

      await adapter.cancel('resume-task-1');
      expect(capturedSignal!.aborted).toBe(true);

      const events = await eventsPromise;
      const failedEvent = events.find((e) => e.type === 'failed');
      expect(failedEvent).toBeDefined();
      expect((failedEvent as any).error).toContain('Aborted');
    } finally {
      await cleanupWorkspace(runId).catch(() => {});
    }
  });

  it('cancelAll aborts all active executions', async () => {
    const runId = `test-${randomUUID()}`;
    const workspace = await createWorkspace(runId);

    try {
      let capturedSignal: AbortSignal | undefined;
      mockRunStreamed.mockImplementation((_input: any, opts: any) => {
        capturedSignal = opts?.signal;
        return new Promise((_, reject) => {
          opts?.signal?.addEventListener('abort', () => reject(new Error('Aborted')));
        });
      });

      const spec = makeSpec('task-cancelall-1', 'long task');
      const handle = await adapter.prepare(spec, workspace);

      const eventsPromise = (async () => {
        const events: RuntimeEvent[] = [];
        for await (const event of adapter.execute(handle, spec)) {
          events.push(event);
        }
        return events;
      })();

      await new Promise((r) => setTimeout(r, 50));
      expect(capturedSignal!.aborted).toBe(false);

      adapter.cancelAll();
      expect(capturedSignal!.aborted).toBe(true);

      const events = await eventsPromise;
      expect(events.find((e) => e.type === 'failed')).toBeDefined();
    } finally {
      await cleanupWorkspace(runId).catch(() => {});
    }
  });

  it('times out after configured timeout', async () => {
    const runId = `test-${randomUUID()}`;
    const workspace = await createWorkspace(runId);

    // Create adapter with very short timeout for testing
    const shortTimeoutAdapter = new CodexAdapter({
      baseUrl: 'http://localhost:8080',
      apiKey: 'test-key',
      model: 'codex-mini',
      timeoutMs: 100, // 100ms timeout
    });

    try {
      mockRunStreamed.mockImplementation((_input: any, opts: any) => {
        // Return a promise that rejects when aborted (simulates SDK behavior
        // where spawn() receives the signal and kills the child process)
        return new Promise((_, reject) => {
          opts?.signal?.addEventListener('abort', () =>
            reject(new Error('The operation was aborted')),
          );
        });
      });

      const spec = makeSpec('task-timeout-1', 'slow task');
      const handle = await shortTimeoutAdapter.prepare(spec, workspace);

      const events: RuntimeEvent[] = [];
      for await (const event of shortTimeoutAdapter.execute(handle, spec)) {
        events.push(event);
      }

      const failedEvent = events.find((e) => e.type === 'failed');
      expect(failedEvent).toBeDefined();
      expect((failedEvent as any).error).toContain('timed out');
    } finally {
      await cleanupWorkspace(runId).catch(() => {});
    }
  }, 10000);

  it('classifies execution timeout as timeout even without "abort" in the error text', async () => {
    const runId = `test-${randomUUID()}`;
    const workspace = await createWorkspace(runId);

    const shortTimeoutAdapter = new CodexAdapter({
      baseUrl: 'http://localhost:8080',
      apiKey: 'test-key',
      model: 'codex-mini',
      timeoutMs: 100,
    });

    try {
      mockRunStreamed.mockImplementation((_input: any, opts: any) => {
        // A real child killed by the restored spawn-signal path surfaces
        // messages like "Codex Exec exited with signal SIGTERM" — no "abort".
        return new Promise((_, reject) => {
          opts?.signal?.addEventListener('abort', () =>
            reject(new Error('Codex Exec exited with signal SIGTERM: ')),
          );
        });
      });

      const spec = makeSpec('task-timeout-2', 'slow task');
      const handle = await shortTimeoutAdapter.prepare(spec, workspace);

      const events: RuntimeEvent[] = [];
      for await (const event of shortTimeoutAdapter.execute(handle, spec)) {
        events.push(event);
      }

      const failedEvent = events.find((e) => e.type === 'failed') as any;
      expect(failedEvent).toBeDefined();
      expect(failedEvent.error).toContain('timed out');
      expect(failedEvent.reason).toBeUndefined();
    } finally {
      await cleanupWorkspace(runId).catch(() => {});
    }
  }, 10000);

  it('completes after turn.completed even if the SDK stream stays open', async () => {
    const runId = `test-${randomUUID()}`;
    const workspace = await createWorkspace(runId);

    try {
      async function* lingeringEvents() {
        yield { type: 'thread.started', thread_id: 'thread-123' };
        yield { type: 'turn.started' };
        yield {
          type: 'item.completed',
          item: { id: 'msg-1', type: 'agent_message', text: 'Done' },
        };
        yield {
          type: 'turn.completed',
          usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 },
        };
        await new Promise(() => {});
      }

      mockRunStreamed.mockResolvedValue({ events: lingeringEvents() });

      const spec = makeSpec('task-stream-complete-1', 'finish despite lingering stream');
      const handle = await adapter.prepare(spec, workspace);

      const events = await Promise.race([
        (async () => {
          const out: RuntimeEvent[] = [];
          for await (const event of adapter.execute(handle, spec)) {
            out.push(event);
          }
          return out;
        })(),
        new Promise<RuntimeEvent[]>((_, reject) =>
          setTimeout(() => reject(new Error('adapter hung after turn.completed')), 500),
        ),
      ]);

      const completedEvent = events.find((e) => e.type === 'completed');
      expect(completedEvent).toBeDefined();
      expect((completedEvent as any).result.output.text).toBe('Done');
    } finally {
      await cleanupWorkspace(runId).catch(() => {});
    }
  });

  it('aborts and fails when runStreamed does not resolve within startupTimeoutMs', async () => {
    const runId = `test-${randomUUID()}`;
    const workspace = await createWorkspace(runId);
    const startupTimeoutAdapter = new CodexAdapter({
      baseUrl: 'http://localhost:8080',
      apiKey: 'test-key',
      model: 'codex-mini',
      startupTimeoutMs: 100, // very short for test
    });

    try {
      // runStreamed hangs forever — simulates TCP SYN_SENT
      mockRunStreamed.mockImplementation(
        (_input: any, opts: any) =>
          new Promise((_, reject) => {
            opts?.signal?.addEventListener('abort', () =>
              reject(new Error('The operation was aborted')),
            );
          }),
      );

      const spec = makeSpec('task-startup-timeout-1', 'slow connect');
      const handle = await startupTimeoutAdapter.prepare(spec, workspace);

      const events: RuntimeEvent[] = [];
      for await (const event of startupTimeoutAdapter.execute(handle, spec)) {
        events.push(event);
      }

      const failedEvent = events.find((e) => e.type === 'failed');
      expect(failedEvent).toBeDefined();
      expect((failedEvent as any).error).toContain('startup timed out');
    } finally {
      await cleanupWorkspace(runId).catch(() => {});
    }
  }, 10000);

  it('clears startup timer when runStreamed resolves normally', async () => {
    const runId = `test-${randomUUID()}`;
    const workspace = await createWorkspace(runId);
    const startupTimeoutAdapter = new CodexAdapter({
      baseUrl: 'http://localhost:8080',
      apiKey: 'test-key',
      model: 'codex-mini',
      startupTimeoutMs: 5000, // generous — resolves fast
    });

    try {
      const streamEvents = successEvents('done');
      mockRunStreamed.mockResolvedValue({ events: makeEventStream(streamEvents) });

      const spec = makeSpec('task-startup-ok-1', 'quick connect');
      const handle = await startupTimeoutAdapter.prepare(spec, workspace);

      const events: RuntimeEvent[] = [];
      for await (const event of startupTimeoutAdapter.execute(handle, spec)) {
        events.push(event);
      }

      const completedEvent = events.find((e) => e.type === 'completed');
      expect(completedEvent).toBeDefined();
      // If timer was not cleared, the abort would fire 5s later and cause side effects
      // The test completing cleanly is the signal that the timer was cleared
    } finally {
      await cleanupWorkspace(runId).catch(() => {});
    }
  });

  it('fails fast when the SDK stream goes idle for too long', async () => {
    const runId = `test-${randomUUID()}`;
    const workspace = await createWorkspace(runId);
    const idleTimeoutAdapter = new CodexAdapter({
      baseUrl: 'http://localhost:8080',
      apiKey: 'test-key',
      model: 'codex-mini',
      idleTimeoutMs: 50,
    });

    try {
      async function* stalledEvents() {
        yield { type: 'thread.started', thread_id: 'thread-123' };
        yield { type: 'turn.started' };
        await new Promise(() => {});
      }

      mockRunStreamed.mockResolvedValue({ events: stalledEvents() });

      const spec = makeSpec('task-idle-timeout-1', 'stalled task');
      const handle = await idleTimeoutAdapter.prepare(spec, workspace);

      const events: RuntimeEvent[] = [];
      for await (const event of idleTimeoutAdapter.execute(handle, spec)) {
        events.push(event);
      }

      const failedEvent = events.find((e) => e.type === 'failed');
      expect(failedEvent).toBeDefined();
      expect((failedEvent as any).error).toContain('stalled');
    } finally {
      await cleanupWorkspace(runId).catch(() => {});
    }
  });
});

describe('prependPathDirs (SDK 0.137 vendor PATH preservation)', () => {
  const posix: NodeJS.Platform = 'linux';

  it('prepends vendor dirs ahead of the existing PATH', () => {
    const env: Record<string, string> = { PATH: '/usr/bin:/bin' };
    prependPathDirs(env, ['/vendor/codex-path'], posix);
    expect(env.PATH).toBe('/vendor/codex-path:/usr/bin:/bin');
  });

  it('de-duplicates a vendor dir already present in PATH', () => {
    const env: Record<string, string> = { PATH: '/usr/bin:/vendor/codex-path:/bin' };
    prependPathDirs(env, ['/vendor/codex-path'], posix);
    expect(env.PATH).toBe('/vendor/codex-path:/usr/bin:/bin');
  });

  it('handles an empty/absent PATH', () => {
    const env: Record<string, string> = {};
    prependPathDirs(env, ['/vendor/codex-path'], posix);
    expect(env.PATH).toBe('/vendor/codex-path');
  });

  it('on win32 collapses path-like keys into the canonical one', () => {
    const env: Record<string, string> = { Path: 'C:\\bin', PATH: 'C:\\other' };
    prependPathDirs(env, ['C:\\vendor'], 'win32');
    // 'Path' is the canonical key; the stray 'PATH' is removed.
    expect(env.Path.startsWith('C:\\vendor')).toBe(true);
    expect(env.PATH).toBeUndefined();
  });
});
