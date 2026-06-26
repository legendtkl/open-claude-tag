import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { TaskStatus, UserRole } from '@open-tag/core-types';

const {
  getUserRoleMock,
  transitionTaskMock,
  execMock,
  cleanWorktreesMock,
  cleanAllWorktreesMock,
  removeWorktreeByIdMock,
  closeSessionMock,
  createStorageAgentCommandServicesMock,
  handleAgentCommandMock,
} = vi.hoisted(() => ({
  getUserRoleMock: vi.fn(),
  transitionTaskMock: vi.fn(),
  execMock: vi.fn(),
  cleanWorktreesMock: vi.fn(),
  cleanAllWorktreesMock: vi.fn(),
  removeWorktreeByIdMock: vi.fn(),
  closeSessionMock: vi.fn(),
  createStorageAgentCommandServicesMock: vi.fn(),
  handleAgentCommandMock: vi.fn(),
}));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    exec: execMock,
  };
});

vi.mock('@open-tag/approval', () => ({
  getUserRole: getUserRoleMock,
}));

vi.mock('@open-tag/orchestrator', () => ({
  transitionTask: transitionTaskMock,
}));

vi.mock('@open-tag/registry', () => ({
  createStorageAgentCommandServices: createStorageAgentCommandServicesMock,
  handleAgentCommand: handleAgentCommandMock,
}));

vi.mock('../worktree-cleanup.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../worktree-cleanup.js')>();
  return {
    ...actual,
    cleanWorktrees: cleanWorktreesMock,
    cleanAllWorktrees: cleanAllWorktreesMock,
    removeWorktreeById: removeWorktreeByIdMock,
  };
});

vi.mock('@open-tag/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@open-tag/session')>();
  return { ...actual, closeSession: closeSessionMock };
});

import { createSlashCommandHandler } from '../slash-command-handler.js';

