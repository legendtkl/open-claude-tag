import Fastify from 'fastify';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AdminApiError,
  assertActiveBotBindingRouteInvariant,
  buildFeishuChatOpenUrl,
  buildFeishuTasklistOpenUrl,
  buildTaskBoardChatKey,
  createDrizzleAdminApiStore,
  registerAdminApiRoutes,
  resolveChatDisplayName,
  resolveReadableChatDisplayName,
  SUPERADMIN_SCOPE,
  type AdminApiStore,
  type AgentDto,
  type FeishuAppDto,
  type FeishuAppPermissionCheckDto,
  type FeishuAppRegistrationDto,
  type OwnerScope,
} from '../admin-api.js';
import type { Database } from '@open-tag/storage';

const now = new Date('2026-06-06T00:00:00Z');
const EMPTY_DESKTOP_RELEASE_DIR = join(tmpdir(), 'cc-empty-desktop-release-fixture');

function makeAgentDto(overrides: Partial<AgentDto> = {}): AgentDto {
  return {
    id: '00000000-0000-4000-8000-000000000002',
    tenantKey: 'default',
    scopeType: 'system',
    scopeId: 'default',
    handle: 'reviewer',
    displayName: 'Reviewer',
    description: null,
    profileId: '00000000-0000-4000-8000-000000000001',
    profile: null,
    ownerUserId: null,
    platformOwnerId: null,
    platformOwner: null,
    machineId: null,
    machine: null,
    visibility: 'public',
    defaultRuntime: 'codex',
    defaultWorkDir: null,
    runtimeEnvKeys: [],
    projectId: null,
    accessPolicy: {},
    status: 'active',
    binding: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeAppDto(overrides: Partial<FeishuAppDto> = {}): FeishuAppDto {
  return {
    id: '00000000-0000-4000-8000-000000000003',
    tenantKey: 'default',
    appId: 'cli_reviewer',
    appSecretRef: 'FEISHU_REVIEWER_APP_SECRET',
    hasStoredSecret: false,
    botOpenId: 'ou_bot',
    botName: 'Reviewer Bot',
    eventMode: 'websocket',
    status: 'enabled',
    platformOwnerId: null,
    platformOwner: null,
    binding: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeFeishuAppRegistrationDto(
  overrides: Partial<FeishuAppRegistrationDto> = {},
): FeishuAppRegistrationDto {
  return {
    id: '00000000-0000-4000-8000-0000000000f1',
    status: 'pending',
    verificationUrl: 'https://open.feishu.cn/page/launcher?user_code=test',
    expireIn: 600,
    expiresAt: new Date(now.getTime() + 600_000),
    app: null,
    error: null,
    sdkStatus: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeStore(overrides: Partial<AdminApiStore> = {}): AdminApiStore {
  const store: AdminApiStore = {
    getSummary: vi.fn(async () => ({
      profiles: 1,
      agents: 1,
      activeAgents: 1,
      feishuApps: 1,
      enabledFeishuApps: 1,
      botBindings: 1,
      chats: 1,
      taskBoards: 1,
      machines: 2,
      onlineMachines: 1,
    })),
    listComputerAccessUsers: vi.fn(async () => [
      {
        id: '00000000-0000-4000-8000-0000000000b1',
        email: 'alice@example.com',
        displayName: 'Alice',
        role: 'user' as const,
        computerAccessEnabled: true,
        createdAt: now,
        updatedAt: now,
      },
    ]),
    updateComputerAccessUser: vi.fn(async (_scope, id, input) => ({
      id,
      email: 'alice@example.com',
      displayName: 'Alice',
      role: 'user' as const,
      computerAccessEnabled: input.computerAccessEnabled,
      createdAt: now,
      updatedAt: now,
    })),
    listMachines: vi.fn(async () => [
      {
        id: '00000000-0000-4000-8000-0000000000a1',
        name: 'studio-mbp',
        status: 'online',
        ownerOpenId: 'ou_owner',
        lastSeenAt: now,
        runtimes: ['claude_code', 'codex'],
        createdAt: now,
      },
      {
        id: '00000000-0000-4000-8000-0000000000a2',
        name: 'old-laptop',
        status: 'offline',
        ownerOpenId: 'ou_owner',
        lastSeenAt: null,
        runtimes: ['codex'],
        createdAt: now,
      },
    ]),
    disconnectMachine: vi.fn(async (_scope, id) => ({
      id,
      name: 'studio-mbp',
      status: 'online',
      ownerOpenId: 'ou_owner',
      lastSeenAt: now,
      runtimes: ['claude_code', 'codex'],
      createdAt: now,
    })),
    issuePairingToken: vi.fn(async (_scope, input) => ({
      token: 'plain-token-xyz',
      expiresAt: new Date(now.getTime() + 600_000),
      machineName: input.name ?? null,
    })),
    listProfiles: vi.fn(async () => [
      {
        id: '00000000-0000-4000-8000-000000000001',
        name: 'reviewer',
        displayName: 'Reviewer',
        description: null,
        systemPrompt: null,
        stylePrompt: null,
        skillRefs: ['code-review'],
        defaultRuntime: 'codex',
        defaultModel: null,
        sourceType: 'console',
        sourceUri: null,
        platformOwnerId: null,
        platformOwner: null,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      },
    ]),
    listAgents: vi.fn(async () => []),
    createProfile: vi.fn(async (_scope, input) => ({
      id: '00000000-0000-4000-8000-000000000002',
      name: input.name,
      displayName: input.displayName,
      description: input.description ?? null,
      systemPrompt: input.systemPrompt ?? null,
      stylePrompt: input.stylePrompt ?? null,
      skillRefs: input.skillRefs ?? [],
      defaultRuntime: input.defaultRuntime ?? null,
      defaultModel: input.defaultModel ?? null,
      sourceType: 'console',
      sourceUri: null,
      platformOwnerId: null,
      platformOwner: null,
      status: input.status ?? 'active',
      createdAt: now,
      updatedAt: now,
    })),
    updateProfile: vi.fn(async () => {
      throw new AdminApiError(404, 'Profile not found');
    }),
    createAgent: vi.fn(async () => {
      throw new Error('not needed');
    }),
    updateAgent: vi.fn(async () => {
      throw new Error('not needed');
    }),
    deleteAgent: vi.fn(async (_scope, id) => makeAgentDto({ id })),
    listFeishuApps: vi.fn(async () => [makeAppDto()]),
    createFeishuApp: vi.fn(async (_scope, input) =>
      makeAppDto({
        id: '00000000-0000-4000-8000-000000000006',
        tenantKey: input.tenantKey,
        appId: input.appId,
        appSecretRef: input.appSecretRef ?? 'stored',
        hasStoredSecret: Boolean(input.appSecret),
        botOpenId: input.botOpenId ?? null,
        botName: input.botName ?? null,
        eventMode: input.eventMode,
        status: input.status,
      }),
    ),
    updateFeishuApp: vi.fn(async () => {
      throw new Error('not needed');
    }),
    syncFeishuAppMetadata: vi.fn(async (_scope, id) =>
      makeAppDto({ id, botName: 'Synced Reviewer Bot' }),
    ),
    deleteFeishuApp: vi.fn(async (_scope, id) => makeAppDto({ id })),
    checkFeishuAppPermissions: vi.fn(
      async (_scope, id): Promise<FeishuAppPermissionCheckDto> => ({
        feishuAppId: id,
        appId: 'cli_reviewer',
        checkedAt: now,
        status: 'pass',
        grantedScopes: ['im:message:send_as_bot'],
        inventoryScopes: ['im:message:send_as_bot'],
        extraGrantedScopes: [],
        missingRequiredCapabilities: [],
        optionalMissingCapabilities: [],
        capabilities: [
          {
            id: 'send-message-as-bot',
            label: 'Send and reply as bot',
            severity: 'required',
            status: 'ok',
            groups: [{ anyOf: ['im:message:send_as_bot'], satisfiedBy: 'im:message:send_as_bot' }],
          },
        ],
        notes: [],
      }),
    ),
    applyFeishuAppPermissions: vi.fn(async (_scope, id) => ({
      feishuAppId: id,
      appId: 'cli_reviewer',
      submittedAt: now,
      submitted: true as const,
    })),
    startFeishuAppRegistration: vi.fn(async () => makeFeishuAppRegistrationDto()),
    getFeishuAppRegistration: vi.fn(async () => makeFeishuAppRegistrationDto()),
    cancelFeishuAppRegistration: vi.fn(async () =>
      makeFeishuAppRegistrationDto({
        status: 'cancelled',
        error: 'Registration cancelled',
      }),
    ),
    bindBot: vi.fn(async (_scope, input) => ({
      id: '00000000-0000-4000-8000-000000000004',
      agentId: input.agentId,
      feishuAppId: input.feishuAppId,
      botOpenId: 'ou_bot',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    })),
    unbindBot: vi.fn(async () => {
      throw new Error('not needed');
    }),
    listChats: vi.fn(async () => [
      {
        tenantKey: 'default',
        chatId: 'oc_test',
        displayName: 'Engineering',
        openFeishuUrl: buildFeishuChatOpenUrl('oc_test'),
        defaultWorkDir: null,
        defaultRuntime: null,
        defaultAgentId: null,
        defaultAgent: null,
        defaultMachineId: null,
        defaultMachineName: null,
        memoryEnabled: false,
        memorySummaryNextRunAt: null,
        memorySummaryLastRunAt: null,
        memorySummaryLastStatus: null,
        memorySummaryLastError: null,
        agents: [
          {
            id: '00000000-0000-4000-8000-000000000002',
            handle: 'reviewer',
            displayName: 'Reviewer',
            status: 'active',
            taskCount: 1,
            lastTaskAt: now,
          },
        ],
        taskBoard: {
          id: '00000000-0000-4000-8000-000000000005',
          name: 'Engineering任务看板',
          tasklistGuid: 'tl_test',
          openTasklistUrl: buildFeishuTasklistOpenUrl('tl_test'),
          taskCount: 1,
        },
        taskCount: 1,
        lastTaskAt: null,
        createdAt: now,
        updatedAt: now,
      },
    ]),
    updateChat: vi.fn(async () => {
      throw new Error('not needed');
    }),
    listTaskBoards: vi.fn(async () => [
      {
        id: '00000000-0000-4000-8000-000000000005',
        name: 'Engineering任务看板',
        scopeType: 'chat',
        scopeId: 'default:oc_test',
        chatId: 'oc_test',
        chatDisplayName: 'Engineering',
        tasklistGuid: 'tl_test',
        openTasklistUrl: buildFeishuTasklistOpenUrl('tl_test'),
        openChatUrl: buildFeishuChatOpenUrl('oc_test'),
        statusFieldGuid: 'field_status',
        statusOptions: {},
        sections: {},
        tasks: [
          {
            id: '00000000-0000-4000-8000-000000000007',
            taskId: '00000000-0000-4000-8000-000000000008',
            trackingSpaceId: '00000000-0000-4000-8000-000000000005',
            sessionId: '00000000-0000-4000-8000-000000000009',
            chatId: 'oc_test',
            title: 'Ship readable boards',
            taskType: 'coding',
            localStatus: 'running',
            trackingStatus: 'in-progress',
            runtimeHint: 'codex',
            feishuTaskGuid: 'ft_test',
            openTaskUrl: 'https://applink.example.com/client/todo/detail?guid=ft_test',
            sourceTopicUrl: 'https://applink.feishu.cn/client/chat/topic',
            lastSyncError: null,
            runs: [
              {
                id: '00000000-0000-4000-8000-000000000012',
                taskId: '00000000-0000-4000-8000-000000000008',
                runtimeBackend: 'codex',
                mode: 'one_shot',
                workspacePath: '/tmp/open-claude-tag/session',
                externalSessionRef: null,
                status: 'running',
                exitCode: null,
                startedAt: now,
                completedAt: null,
                lastHeartbeatAt: now,
                eventCount: 2,
                events: [
                  {
                    id: '00000000-0000-4000-8000-000000000013',
                    runId: '00000000-0000-4000-8000-000000000012',
                    taskId: '00000000-0000-4000-8000-000000000008',
                    eventIndex: 1,
                    eventType: 'status',
                    message: 'Starting Codex...',
                    progress: null,
                    payload: { type: 'status', message: 'Starting Codex...' },
                    createdAt: now,
                  },
                  {
                    id: '00000000-0000-4000-8000-000000000014',
                    runId: '00000000-0000-4000-8000-000000000012',
                    taskId: '00000000-0000-4000-8000-000000000008',
                    eventIndex: 2,
                    eventType: 'progress',
                    message: 'Reading files',
                    progress: 35,
                    payload: { type: 'progress', percent: 35, message: 'Reading files' },
                    createdAt: now,
                  },
                ],
              },
            ],
            createdAt: now,
            updatedAt: now,
          },
        ],
        taskCount: 1,
        statusCounts: {
          todo: 0,
          'in-progress': 1,
          'to-clarify': 0,
          review: 0,
          completed: 0,
          cleaned: 0,
          unknown: 0,
        },
        createdAt: now,
        updatedAt: now,
      },
    ]),
    listTaskBoardTasks: vi.fn(async () => [
      {
        id: '00000000-0000-4000-8000-000000000007',
        taskId: '00000000-0000-4000-8000-000000000008',
        trackingSpaceId: '00000000-0000-4000-8000-000000000005',
        sessionId: '00000000-0000-4000-8000-000000000009',
        chatId: 'oc_test',
        title: 'Ship readable boards',
        taskType: 'coding',
        localStatus: 'running',
        trackingStatus: 'in-progress',
        runtimeHint: 'codex',
        feishuTaskGuid: 'ft_test',
        openTaskUrl: 'https://applink.example.com/client/todo/detail?guid=ft_test',
        sourceTopicUrl: 'https://applink.feishu.cn/client/chat/topic',
        lastSyncError: null,
        runs: [],
        createdAt: now,
        updatedAt: now,
      },
    ]),
    ...overrides,
  };
  return store;
}

// Default routes run with `adminToken` so non-loopback test injections fall to the
// break-glass superadmin path (the legacy default for these route-shape tests).
function makeApp(
  store = makeStore(),
  afterFeishuRuntimeChange?: () => Promise<void>,
  extra?: { serverPublicUrl?: string | null; daemonVersion?: string | null },
) {
  const app = Fastify({ logger: false });
  registerAdminApiRoutes(app, {
    store,
    adminToken: 'secret-token',
    afterFeishuRuntimeChange,
    ...extra,
  });
  return app;
}

function tokenHeaders() {
  return { authorization: 'Bearer secret-token' };
}

describe('admin api routes', () => {
  it('lists summary and backend-owned Feishu links', async () => {
    const app = makeApp();

    const summary = await app.inject({
      method: 'GET',
      url: '/admin/summary',
      headers: tokenHeaders(),
    });
    expect(summary.statusCode).toBe(200);
    expect(summary.json()).toMatchObject({ agents: 1, taskBoards: 1 });

    const chats = await app.inject({ method: 'GET', url: '/admin/chats', headers: tokenHeaders() });
    expect(chats.statusCode).toBe(200);
    expect(chats.json()[0].openFeishuUrl).toBe(
      'https://applink.feishu.cn/client/chat/open?openChatId=oc_test',
    );

    const boards = await app.inject({
      method: 'GET',
      url: '/admin/task-boards',
      headers: tokenHeaders(),
    });
    expect(boards.json()[0].openTasklistUrl).toBe(
      'https://applink.feishu.cn/client/todo/task_list?guid=tl_test',
    );
    expect(boards.json()[0].tasks[0].runs[0].events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventIndex: 1,
          eventType: 'status',
          message: 'Starting Codex...',
        }),
        expect.objectContaining({
          eventIndex: 2,
          eventType: 'progress',
          message: 'Reading files',
          progress: 35,
        }),
      ]),
    );
  });

  it('passes task board pagination through the admin routes', async () => {
    const store = makeStore();
    const app = makeApp(store);

    const boards = await app.inject({
      method: 'GET',
      url: '/admin/task-boards?taskLimit=5',
      headers: tokenHeaders(),
    });
    expect(boards.statusCode).toBe(200);
    expect(store.listTaskBoards).toHaveBeenCalledWith(SUPERADMIN_SCOPE, { taskLimit: 5 });

    const tasks = await app.inject({
      method: 'GET',
      url: '/admin/task-boards/00000000-0000-4000-8000-000000000005/tasks?offset=5&limit=5&status=in-progress',
      headers: tokenHeaders(),
    });
    expect(tasks.statusCode).toBe(200);
    expect(tasks.json()[0].title).toBe('Ship readable boards');
    expect(store.listTaskBoardTasks).toHaveBeenCalledWith(
      SUPERADMIN_SCOPE,
      '00000000-0000-4000-8000-000000000005',
      { offset: 5, limit: 5, status: 'in-progress' },
    );
  });

  // ── B4: offset is bounded so a huge value fails validation (400), not the store ──
  it('rejects a task-board tasks offset beyond the allowed maximum with 400', async () => {
    const store = makeStore();
    const app = makeApp(store);

    const response = await app.inject({
      method: 'GET',
      url: '/admin/task-boards/00000000-0000-4000-8000-000000000005/tasks?offset=100001',
      headers: tokenHeaders(),
    });
    expect(response.statusCode).toBe(400);
    expect(store.listTaskBoardTasks).not.toHaveBeenCalled();

    // The maximum itself is still accepted (boundary stays usable).
    const atMax = await app.inject({
      method: 'GET',
      url: '/admin/task-boards/00000000-0000-4000-8000-000000000005/tasks?offset=100000',
      headers: tokenHeaders(),
    });
    expect(atMax.statusCode).toBe(200);
  });

  it('redacts Feishu app secrets by returning only secret refs and storage state', async () => {
    const app = makeApp(
      makeStore({
        listFeishuApps: vi.fn(async () => [
          makeAppDto({ appSecretRef: 'stored', hasStoredSecret: true }),
        ]),
      }),
    );

    const response = await app.inject({
      method: 'GET',
      url: '/admin/feishu-apps',
      headers: tokenHeaders(),
    });
    expect(response.statusCode).toBe(200);
    const bodyText = response.body;
    expect(bodyText).toContain('"hasStoredSecret":true');
    expect(bodyText).not.toContain('appSecret"');
    expect(bodyText).not.toContain('plain_secret');
  });

  it('checks Feishu app permission grants through the admin route', async () => {
    const store = makeStore();
    const app = makeApp(store);

    const response = await app.inject({
      method: 'POST',
      url: '/admin/feishu-apps/00000000-0000-4000-8000-000000000003/permission-check',
    });

    expect(response.statusCode).toBe(200);
    expect(store.checkFeishuAppPermissions).toHaveBeenCalledWith(
      SUPERADMIN_SCOPE,
      '00000000-0000-4000-8000-000000000003',
    );
    expect(response.json()).toMatchObject({
      status: 'pass',
      missingRequiredCapabilities: [],
      capabilities: [
        {
          id: 'send-message-as-bot',
          status: 'ok',
        },
      ],
    });
  });

  it('submits Feishu app permission approval through the admin route', async () => {
    const applyFeishuAppPermissions = vi.fn(async (_scope, id) => ({
      feishuAppId: id,
      appId: 'cli_reviewer',
      submittedAt: now,
      submitted: true as const,
    }));
    const store = makeStore({
      applyFeishuAppPermissions,
    } as Partial<AdminApiStore>);

    const app = makeApp(store);

    const response = await app.inject({
      method: 'POST',
      url: '/admin/feishu-apps/00000000-0000-4000-8000-000000000003/permission-apply',
      headers: tokenHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(applyFeishuAppPermissions).toHaveBeenCalledWith(
      SUPERADMIN_SCOPE,
      '00000000-0000-4000-8000-000000000003',
    );
    expect(response.json()).toMatchObject({
      feishuAppId: '00000000-0000-4000-8000-000000000003',
      appId: 'cli_reviewer',
      submitted: true,
    });
  });

  it('starts one-click Feishu app registration through the admin route', async () => {
    const store = makeStore();
    const app = makeApp(store);

    const response = await app.inject({
      method: 'POST',
      url: '/admin/feishu-apps/one-click-registration',
      payload: {
        botName: 'Reviewer Bot',
        description: 'Reviews code in Feishu',
      },
      headers: tokenHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(store.startFeishuAppRegistration).toHaveBeenCalledWith(SUPERADMIN_SCOPE, {
      botName: 'Reviewer Bot',
      description: 'Reviews code in Feishu',
    });
    expect(response.json()).toMatchObject({
      status: 'pending',
      verificationUrl: expect.stringContaining('/page/launcher'),
    });
  });

  it('polls and cancels one-click Feishu app registration sessions', async () => {
    const store = makeStore();
    const app = makeApp(store);
    const registrationId = '00000000-0000-4000-8000-0000000000f1';

    const status = await app.inject({
      method: 'GET',
      url: `/admin/feishu-apps/one-click-registration/${registrationId}`,
      headers: tokenHeaders(),
    });
    const cancelled = await app.inject({
      method: 'DELETE',
      url: `/admin/feishu-apps/one-click-registration/${registrationId}`,
      headers: tokenHeaders(),
    });

    expect(status.statusCode).toBe(200);
    expect(store.getFeishuAppRegistration).toHaveBeenCalledWith(SUPERADMIN_SCOPE, registrationId);
    expect(cancelled.statusCode).toBe(200);
    expect(store.cancelFeishuAppRegistration).toHaveBeenCalledWith(
      SUPERADMIN_SCOPE,
      registrationId,
    );
    expect(cancelled.json()).toMatchObject({ status: 'cancelled' });
  });

  it('returns missing required and optional permission gaps from the checker', async () => {
    const store = makeStore({
      checkFeishuAppPermissions: vi.fn(
        async (_scope, id): Promise<FeishuAppPermissionCheckDto> => ({
          feishuAppId: id,
          appId: 'cli_reviewer',
          checkedAt: new Date('2026-06-06T00:00:00Z'),
          status: 'fail',
          grantedScopes: [],
          inventoryScopes: ['im:message:send_as_bot', 'im:message.group_msg:readonly'],
          extraGrantedScopes: [],
          missingRequiredCapabilities: ['send-message-as-bot'],
          optionalMissingCapabilities: ['read-group-message'],
          capabilities: [
            {
              id: 'send-message-as-bot',
              label: 'Send and reply as bot',
              severity: 'required',
              status: 'missing',
              groups: [{ anyOf: ['im:message:send_as_bot'], satisfiedBy: null }],
            },
            {
              id: 'read-group-message',
              label: 'Read non-@ group message content',
              severity: 'optional',
              status: 'optional_missing',
              groups: [{ anyOf: ['im:message.group_msg:readonly'], satisfiedBy: null }],
            },
          ],
          notes: ['Scope check only'],
        }),
      ),
    });
    const app = makeApp(store);

    const response = await app.inject({
      method: 'POST',
      url: '/admin/feishu-apps/00000000-0000-4000-8000-000000000003/permission-check',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'fail',
      missingRequiredCapabilities: ['send-message-as-bot'],
      optionalMissingCapabilities: ['read-group-message'],
    });
  });

  it('returns not found when checking an unknown Feishu app', async () => {
    const store = makeStore({
      checkFeishuAppPermissions: vi.fn(async () => {
        throw new AdminApiError(404, 'Feishu app not found');
      }),
    });
    const app = makeApp(store);

    const response = await app.inject({
      method: 'POST',
      url: '/admin/feishu-apps/00000000-0000-4000-8000-000000000099/permission-check',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error).toBe('Feishu app not found');
  });

  it('returns redacted secret resolution errors for permission checks', async () => {
    const store = makeStore({
      checkFeishuAppPermissions: vi.fn(async () => {
        throw new AdminApiError(
          409,
          'Feishu app secret env var FEISHU_MISSING_SECRET is not configured',
        );
      }),
    });
    const app = makeApp(store);

    const response = await app.inject({
      method: 'POST',
      url: '/admin/feishu-apps/00000000-0000-4000-8000-000000000003/permission-check',
    });

    expect(response.statusCode).toBe(409);
    expect(response.body).toContain('FEISHU_MISSING_SECRET');
    expect(response.body).not.toContain('plain-secret-value');
  });

  it('returns readable Feishu upstream errors for permission checks', async () => {
    const store = makeStore({
      checkFeishuAppPermissions: vi.fn(async () => {
        throw new AdminApiError(502, 'Feishu app permission check failed: tenant token denied');
      }),
    });
    const app = makeApp(store);

    const response = await app.inject({
      method: 'POST',
      url: '/admin/feishu-apps/00000000-0000-4000-8000-000000000003/permission-check',
    });

    expect(response.statusCode).toBe(502);
    expect(response.json().error).toBe('Feishu app permission check failed: tenant token denied');
  });

  it('checks Feishu permissions with env secret refs before stored secrets', async () => {
    const previousSecret = process.env.FEISHU_REVIEWER_PERMISSION_SECRET;
    process.env.FEISHU_REVIEWER_PERMISSION_SECRET = 'env-secret-value';
    const feishuAppRow = {
      id: '00000000-0000-4000-8000-000000000003',
      appId: 'cli_reviewer',
      appSecretRef: 'env:FEISHU_REVIEWER_PERMISSION_SECRET',
      appSecret: 'stale-stored-secret',
    };
    const limit = vi.fn(async () => [feishuAppRow]);
    const where = vi.fn(() => ({ limit }));
    const from = vi.fn(() => ({ where }));
    const db = { select: vi.fn(() => ({ from })) };
    const listApplicationScopes = vi.fn(async () => []);
    const createFeishuClient = vi.fn(() => ({
      listApplicationScopes,
      applyApplicationScopes: vi.fn(),
    }));

    try {
      const store = createDrizzleAdminApiStore(
        db as unknown as Parameters<typeof createDrizzleAdminApiStore>[0],
        { createFeishuClient },
      );
      const result = await store.checkFeishuAppPermissions(SUPERADMIN_SCOPE, feishuAppRow.id);

      expect(result.feishuAppId).toBe(feishuAppRow.id);
      expect(createFeishuClient).toHaveBeenCalledWith({
        appId: 'cli_reviewer',
        appSecret: 'env-secret-value',
      });
      expect(listApplicationScopes).toHaveBeenCalledTimes(1);
    } finally {
      if (previousSecret === undefined) {
        delete process.env.FEISHU_REVIEWER_PERMISSION_SECRET;
      } else {
        process.env.FEISHU_REVIEWER_PERMISSION_SECRET = previousSecret;
      }
    }
  });

  it('does not require Feishu Task scopes when task tracking is disabled', async () => {
    const feishuAppRow = {
      id: '00000000-0000-4000-8000-000000000003',
      appId: 'cli_reviewer',
      appSecretRef: 'stored',
      appSecret: 'stored-secret-value',
    };
    const limit = vi.fn(async () => [feishuAppRow]);
    const where = vi.fn(() => ({ limit }));
    const from = vi.fn(() => ({ where }));
    const db = { select: vi.fn(() => ({ from })) };
    const listApplicationScopes = vi.fn(async () => [
      { scopeName: 'im:message.p2p_msg:readonly', grantStatus: 1 },
      { scopeName: 'im:message.group_at_msg:readonly', grantStatus: 1 },
      { scopeName: 'im:message:send_as_bot', grantStatus: 1 },
      { scopeName: 'im:message:update', grantStatus: 1 },
      { scopeName: 'im:message.reactions:write_only', grantStatus: 1 },
      { scopeName: 'im:message:readonly', grantStatus: 1 },
      { scopeName: 'im:resource', grantStatus: 1 },
      { scopeName: 'docs:event:subscribe', grantStatus: 1 },
      { scopeName: 'docs:document.comment:read', grantStatus: 1 },
      { scopeName: 'docs:document.comment:create', grantStatus: 1 },
      { scopeName: 'im:chat:read', grantStatus: 1 },
      { scopeName: 'im:chat.members:read', grantStatus: 1 },
    ]);
    const createFeishuClient = vi.fn(() => ({
      listApplicationScopes,
      applyApplicationScopes: vi.fn(),
    }));
    const store = createDrizzleAdminApiStore(
      db as unknown as Parameters<typeof createDrizzleAdminApiStore>[0],
      { createFeishuClient, feishuTaskTrackingEnabled: false },
    );

    const result = await store.checkFeishuAppPermissions(SUPERADMIN_SCOPE, feishuAppRow.id);

    expect(result.status).toBe('pass');
    expect(result.inventoryScopes.some((scope) => scope.startsWith('task:'))).toBe(false);
    expect(result.missingRequiredCapabilities).toEqual([]);
  });

  it('requires Feishu Task scopes when task tracking is enabled', async () => {
    const feishuAppRow = {
      id: '00000000-0000-4000-8000-000000000003',
      appId: 'cli_reviewer',
      appSecretRef: 'stored',
      appSecret: 'stored-secret-value',
    };
    const limit = vi.fn(async () => [feishuAppRow]);
    const where = vi.fn(() => ({ limit }));
    const from = vi.fn(() => ({ where }));
    const db = { select: vi.fn(() => ({ from })) };
    const listApplicationScopes = vi.fn(async () => [
      { scopeName: 'im:message.p2p_msg:readonly', grantStatus: 1 },
      { scopeName: 'im:message.group_at_msg:readonly', grantStatus: 1 },
      { scopeName: 'im:message:send_as_bot', grantStatus: 1 },
      { scopeName: 'im:message:update', grantStatus: 1 },
      { scopeName: 'im:message.reactions:write_only', grantStatus: 1 },
      { scopeName: 'im:message:readonly', grantStatus: 1 },
      { scopeName: 'im:resource', grantStatus: 1 },
      { scopeName: 'docs:event:subscribe', grantStatus: 1 },
      { scopeName: 'docs:document.comment:read', grantStatus: 1 },
      { scopeName: 'docs:document.comment:create', grantStatus: 1 },
      { scopeName: 'im:chat:read', grantStatus: 1 },
      { scopeName: 'im:chat.members:read', grantStatus: 1 },
    ]);
    const createFeishuClient = vi.fn(() => ({
      listApplicationScopes,
      applyApplicationScopes: vi.fn(),
    }));
    const store = createDrizzleAdminApiStore(
      db as unknown as Parameters<typeof createDrizzleAdminApiStore>[0],
      { createFeishuClient, feishuTaskTrackingEnabled: true },
    );

    const result = await store.checkFeishuAppPermissions(SUPERADMIN_SCOPE, feishuAppRow.id);

    expect(result.status).toBe('fail');
    expect(result.missingRequiredCapabilities).toEqual([
      'tasklist-management',
      'custom-field-management',
      'section-management',
      'task-management',
    ]);
  });

  it('applies Feishu permissions with env secret refs before stored secrets', async () => {
    const previousSecret = process.env.FEISHU_REVIEWER_PERMISSION_SECRET;
    process.env.FEISHU_REVIEWER_PERMISSION_SECRET = 'env-secret-value';
    const feishuAppRow = {
      id: '00000000-0000-4000-8000-000000000003',
      appId: 'cli_reviewer',
      appSecretRef: 'env:FEISHU_REVIEWER_PERMISSION_SECRET',
      appSecret: 'stale-stored-secret',
      status: 'enabled',
      platformOwnerId: null,
    };
    const limit = vi.fn(async () => [feishuAppRow]);
    const where = vi.fn(() => ({ limit }));
    const from = vi.fn(() => ({ where }));
    const db = { select: vi.fn(() => ({ from })) };
    const applyApplicationScopes = vi.fn(async () => ({ submitted: true as const }));
    const createFeishuClient = vi.fn(() => ({
      listApplicationScopes: vi.fn(),
      applyApplicationScopes,
    }));

    try {
      const store = createDrizzleAdminApiStore(
        db as unknown as Parameters<typeof createDrizzleAdminApiStore>[0],
        { createFeishuClient },
      );
      const result = await store.applyFeishuAppPermissions(SUPERADMIN_SCOPE, feishuAppRow.id);

      expect(result).toMatchObject({
        feishuAppId: feishuAppRow.id,
        appId: 'cli_reviewer',
        submitted: true,
      });
      expect(createFeishuClient).toHaveBeenCalledWith({
        appId: 'cli_reviewer',
        appSecret: 'env-secret-value',
      });
      expect(applyApplicationScopes).toHaveBeenCalledTimes(1);
    } finally {
      if (previousSecret === undefined) {
        delete process.env.FEISHU_REVIEWER_PERMISSION_SECRET;
      } else {
        process.env.FEISHU_REVIEWER_PERMISSION_SECRET = previousSecret;
      }
    }
  });

  it('returns redacted secret resolution errors for permission apply', async () => {
    const feishuAppRow = {
      id: '00000000-0000-4000-8000-000000000003',
      appId: 'cli_reviewer',
      appSecretRef: 'env:FEISHU_MISSING_PERMISSION_SECRET',
      appSecret: null,
      status: 'enabled',
      platformOwnerId: null,
    };
    const limit = vi.fn(async () => [feishuAppRow]);
    const where = vi.fn(() => ({ limit }));
    const from = vi.fn(() => ({ where }));
    const db = { select: vi.fn(() => ({ from })) };
    const applyApplicationScopes = vi.fn(async () => ({ submitted: true as const }));
    const createFeishuClient = vi.fn(() => ({
      listApplicationScopes: vi.fn(),
      applyApplicationScopes,
    }));
    const store = createDrizzleAdminApiStore(
      db as unknown as Parameters<typeof createDrizzleAdminApiStore>[0],
      { createFeishuClient },
    );

    await expect(
      store.applyFeishuAppPermissions(SUPERADMIN_SCOPE, feishuAppRow.id),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: 'Feishu app secret env var FEISHU_MISSING_PERMISSION_SECRET is not configured',
    });
    expect(createFeishuClient).not.toHaveBeenCalled();
    expect(applyApplicationScopes).not.toHaveBeenCalled();
  });

  it('returns readable Feishu upstream errors for permission apply', async () => {
    const feishuAppRow = {
      id: '00000000-0000-4000-8000-000000000003',
      appId: 'cli_reviewer',
      appSecretRef: 'stored',
      appSecret: 'stored-secret-value',
      status: 'enabled',
      platformOwnerId: null,
    };
    const limit = vi.fn(async () => [feishuAppRow]);
    const where = vi.fn(() => ({ limit }));
    const from = vi.fn(() => ({ where }));
    const db = { select: vi.fn(() => ({ from })) };
    const applyApplicationScopes = vi.fn(async () => {
      throw new Error('apply frequency limited');
    });
    const createFeishuClient = vi.fn(() => ({
      listApplicationScopes: vi.fn(),
      applyApplicationScopes,
    }));
    const store = createDrizzleAdminApiStore(
      db as unknown as Parameters<typeof createDrizzleAdminApiStore>[0],
      { createFeishuClient },
    );

    await expect(
      store.applyFeishuAppPermissions(SUPERADMIN_SCOPE, feishuAppRow.id),
    ).rejects.toMatchObject({
      statusCode: 502,
      message: 'Feishu app permission apply failed: apply frequency limited',
    });
  });

  it('returns actionable no-pending-scope results for permission apply', async () => {
    const feishuAppRow = {
      id: '00000000-0000-4000-8000-000000000003',
      appId: 'cli_reviewer',
      appSecretRef: 'stored',
      appSecret: 'stored-secret-value',
      status: 'enabled',
      platformOwnerId: null,
    };
    const limit = vi.fn(async () => [feishuAppRow]);
    const where = vi.fn(() => ({ limit }));
    const from = vi.fn(() => ({ where }));
    const db = { select: vi.fn(() => ({ from })) };
    const applyApplicationScopes = vi.fn(async () => {
      const error = new Error(
        'applyApplicationScopes failed: HTTP 400 {"code":212002,"msg":"unauthorized scopes were empty"}',
      ) as Error & { details: { status: number; body: string } };
      error.details = {
        status: 400,
        body: '{"code":212002,"msg":"unauthorized scopes were empty"}',
      };
      throw error;
    });
    const createFeishuClient = vi.fn(() => ({
      listApplicationScopes: vi.fn(),
      applyApplicationScopes,
    }));
    const store = createDrizzleAdminApiStore(
      db as unknown as Parameters<typeof createDrizzleAdminApiStore>[0],
      { createFeishuClient },
    );

    await expect(
      store.applyFeishuAppPermissions(SUPERADMIN_SCOPE, feishuAppRow.id),
    ).resolves.toMatchObject({
      feishuAppId: feishuAppRow.id,
      appId: 'cli_reviewer',
      submitted: false,
      status: 'no_pending_scopes',
      message:
        "No pending app-version scopes can be submitted for approval. Add the missing scopes to this app's permission configuration in Feishu Open Platform, publish or approve that app version, then run Check permissions again.",
    });
  });

  it('recognizes Feishu empty scope apply errors from error details code', async () => {
    const feishuAppRow = {
      id: '00000000-0000-4000-8000-000000000003',
      appId: 'cli_reviewer',
      appSecretRef: 'stored',
      appSecret: 'stored-secret-value',
      status: 'enabled',
      platformOwnerId: null,
    };
    const limit = vi.fn(async () => [feishuAppRow]);
    const where = vi.fn(() => ({ limit }));
    const from = vi.fn(() => ({ where }));
    const db = { select: vi.fn(() => ({ from })) };
    const applyApplicationScopes = vi.fn(async () => {
      const error = new Error('applyApplicationScopes failed: code 212002') as Error & {
        details: { code: number };
      };
      error.details = { code: 212002 };
      throw error;
    });
    const createFeishuClient = vi.fn(() => ({
      listApplicationScopes: vi.fn(),
      applyApplicationScopes,
    }));
    const store = createDrizzleAdminApiStore(
      db as unknown as Parameters<typeof createDrizzleAdminApiStore>[0],
      { createFeishuClient },
    );

    await expect(
      store.applyFeishuAppPermissions(SUPERADMIN_SCOPE, feishuAppRow.id),
    ).resolves.toMatchObject({
      feishuAppId: feishuAppRow.id,
      appId: 'cli_reviewer',
      submitted: false,
      status: 'no_pending_scopes',
      message:
        "No pending app-version scopes can be submitted for approval. Add the missing scopes to this app's permission configuration in Feishu Open Platform, publish or approve that app version, then run Check permissions again.",
    });
  });

  it.each([
    [
      'details code',
      () => {
        const error = new Error('applyApplicationScopes failed: duplicate apply') as Error & {
          details: { code: number };
        };
        error.details = { code: 212004 };
        return error;
      },
    ],
    [
      'JSON response body',
      () => {
        const error = new Error(
          'applyApplicationScopes failed: HTTP 400 {"code":212004,"msg":"duplicate apply"}',
        ) as Error & { details: { status: number; body: string } };
        error.details = {
          status: 400,
          body: '{"code":212004,"msg":"duplicate apply"}',
        };
        return error;
      },
    ],
    ['message text', () => new Error('applyApplicationScopes failed: code 212004 duplicate apply')],
  ])(
    'treats duplicate Feishu scope apply errors as submitted from %s',
    async (_name, buildError) => {
      const feishuAppRow = {
        id: '00000000-0000-4000-8000-000000000003',
        appId: 'cli_reviewer',
        appSecretRef: 'stored',
        appSecret: 'stored-secret-value',
        status: 'enabled',
        platformOwnerId: null,
      };
      const limit = vi.fn(async () => [feishuAppRow]);
      const where = vi.fn(() => ({ limit }));
      const from = vi.fn(() => ({ where }));
      const db = { select: vi.fn(() => ({ from })) };
      const applyApplicationScopes = vi.fn(async () => {
        throw buildError();
      });
      const createFeishuClient = vi.fn(() => ({
        listApplicationScopes: vi.fn(),
        applyApplicationScopes,
      }));
      const store = createDrizzleAdminApiStore(
        db as unknown as Parameters<typeof createDrizzleAdminApiStore>[0],
        { createFeishuClient },
      );

      await expect(
        store.applyFeishuAppPermissions(SUPERADMIN_SCOPE, feishuAppRow.id),
      ).resolves.toMatchObject({
        feishuAppId: feishuAppRow.id,
        appId: 'cli_reviewer',
        submitted: true,
        status: 'submitted',
      });
    },
  );

  it('rejects permission apply for apps outside the owner scope without calling Feishu', async () => {
    const feishuAppRow = {
      id: '00000000-0000-4000-8000-000000000003',
      appId: 'cli_reviewer',
      appSecretRef: 'stored',
      appSecret: 'stored-secret-value',
      status: 'enabled',
      platformOwnerId: '00000000-0000-4000-8000-0000000000bb',
    };
    const limit = vi.fn(async () => [feishuAppRow]);
    const where = vi.fn(() => ({ limit }));
    const from = vi.fn(() => ({ where }));
    const db = { select: vi.fn(() => ({ from })) };
    const createFeishuClient = vi.fn(() => ({
      listApplicationScopes: vi.fn(),
      applyApplicationScopes: vi.fn(),
    }));
    const store = createDrizzleAdminApiStore(
      db as unknown as Parameters<typeof createDrizzleAdminApiStore>[0],
      { createFeishuClient },
    );
    const aliceScope: OwnerScope = {
      isSuperadmin: false,
      platformUserId: '00000000-0000-4000-8000-0000000000aa',
      computerAccessEnabled: true,
    };

    await expect(
      store.applyFeishuAppPermissions(aliceScope, feishuAppRow.id),
    ).rejects.toMatchObject({
      statusCode: 404,
      message: 'Feishu app not found',
    });
    expect(createFeishuClient).not.toHaveBeenCalled();
  });

  it('syncs Feishu app bot name from application metadata', async () => {
    const feishuAppRow = {
      id: '00000000-0000-4000-8000-000000000003',
      tenantKey: 'default',
      appId: 'cli_reviewer',
      appSecretRef: 'stored',
      appSecret: 'stored-secret-value',
      botOpenId: 'ou_bot',
      botName: 'Old Bot Name',
      eventMode: 'websocket',
      status: 'enabled',
      platformOwnerId: null,
      createdAt: now,
      updatedAt: now,
    };
    const syncedRow = { ...feishuAppRow, botName: 'Synced Reviewer Bot', updatedAt: now };
    const getApplicationInfo = vi.fn(async () => ({
      appId: 'cli_reviewer',
      appName: 'Synced Reviewer Bot',
      status: 1,
    }));
    const createFeishuClient = vi.fn(() => ({
      getApplicationInfo,
      listApplicationScopes: vi.fn(),
      applyApplicationScopes: vi.fn(),
    }));
    const returning = vi.fn(async () => [{ id: feishuAppRow.id }]);
    const updateWhere = vi.fn(() => ({ returning }));
    const set = vi.fn(() => ({ where: updateWhere }));
    let selectCount = 0;
    const select = vi.fn(() => {
      selectCount += 1;
      if (selectCount === 1) {
        return {
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn(async () => [feishuAppRow]),
            })),
          })),
        };
      }
      if (selectCount === 2) {
        return {
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              orderBy: vi.fn(async () => [syncedRow]),
            })),
          })),
        };
      }
      return { from: vi.fn(async () => []) };
    });
    const db = {
      select,
      update: vi.fn(() => ({ set })),
    };
    const store = createDrizzleAdminApiStore(
      db as unknown as Parameters<typeof createDrizzleAdminApiStore>[0],
      { createFeishuClient },
    );

    const result = await store.syncFeishuAppMetadata(SUPERADMIN_SCOPE, feishuAppRow.id);

    expect(createFeishuClient).toHaveBeenCalledWith({
      appId: 'cli_reviewer',
      appSecret: 'stored-secret-value',
    });
    expect(getApplicationInfo).toHaveBeenCalledWith({ appId: 'cli_reviewer', lang: 'zh_cn' });
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        botName: 'Synced Reviewer Bot',
        updatedAt: expect.any(Date),
      }),
    );
    expect(result).toMatchObject({
      id: feishuAppRow.id,
      appId: 'cli_reviewer',
      botName: 'Synced Reviewer Bot',
    });
    expect(JSON.stringify(result)).not.toContain('stored-secret-value');
  });

  it('does not overwrite Feishu app bot name when metadata sync fails', async () => {
    const feishuAppRow = {
      id: '00000000-0000-4000-8000-000000000003',
      appId: 'cli_reviewer',
      appSecretRef: 'stored',
      appSecret: 'stored-secret-value',
      botName: 'Old Bot Name',
      status: 'enabled',
      platformOwnerId: null,
    };
    const limit = vi.fn(async () => [feishuAppRow]);
    const where = vi.fn(() => ({ limit }));
    const from = vi.fn(() => ({ where }));
    const db = {
      select: vi.fn(() => ({ from })),
      update: vi.fn(),
    };
    const getApplicationInfo = vi.fn(async () => {
      throw new Error('insufficient permission');
    });
    const createFeishuClient = vi.fn(() => ({
      getApplicationInfo,
      listApplicationScopes: vi.fn(),
      applyApplicationScopes: vi.fn(),
    }));
    const store = createDrizzleAdminApiStore(
      db as unknown as Parameters<typeof createDrizzleAdminApiStore>[0],
      { createFeishuClient },
    );

    await expect(
      store.syncFeishuAppMetadata(SUPERADMIN_SCOPE, feishuAppRow.id),
    ).rejects.toMatchObject({
      statusCode: 502,
      message: 'Feishu app metadata sync failed: insufficient permission',
    });
    expect(db.update).not.toHaveBeenCalled();
  });

  it('rejects metadata sync for apps outside the owner scope without calling Feishu', async () => {
    const feishuAppRow = {
      id: '00000000-0000-4000-8000-000000000003',
      appId: 'cli_reviewer',
      appSecretRef: 'stored',
      appSecret: 'stored-secret-value',
      status: 'enabled',
      platformOwnerId: '00000000-0000-4000-8000-0000000000bb',
    };
    const limit = vi.fn(async () => [feishuAppRow]);
    const where = vi.fn(() => ({ limit }));
    const from = vi.fn(() => ({ where }));
    const db = {
      select: vi.fn(() => ({ from })),
      update: vi.fn(),
    };
    const createFeishuClient = vi.fn(() => ({
      getApplicationInfo: vi.fn(),
      listApplicationScopes: vi.fn(),
      applyApplicationScopes: vi.fn(),
    }));
    const store = createDrizzleAdminApiStore(
      db as unknown as Parameters<typeof createDrizzleAdminApiStore>[0],
      { createFeishuClient },
    );
    const aliceScope: OwnerScope = {
      isSuperadmin: false,
      platformUserId: '00000000-0000-4000-8000-0000000000aa',
      computerAccessEnabled: true,
    };

    await expect(store.syncFeishuAppMetadata(aliceScope, feishuAppRow.id)).rejects.toMatchObject({
      statusCode: 404,
      message: 'Feishu app not found',
    });
    expect(createFeishuClient).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it('persists a completed one-click registration as an owned stored-secret app', async () => {
    const ownerScope: OwnerScope = {
      isSuperadmin: false,
      platformUserId: '00000000-0000-4000-8000-0000000000a1',
      computerAccessEnabled: true,
    };
    const returnedRow = {
      id: '00000000-0000-4000-8000-0000000000a3',
      tenantKey: 'default',
      appId: 'cli_one_click',
      appSecretRef: 'stored',
      appSecret: 'sdk-secret',
      botOpenId: null,
      botName: 'Reviewer Bot',
      eventMode: 'websocket',
      status: 'enabled',
      platformOwnerId: ownerScope.platformUserId,
      createdAt: now,
      updatedAt: now,
    };
    const returning = vi.fn(async () => [returnedRow]);
    const values = vi.fn(() => ({ returning }));
    const db = {
      insert: vi.fn(() => ({ values })),
    };
    const registerFeishuApp = vi.fn(
      (options: Parameters<typeof import('@larksuiteoapi/node-sdk').registerApp>[0]) => {
        options.onQRCodeReady({
          url: 'https://open.feishu.cn/page/launcher?user_code=one-click',
          expireIn: 600,
        });
        return Promise.resolve({
          client_id: 'cli_one_click',
          client_secret: 'sdk-secret',
        });
      },
    );
    const applyApplicationScopes = vi.fn(async () => ({ submitted: true as const }));
    const createFeishuClient = vi.fn(() => ({
      listApplicationScopes: vi.fn(),
      applyApplicationScopes,
    }));
    const afterFeishuAppRegistrationComplete = vi.fn(async () => undefined);
    const store = createDrizzleAdminApiStore(
      db as unknown as Parameters<typeof createDrizzleAdminApiStore>[0],
      { registerFeishuApp, createFeishuClient, afterFeishuAppRegistrationComplete },
    );

    const started = await store.startFeishuAppRegistration(ownerScope, {
      botName: 'Reviewer Bot',
      description: 'Reviews code',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const completed = await store.getFeishuAppRegistration(ownerScope, started.id);

    expect(started).toMatchObject({
      status: 'pending',
      verificationUrl: expect.stringContaining('user_code=one-click'),
    });
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: 'cli_one_click',
        appSecret: 'sdk-secret',
        appSecretRef: 'stored',
        botName: 'Reviewer Bot',
        platformOwnerId: ownerScope.platformUserId,
        eventMode: 'websocket',
        status: 'enabled',
      }),
    );
    expect(completed).toMatchObject({
      status: 'completed',
      app: {
        id: returnedRow.id,
        appId: 'cli_one_click',
        hasStoredSecret: true,
        botName: 'Reviewer Bot',
      },
    });
    expect(JSON.stringify(completed)).not.toContain('sdk-secret');
    expect(createFeishuClient).toHaveBeenCalledWith({
      appId: 'cli_one_click',
      appSecret: 'sdk-secret',
    });
    expect(applyApplicationScopes).toHaveBeenCalledTimes(1);
    expect(afterFeishuAppRegistrationComplete).toHaveBeenCalledTimes(1);
  });

  it('keeps one-click registration completed when permission approval fails after persistence', async () => {
    const returnedRow = {
      id: '00000000-0000-4000-8000-0000000000a3',
      tenantKey: 'default',
      appId: 'cli_one_click',
      appSecretRef: 'stored',
      appSecret: 'sdk-secret',
      botOpenId: null,
      botName: 'Reviewer Bot',
      eventMode: 'websocket',
      status: 'enabled',
      platformOwnerId: null,
      createdAt: now,
      updatedAt: now,
    };
    const returning = vi.fn(async () => [returnedRow]);
    const values = vi.fn(() => ({ returning }));
    const db = {
      insert: vi.fn(() => ({ values })),
    };
    const registerFeishuApp = vi.fn(
      (options: Parameters<typeof import('@larksuiteoapi/node-sdk').registerApp>[0]) => {
        options.onQRCodeReady({
          url: 'https://open.feishu.cn/page/launcher?user_code=one-click',
          expireIn: 600,
        });
        return Promise.resolve({
          client_id: 'cli_one_click',
          client_secret: 'sdk-secret',
        });
      },
    );
    const applyApplicationScopes = vi.fn(async () => {
      throw new Error('approval failed');
    });
    const createFeishuClient = vi.fn(() => ({
      listApplicationScopes: vi.fn(),
      applyApplicationScopes,
    }));
    const afterFeishuAppRegistrationComplete = vi.fn(async () => undefined);
    const store = createDrizzleAdminApiStore(
      db as unknown as Parameters<typeof createDrizzleAdminApiStore>[0],
      { registerFeishuApp, createFeishuClient, afterFeishuAppRegistrationComplete },
    );

    const started = await store.startFeishuAppRegistration(SUPERADMIN_SCOPE, {
      botName: 'Reviewer Bot',
      description: 'Reviews code',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const completed = await store.getFeishuAppRegistration(SUPERADMIN_SCOPE, started.id);

    expect(completed).toMatchObject({
      status: 'completed',
      app: {
        id: returnedRow.id,
        appId: 'cli_one_click',
      },
      error: expect.stringContaining('permission approval failed:'),
    });
    expect(completed.error).toContain('approval failed');
    expect(afterFeishuAppRegistrationComplete).toHaveBeenCalledTimes(1);
  });

  it('keeps one-click registration completed when runtime reload fails after persistence', async () => {
    const returnedRow = {
      id: '00000000-0000-4000-8000-0000000000a3',
      tenantKey: 'default',
      appId: 'cli_one_click',
      appSecretRef: 'stored',
      appSecret: 'sdk-secret',
      botOpenId: null,
      botName: 'Reviewer Bot',
      eventMode: 'websocket',
      status: 'enabled',
      platformOwnerId: null,
      createdAt: now,
      updatedAt: now,
    };
    const returning = vi.fn(async () => [returnedRow]);
    const values = vi.fn(() => ({ returning }));
    const db = {
      insert: vi.fn(() => ({ values })),
    };
    const registerFeishuApp = vi.fn(
      (options: Parameters<typeof import('@larksuiteoapi/node-sdk').registerApp>[0]) => {
        options.onQRCodeReady({
          url: 'https://open.feishu.cn/page/launcher?user_code=one-click',
          expireIn: 600,
        });
        return Promise.resolve({
          client_id: 'cli_one_click',
          client_secret: 'sdk-secret',
        });
      },
    );
    const afterFeishuAppRegistrationComplete = vi.fn(async () => {
      throw new Error('reload failed');
    });
    const applyApplicationScopes = vi.fn(async () => ({ submitted: true as const }));
    const createFeishuClient = vi.fn(() => ({
      listApplicationScopes: vi.fn(),
      applyApplicationScopes,
    }));
    const store = createDrizzleAdminApiStore(
      db as unknown as Parameters<typeof createDrizzleAdminApiStore>[0],
      { registerFeishuApp, createFeishuClient, afterFeishuAppRegistrationComplete },
    );

    const started = await store.startFeishuAppRegistration(SUPERADMIN_SCOPE, {
      botName: 'Reviewer Bot',
      description: 'Reviews code',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const completed = await store.getFeishuAppRegistration(SUPERADMIN_SCOPE, started.id);

    expect(completed).toMatchObject({
      status: 'completed',
      app: {
        id: returnedRow.id,
        appId: 'cli_one_click',
      },
      error: expect.stringContaining('runtime reload failed: reload failed'),
    });
  });

  it('times out one-click registration when the SDK never returns a verification link', async () => {
    let signal: AbortSignal | undefined;
    const registerFeishuApp = vi.fn(
      (options: Parameters<typeof import('@larksuiteoapi/node-sdk').registerApp>[0]) => {
        signal = options.signal;
        return new Promise<
          Awaited<ReturnType<typeof import('@larksuiteoapi/node-sdk').registerApp>>
        >(() => undefined);
      },
    );
    const store = createDrizzleAdminApiStore(
      {} as Parameters<typeof createDrizzleAdminApiStore>[0],
      { registerFeishuApp, feishuAppRegistrationReadyTimeoutMs: 5 },
    );

    const started = store.startFeishuAppRegistration(SUPERADMIN_SCOPE, {
      botName: 'Reviewer Bot',
      description: 'Reviews code',
    });

    await expect(started).rejects.toThrow(
      'Feishu app registration failed: Timed out waiting for Feishu verification link',
    );
    expect(signal?.aborted).toBe(true);
  });

  it('validates mutations before calling the store', async () => {
    const store = makeStore();
    const app = makeApp(store);

    const response = await app.inject({
      method: 'POST',
      url: '/admin/profiles',
      payload: { displayName: 'Missing Name' },
      headers: tokenHeaders(),
    });

    expect(response.statusCode).toBe(400);
    expect(store.createProfile).not.toHaveBeenCalled();
  });

  it('creates bot bindings through the admin store', async () => {
    const store = makeStore();
    const app = makeApp(store);

    const response = await app.inject({
      method: 'POST',
      url: '/admin/bot-bindings',
      payload: {
        agentId: '00000000-0000-4000-8000-000000000010',
        feishuAppId: '00000000-0000-4000-8000-000000000011',
      },
      headers: tokenHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'active', botOpenId: 'ou_bot' });
    expect(store.bindBot).toHaveBeenCalledWith(SUPERADMIN_SCOPE, {
      agentId: '00000000-0000-4000-8000-000000000010',
      feishuAppId: '00000000-0000-4000-8000-000000000011',
    });
  });

  it('accepts agent creation with inline managed profile config', async () => {
    const store = makeStore({
      createAgent: vi.fn(async (_scope, input) =>
        makeAgentDto({
          id: '00000000-0000-4000-8000-000000000020',
          tenantKey: input.tenantKey,
          scopeType: input.scopeType,
          scopeId: input.scopeId,
          handle: input.handle,
          displayName: input.displayName,
          description: input.description ?? null,
          profileId: '00000000-0000-4000-8000-000000000021',
          profile: {
            id: '00000000-0000-4000-8000-000000000021',
            name: 'reviewer-managed',
            displayName: input.profile?.displayName ?? input.displayName,
            status: 'active',
          },
          visibility: input.visibility,
          defaultRuntime: input.defaultRuntime ?? null,
          defaultWorkDir: input.defaultWorkDir ?? null,
          runtimeEnvKeys: Object.keys(input.runtimeEnv ?? {}).sort(),
          status: input.status,
        }),
      ),
    });
    const app = makeApp(store);

    const response = await app.inject({
      method: 'POST',
      url: '/admin/agents',
      payload: {
        handle: 'reviewer',
        displayName: 'Reviewer',
        description: 'Reviews code',
        defaultRuntime: 'codex',
        runtimeEnv: { a: 'b', FEATURE_FLAG: 'enabled' },
        profile: { displayName: 'Reviewer', defaultRuntime: 'codex' },
      },
      headers: tokenHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(store.createAgent).toHaveBeenCalledWith(SUPERADMIN_SCOPE, {
      tenantKey: 'default',
      scopeType: 'system',
      scopeId: 'default',
      handle: 'reviewer',
      displayName: 'Reviewer',
      description: 'Reviews code',
      visibility: 'public',
      defaultRuntime: 'codex',
      runtimeEnv: { a: 'b', FEATURE_FLAG: 'enabled' },
      memoryEnabled: true,
      status: 'active',
      profile: { displayName: 'Reviewer', defaultRuntime: 'codex' },
    });
    expect(response.json()).toMatchObject({
      handle: 'reviewer',
      displayName: 'Reviewer',
      runtimeEnvKeys: ['FEATURE_FLAG', 'a'],
      profile: { displayName: 'Reviewer' },
    });
    expect(response.json()).not.toHaveProperty('runtimeEnv');
  });

  it('rejects invalid agent runtime env keys before calling the store', async () => {
    const store = makeStore();
    const app = makeApp(store);

    const response = await app.inject({
      method: 'POST',
      url: '/admin/agents',
      payload: {
        handle: 'bad-env',
        displayName: 'Bad Env',
        runtimeEnv: { 'bad-key': 'value' },
      },
      headers: tokenHeaders(),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain(
      'runtimeEnv keys must be valid environment variable names',
    );
    expect(store.createAgent).not.toHaveBeenCalled();
  });

  it('does not apply Claude credential pair validation to non-Claude agent creation', async () => {
    const store = makeStore({
      createAgent: vi.fn(async (_scope, input) =>
        makeAgentDto({
          displayName: input.displayName,
          defaultRuntime: input.defaultRuntime ?? null,
          runtimeEnvKeys: Object.keys(input.runtimeEnv ?? {}).sort(),
        }),
      ),
    });
    const app = makeApp(store);

    const response = await app.inject({
      method: 'POST',
      url: '/admin/agents',
      payload: {
        displayName: 'Codex Agent',
        defaultRuntime: 'codex',
        runtimeEnv: { ANTHROPIC_API_KEY: 'sk-non-claude' },
      },
      headers: tokenHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(store.createAgent).toHaveBeenCalledTimes(1);
    expect(response.json().runtimeEnvKeys).toEqual(['ANTHROPIC_API_KEY']);
    expect(response.json()).not.toHaveProperty('runtimeEnv');
  });

  it('accepts a subscription-mode claude_code agent created without ANTHROPIC credentials', async () => {
    const store = makeStore({
      createAgent: vi.fn(async (_scope, input) =>
        makeAgentDto({
          displayName: input.displayName,
          defaultRuntime: input.defaultRuntime ?? null,
          runtimeEnvKeys: Object.keys(input.runtimeEnv ?? {}).sort(),
        }),
      ),
    });
    const app = makeApp(store);

    const response = await app.inject({
      method: 'POST',
      url: '/admin/agents',
      payload: {
        displayName: 'Claude Agent',
        defaultRuntime: 'claude_code',
      },
      headers: tokenHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(store.createAgent).toHaveBeenCalledWith(
      SUPERADMIN_SCOPE,
      expect.objectContaining({
        displayName: 'Claude Agent',
        defaultRuntime: 'claude_code',
      }),
    );
    expect(response.json().runtimeEnvKeys).toEqual([]);
    expect(response.json()).not.toHaveProperty('runtimeEnv');
  });

  it('rejects partial claude_code custom credentials before calling the store', async () => {
    const store = makeStore();
    const app = makeApp(store);

    const withoutBaseUrl = await app.inject({
      method: 'POST',
      url: '/admin/agents',
      payload: {
        displayName: 'Claude Agent',
        defaultRuntime: 'claude_code',
        runtimeEnv: { ANTHROPIC_API_KEY: 'sk-test' },
      },
      headers: tokenHeaders(),
    });
    const withoutApiKey = await app.inject({
      method: 'POST',
      url: '/admin/agents',
      payload: {
        displayName: 'Claude Agent',
        defaultRuntime: 'claude_code',
        runtimeEnv: { ANTHROPIC_BASE_URL: 'https://gateway.example' },
      },
      headers: tokenHeaders(),
    });

    expect(withoutBaseUrl.statusCode).toBe(400);
    expect(withoutBaseUrl.json().error).toContain('ANTHROPIC_BASE_URL');
    expect(withoutApiKey.statusCode).toBe(400);
    expect(withoutApiKey.json().error).toContain('ANTHROPIC_API_KEY');
    expect(store.createAgent).not.toHaveBeenCalled();
  });

  it('rejects a claude_code agent created with a non-URL ANTHROPIC_BASE_URL', async () => {
    const store = makeStore();
    const app = makeApp(store);

    const response = await app.inject({
      method: 'POST',
      url: '/admin/agents',
      payload: {
        displayName: 'Claude Agent',
        defaultRuntime: 'claude_code',
        runtimeEnv: { ANTHROPIC_BASE_URL: 'not-a-url', ANTHROPIC_API_KEY: 'sk-test' },
      },
      headers: tokenHeaders(),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain('ANTHROPIC_BASE_URL');
    expect(store.createAgent).not.toHaveBeenCalled();
  });

  it('accepts a claude_code agent created with valid BASE_URL and API_KEY', async () => {
    const store = makeStore({
      createAgent: vi.fn(async (_scope, input) =>
        makeAgentDto({
          displayName: input.displayName,
          defaultRuntime: input.defaultRuntime ?? null,
          runtimeEnvKeys: Object.keys(input.runtimeEnv ?? {}).sort(),
        }),
      ),
    });
    const app = makeApp(store);

    const response = await app.inject({
      method: 'POST',
      url: '/admin/agents',
      payload: {
        displayName: 'Claude Agent',
        defaultRuntime: 'claude_code',
        runtimeEnv: {
          ANTHROPIC_BASE_URL: 'https://gateway.example/v1',
          ANTHROPIC_API_KEY: 'sk-test',
        },
      },
      headers: tokenHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(store.createAgent).toHaveBeenCalledTimes(1);
    // Secret values are never echoed back — only the key names.
    expect(response.json().runtimeEnvKeys).toEqual(['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL']);
    expect(response.json()).not.toHaveProperty('runtimeEnv');
  });

  it('accepts a subscription-mode Claude agent created via an inline claude_code profile', async () => {
    const store = makeStore({
      createAgent: vi.fn(async (_scope, input) =>
        makeAgentDto({
          displayName: input.displayName,
          defaultRuntime: input.defaultRuntime ?? input.profile?.defaultRuntime ?? null,
          runtimeEnvKeys: Object.keys(input.runtimeEnv ?? {}).sort(),
        }),
      ),
    });
    const app = makeApp(store);

    const response = await app.inject({
      method: 'POST',
      url: '/admin/agents',
      payload: {
        displayName: 'Claude via Profile',
        profile: { displayName: 'Claude via Profile', defaultRuntime: 'claude_code' },
      },
      headers: tokenHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(store.createAgent).toHaveBeenCalledTimes(1);
    expect(response.json().runtimeEnvKeys).toEqual([]);
    expect(response.json()).not.toHaveProperty('runtimeEnv');
  });

  it('rejects partial claude_code custom credentials on agent patch', async () => {
    const store = makeStore();
    const app = makeApp(store);
    const agentId = '00000000-0000-4000-8000-000000000020';

    const response = await app.inject({
      method: 'PATCH',
      url: `/admin/agents/${agentId}`,
      payload: {
        defaultRuntime: 'claude_code',
        runtimeEnv: { ANTHROPIC_BASE_URL: 'https://gateway.example' },
      },
      headers: tokenHeaders(),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain('ANTHROPIC_API_KEY');
    expect(store.updateAgent).not.toHaveBeenCalled();
  });

  it('does not apply Claude credential pair validation to non-Claude agent patch', async () => {
    const store = makeStore({
      updateAgent: vi.fn(async (_scope, id, input) =>
        makeAgentDto({
          id,
          defaultRuntime: input.defaultRuntime ?? null,
          runtimeEnvKeys: Object.keys(input.runtimeEnv ?? {}).sort(),
        }),
      ),
    });
    const app = makeApp(store);
    const agentId = '00000000-0000-4000-8000-000000000020';

    const response = await app.inject({
      method: 'PATCH',
      url: `/admin/agents/${agentId}`,
      payload: {
        defaultRuntime: 'codex',
        runtimeEnv: { ANTHROPIC_API_KEY: 'sk-non-claude' },
      },
      headers: tokenHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(store.updateAgent).toHaveBeenCalledTimes(1);
    expect(response.json().runtimeEnvKeys).toEqual(['ANTHROPIC_API_KEY']);
    expect(response.json()).not.toHaveProperty('runtimeEnv');
  });

  it('forwards the agent machine binding to the store (D-A8)', async () => {
    const machineId = '00000000-0000-4000-8000-000000000099';
    const store = makeStore({
      createAgent: vi.fn(async (_scope, input) =>
        makeAgentDto({
          handle: input.handle,
          displayName: input.displayName,
          machineId: input.machineId ?? null,
          machine: input.machineId
            ? { id: input.machineId, name: 'studio-mbp', status: 'online' }
            : null,
        }),
      ),
    });
    const app = makeApp(store);

    const response = await app.inject({
      method: 'POST',
      url: '/admin/agents',
      payload: { handle: 'bound', displayName: 'Bound Agent', machineId },
      headers: tokenHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(store.createAgent).toHaveBeenCalledWith(
      SUPERADMIN_SCOPE,
      expect.objectContaining({ machineId }),
    );
    expect(response.json()).toMatchObject({
      machineId,
      machine: { id: machineId, name: 'studio-mbp', status: 'online' },
    });
  });

  it('deletes agents through the admin store', async () => {
    const store = makeStore();
    const app = makeApp(store);
    const agentId = '00000000-0000-4000-8000-000000000020';

    const response = await app.inject({
      method: 'DELETE',
      url: `/admin/agents/${agentId}`,
      headers: tokenHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(store.deleteAgent).toHaveBeenCalledWith(SUPERADMIN_SCOPE, agentId);
    expect(response.json()).toMatchObject({ id: agentId, handle: 'reviewer' });
  });

  it('rejects plaintext-looking Feishu app secret refs before calling the store', async () => {
    const store = makeStore();
    const app = makeApp(store);

    const response = await app.inject({
      method: 'POST',
      url: '/admin/feishu-apps',
      payload: { appId: 'cli_plaintext', appSecretRef: 'plain-secret-value-123' },
      headers: tokenHeaders(),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain('appSecretRef must be an env var reference');
    expect(store.createFeishuApp).not.toHaveBeenCalled();
  });

  it('rejects stored secret sentinel without an app secret', async () => {
    const store = makeStore();
    const app = makeApp(store);

    const response = await app.inject({
      method: 'POST',
      url: '/admin/feishu-apps',
      payload: { appId: 'cli_missing_stored_secret', appSecretRef: 'stored' },
      headers: tokenHeaders(),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain('Either an env appSecretRef or appSecret is required');
    expect(store.createFeishuApp).not.toHaveBeenCalled();
  });

  it('accepts env secret refs and normalizes empty optional bot fields', async () => {
    const store = makeStore();
    const app = makeApp(store);

    const response = await app.inject({
      method: 'POST',
      url: '/admin/feishu-apps',
      payload: {
        appId: 'cli_empty_optional',
        appSecretRef: 'env:FEISHU_EMPTY_OPTIONAL_SECRET',
        botName: ' ',
        botOpenId: '',
      },
      headers: tokenHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(store.createFeishuApp).toHaveBeenCalledWith(SUPERADMIN_SCOPE, {
      tenantKey: 'default',
      appId: 'cli_empty_optional',
      appSecretRef: 'env:FEISHU_EMPTY_OPTIONAL_SECRET',
      botName: null,
      botOpenId: null,
      eventMode: 'websocket',
      status: 'enabled',
    });
  });

  it('accepts stored Feishu app secrets without returning the secret', async () => {
    const store = makeStore();
    const app = makeApp(store);

    const response = await app.inject({
      method: 'POST',
      url: '/admin/feishu-apps',
      payload: { appId: 'cli_stored_secret', appSecret: 'plain-secret-value-123' },
      headers: tokenHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(store.createFeishuApp).toHaveBeenCalledWith(SUPERADMIN_SCOPE, {
      tenantKey: 'default',
      appId: 'cli_stored_secret',
      appSecret: 'plain-secret-value-123',
      eventMode: 'websocket',
      status: 'enabled',
    });
    expect(response.body).toContain('"hasStoredSecret":true');
    expect(response.body).not.toContain('plain-secret-value-123');
  });

  it('patches Feishu app bot names through the admin route', async () => {
    const updateFeishuApp = vi.fn(async (_scope, id, input) =>
      makeAppDto({ id, botName: input.botName ?? null }),
    );
    const store = makeStore({ updateFeishuApp });
    const app = makeApp(store);
    const feishuAppId = '00000000-0000-4000-8000-000000000030';

    const response = await app.inject({
      method: 'PATCH',
      url: `/admin/feishu-apps/${feishuAppId}`,
      payload: { botName: 'Reviewer Bot Local' },
      headers: tokenHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(updateFeishuApp).toHaveBeenCalledWith(SUPERADMIN_SCOPE, feishuAppId, {
      botName: 'Reviewer Bot Local',
    });
    expect(response.json()).toMatchObject({ id: feishuAppId, botName: 'Reviewer Bot Local' });
    expect(response.body).not.toContain('plain-secret-value-123');
  });

  it('syncs Feishu app metadata through the admin route', async () => {
    const syncFeishuAppMetadata = vi.fn(async (_scope, id) =>
      makeAppDto({ id, botName: 'Synced Reviewer Bot' }),
    );
    const store = makeStore({ syncFeishuAppMetadata });
    const afterFeishuRuntimeChange = vi.fn(async () => undefined);
    const app = makeApp(store, afterFeishuRuntimeChange);
    const feishuAppId = '00000000-0000-4000-8000-000000000030';

    const response = await app.inject({
      method: 'POST',
      url: `/admin/feishu-apps/${feishuAppId}/sync-metadata`,
      headers: tokenHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(syncFeishuAppMetadata).toHaveBeenCalledWith(SUPERADMIN_SCOPE, feishuAppId);
    expect(response.json()).toMatchObject({ id: feishuAppId, botName: 'Synced Reviewer Bot' });
    expect(response.body).not.toContain('plain-secret-value-123');
    expect(afterFeishuRuntimeChange).toHaveBeenCalledTimes(1);
  });

  it('deletes Feishu apps through the admin store', async () => {
    const store = makeStore();
    const app = makeApp(store);
    const feishuAppId = '00000000-0000-4000-8000-000000000030';

    const response = await app.inject({
      method: 'DELETE',
      url: `/admin/feishu-apps/${feishuAppId}`,
      headers: tokenHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(store.deleteFeishuApp).toHaveBeenCalledWith(SUPERADMIN_SCOPE, feishuAppId);
    expect(response.json()).toMatchObject({ id: feishuAppId, appId: 'cli_reviewer' });
  });

  it('runs the Feishu runtime reload hook after app and binding mutations', async () => {
    const store = makeStore();
    const afterFeishuRuntimeChange = vi.fn(async () => undefined);
    const app = makeApp(store, afterFeishuRuntimeChange);

    await app.inject({
      method: 'POST',
      url: '/admin/feishu-apps',
      payload: { appId: 'cli_reload', appSecret: 'reload-secret' },
      headers: tokenHeaders(),
    });
    await app.inject({
      method: 'POST',
      url: '/admin/bot-bindings',
      payload: {
        agentId: '00000000-0000-4000-8000-000000000010',
        feishuAppId: '00000000-0000-4000-8000-000000000011',
      },
      headers: tokenHeaders(),
    });
    await app.inject({
      method: 'DELETE',
      url: '/admin/agents/00000000-0000-4000-8000-000000000010',
      headers: tokenHeaders(),
    });
    await app.inject({
      method: 'DELETE',
      url: '/admin/feishu-apps/00000000-0000-4000-8000-000000000011',
      headers: tokenHeaders(),
    });
    await app.inject({
      method: 'POST',
      url: '/admin/feishu-apps/00000000-0000-4000-8000-000000000011/sync-metadata',
      headers: tokenHeaders(),
    });

    expect(afterFeishuRuntimeChange).toHaveBeenCalledTimes(5);
  });

  it('guards active bot binding route invariants', () => {
    expect(() =>
      assertActiveBotBindingRouteInvariant({
        agentStatus: 'active',
        appStatus: 'enabled',
        agentTenantKey: 'default',
        appTenantKey: 'default',
      }),
    ).not.toThrow();

    expect(() =>
      assertActiveBotBindingRouteInvariant({
        agentStatus: 'inactive',
        appStatus: 'enabled',
        agentTenantKey: 'default',
        appTenantKey: 'default',
      }),
    ).toThrow(AdminApiError);
    expect(() =>
      assertActiveBotBindingRouteInvariant({
        agentStatus: 'active',
        appStatus: 'disabled',
        agentTenantKey: 'default',
        appTenantKey: 'default',
      }),
    ).toThrow(AdminApiError);
    expect(() =>
      assertActiveBotBindingRouteInvariant({
        agentStatus: 'active',
        appStatus: 'enabled',
        agentTenantKey: 'tenant_a',
        appTenantKey: 'tenant_b',
      }),
    ).toThrow(AdminApiError);
  });

  it('keys task boards by tenant and chat id', () => {
    expect(buildTaskBoardChatKey('chat', 'oc_test')).toBe('default:oc_test');
    expect(buildTaskBoardChatKey('chat', 'tenant_b:oc_test')).toBe('tenant_b:oc_test');
    expect(buildTaskBoardChatKey('global', 'default')).toBeNull();
  });

  it('recovers readable chat names from saved task board names', async () => {
    expect(
      resolveChatDisplayName({
        chatId: 'oc_test0000000000000000000000000000001',
        taskBoardName: 'Engineering任务看板',
      }),
    ).toBe('Engineering');

    expect(
      resolveChatDisplayName({
        chatId: 'oc_test0000000000000000000000000000001',
        taskBoardName: 'oc_test0000000000000000000000000000001任务看板',
      }),
    ).toBe('Chat oc_test000...000001');

    const resolveFeishuChatDisplayName = vi.fn(async () => 'Engineering');
    await expect(
      resolveReadableChatDisplayName(
        { resolveFeishuChatDisplayName },
        { tenantKey: 'default', chatId: 'oc_test0000000000000000000000000000001' },
      ),
    ).resolves.toBe('Engineering');
    expect(resolveFeishuChatDisplayName).toHaveBeenCalledWith({
      tenantKey: 'default',
      chatId: 'oc_test0000000000000000000000000000001',
    });
  });

  it('lists machines ordered online-first with runtimes and last seen', async () => {
    const store = makeStore();
    const app = makeApp(store);

    const response = await app.inject({
      method: 'GET',
      url: '/admin/machines',
      headers: tokenHeaders(),
    });
    expect(response.statusCode).toBe(200);
    const machines = response.json();
    expect(machines).toHaveLength(2);
    expect(machines[0]).toMatchObject({
      name: 'studio-mbp',
      status: 'online',
      ownerOpenId: 'ou_owner',
      runtimes: ['claude_code', 'codex'],
    });
    expect(machines[1]).toMatchObject({ name: 'old-laptop', status: 'offline', lastSeenAt: null });
    expect(store.listMachines).toHaveBeenCalledWith(SUPERADMIN_SCOPE);
  });

  it('disconnects a machine via POST /admin/machines/:id/disconnect (D-A9)', async () => {
    const store = makeStore();
    const app = makeApp(store);
    const machineId = '00000000-0000-4000-8000-0000000000a1';

    const response = await app.inject({
      method: 'POST',
      url: `/admin/machines/${machineId}/disconnect`,
      headers: tokenHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: machineId, status: 'online' });
    expect(store.disconnectMachine).toHaveBeenCalledWith(SUPERADMIN_SCOPE, machineId);
  });

  it('rejects a non-uuid machine id on disconnect with a 400', async () => {
    const app = makeApp();
    const response = await app.inject({
      method: 'POST',
      url: '/admin/machines/not-a-uuid/disconnect',
      headers: tokenHeaders(),
    });
    expect(response.statusCode).toBe(400);
  });

  it('reports machine counts in the summary', async () => {
    const app = makeApp();

    const summary = await app.inject({
      method: 'GET',
      url: '/admin/summary',
      headers: tokenHeaders(),
    });
    expect(summary.statusCode).toBe(200);
    expect(summary.json()).toMatchObject({ machines: 2, onlineMachines: 1 });
  });

  it('lists computer access settings for a superadmin', async () => {
    const store = makeStore();
    const app = makeApp(store);

    const response = await app.inject({
      method: 'GET',
      url: '/admin/settings/computer-access',
      headers: tokenHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      expect.objectContaining({
        email: 'alice@example.com',
        computerAccessEnabled: true,
      }),
    ]);
    expect(store.listComputerAccessUsers).toHaveBeenCalledWith(SUPERADMIN_SCOPE);
  });

  it('updates computer access settings for a superadmin', async () => {
    const store = makeStore();
    const app = makeApp(store);
    const userId = '00000000-0000-4000-8000-0000000000b1';

    const response = await app.inject({
      method: 'PATCH',
      url: `/admin/settings/computer-access/${userId}`,
      payload: { computerAccessEnabled: false },
      headers: tokenHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: userId, computerAccessEnabled: false });
    expect(store.updateComputerAccessUser).toHaveBeenCalledWith(SUPERADMIN_SCOPE, userId, {
      computerAccessEnabled: false,
    });
  });

  it('issues a pairing token and renders the npx connect command (D-A7)', async () => {
    const store = makeStore();
    const app = makeApp(store, undefined, {
      serverPublicUrl: 'https://cc.example.com',
      daemonVersion: '0.1.0',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/admin/machines/pairing-token',
      payload: { name: 'workstation' },
      headers: tokenHeaders(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.token).toBe('plain-token-xyz');
    expect(body.machineName).toBe('workstation');
    expect(body.serverConfigured).toBe(true);
    // The install command always targets @latest (a version pin would break
    // whenever a publish and a server deploy drift apart), plus the server URL
    // and the plaintext token.
    expect(body.connectCommand).toContain('npx @open-tag/daemon@latest');
    expect(body.connectCommand).toContain('--server-url https://cc.example.com');
    expect(body.connectCommand).toContain('--token plain-token-xyz');
    expect(body.connectCommand).toContain('--background');
    expect(store.issuePairingToken).toHaveBeenCalledWith(SUPERADMIN_SCOPE, { name: 'workstation' });
  });

  it('falls back to a <SERVER_PUBLIC_URL> placeholder when unset', async () => {
    const app = makeApp(makeStore(), undefined, { serverPublicUrl: null });
    const response = await app.inject({
      method: 'POST',
      url: '/admin/machines/pairing-token',
      payload: {},
      headers: tokenHeaders(),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.serverConfigured).toBe(false);
    expect(body.connectCommand).toContain('--server-url <SERVER_PUBLIC_URL>');
    expect(body.connectCommand).toContain('@open-tag/daemon@latest');
  });

  it('surfaces a 400 when the store rejects token issuance for a token-admin', async () => {
    const store = makeStore({
      issuePairingToken: vi.fn(async () => {
        throw new AdminApiError(400, 'log in as a user to pair a machine');
      }),
    });
    const app = makeApp(store);
    const response = await app.inject({
      method: 'POST',
      url: '/admin/machines/pairing-token',
      payload: {},
      headers: tokenHeaders(),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      ok: false,
      error: 'log in as a user to pair a machine',
    });
  });

  it('binds a chat to a valid machine through the admin store', async () => {
    const store = makeStore({
      updateChat: vi.fn(async (_scope, tenantKey, chatId, input) => ({
        tenantKey,
        chatId,
        displayName: 'Engineering',
        openFeishuUrl: buildFeishuChatOpenUrl(chatId),
        defaultWorkDir: null,
        defaultRuntime: null,
        defaultAgentId: null,
        defaultAgent: null,
        defaultMachineId: input.defaultMachineId ?? null,
        defaultMachineName: input.defaultMachineId ? 'studio-mbp' : null,
        memoryEnabled: input.memoryEnabled ?? false,
        memorySummaryNextRunAt: input.memoryEnabled ? now : null,
        memorySummaryLastRunAt: null,
        memorySummaryLastStatus: null,
        memorySummaryLastError: null,
        agents: [],
        taskBoard: null,
        taskCount: 0,
        lastTaskAt: null,
        createdAt: now,
        updatedAt: now,
      })),
    });
    const app = makeApp(store);

    const response = await app.inject({
      method: 'PATCH',
      url: '/admin/chats/default/oc_test',
      payload: { defaultMachineId: '00000000-0000-4000-8000-0000000000a1' },
      headers: tokenHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(store.updateChat).toHaveBeenCalledWith(SUPERADMIN_SCOPE, 'default', 'oc_test', {
      defaultMachineId: '00000000-0000-4000-8000-0000000000a1',
    });
    expect(response.json()).toMatchObject({
      defaultMachineId: '00000000-0000-4000-8000-0000000000a1',
      defaultMachineName: 'studio-mbp',
    });
  });

  it('patches chat memory through the admin store', async () => {
    const store = makeStore({
      updateChat: vi.fn(async (_scope, tenantKey, chatId, input) => ({
        tenantKey,
        chatId,
        displayName: 'Engineering',
        openFeishuUrl: buildFeishuChatOpenUrl(chatId),
        defaultWorkDir: null,
        defaultRuntime: null,
        defaultAgentId: '00000000-0000-4000-8000-000000000002',
        defaultAgent: null,
        defaultMachineId: null,
        defaultMachineName: null,
        memoryEnabled: input.memoryEnabled ?? false,
        memorySummaryNextRunAt: input.memoryEnabled ? now : null,
        memorySummaryLastRunAt: null,
        memorySummaryLastStatus: null,
        memorySummaryLastError: null,
        agents: [],
        taskBoard: null,
        taskCount: 0,
        lastTaskAt: null,
        createdAt: now,
        updatedAt: now,
      })),
    });
    const app = makeApp(store);

    const response = await app.inject({
      method: 'PATCH',
      url: '/admin/chats/default/oc_test',
      payload: { memoryEnabled: true },
      headers: tokenHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(store.updateChat).toHaveBeenCalledWith(SUPERADMIN_SCOPE, 'default', 'oc_test', {
      memoryEnabled: true,
    });
    expect(response.json()).toMatchObject({
      memoryEnabled: true,
      memorySummaryNextRunAt: now.toISOString(),
    });
  });

  it('disables chat memory through the admin store', async () => {
    const store = makeStore({
      updateChat: vi.fn(async (_scope, tenantKey, chatId, input) => ({
        tenantKey,
        chatId,
        displayName: 'Engineering',
        openFeishuUrl: buildFeishuChatOpenUrl(chatId),
        defaultWorkDir: null,
        defaultRuntime: null,
        defaultAgentId: '00000000-0000-4000-8000-000000000002',
        defaultAgent: null,
        defaultMachineId: null,
        defaultMachineName: null,
        memoryEnabled: input.memoryEnabled ?? true,
        memorySummaryNextRunAt: null,
        memorySummaryLastRunAt: null,
        memorySummaryLastStatus: null,
        memorySummaryLastError: null,
        agents: [],
        taskBoard: null,
        taskCount: 0,
        lastTaskAt: null,
        createdAt: now,
        updatedAt: now,
      })),
    });
    const app = makeApp(store);

    const response = await app.inject({
      method: 'PATCH',
      url: '/admin/chats/default/oc_test',
      payload: { memoryEnabled: false },
      headers: tokenHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(store.updateChat).toHaveBeenCalledWith(SUPERADMIN_SCOPE, 'default', 'oc_test', {
      memoryEnabled: false,
    });
    expect(response.json()).toMatchObject({
      memoryEnabled: false,
      memorySummaryNextRunAt: null,
    });
  });

  it('rejects binding a chat to a revoked machine with a 400', async () => {
    const store = makeStore({
      updateChat: vi.fn(async () => {
        throw new AdminApiError(
          400,
          'Default machine is revoked; choose an active machine or clear the binding',
        );
      }),
    });
    const app = makeApp(store);

    const response = await app.inject({
      method: 'PATCH',
      url: '/admin/chats/default/oc_test',
      payload: { defaultMachineId: '00000000-0000-4000-8000-0000000000a9' },
      headers: tokenHeaders(),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain('revoked');
  });

  it('rejects a non-uuid defaultMachineId before calling the store', async () => {
    const store = makeStore();
    const app = makeApp(store);

    const response = await app.inject({
      method: 'PATCH',
      url: '/admin/chats/default/oc_test',
      payload: { defaultMachineId: 'not-a-uuid' },
      headers: tokenHeaders(),
    });

    expect(response.statusCode).toBe(400);
    expect(store.updateChat).not.toHaveBeenCalled();
  });
});

describe('admin guard identity resolution', () => {
  it('rejects non-loopback admin requests without a configured token', async () => {
    const app = Fastify({ logger: false });
    registerAdminApiRoutes(app, { store: makeStore() });

    const response = await app.inject({
      method: 'GET',
      url: '/admin/summary',
      remoteAddress: '10.0.0.8',
    });

    expect(response.statusCode).toBe(403);
  });

  it('accepts non-loopback admin requests with the configured bearer token', async () => {
    const app = makeApp();

    const response = await app.inject({
      method: 'GET',
      url: '/admin/summary',
      remoteAddress: '10.0.0.8',
      headers: { authorization: 'Bearer secret-token' },
    });

    expect(response.statusCode).toBe(200);
  });

  // ── B3: break-glass token compared in constant time (behavior unchanged) ──
  it('accepts the configured token via the x-open-claude-tag-admin-token header', async () => {
    const app = makeApp();
    const response = await app.inject({
      method: 'GET',
      url: '/admin/summary',
      remoteAddress: '10.0.0.8',
      headers: { 'x-open-claude-tag-admin-token': 'secret-token' },
    });
    expect(response.statusCode).toBe(200);
  });

  it('rejects a wrong admin token (header and bearer forms)', async () => {
    const app = makeApp();
    const wrongHeader = await app.inject({
      method: 'GET',
      url: '/admin/summary',
      remoteAddress: '10.0.0.8',
      headers: { 'x-open-claude-tag-admin-token': 'not-the-token' },
    });
    expect(wrongHeader.statusCode).toBe(403);
    // A length-mismatched token must also be rejected (and never throw from the
    // constant-time compare, which requires equal-length buffers).
    const wrongBearer = await app.inject({
      method: 'GET',
      url: '/admin/summary',
      remoteAddress: '10.0.0.8',
      headers: { authorization: 'Bearer x' },
    });
    expect(wrongBearer.statusCode).toBe(403);
  });

  it('reports a token admin via /admin/me on the break-glass path', async () => {
    const app = makeApp();

    const response = await app.inject({
      method: 'GET',
      url: '/admin/me',
      remoteAddress: '10.0.0.8',
      headers: { authorization: 'Bearer secret-token' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      id: null,
      email: null,
      displayName: null,
      role: 'superadmin',
      computerAccessEnabled: true,
      tokenAdmin: true,
    });
  });

  it('reports a token admin via /admin/me on loopback', async () => {
    const app = Fastify({ logger: false });
    registerAdminApiRoutes(app, { store: makeStore() });

    const response = await app.inject({ method: 'GET', url: '/admin/me' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ role: 'superadmin', tokenAdmin: true });
  });

  // Live-found privilege escalation: a same-host reverse proxy (serve-console)
  // makes every external request arrive from 127.0.0.1 at the socket level.
  // The guard must use x-forwarded-for set by that local proxy.
  it('does NOT treat a loopback socket as break-glass when XFF names a remote client', async () => {
    const app = Fastify({ logger: false });
    registerAdminApiRoutes(app, { store: makeStore() });

    const response = await app.inject({
      method: 'GET',
      url: '/admin/summary',
      remoteAddress: '127.0.0.1',
      headers: { 'x-forwarded-for': '10.37.1.99' },
    });

    expect(response.statusCode).toBe(403);
  });

  it('still grants loopback break-glass when XFF itself is loopback (local proxy, local client)', async () => {
    const app = Fastify({ logger: false });
    registerAdminApiRoutes(app, { store: makeStore() });

    const response = await app.inject({
      method: 'GET',
      url: '/admin/summary',
      remoteAddress: '127.0.0.1',
      headers: { 'x-forwarded-for': '::1' },
    });

    expect(response.statusCode).toBe(200);
  });

  it('ignores forged XFF from a non-loopback socket (no escalation either way)', async () => {
    const app = Fastify({ logger: false });
    registerAdminApiRoutes(app, { store: makeStore() });

    const response = await app.inject({
      method: 'GET',
      url: '/admin/summary',
      remoteAddress: '10.0.0.8',
      headers: { 'x-forwarded-for': '127.0.0.1' },
    });

    expect(response.statusCode).toBe(403);
  });

  // The escalation this fix closes: an append-style same-host proxy keeps the
  // attacker-supplied leftmost XFF hop, so forging `X-Forwarded-For: 127.0.0.1`
  // must NOT grant break-glass superadmin. The trustworthy hop is the LAST one
  // (the real client the proxy appended).
  it('rejects an append-proxy spoof that forges a loopback first hop', async () => {
    const app = Fastify({ logger: false });
    registerAdminApiRoutes(app, { store: makeStore() });

    const response = await app.inject({
      method: 'GET',
      url: '/admin/summary',
      remoteAddress: '127.0.0.1',
      headers: { 'x-forwarded-for': '127.0.0.1, 203.0.113.7' },
    });

    expect(response.statusCode).toBe(403);
  });

  it('rejects a multi-forged loopback prefix (only the appended last hop counts)', async () => {
    const app = Fastify({ logger: false });
    registerAdminApiRoutes(app, { store: makeStore() });

    const response = await app.inject({
      method: 'GET',
      url: '/admin/summary',
      remoteAddress: '127.0.0.1',
      headers: { 'x-forwarded-for': '127.0.0.1, 127.0.0.1, 203.0.113.7' },
    });

    expect(response.statusCode).toBe(403);
  });

  it('grants loopback break-glass when the proxy-appended last hop is loopback', async () => {
    // A genuinely local client behind the same-host proxy: the forged/earlier
    // prefix is ignored, the proxy-observed immediate peer (last hop) is loopback.
    const app = Fastify({ logger: false });
    registerAdminApiRoutes(app, { store: makeStore() });

    const response = await app.inject({
      method: 'GET',
      url: '/admin/summary',
      remoteAddress: '127.0.0.1',
      headers: { 'x-forwarded-for': '203.0.113.7, 127.0.0.1' },
    });

    expect(response.statusCode).toBe(200);
  });

  it('rejects a malformed XFF chain with empty segments (fail closed)', async () => {
    const app = Fastify({ logger: false });
    registerAdminApiRoutes(app, { store: makeStore() });

    const response = await app.inject({
      method: 'GET',
      url: '/admin/summary',
      remoteAddress: '127.0.0.1',
      headers: { 'x-forwarded-for': '127.0.0.1, ' },
    });

    expect(response.statusCode).toBe(403);
  });

  it('rejects a "localhost" hostname in XFF (proxies forward IP literals, not names)', async () => {
    const app = Fastify({ logger: false });
    registerAdminApiRoutes(app, { store: makeStore() });

    const response = await app.inject({
      method: 'GET',
      url: '/admin/summary',
      remoteAddress: '127.0.0.1',
      headers: { 'x-forwarded-for': 'localhost' },
    });

    expect(response.statusCode).toBe(403);
  });
});

// In-memory platform_users fake supporting the calls the dev-auth guard makes:
// upsertPlatformUserByDevAuth (insert ... onConflictDoUpdate returning). Keyed by
// ssoSub (the namespaced `dev:<sub>`) so the upsert is idempotent.
type FakePlatformUserRow = {
  id: string;
  ssoSub: string;
  email: string | null;
  displayName: string | null;
  department: string | null;
  role: string;
  computerAccessEnabled: boolean;
};

function collectConditionStrings(
  value: unknown,
  out = new Set<string>(),
  seen = new WeakSet<object>(),
): Set<string> {
  if (typeof value === 'string') {
    out.add(value);
    return out;
  }
  if (!value || typeof value !== 'object') return out;
  if (seen.has(value)) return out;
  seen.add(value);
  for (const item of Object.values(value as Record<string, unknown>)) {
    collectConditionStrings(item, out, seen);
  }
  return out;
}

function fakePlatformUserDb(initialRows: FakePlatformUserRow[] = []) {
  const rows = new Map<string, FakePlatformUserRow>(initialRows.map((row) => [row.ssoSub, row]));
  let seq = 0;
  const rowFromCondition = (condition: unknown): FakePlatformUserRow | undefined => {
    const values = collectConditionStrings(condition);
    for (const [ssoSub, row] of rows) {
      if (values.has(ssoSub)) return row;
    }
    return undefined;
  };
  const handle = {
    // isBootstrapEligible / the in-lock re-check both do
    // db.select({...}).from(platformUsers) and await the array.
    select: (selection?: Record<string, unknown>) => ({
      from: () => {
        if (selection && 'value' in selection) return Promise.resolve([{ value: rows.size }]);
        return {
          where: (condition: unknown) => ({
            limit: async () => {
              const row = rowFromCondition(condition);
              return row ? [row] : [];
            },
          }),
        };
      },
    }),
    update: () => ({
      set: (set: Partial<FakePlatformUserRow>) => ({
        where: (condition: unknown) => ({
          returning: async () => {
            const row = rowFromCondition(condition);
            if (!row) return [];
            const merged = { ...row, ...set } as FakePlatformUserRow;
            rows.delete(row.ssoSub);
            rows.set(merged.ssoSub, merged);
            return [merged];
          },
        }),
      }),
    }),
    insert: () => ({
      values: (values: {
        ssoSub: string;
        email: string | null;
        displayName: string | null;
        department: string | null;
        role: string;
      }) => ({
        onConflictDoUpdate: ({ set }: { set: Record<string, unknown> }) => ({
          returning: async () => {
            const existing = rows.get(values.ssoSub);
            if (existing) {
              const merged = { ...existing, ...set } as typeof existing;
              rows.set(values.ssoSub, merged);
              return [merged];
            }
            const created = { id: `pu-${++seq}`, computerAccessEnabled: false, ...values };
            rows.set(values.ssoSub, created);
            return [created];
          },
        }),
      }),
    }),
    // pg_advisory_xact_lock(...) inside the bootstrap transaction.
    execute: async () => undefined,
  };
  const db = {
    ...handle,
    // Bootstrap runs upsert inside db.transaction; the fake runs the callback
    // synchronously against the same in-memory handle (no real isolation needed —
    // these tests exercise sequential logins, not concurrency).
    transaction: async (fn: (tx: typeof handle) => Promise<unknown>) => fn(handle),
  } as unknown as Database;
  return { db, rows };
}

describe('auth config + logout (unguarded)', () => {
  function makeAuthApp(
    overrides: Parameters<typeof registerAdminApiRoutes>[1] = { store: makeStore() },
  ) {
    const app = Fastify({ logger: false });
    registerAdminApiRoutes(app, { desktopReleaseDir: EMPTY_DESKTOP_RELEASE_DIR, ...overrides });
    return app;
  }

  it('reports the auth config with defaults (no SSO fields)', async () => {
    const app = makeAuthApp({ store: makeStore(), devAuthEnabled: false });
    const response = await app.inject({
      method: 'GET',
      url: '/admin/auth/config',
      remoteAddress: '10.0.0.8',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      devAuthEnabled: false,
      personalMode: false,
      serverPublicUrl: null,
      daemonVersion: null,
      desktopArtifacts: { arm64: false, x64: false },
      desktopVersion: null,
    });
  });

  it('reports personalMode in /admin/auth/config', async () => {
    const off = makeAuthApp({ store: makeStore(), personalMode: false });
    const offResponse = await off.inject({
      method: 'GET',
      url: '/admin/auth/config',
      remoteAddress: '10.0.0.8',
    });
    expect(offResponse.json()).toMatchObject({ personalMode: false });

    const on = makeAuthApp({ store: makeStore(), personalMode: true });
    const onResponse = await on.inject({
      method: 'GET',
      url: '/admin/auth/config',
      remoteAddress: '10.0.0.8',
    });
    expect(onResponse.json()).toMatchObject({ personalMode: true });
  });

  it('does not expose the removed SSO endpoints (exchange / sso-login 404)', async () => {
    const app = makeAuthApp();
    const exchange = await app.inject({
      method: 'POST',
      url: '/admin/auth/exchange',
      remoteAddress: '10.0.0.8',
      payload: { jwt: 'whatever' },
    });
    expect(exchange.statusCode).toBe(404);
    const ssoLogin = await app.inject({
      method: 'GET',
      url: '/admin/auth/sso-login?return_to=%2F',
      remoteAddress: '10.0.0.8',
    });
    expect(ssoLogin.statusCode).toBe(404);
  });

  it('clears the dev-auth cookie on logout', async () => {
    const app = makeAuthApp();
    const response = await app.inject({
      method: 'POST',
      url: '/admin/auth/logout',
      remoteAddress: '10.0.0.8',
    });
    expect(response.statusCode).toBe(200);
    const raw = response.headers['set-cookie'];
    const cookies = Array.isArray(raw) ? raw : [raw as string];
    const joined = cookies.join('\n');
    expect(joined).toContain('cc_dev_user=;');
    expect(joined).toContain('Max-Age=0');
  });

  it('still admits the break-glass token and loopback', async () => {
    const app = Fastify({ logger: false });
    registerAdminApiRoutes(app, { store: makeStore(), adminToken: 'secret-token' });

    const viaToken = await app.inject({
      method: 'GET',
      url: '/admin/summary',
      remoteAddress: '10.0.0.8',
      headers: { authorization: 'Bearer secret-token' },
    });
    expect(viaToken.statusCode).toBe(200);

    const viaLoopback = await app.inject({ method: 'GET', url: '/admin/me' });
    expect(viaLoopback.statusCode).toBe(200);
    expect(viaLoopback.json()).toMatchObject({ tokenAdmin: true });
  });

  it('rejects a non-loopback request without a token (403)', async () => {
    const app = Fastify({ logger: false });
    registerAdminApiRoutes(app, { store: makeStore() });
    const response = await app.inject({
      method: 'GET',
      url: '/admin/summary',
      remoteAddress: '10.0.0.8',
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('dev-auth login mode (design D-A6, local non-SSO login)', () => {
  function makeDevApp(overrides: Parameters<typeof registerAdminApiRoutes>[1]) {
    const app = Fastify({ logger: false });
    registerAdminApiRoutes(app, overrides);
    return app;
  }

  it('hides the dev-auth endpoint (404) when the flag is off', async () => {
    const { db } = fakePlatformUserDb();
    const app = makeDevApp({ db, store: makeStore(), devAuthEnabled: false });
    const response = await app.inject({
      method: 'POST',
      url: '/admin/auth/dev-login',
      remoteAddress: '10.0.0.8',
      payload: { sub: 'alice' },
    });
    expect(response.statusCode).toBe(404);
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('reports devAuthEnabled in /admin/auth/config', async () => {
    const off = makeDevApp({ store: makeStore(), devAuthEnabled: false });
    const offResponse = await off.inject({ method: 'GET', url: '/admin/auth/config' });
    expect(offResponse.json()).toMatchObject({ devAuthEnabled: false });

    const on = makeDevApp({
      db: fakePlatformUserDb().db,
      store: makeStore(),
      devAuthEnabled: true,
    });
    const onResponse = await on.inject({ method: 'GET', url: '/admin/auth/config' });
    expect(onResponse.json()).toMatchObject({ devAuthEnabled: true });
  });

  it('ignores a forged cc_dev_user cookie when the flag is off (no escalation)', async () => {
    const { db } = fakePlatformUserDb();
    const app = makeDevApp({ db, store: makeStore(), devAuthEnabled: false });
    const response = await app.inject({
      method: 'GET',
      url: '/admin/summary',
      remoteAddress: '10.0.0.8',
      headers: { cookie: 'cc_dev_user=mallory' },
    });
    // No SSO, not loopback, flag off ⇒ the cookie is never read ⇒ 403.
    expect(response.statusCode).toBe(403);
  });

  it('dev-login creates a platform user, sets the cookie, and returns a scoped me payload', async () => {
    const { db, rows } = fakePlatformUserDb();
    const app = makeDevApp({ db, store: makeStore(), devAuthEnabled: true });

    const response = await app.inject({
      method: 'POST',
      url: '/admin/auth/dev-login',
      remoteAddress: '10.0.0.8',
      payload: { sub: 'alice', name: 'Alice Dev' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      displayName: 'Alice Dev',
      role: 'user',
      tokenAdmin: false,
      devAuth: true,
    });
    // The namespaced sso_sub keeps dev identities from colliding with real subs.
    expect(rows.has('dev:alice')).toBe(true);

    const cookie = response.headers['set-cookie'] as string;
    expect(cookie).toContain('cc_dev_user=alice');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Max-Age=43200');
    expect(cookie).not.toContain('Secure');
  });

  it('rejects an empty/invalid dev-auth sub before persisting', async () => {
    const { db } = fakePlatformUserDb();
    const app = makeDevApp({ db, store: makeStore(), devAuthEnabled: true });
    const blank = await app.inject({
      method: 'POST',
      url: '/admin/auth/dev-login',
      payload: { sub: '   ' },
    });
    expect(blank.statusCode).toBe(400);
    const weird = await app.inject({
      method: 'POST',
      url: '/admin/auth/dev-login',
      payload: { sub: 'bad sub!' },
    });
    expect(weird.statusCode).toBe(400);
  });

  it('authenticates a guarded request from the cc_dev_user cookie when enabled', async () => {
    const { db } = fakePlatformUserDb();
    const store = makeStore();
    const app = makeDevApp({ db, store, devAuthEnabled: true });

    const login = await app.inject({
      method: 'POST',
      url: '/admin/auth/dev-login',
      remoteAddress: '10.0.0.8',
      payload: { sub: 'alice', name: 'Alice Dev' },
    });
    const cookiePair = (login.headers['set-cookie'] as string).split(';')[0]; // cc_dev_user=alice

    const me = await app.inject({
      method: 'GET',
      url: '/admin/me',
      remoteAddress: '10.0.0.8',
      headers: { cookie: cookiePair },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({
      displayName: 'Alice Dev',
      role: 'user',
      tokenAdmin: false,
      devAuth: true,
      computerAccessEnabled: false,
    });

    // The store receives an owner-scoped (non-superadmin) scope for the dev user.
    await app.inject({
      method: 'GET',
      url: '/admin/agents',
      remoteAddress: '10.0.0.8',
      headers: { cookie: cookiePair },
    });
    const scope = (store.listAgents as ReturnType<typeof vi.fn>).mock.calls.at(
      -1,
    )?.[0] as OwnerScope;
    expect(scope.isSuperadmin).toBe(false);
    expect(scope.platformUserId).toBeTruthy();
    expect(scope.computerAccessEnabled).toBe(false);
  });

  it('isolates two dev users by passing distinct owner scopes to the store', async () => {
    const { db } = fakePlatformUserDb();
    const store = makeStore();
    const app = makeDevApp({ db, store, devAuthEnabled: true });

    async function scopeForSub(sub: string): Promise<OwnerScope> {
      await app.inject({
        method: 'GET',
        url: '/admin/agents',
        remoteAddress: '10.0.0.8',
        headers: { cookie: `cc_dev_user=${sub}` },
      });
      return (store.listAgents as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as OwnerScope;
    }

    const aliceScope = await scopeForSub('alice');
    const bobScope = await scopeForSub('bob');
    expect(aliceScope.isSuperadmin).toBe(false);
    expect(bobScope.isSuperadmin).toBe(false);
    expect(aliceScope.computerAccessEnabled).toBe(false);
    expect(bobScope.computerAccessEnabled).toBe(false);
    expect(aliceScope.platformUserId).toBeTruthy();
    expect(bobScope.platformUserId).toBeTruthy();
    // Distinct platform users ⇒ owner filtering isolates one from the other.
    expect(aliceScope.platformUserId).not.toBe(bobScope.platformUserId);
  });

  it('keeps a dev user as role user even when they are the first platform user', async () => {
    const { db } = fakePlatformUserDb();
    const app = makeDevApp({ db, store: makeStore(), devAuthEnabled: true });
    // No platform_users exist yet. The dev path must NOT promote the first user
    // to superadmin — superadmin stays break-glass-token only.
    const response = await app.inject({
      method: 'POST',
      url: '/admin/auth/dev-login',
      remoteAddress: '10.0.0.8',
      payload: { sub: 'first-ever' },
    });
    expect(response.json()).toMatchObject({ role: 'user', devAuth: true });
  });

  it('logout clears the dev-auth cookie too', async () => {
    const { db } = fakePlatformUserDb();
    const app = makeDevApp({ db, store: makeStore(), devAuthEnabled: true });
    const response = await app.inject({
      method: 'POST',
      url: '/admin/auth/logout',
      remoteAddress: '10.0.0.8',
    });
    const raw = response.headers['set-cookie'];
    const cookies = Array.isArray(raw) ? raw : [raw as string];
    expect(cookies.join('\n')).toContain('cc_dev_user=;');
  });
});

describe('daemon install guide config + artifact', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeArtifact(contents = 'fake-daemon-tarball'): string {
    const dir = mkdtempSync(join(tmpdir(), 'cc-daemon-artifact-'));
    tempDirs.push(dir);
    const path = join(dir, 'open-claude-tag-daemon-0.1.0.tgz');
    writeFileSync(path, contents);
    return path;
  }

  function makeApp(overrides: Parameters<typeof registerAdminApiRoutes>[1]) {
    const app = Fastify({ logger: false });
    registerAdminApiRoutes(app, { desktopReleaseDir: EMPTY_DESKTOP_RELEASE_DIR, ...overrides });
    return app;
  }

  it('exposes serverPublicUrl and daemonVersion on the (unauthenticated) config', async () => {
    const app = makeApp({
      store: makeStore(),
      serverPublicUrl: 'http://10.37.206.226:3001/',
      daemonVersion: '0.1.0',
    });
    const response = await app.inject({
      method: 'GET',
      url: '/admin/auth/config',
      remoteAddress: '10.0.0.8',
    });
    expect(response.statusCode).toBe(200);
    // Trailing slash is trimmed so the console builds a clean `--server-url <url>`.
    expect(response.json()).toMatchObject({
      serverPublicUrl: 'http://10.37.206.226:3001',
      daemonVersion: '0.1.0',
    });
  });

  it('reports serverPublicUrl/daemonVersion as null when unset', async () => {
    const app = makeApp({ store: makeStore() });
    const response = await app.inject({ method: 'GET', url: '/admin/auth/config' });
    expect(response.json()).toMatchObject({ serverPublicUrl: null, daemonVersion: null });
  });

  it('streams the daemon tarball with attachment headers when the artifact exists', async () => {
    const artifactPath = makeArtifact();
    const app = makeApp({ store: makeStore(), daemonArtifactPath: artifactPath });
    const response = await app.inject({
      method: 'GET',
      url: '/admin/daemon/artifact',
      remoteAddress: '10.0.0.8',
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-disposition']).toBe(
      'attachment; filename="open-claude-tag-daemon.tgz"',
    );
    expect(response.headers['content-type']).toBe('application/gzip');
    expect(response.body).toBe('fake-daemon-tarball');
  });

  it('returns 404 with a JSON hint when the artifact path is not configured', async () => {
    const app = makeApp({ store: makeStore() });
    const response = await app.inject({ method: 'GET', url: '/admin/daemon/artifact' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ ok: false });
    expect(String(response.json().error)).toMatch(/DAEMON_ARTIFACT_PATH/);
  });

  it('returns 404 when the configured artifact path is missing on disk', async () => {
    const app = makeApp({
      store: makeStore(),
      daemonArtifactPath: '/tmp/does-not-exist-open-claude-tag-daemon.tgz',
    });
    const response = await app.inject({ method: 'GET', url: '/admin/daemon/artifact' });
    expect(response.statusCode).toBe(404);
    expect(String(response.json().error)).toMatch(/not found/);
  });

  // ── B6: refuse to serve a file that escapes the artifacts directory ──
  it('refuses (404) to serve an artifact path that symlinks outside its directory', async () => {
    // A secret file living OUTSIDE the artifacts directory.
    const secretDir = mkdtempSync(join(tmpdir(), 'cc-daemon-secret-'));
    tempDirs.push(secretDir);
    const secretPath = join(secretDir, 'secret.txt');
    writeFileSync(secretPath, 'top-secret-not-a-tarball');

    // The configured path is a symlink INSIDE an artifacts dir that resolves to
    // the out-of-tree secret. Serving it would leak an arbitrary file.
    const artifactsDir = mkdtempSync(join(tmpdir(), 'cc-daemon-artifact-'));
    tempDirs.push(artifactsDir);
    const linkPath = join(artifactsDir, 'open-claude-tag-daemon-0.1.0.tgz');
    symlinkSync(secretPath, linkPath);

    const app = makeApp({ store: makeStore(), daemonArtifactPath: linkPath });
    const response = await app.inject({
      method: 'GET',
      url: '/admin/daemon/artifact',
      remoteAddress: '10.0.0.8',
    });
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain('top-secret');
  });

  it('still serves an in-directory symlink to a real tarball (happy path preserved)', async () => {
    // A symlink that stays WITHIN the artifacts directory is fine — only escapes
    // are refused, so a deploy that symlinks `latest.tgz` -> the real file works.
    const artifactsDir = mkdtempSync(join(tmpdir(), 'cc-daemon-artifact-'));
    tempDirs.push(artifactsDir);
    const realPath = join(artifactsDir, 'open-claude-tag-daemon-0.1.0.tgz');
    writeFileSync(realPath, 'fake-daemon-tarball');
    const linkPath = join(artifactsDir, 'latest.tgz');
    symlinkSync(realPath, linkPath);

    const app = makeApp({ store: makeStore(), daemonArtifactPath: linkPath });
    const response = await app.inject({
      method: 'GET',
      url: '/admin/daemon/artifact',
      remoteAddress: '10.0.0.8',
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('fake-daemon-tarball');
  });
});

describe('desktop app artifact + config', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeArtifact(name = 'OpenClaudeTag Console-0.1.0-arm64.dmg', contents = 'fake-dmg'): string {
    const dir = mkdtempSync(join(tmpdir(), 'cc-desktop-artifact-'));
    tempDirs.push(dir);
    const path = join(dir, name);
    writeFileSync(path, contents);
    return path;
  }

  function makeReleaseArtifact(
    name = 'OpenClaudeTag Console-0.1.0-arm64.dmg',
    contents = 'fake-dmg',
  ): string {
    const dir = mkdtempSync(join(tmpdir(), 'cc-desktop-release-'));
    tempDirs.push(dir);
    const path = join(dir, name);
    writeFileSync(path, contents);
    return dir;
  }

  function makeApp(overrides: Parameters<typeof registerAdminApiRoutes>[1]) {
    const app = Fastify({ logger: false });
    registerAdminApiRoutes(app, { desktopReleaseDir: EMPTY_DESKTOP_RELEASE_DIR, ...overrides });
    return app;
  }

  it('advertises desktopArtifacts and desktopVersion on the (unauthenticated) config', async () => {
    const app = makeApp({
      store: makeStore(),
      desktopArtifactPathArm64: makeArtifact(),
      desktopVersion: '0.1.0',
    });
    const response = await app.inject({
      method: 'GET',
      url: '/admin/auth/config',
      remoteAddress: '10.0.0.8',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      desktopArtifacts: { arm64: true, x64: false },
      desktopVersion: '0.1.0',
    });
  });

  it('reports desktopArtifacts.arm64 false when the path is set but the file is missing', async () => {
    const app = makeApp({
      store: makeStore(),
      desktopArtifactPathArm64: '/tmp/does-not-exist-OpenClaudeTag-Console-arm64.dmg',
    });
    const response = await app.inject({ method: 'GET', url: '/admin/auth/config' });
    // A stale env path must NOT advertise as available, or the console would
    // enable an artifact action that 404s on click.
    expect(response.json()).toMatchObject({ desktopArtifacts: { arm64: false, x64: false } });
  });

  it('reports desktopArtifacts false/false and desktopVersion null when unset', async () => {
    const app = makeApp({ store: makeStore() });
    const response = await app.inject({ method: 'GET', url: '/admin/auth/config' });
    expect(response.json()).toMatchObject({
      desktopArtifacts: { arm64: false, x64: false },
      desktopVersion: null,
    });
  });

  it('discovers a standard desktop release DMG when no artifact path is configured', async () => {
    const desktopReleaseDir = makeReleaseArtifact();
    const app = makeApp({
      store: makeStore(),
      desktopReleaseDir,
      desktopVersion: '0.1.0',
    });
    const response = await app.inject({ method: 'GET', url: '/admin/auth/config' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      desktopArtifacts: { arm64: true, x64: false },
      desktopVersion: '0.1.0',
    });
  });

  it('streams the arm64 DMG with attachment headers when requested explicitly', async () => {
    const app = makeApp({
      store: makeStore(),
      desktopArtifactPathArm64: makeArtifact(),
      desktopVersion: '0.1.0',
    });
    const response = await app.inject({
      method: 'GET',
      url: '/admin/desktop/artifact?arch=arm64',
      remoteAddress: '10.0.0.8',
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-disposition']).toBe(
      'attachment; filename="OpenClaudeTag Console-0.1.0-arm64.dmg"',
    );
    expect(response.headers['content-type']).toBe('application/octet-stream');
    expect(response.body).toBe('fake-dmg');
  });

  it('streams a discovered standard desktop release DMG with attachment headers', async () => {
    const desktopReleaseDir = makeReleaseArtifact();
    const app = makeApp({
      store: makeStore(),
      desktopReleaseDir,
      desktopVersion: '0.1.0',
    });
    const response = await app.inject({
      method: 'GET',
      url: '/admin/desktop/artifact?arch=arm64',
      remoteAddress: '10.0.0.8',
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-disposition']).toBe(
      'attachment; filename="OpenClaudeTag Console-0.1.0-arm64.dmg"',
    );
    expect(response.headers['content-type']).toBe('application/octet-stream');
    expect(response.body).toBe('fake-dmg');
  });

  it('defaults to arm64 when no arch query is given', async () => {
    const app = makeApp({
      store: makeStore(),
      desktopArtifactPathArm64: makeArtifact(),
      desktopVersion: '0.1.0',
    });
    const response = await app.inject({ method: 'GET', url: '/admin/desktop/artifact' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-disposition']).toBe(
      'attachment; filename="OpenClaudeTag Console-0.1.0-arm64.dmg"',
    );
  });

  it('returns 404 with a JSON hint when the requested arch is not configured', async () => {
    const app = makeApp({ store: makeStore(), desktopArtifactPathArm64: makeArtifact() });
    const response = await app.inject({ method: 'GET', url: '/admin/desktop/artifact?arch=x64' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ ok: false });
    expect(String(response.json().error)).toMatch(/DESKTOP_ARTIFACT_PATH_X64/);
  });

  it('returns 400 for an invalid arch value', async () => {
    const app = makeApp({ store: makeStore(), desktopArtifactPathArm64: makeArtifact() });
    const response = await app.inject({ method: 'GET', url: '/admin/desktop/artifact?arch=win' });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ ok: false });
    expect(String(response.json().error)).toMatch(/arch/i);
  });

  it('returns 400 for a repeated arch query param (parsed as an array)', async () => {
    const app = makeApp({ store: makeStore(), desktopArtifactPathArm64: makeArtifact() });
    const response = await app.inject({
      method: 'GET',
      url: '/admin/desktop/artifact?arch=arm64&arch=x64',
    });
    expect(response.statusCode).toBe(400);
    expect(String(response.json().error)).toMatch(/arch/i);
  });

  it('returns 404 when the configured arch path is missing on disk', async () => {
    const app = makeApp({
      store: makeStore(),
      desktopArtifactPathArm64: '/tmp/does-not-exist-OpenClaudeTag-Console-arm64.dmg',
    });
    const response = await app.inject({ method: 'GET', url: '/admin/desktop/artifact?arch=arm64' });
    expect(response.statusCode).toBe(404);
    expect(String(response.json().error)).toMatch(/not found/);
    // The unguarded endpoint must not leak the server-side filesystem path.
    expect(String(response.json().error)).not.toContain('/tmp');
  });
});