function makeDbStub(
  selectResults: unknown[] = [[{ sdkSessionId: null, runtimeBackend: 'codex' }]],
) {
  const insertedTasks: Record<string, unknown>[] = [];
  const insertedRows: Record<string, unknown>[] = [];
  const upserts: Array<{ values: Record<string, unknown>; set: Record<string, unknown> }> = [];
  const remainingResults = [...selectResults];
  const takeNext = () => (remainingResults.shift() as unknown[]) ?? [];

  const selectChain = {
    from: () => selectChain,
    leftJoin: () => selectChain,
    innerJoin: () => selectChain,
    where: () => selectChain,
    orderBy: () => selectChain,
    limit: async () => takeNext(),
    then: (resolve: (value: unknown[]) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(takeNext()).then(resolve, reject),
  };

  return {
    select: vi.fn(() => selectChain),
    insert: vi.fn(() => ({
      values: vi.fn((row: Record<string, unknown>) => {
        insertedRows.push(row);
        if (row.taskType) insertedTasks.push(row);
        return {
          onConflictDoUpdate: vi.fn(async ({ set }: { set: Record<string, unknown> }) => {
            upserts.push({ values: row, set });
          }),
          returning: vi.fn(async () => [row]),
        };
      }),
    })),
    _insertedTasks: insertedTasks,
    _insertedRows: insertedRows,
    _upserts: upserts,
  };
}

function makeDeps(selectResults?: unknown[]) {
  return {
    db: makeDbStub(selectResults),
    feishuClient: {
      sendMessage: vi.fn(async () => undefined),
      getChat: vi.fn(async (chatId: string) => ({ chatId, name: 'Engineering' })),
    },
    queue: {
      enqueue: vi.fn(async () => 'job-123'),
    },
    memoryHandler: {
      forget: vi.fn(async () => 0),
    },
    feishuTaskSync: {
      initializeChatTrackingSpace: vi.fn(async () => ({
        tasklistGuid: 'tl_init_001',
        tasklistUrl: 'https://debug/tasklist',
        tasklistName: 'Engineering任务看板',
        memberCount: 2,
        statusFieldGuid: 'field_status',
        created: true,
      })),
      addBotToChatTrackingSpace: vi.fn(async () => ({
        tasklistGuid: 'tl_init_001',
        botOpenId: 'ou_new_bot',
        botName: 'New Bot',
        configurationMessageId: 'om_config_001',
      })),
      applyChatTasklistConfiguration: vi.fn(async () => ({
        chatId: 'oc_test_chat',
        tasklistGuid: 'tl_init_001',
      })),
      cleanCompletedTasksForSession: vi.fn(async () => ({
        scope: 'session',
        tasklistGuid: 'tl_init_001',
        retentionDays: 7,
        dryRun: false,
        scanned: 1,
        eligible: 1,
        removed: 1,
        skipped: 0,
        failed: 0,
        failures: [],
      })),
      cleanCompletedTasksForChat: vi.fn(async () => ({
        scope: 'chat',
        tasklistGuid: 'tl_init_001',
        retentionDays: 3,
        dryRun: true,
        scanned: 2,
        eligible: 1,
        removed: 0,
        skipped: 1,
        failed: 0,
        failures: [],
      })),
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    repoRoot: '/tmp/open-claude-tag',
    instanceRole: 'primary',
  };
}

function makeEvent(
  command: string,
  args: string,
  raw?: unknown,
  overrides: Record<string, unknown> = {},
) {
  return {
    chatId: 'oc_test_chat',
    chatType: 'group',
    tenantKey: 'tenant_001',
    senderOpenId: 'ou_test_user',
    senderType: 'user',
    content: { command, args, raw },
    ...overrides,
  } as any;
}

describe('createSlashCommandHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.OPEN_ACCESS;
    getUserRoleMock.mockResolvedValue(null);
    transitionTaskMock.mockResolvedValue(undefined);
    cleanWorktreesMock.mockResolvedValue({
      mergedCleaned: [],
      closedCleaned: [],
      orphanDbCleaned: [],
      orphanDiskCleaned: [],
      targetCleaned: [],
      staleSkipped: [],
      errors: [],
    });
    removeWorktreeByIdMock.mockResolvedValue({
      targetCleaned: [],
      errors: [],
      mergedCleaned: [],
      closedCleaned: [],
      orphanDbCleaned: [],
      orphanDiskCleaned: [],
      staleSkipped: [],
    });
    cleanAllWorktreesMock.mockResolvedValue({
      mergedCleaned: [],
      closedCleaned: [],
      orphanDbCleaned: [],
      orphanDiskCleaned: [],
      targetCleaned: [],
      staleSkipped: [],
      errors: [],
    });
    closeSessionMock.mockResolvedValue(undefined);
    createStorageAgentCommandServicesMock.mockReturnValue({ registryServices: true });
    handleAgentCommandMock.mockResolvedValue({ message: 'agent command ok', mutated: false });
    execMock.mockImplementation(
      (
        _command: string,
        _options: unknown,
        callback: (error: Error | null, result: { stdout: string; stderr: string }) => void,
      ) => {
        callback(null, { stdout: '', stderr: '' });
      },
    );
  });

  it('/new reports the active manual session without enqueuing an agent task', async () => {
    const deps = makeDeps();
    const handler = createSlashCommandHandler(
      deps as unknown as Parameters<typeof createSlashCommandHandler>[0],
    );

    await handler(makeEvent('/new', ''), 'session-new-123456');

    expect(deps.queue.enqueue).not.toHaveBeenCalled();
    const sentText = (deps.feishuClient.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][2]
      .content.text as string;
    expect(sentText).toContain('New manual session started: session-');
    expect(sentText).toContain('/reset');
  });

  it('/reset reports the main session without enqueuing an agent task', async () => {
    const deps = makeDeps();
    const handler = createSlashCommandHandler(
      deps as unknown as Parameters<typeof createSlashCommandHandler>[0],
    );

    await handler(makeEvent('/reset', ''), 'session-main-123456');

    expect(deps.queue.enqueue).not.toHaveBeenCalled();
    const sentText = (deps.feishuClient.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][2]
      .content.text as string;
    expect(sentText).toContain('Returned to the main session: session-');
  });

  it('/chat init initializes chat config and chat task board', async () => {
    const deps = makeDeps();
    const handler = createSlashCommandHandler(deps as any);

    await handler(makeEvent('/chat', 'init', undefined, { replyLanguage: 'en-US' }), 'session-123');

    expect(deps.db._insertedRows).toContainEqual(
      expect.objectContaining({
        tenantKey: 'tenant_001',
        chatId: 'oc_test_chat',
        displayName: 'Engineering',
        createdByOpenId: 'ou_test_user',
      }),
    );
    expect(deps.feishuTaskSync.initializeChatTrackingSpace).toHaveBeenCalledWith({
      chatId: 'oc_test_chat',
      tenantKey: 'tenant_001',
    });
    expect(deps.feishuClient.sendMessage).toHaveBeenCalledWith(
      'chat_id',
      'oc_test_chat',
      {
        msg_type: 'text',
        content: { text: expect.stringContaining('Chat configuration initialized.') },
      },
      undefined,
    );
  });

  it('/chat set-workdir stores an absolute chat default workdir', async () => {
    const deps = makeDeps();
    const handler = createSlashCommandHandler(deps as any);

    await handler(
      makeEvent('/chat', 'set-workdir /tmp', undefined, { replyLanguage: 'en-US' }),
      'session-123',
    );

    expect(deps.db._upserts).toContainEqual(
      expect.objectContaining({
        set: expect.objectContaining({ defaultWorkDir: '/tmp' }),
      }),
    );
    expect(deps.feishuClient.sendMessage).toHaveBeenCalledWith(
      'chat_id',
      'oc_test_chat',
      {
        msg_type: 'text',
        content: { text: 'Default workdir for this chat set to:\n/tmp' },
      },
      undefined,
    );
  });

  it('/chat set-workdir unwraps Feishu markdown links inside path arguments', async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), 'open-claude-tag-workdir-link-'));
    const intendedPath = join(tmpRoot, 'example.com/perf_analyse');
    await mkdir(intendedPath, { recursive: true });

    try {
      const deps = makeDeps();
      const handler = createSlashCommandHandler(deps as any);
      const linkedPath = `${tmpRoot}/[example.com/perf_analyse/](http://example.com/perf_analyse/)`;

      await handler(
        makeEvent('/chat', `set-workdir ${linkedPath}`, undefined, { replyLanguage: 'en-US' }),
        'session-123',
      );

      expect(deps.db._upserts).toContainEqual(
        expect.objectContaining({
          set: expect.objectContaining({ defaultWorkDir: `${intendedPath}/` }),
        }),
      );
      expect(deps.feishuClient.sendMessage).toHaveBeenCalledWith(
        'chat_id',
        'oc_test_chat',
        {
          msg_type: 'text',
          content: { text: `Default workdir for this chat set to:\n${intendedPath}/` },
        },
        undefined,
      );
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('/chat set-workdir accepts a machine-local path when the acting agent is machine-bound', async () => {
    // The agent is bound to a machine, so the path lives on that machine — the
    // server must NOT reject it just because it does not exist locally.
    const deps = {
      ...makeDeps([[{ machineId: 'machine-mac' }]]),
      agentContext: { agentId: 'agent-1' },
    };
    const handler = createSlashCommandHandler(deps as any);

    const macPath = '/Users/dev/only/on/the/mac';
    await handler(
      makeEvent('/chat', `set-workdir ${macPath}`, undefined, { replyLanguage: 'en-US' }),
      'session-123',
    );

    expect(deps.db._upserts).toContainEqual(
      expect.objectContaining({ set: expect.objectContaining({ defaultWorkDir: macPath }) }),
    );
    expect(deps.feishuClient.sendMessage).toHaveBeenCalledWith(
      'chat_id',
      'oc_test_chat',
      {
        msg_type: 'text',
        content: {
          text: `Default workdir for this chat set to:\n${macPath}\n(existence will be checked on the executing machine)`,
        },
      },
      undefined,
    );
  });

  it('/chat clear-workdir clears the chat default workdir', async () => {
    const deps = makeDeps();
    const handler = createSlashCommandHandler(deps as any);

    await handler(
      makeEvent('/chat', 'clear-workdir', undefined, { replyLanguage: 'en-US' }),
      'session-123',
    );

    expect(deps.db._upserts).toContainEqual(
      expect.objectContaining({
        set: expect.objectContaining({ defaultWorkDir: null }),
      }),
    );
  });

  it('/chat memory rejects non-owner configuration changes', async () => {
    const deps = makeDeps();
    const handler = createSlashCommandHandler(deps as any);

    await handler(
      makeEvent('/chat', 'memory enable', undefined, { replyLanguage: 'en-US' }),
      'session-123',
    );

    expect(deps.db._upserts).toEqual([]);
    const sentText = (deps.feishuClient.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][2]
      .content.text as string;
    expect(sentText).toBe('Permission denied: /chat memory is restricted to the project owner.');
  });

  it('/chat memory enable stores the default summary schedule and current chat agent', async () => {
    getUserRoleMock.mockResolvedValue(UserRole.OWNER);
    const deps = {
      ...makeDeps(),
      agentContext: { agentId: 'agent-current', feishuAppId: 'app-current' },
    };
    const handler = createSlashCommandHandler(deps as any);

    await handler(
      makeEvent('/chat', 'memory enable', undefined, { replyLanguage: 'en-US' }),
      'session-123',
    );

    expect(deps.db._upserts).toContainEqual(
      expect.objectContaining({
        set: expect.objectContaining({
          memoryEnabled: true,
          memorySummaryAgentId: 'agent-current',
          memorySummaryTime: '09:30',
          memorySummaryTimezone: 'Asia/Shanghai',
          memorySummaryNextRunAt: expect.any(Date),
        }),
      }),
    );
    const sentText = (deps.feishuClient.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][2]
      .content.text as string;
    expect(sentText).toContain(
      "Chat memory enabled. Daily summaries run automatically with this chat's agent.",
    );
  });

  it('/chat memory rejects legacy detailed config subcommands', async () => {
    getUserRoleMock.mockResolvedValue(UserRole.OWNER);
    const deps = makeDeps();
    const handler = createSlashCommandHandler(deps as any);

    await handler(
      makeEvent('/chat', 'memory set-schedule 09:30 Asia/Shanghai', undefined, {
        replyLanguage: 'en-US',
      }),
      'session-123',
    );

    expect(deps.db._upserts).toEqual([]);
    const sentText = (deps.feishuClient.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][2]
      .content.text as string;
    expect(sentText).toBe('Usage: /chat memory status | enable | disable');
  });

  it('/chat memory is rejected in private chats', async () => {
    getUserRoleMock.mockResolvedValue(UserRole.OWNER);
    const deps = makeDeps();
    const handler = createSlashCommandHandler(deps as any);

    await handler(
      makeEvent('/chat', 'memory status', undefined, {
        replyLanguage: 'en-US',
        chatType: 'p2p',
      }),
      'session-123',
    );

    const sentText = (deps.feishuClient.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][2]
      .content.text as string;
    expect(sentText).toBe('/chat can only be used in group chats.');
  });

  it('/chat memory status reports the current group memory config', async () => {
    getUserRoleMock.mockResolvedValue(UserRole.OWNER);
    const deps = makeDeps([
      [
        {
          memoryEnabled: true,
          memorySummaryAgentId: 'agent-memory',
          memorySummaryTime: '09:30',
          memorySummaryTimezone: 'Asia/Shanghai',
          memorySummaryNextRunAt: new Date('2026-06-24T01:30:00.000Z'),
          memorySummaryLastRunAt: null,
          memorySummaryLastStatus: 'completed',
          memorySummaryLastError: null,
        },
      ],
    ]);
    const handler = createSlashCommandHandler(deps as any);

    await handler(
      makeEvent('/chat', 'memory status', undefined, { replyLanguage: 'en-US' }),
      'session-123',
    );

    const sentText = (deps.feishuClient.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][2]
      .content.text as string;
    expect(sentText).toContain('Status: enabled');
    expect(sentText).toContain('Next summary: 2026-06-24T01:30:00.000Z');
    expect(sentText).toContain('Last status: completed');
  });

  it('/chat set-runtime is removed and falls through to the usage reply', async () => {
    const deps = makeDeps();
    const handler = createSlashCommandHandler(deps as any);

    await handler(
      makeEvent('/chat', 'set-runtime codex', undefined, { replyLanguage: 'en-US' }),
      'session-123',
    );

    expect(deps.db._upserts).toEqual([]);
    const sentText = (deps.feishuClient.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][2]
      .content.text as string;
    expect(sentText).toBe(
      'Usage: /chat init | /chat status | /chat memory <subcommand> | /chat set-workdir <absolute-path> | /chat clear-workdir',
    );
  });

  it('/chat status reports current chat config and task board', async () => {
    const deps = makeDeps([
      [{ defaultWorkDir: '/tmp/project-a' }],
      [{ tasklistGuid: 'tl_chat_001' }],
    ]);
    const handler = createSlashCommandHandler(deps as any);

    await handler(
      makeEvent('/chat', 'status', undefined, { replyLanguage: 'en-US' }),
      'session-123',
    );

    expect(deps.feishuClient.sendMessage).toHaveBeenCalledWith(
      'chat_id',
      'oc_test_chat',
      {
        msg_type: 'text',
        content: {
          text: [
            'Chat configuration:',
            'Workdir: /tmp/project-a',
            'Task board: tl_chat_001',
          ].join('\n'),
        },
      },
      undefined,
    );
  });

  it('/agent grants mutation permission through MANAGE_AGENTS env', async () => {
    process.env.MANAGE_AGENTS = 'ou_test_user';
    const deps = makeDeps();
    const handler = createSlashCommandHandler(deps as any);

    await handler(makeEvent('/agent', 'sync'), 'session-123');

    expect(createStorageAgentCommandServicesMock).toHaveBeenCalledWith(deps.db, {
      repoRoot: '/tmp/open-claude-tag',
      tenantKey: 'tenant_001',
      chatId: 'oc_test_chat',
    });
    expect(handleAgentCommandMock).toHaveBeenCalledWith(
      'sync',
      { canManageAgents: true },
      { registryServices: true },
    );
  });

  it('/agent grants mutation permission through owner role', async () => {
    getUserRoleMock.mockResolvedValue(UserRole.OWNER);
    const deps = makeDeps();
    const handler = createSlashCommandHandler(deps as any);

    await handler(makeEvent('/agent', 'bind-bot open-claude-tag cli_primary'), 'session-123');

    expect(handleAgentCommandMock).toHaveBeenCalledWith(
      'bind-bot open-claude-tag cli_primary',
      { canManageAgents: true },
      { registryServices: true },
    );
  });

  it('creates and enqueues a scheduled task with startAfter', async () => {
    const deps = makeDeps([
      [{ metadata: { replyLanguage: 'zh-CN' } }],
      [{ sdkSessionId: null, runtimeBackend: 'codex' }],
    ]);
    const handler = createSlashCommandHandler(deps as any);

    await handler(makeEvent('/schedule', '2026-03-27T09:00:00Z implement feature'), 'session-123');

    expect(deps.db._insertedTasks).toHaveLength(1);
    expect(deps.db._insertedTasks[0]).toMatchObject({
      sessionId: 'session-123',
      taskType: 'self_dev',
      goal: 'implement feature',
      status: TaskStatus.PENDING,
      constraints: expect.objectContaining({ chatId: 'oc_test_chat', replyLanguage: 'zh-CN' }),
    });
    expect(transitionTaskMock).toHaveBeenCalledWith(deps.db, expect.any(String), TaskStatus.QUEUED);
    expect(deps.queue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-123',
        taskType: 'self_dev',
        goal: 'implement feature',
        runtimeHint: 'codex',
        constraints: expect.objectContaining({ chatId: 'oc_test_chat', replyLanguage: 'zh-CN' }),
      }),
      {
        startAfter: new Date('2026-03-27T09:00:00.000Z'),
      },
    );
    expect(deps.feishuClient.sendMessage).toHaveBeenCalledWith(
      'chat_id',
      'oc_test_chat',
      {
        msg_type: 'text',
        content: {
          text: expect.stringContaining('Job ID: job-123'),
        },
      },
      undefined,
    );
  });

  it('marks scheduled tasks failed when enqueue fails', async () => {
    const deps = makeDeps([
      [{ metadata: { replyLanguage: 'en-US' } }],
      [{ sdkSessionId: null, runtimeBackend: 'codex' }],
    ]);
    (deps.queue.enqueue as any).mockRejectedValueOnce(new Error('queue down'));
    const handler = createSlashCommandHandler(deps as any);

    await handler(makeEvent('/schedule', '2026-03-27T09:00:00Z implement feature'), 'session-123');

    expect(deps.db._insertedTasks).toHaveLength(1);
    expect(transitionTaskMock).toHaveBeenCalledWith(deps.db, expect.any(String), TaskStatus.QUEUED);
    expect(transitionTaskMock).toHaveBeenCalledWith(deps.db, expect.any(String), TaskStatus.FAILED, {
      errorMessage: 'queue down',
    });
    expect(deps.feishuClient.sendMessage).toHaveBeenCalledWith(
      'chat_id',
      'oc_test_chat',
      {
        msg_type: 'text',
        content: {
          text: 'Scheduling failed: please retry later.',
        },
      },
      undefined,
    );
  });

  it('creates scheduled tasks with the routed agent identity', async () => {
    const deps = {
      ...makeDeps([
        [{ metadata: { replyLanguage: 'en-US' } }],
        [{ sdkSessionId: null, runtimeBackend: 'claude_code' }],
      ]),
      agentContext: {
        agentId: 'agent_123',
        feishuAppId: 'app_123',
      },
    };
    const handler = createSlashCommandHandler(deps as any);

    await handler(makeEvent('/schedule', '2026-03-27T09:00:00Z implement feature'), 'session-123');

    expect(deps.db._insertedTasks[0]).toMatchObject({
      agentId: 'agent_123',
      feishuAppId: 'app_123',
      constraints: expect.objectContaining({
        agentId: 'agent_123',
        feishuAppId: 'app_123',
      }),
    });
    expect(deps.queue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent_123',
        feishuAppId: 'app_123',
        constraints: expect.objectContaining({
          agentId: 'agent_123',
          feishuAppId: 'app_123',
        }),
      }),
      expect.any(Object),
    );
  });

  it('marks scheduled debug tasks to skip runtime execution', async () => {
    const deps = makeDeps([
      [{ metadata: { replyLanguage: 'en-US' } }],
      [{ sdkSessionId: null, runtimeBackend: 'claude_code' }],
    ]);
    const handler = createSlashCommandHandler(deps as any);

    await handler(
      makeEvent('/schedule', '2026-03-27T09:00:00Z implement feature', {
        event: {
          message: {
            __openClaudeTagDebug: {
              skipTaskExecution: true,
            },
          },
        },
      }),
      'session-123',
    );

    expect(deps.db._insertedTasks[0]).toMatchObject({
      constraints: expect.objectContaining({
        debugSkipExecution: true,
      }),
    });
    expect(deps.queue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        constraints: expect.objectContaining({
          debugSkipExecution: true,
        }),
      }),
      expect.any(Object),
    );
  });

  it('returns a Chinese validation reply when /schedule time parsing fails', async () => {
    const deps = makeDeps();
    const handler = createSlashCommandHandler(deps as any);

    await handler(
      {
        ...makeEvent('/schedule', 'not-a-time implement feature'),
        replyLanguage: 'zh-CN',
      } as any,
      'session-123',
    );

    expect(deps.feishuClient.sendMessage).toHaveBeenCalledWith(
      'chat_id',
      'oc_test_chat',
      {
        msg_type: 'text',
        content: {
          text: expect.stringContaining('无法解析时间表达式'),
        },
      },
      undefined,
    );
  });

  it('returns a Chinese usage reply for /project add when arguments are missing', async () => {
    const deps = makeDeps();
    const handler = createSlashCommandHandler(deps as any);

    await handler(
      {
        ...makeEvent('/project', 'add demo'),
        replyLanguage: 'zh-CN',
      } as any,
      'session-123',
    );

    expect(deps.feishuClient.sendMessage).toHaveBeenCalledWith(
      'chat_id',
      'oc_test_chat',
      {
        msg_type: 'text',
        content: {
          text: '用法：/project add <name> <path>',
        },
      },
      undefined,
    );
  });

  it('returns a Chinese no-PR reply for /merge-pr when the session has no PR', async () => {
    const deps = makeDeps([[]]);
    const handler = createSlashCommandHandler(deps as any);

    await handler(
      {
        ...makeEvent('/merge-pr', ''),
        replyLanguage: 'zh-CN',
      } as any,
      'session-123',
    );

    expect(deps.feishuClient.sendMessage).toHaveBeenCalledWith(
      'chat_id',
      'oc_test_chat',
      {
        msg_type: 'text',
        content: {
          text: '当前 session 还没有关联 PR/MR。',
        },
      },
      undefined,
    );
  });

  it('/merge-pr merges a GitHub PR', async () => {
    const deps = makeDeps([
      [],
      [{ prUrl: 'https://github.com/owner/repo/pull/42' }],
    ]);
    const handler = createSlashCommandHandler(deps as any);

    await handler(makeEvent('/merge-pr', ''), 'session-123');

    expect(execMock).toHaveBeenCalledWith(
      "gh pr merge 'https://github.com/owner/repo/pull/42' --squash --delete-branch",
      { cwd: '/tmp/open-claude-tag' },
      expect.any(Function),
    );
    expect(deps.feishuClient.sendMessage).toHaveBeenCalledWith(
      'chat_id',
      'oc_test_chat',
      {
        msg_type: 'text',
        content: {
          text: 'PR/MR merged: https://github.com/owner/repo/pull/42',
        },
      },
      undefined,
    );
  });

  it('returns a Chinese empty-state reply for /session worktrees when no worktrees exist', async () => {
    getUserRoleMock.mockResolvedValue(UserRole.OWNER);
    const deps = makeDeps([[]]);
    const handler = createSlashCommandHandler(deps as any);

    await handler(
      {
        ...makeEvent('/session', 'worktrees'),
        replyLanguage: 'zh-CN',
      } as any,
      'session-123',
    );

    expect(deps.feishuClient.sendMessage).toHaveBeenCalledWith(
      'chat_id',
      'oc_test_chat',
      {
        msg_type: 'text',
        content: {
          text: '未找到任何 worktree。',
        },
      },
      undefined,
    );
  });

  it('reports skipped unmanaged worktrees for /session clean instead of saying nothing to clean', async () => {
    getUserRoleMock.mockResolvedValue(UserRole.OWNER);
    cleanWorktreesMock.mockResolvedValue({
      mergedCleaned: [],
      closedCleaned: [],
      orphanDbCleaned: [],
      orphanDiskCleaned: [],
      targetCleaned: [],
      staleSkipped: ['dev/direct-path'],
      errors: [],
    });
    const deps = makeDeps();
    const handler = createSlashCommandHandler(deps as any);

    await handler(
      {
        ...makeEvent('/session', 'clean'),
        replyLanguage: 'en-US',
      } as any,
      'session-123',
    );

    const sentText = (deps.feishuClient.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][2]
      .content.text as string;
    expect(sentText).toContain('Skipped unmanaged worktrees: dev/direct-path');
    expect(sentText).not.toContain('Nothing to clean.');
  });

  it('/session clean <id> routes to removeWorktreeById for owners', async () => {
    getUserRoleMock.mockResolvedValue(UserRole.OWNER);
    removeWorktreeByIdMock.mockResolvedValue({
      targetCleaned: ['dev/abc123'],
      errors: [],
      mergedCleaned: [],
      closedCleaned: [],
      orphanDbCleaned: [],
      orphanDiskCleaned: [],
      staleSkipped: [],
    });
    const deps = makeDeps();
    const handler = createSlashCommandHandler(deps as any);

    await handler(
      makeEvent('/session', 'clean abc123', undefined, { replyLanguage: 'en-US' }),
      'session-123',
    );

    expect(removeWorktreeByIdMock).toHaveBeenCalledWith(deps.db, '/tmp/open-claude-tag', 'abc123');
    expect(cleanWorktreesMock).not.toHaveBeenCalled();
    expect(cleanAllWorktreesMock).not.toHaveBeenCalled();
    const sentText = (deps.feishuClient.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][2]
      .content.text as string;
    expect(sentText).toContain('dev/abc123');
  });

  it('/session clean --all routes to cleanAllWorktrees for owners', async () => {
    getUserRoleMock.mockResolvedValue(UserRole.OWNER);
    cleanAllWorktreesMock.mockResolvedValue({
      mergedCleaned: [],
      closedCleaned: [],
      orphanDbCleaned: [],
      orphanDiskCleaned: ['dev-orphan-1'],
      targetCleaned: ['dev/feature-x'],
      staleSkipped: [],
      errors: [],
    });
    const deps = makeDeps();
    const handler = createSlashCommandHandler(deps as any);

    await handler(
      makeEvent('/session', 'clean --all', undefined, { replyLanguage: 'en-US' }),
      'session-123',
    );

    expect(cleanAllWorktreesMock).toHaveBeenCalledWith(deps.db, '/tmp/open-claude-tag');
    expect(cleanWorktreesMock).not.toHaveBeenCalled();
    expect(removeWorktreeByIdMock).not.toHaveBeenCalled();
    const sentText = (deps.feishuClient.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][2]
      .content.text as string;
    expect(sentText).toContain('Force cleanup complete (--all):');
    expect(sentText).toContain('dev/feature-x');
    expect(sentText).toContain('dev-orphan-1');
  });

  it('denies /session worktrees and /session clean for non-owners', async () => {
    getUserRoleMock.mockResolvedValue(null);
    const deps = makeDeps();
    const handler = createSlashCommandHandler(deps as any);

    await handler(makeEvent('/session', 'worktrees', undefined, { replyLanguage: 'en-US' }), 'session-123');
    await handler(makeEvent('/session', 'clean', undefined, { replyLanguage: 'en-US' }), 'session-123');

    expect(cleanWorktreesMock).not.toHaveBeenCalled();
    expect(cleanAllWorktreesMock).not.toHaveBeenCalled();
    expect(removeWorktreeByIdMock).not.toHaveBeenCalled();
    const sent = (deps.feishuClient.sendMessage as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => call[2].content.text as string,
    );
    expect(sent[0]).toContain('Permission denied');
    expect(sent[0]).toContain('/session worktrees');
    expect(sent[1]).toContain('Permission denied');
    expect(sent[1]).toContain('/session clean');
  });

  it('OPEN_ACCESS=true bypasses the /session worktree subcommand owner check', async () => {
    process.env.OPEN_ACCESS = 'true';
    getUserRoleMock.mockResolvedValue(null);
    const deps = makeDeps([[]]);
    const handler = createSlashCommandHandler(deps as any);

    await handler(
      makeEvent('/session', 'worktrees', undefined, { replyLanguage: 'en-US' }),
      'session-123',
    );

    const sentText = (deps.feishuClient.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][2]
      .content.text as string;
    expect(sentText).toBe('No worktrees found.');
  });

  it('keeps /session list open to non-owners', async () => {
    getUserRoleMock.mockResolvedValue(null);
    const deps = makeDeps([[]]);
    const handler = createSlashCommandHandler(deps as any);

    await handler(makeEvent('/session', 'list', undefined, { replyLanguage: 'en-US' }), 'session-123');

    const sentText = (deps.feishuClient.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][2]
      .content.text as string;
    expect(sentText).not.toContain('Permission denied');
  });

  it('/status appends process health to the session info', async () => {
    const deps = makeDeps([
      [{ metadata: {} }],
      [
        {
          sessionKey: 'feishu:t:c:main',
          scope: 'group:main',
          status: 'active',
          messageCount: 3,
          createdAt: new Date('2026-06-01T00:00:00Z'),
        },
      ],
    ]);
    const handler = createSlashCommandHandler(deps as any);

    await handler(makeEvent('/status', '', undefined, { replyLanguage: 'en-US' }), 'session-status');

    const sentText = (deps.feishuClient.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][2]
      .content.text as string;
    expect(sentText).toMatch(/Uptime: \d+s/);
    expect(sentText).toMatch(/RSS: \d+ MB/);
  });

  it('/status keeps the health lines when no session row exists (liveness probe)', async () => {
    const deps = makeDeps([[], []]);
    const handler = createSlashCommandHandler(deps as any);

    await handler(makeEvent('/status', '', undefined, { replyLanguage: 'en-US' }), 'session-missing');

    const sentText = (deps.feishuClient.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][2]
      .content.text as string;
    expect(sentText).toMatch(/Uptime: \d+s/);
    expect(sentText).toMatch(/RSS: \d+ MB/);
  });

  it('/status still replies with health lines when the session lookup throws', async () => {
    const deps = makeDeps();
    (deps.db.select as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('db down');
    });
    const handler = createSlashCommandHandler(deps as any);

    await handler(makeEvent('/status', '', undefined, { replyLanguage: 'en-US' }), 'session-db-down');

    const sentText = (deps.feishuClient.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][2]
      .content.text as string;
    expect(sentText).toContain('Session info unavailable.');
    expect(sentText).toMatch(/Uptime: \d+s/);
    expect(sentText).toMatch(/RSS: \d+ MB/);
    expect(sentText).not.toContain('Command failed');
  });

  it('/add-bot adds the mentioned bot to the current chat task board', async () => {
    const deps = makeDeps();
    const handler = createSlashCommandHandler(deps as any);

    await handler(
      {
        ...makeEvent('/add-bot', ''),
        content: {
          command: '/add-bot',
          args: '',
          commandIndex: 9,
          mentions: [
            { id: 'ou_current_bot', name: 'OpenClaudeTag', isBot: true, key: '@_user_1', index: 0 },
            { id: 'ou_new_bot', name: 'New Bot', isBot: false, key: '@_user_2', index: 18 },
          ],
        },
      } as any,
      'session-add-bot',
      'om_thread_001',
    );

    expect(deps.feishuTaskSync.addBotToChatTrackingSpace).toHaveBeenCalledWith({
      chatId: 'oc_test_chat',
      tenantKey: 'tenant_001',
      botOpenId: 'ou_new_bot',
      botName: 'New Bot',
      replyToMessageId: 'om_thread_001',
    });
    expect(deps.queue.enqueue).not.toHaveBeenCalled();
    const sentText = (deps.feishuClient.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][2]
      .content.text as string;
    expect(sentText).toContain('Bot added to this chat task board.');
    expect(sentText).toContain('GUID: tl_init_001');
  });

  it('/add-bot ignores non-bot mentions before the command', async () => {
    const deps = makeDeps();
    const handler = createSlashCommandHandler(deps as any);

    await handler(
      {
        ...makeEvent('/add-bot', ''),
        content: {
          command: '/add-bot',
          args: '',
          commandIndex: 18,
          mentions: [
            { id: 'ou_current_bot', name: 'OpenClaudeTag', isBot: true, key: '@_user_1', index: 0 },
            { id: 'ou_human', name: 'Alice', isBot: false, key: '@_user_2', index: 9 },
            { id: 'ou_new_bot', name: 'New Bot', isBot: false, key: '@_user_3', index: 27 },
          ],
        },
      } as any,
      'session-add-bot-before-mention',
      'om_thread_001',
    );

    expect(deps.feishuTaskSync.addBotToChatTrackingSpace).toHaveBeenCalledWith({
      chatId: 'oc_test_chat',
      tenantKey: 'tenant_001',
      botOpenId: 'ou_new_bot',
      botName: 'New Bot',
      replyToMessageId: 'om_thread_001',
    });
  });

  it('/add-bot rejects ambiguous target mentions after the command', async () => {
    const deps = makeDeps();
    const handler = createSlashCommandHandler(deps as any);

    await handler(
      {
        ...makeEvent('/add-bot', ''),
        content: {
          command: '/add-bot',
          args: '',
          commandIndex: 9,
          mentions: [
            { id: 'ou_current_bot', name: 'OpenClaudeTag', isBot: true, key: '@_user_1', index: 0 },
            { id: 'ou_new_bot_1', name: 'New Bot 1', isBot: false, key: '@_user_2', index: 18 },
            { id: 'ou_new_bot_2', name: 'New Bot 2', isBot: false, key: '@_user_3', index: 27 },
          ],
        },
      } as any,
      'session-add-bot-ambiguous',
    );

    expect(deps.feishuTaskSync.addBotToChatTrackingSpace).not.toHaveBeenCalled();
    const sentText = (deps.feishuClient.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][2]
      .content.text as string;
    expect(sentText).toBe('Usage: /add-bot @new-bot');
  });

  it('/add-bot requires a target bot mention', async () => {
    const deps = makeDeps();
    const handler = createSlashCommandHandler(deps as any);

    await handler(
      {
        ...makeEvent('/add-bot', ''),
        content: {
          command: '/add-bot',
          args: '',
          commandIndex: 9,
          mentions: [
            { id: 'ou_current_bot', name: 'OpenClaudeTag', isBot: true, key: '@_user_1', index: 0 },
          ],
        },
      } as any,
      'session-add-bot-missing',
    );

    expect(deps.feishuTaskSync.addBotToChatTrackingSpace).not.toHaveBeenCalled();
    const sentText = (deps.feishuClient.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][2]
      .content.text as string;
    expect(sentText).toBe('Usage: /add-bot @new-bot');
  });

  it('/clean-task cleans completed tasks for the current session by default', async () => {
    const deps = makeDeps();
    const handler = createSlashCommandHandler(deps as any);

    await handler(makeEvent('/clean-task', ''), 'session-clean-task');

    expect(deps.feishuTaskSync.cleanCompletedTasksForSession).toHaveBeenCalledWith({
      sessionId: 'session-clean-task',
      retentionDays: undefined,
      dryRun: false,
    });
    expect(deps.feishuTaskSync.cleanCompletedTasksForChat).not.toHaveBeenCalled();
    expect(deps.queue.enqueue).not.toHaveBeenCalled();
    const sentText = (deps.feishuClient.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][2]
      .content.text as string;
    expect(sentText).toContain('Task cleanup complete.');
    expect(sentText).toContain('Scope: current session');
    expect(sentText).toContain('Removed: 1');
  });

  it('/clean-task --chat --dry-run previews chat task board cleanup', async () => {
    const deps = makeDeps();
    const handler = createSlashCommandHandler(deps as any);

    await handler(makeEvent('/clean-task', '--chat --dry-run --days 3'), 'session-clean-chat');

    expect(deps.feishuTaskSync.cleanCompletedTasksForChat).toHaveBeenCalledWith({
      chatId: 'oc_test_chat',
      retentionDays: 3,
      dryRun: true,
    });
    expect(deps.feishuTaskSync.cleanCompletedTasksForSession).not.toHaveBeenCalled();
    const sentText = (deps.feishuClient.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][2]
      .content.text as string;
    expect(sentText).toContain('Task cleanup preview complete.');
    expect(sentText).toContain('Scope: current chat task board');
    expect(sentText).toContain('Would remove: 1');
  });

  it('/clean-task rejects invalid retention arguments', async () => {
    const deps = makeDeps();
    const handler = createSlashCommandHandler(deps as any);

    await handler(makeEvent('/clean-task', '--days nope'), 'session-clean-invalid');

    expect(deps.feishuTaskSync.cleanCompletedTasksForSession).not.toHaveBeenCalled();
    const sentText = (deps.feishuClient.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][2]
      .content.text as string;
    expect(sentText).toContain('Invalid options: --days requires a non-negative integer');
  });

  it('/clean-task --help returns cleanup help text', async () => {
    const deps = makeDeps();
    const handler = createSlashCommandHandler(deps as any);

    await handler(makeEvent('/clean-task', '--help'), 'session-clean-help');

    const sentText = (deps.feishuClient.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][2]
      .content.text as string;
    expect(sentText).toContain('/clean-task');
    expect(sentText).toContain('--chat');
  });

  it('/configure-tasklist applies bot-to-bot task board configuration', async () => {
    const deps = makeDeps();
    const handler = createSlashCommandHandler(deps as any);

    await handler(
      {
        ...makeEvent('/configure-tasklist', 'payload_123'),
        chatType: 'p2p',
        senderType: 'app',
      } as any,
      'session-configure-tasklist',
    );

    expect(deps.feishuTaskSync.applyChatTasklistConfiguration).toHaveBeenCalledWith({
      encodedPayload: 'payload_123',
    });
    const sentText = (deps.feishuClient.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][2]
      .content.text as string;
    expect(sentText).toContain('Task board configuration applied.');
    expect(sentText).toContain('GUID: tl_init_001');
  });

  it('/configure-tasklist applies bot-sent group task board configuration', async () => {
    const deps = makeDeps();
    const handler = createSlashCommandHandler(deps as any);

    await handler(
      {
        ...makeEvent('/configure-tasklist', 'payload_123'),
        chatType: 'group',
        senderType: 'app',
      } as any,
      'session-configure-tasklist-group',
    );

    expect(deps.feishuTaskSync.applyChatTasklistConfiguration).toHaveBeenCalledWith({
      encodedPayload: 'payload_123',
    });
    const sentText = (deps.feishuClient.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][2]
      .content.text as string;
    expect(sentText).toContain('Task board configuration applied.');
    expect(sentText).toContain('GUID: tl_init_001');
  });

  it('/configure-tasklist rejects non-bot senders', async () => {
    const deps = makeDeps();
    const handler = createSlashCommandHandler(deps as any);

    await handler(
      {
        ...makeEvent('/configure-tasklist', 'payload_123'),
        chatType: 'p2p',
        senderType: 'user',
      } as any,
      'session-configure-tasklist-user',
    );

    expect(deps.feishuTaskSync.applyChatTasklistConfiguration).not.toHaveBeenCalled();
    const sentText = (deps.feishuClient.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][2]
      .content.text as string;
    expect(sentText).toBe(
      '/configure-tasklist only accepts bot-sent task board configuration messages.',
    );
  });

  describe('/close', () => {
    it('--help returns help text without archiving or removing a worktree', async () => {
      const deps = makeDeps();
      const handler = createSlashCommandHandler(
        deps as unknown as Parameters<typeof createSlashCommandHandler>[0],
      );

      await handler(makeEvent('/close', '--help'), 'session-close-help');

      expect(removeWorktreeByIdMock).not.toHaveBeenCalled();
      expect(closeSessionMock).not.toHaveBeenCalled();
      const sentText = (deps.feishuClient.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][2]
        .content.text as string;
      expect(sentText).toContain('/close');
      expect(sentText).toContain('Usage: /close');
    });

    it('removes worktree and archives session when worktree exists', async () => {
      removeWorktreeByIdMock.mockResolvedValue({
        targetCleaned: ['dev/abc123'],
        errors: [],
        mergedCleaned: [],
        closedCleaned: [],
        orphanDbCleaned: [],
        orphanDiskCleaned: [],
        staleSkipped: [],
      });
      const deps = makeDeps();
      const handler = createSlashCommandHandler(deps as any);

      await handler(makeEvent('/close', ''), 'session-abc123');

      expect(removeWorktreeByIdMock).toHaveBeenCalledWith(
        deps.db,
        '/tmp/open-claude-tag',
        'session-abc123',
      );
      expect(closeSessionMock).toHaveBeenCalledWith(deps.db, 'session-abc123');
      const sentText = (deps.feishuClient.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][2]
        .content.text as string;
      expect(sentText).toContain('Session closed');
      expect(sentText).toContain('dev/abc123');
    });

    it('archives session without worktree ops when no worktree present', async () => {
      removeWorktreeByIdMock.mockResolvedValue({
        targetCleaned: [],
        errors: ['No worktree found matching "session-no-wt"'],
        mergedCleaned: [],
        closedCleaned: [],
        orphanDbCleaned: [],
        orphanDiskCleaned: [],
        staleSkipped: [],
      });
      const deps = makeDeps();
      const handler = createSlashCommandHandler(deps as any);

      await handler(makeEvent('/close', ''), 'session-no-wt');

      expect(closeSessionMock).toHaveBeenCalledWith(deps.db, 'session-no-wt');
      const sentText = (deps.feishuClient.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][2]
        .content.text as string;
      expect(sentText).toBe('Session closed.');
    });

    it('handles missing worktree on disk gracefully', async () => {
      removeWorktreeByIdMock.mockResolvedValue({
        targetCleaned: [],
        errors: [],
        mergedCleaned: [],
        closedCleaned: [],
        orphanDbCleaned: [],
        orphanDiskCleaned: [],
        staleSkipped: [],
      });
      const deps = makeDeps();
      const handler = createSlashCommandHandler(deps as any);

      await handler(makeEvent('/close', ''), 'session-disk-gone');

      expect(closeSessionMock).toHaveBeenCalledWith(deps.db, 'session-disk-gone');
      expect(deps.feishuClient.sendMessage).toHaveBeenCalledTimes(1);
    });

    it('does not enqueue any task', async () => {
      const deps = makeDeps();
      const handler = createSlashCommandHandler(deps as any);

      await handler(makeEvent('/close', ''), 'session-no-task');

      expect(deps.queue.enqueue).not.toHaveBeenCalled();
    });
  });

});
