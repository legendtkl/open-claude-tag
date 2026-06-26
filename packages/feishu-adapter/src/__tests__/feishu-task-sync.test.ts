import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IntentType, TaskStatus } from '@open-tag/core-types';
import type { FeishuClient } from '../feishu-client.js';
import {
  FeishuTaskSyncService,
  type FeishuCompletedTaskLinkRecord,
  type FeishuTaskLinkRecord,
  type FeishuTaskTrackingRepository,
  type FeishuTaskTrackingSpace,
} from '../feishu-task-sync.js';

class MemoryTrackingRepository implements FeishuTaskTrackingRepository {
  spaces = new Map<string, FeishuTaskTrackingSpace>();
  links = new Map<string, FeishuTaskLinkRecord>();
  completedLinks: FeishuCompletedTaskLinkRecord[] = [];
  taskSessions = new Map<string, string>();
  taskStatuses = new Map<string, TaskStatus>();
  taskUpdatedAt = new Map<string, Date>();
  private locks = new Map<string, Promise<void>>();

  private key(scopeType: string, scopeId: string): string {
    return `${scopeType}:${scopeId}`;
  }

  get space(): FeishuTaskTrackingSpace | null {
    return this.spaces.get(this.key('global', 'default')) ?? null;
  }

  set space(value: FeishuTaskTrackingSpace | null) {
    if (value) {
      this.spaces.set(this.key(value.scopeType, value.scopeId), value);
    } else {
      this.spaces.clear();
    }
  }

  async withScopeLock<T>(
    scopeType: string,
    scopeId: string,
    callback: () => Promise<T>,
  ): Promise<T> {
    const key = this.key(scopeType, scopeId);
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => current);
    this.locks.set(key, tail);

    await previous.catch(() => undefined);
    try {
      return await callback();
    } finally {
      release();
      if (this.locks.get(key) === tail) {
        this.locks.delete(key);
      }
    }
  }

  async findSpace(scopeType: string, scopeId: string): Promise<FeishuTaskTrackingSpace | null> {
    return this.spaces.get(this.key(scopeType, scopeId)) ?? null;
  }

  async findSpaceById(id: string): Promise<FeishuTaskTrackingSpace | null> {
    return [...this.spaces.values()].find((space) => space.id === id) ?? null;
  }

  async saveSpace(space: FeishuTaskTrackingSpace): Promise<FeishuTaskTrackingSpace> {
    const saved = { ...space, id: space.id ?? `space_${this.spaces.size + 1}` };
    this.spaces.set(this.key(saved.scopeType, saved.scopeId), saved);
    return saved;
  }

  async findTaskLink(taskId: string): Promise<FeishuTaskLinkRecord | null> {
    return this.links.get(taskId) ?? null;
  }

  async findTaskLinkBySourceTopic(input: {
    trackingSpaceId: string;
    sourceTopicKey: string;
  }): Promise<FeishuTaskLinkRecord | null> {
    return (
      [...this.links.values()].find(
        (link) =>
          link.trackingSpaceId === input.trackingSpaceId &&
          link.sourceTopicKey === input.sourceTopicKey &&
          Boolean(link.feishuTaskGuid),
      ) ?? null
    );
  }

  async findTaskLinkBySession(input: {
    trackingSpaceId: string;
    sessionId: string;
  }): Promise<FeishuTaskLinkRecord | null> {
    return (
      [...this.links.values()].find(
        (link) =>
          link.trackingSpaceId === input.trackingSpaceId &&
          this.taskSessions.get(link.taskId) === input.sessionId &&
          Boolean(link.feishuTaskGuid),
      ) ?? null
    );
  }

  async recordTaskLink(link: FeishuTaskLinkRecord): Promise<void> {
    this.links.set(link.taskId, link);
  }

  async recordTaskLinkError(input: {
    taskId: string;
    sourceMessageId?: string;
    sourceTopicKey?: string | null;
    sourceTopicUrl?: string | null;
    error: string;
  }): Promise<void> {
    this.links.set(input.taskId, {
      taskId: input.taskId,
      sourceMessageId: input.sourceMessageId,
      sourceTopicKey: input.sourceTopicKey,
      sourceTopicUrl: input.sourceTopicUrl,
      lastSyncError: input.error,
    });
  }

  async updateTaskLinkSync(input: {
    taskId: string;
    lastSyncedStatus?: string;
    lastSyncError?: string | null;
  }): Promise<void> {
    const current = this.links.get(input.taskId) ?? { taskId: input.taskId };
    this.links.set(input.taskId, { ...current, ...input });
  }

  async listCompletedTaskLinksForSession(input: {
    sessionId: string;
    completedBefore: Date;
  }): Promise<FeishuCompletedTaskLinkRecord[]> {
    void input.sessionId;
    return this.completedLinks.filter((link) => link.completedAt <= input.completedBefore);
  }

  async hasRetainedTaskLinkForFeishuTask(input: {
    feishuTaskGuid: string;
    completedBefore: Date;
  }): Promise<boolean> {
    for (const link of this.links.values()) {
      if (link.feishuTaskGuid !== input.feishuTaskGuid) continue;
      if (link.lastSyncedStatus === 'cleaned') continue;

      const status = this.taskStatuses.get(link.taskId);
      if (status && status !== TaskStatus.COMPLETED) return true;

      const completedAt =
        this.taskUpdatedAt.get(link.taskId) ??
        this.completedLinks.find((completedLink) => completedLink.taskId === link.taskId)
          ?.completedAt;
      if (!completedAt || completedAt > input.completedBefore) return true;
    }
    return false;
  }
}

function makeClient(): FeishuClient {
  return {
    createTasklist: vi.fn().mockResolvedValue({ guid: 'tl_1' }),
    getChat: vi.fn().mockResolvedValue({ chatId: 'oc_1', name: 'Engineering' }),
    listChatMembers: vi.fn().mockResolvedValue([
      { memberId: 'ou_1', name: 'User 1' },
      { memberId: 'ou_2', name: 'User 2' },
    ]),
    addTasklistMembers: vi.fn().mockResolvedValue(undefined),
    listTaskCustomFields: vi.fn().mockResolvedValue([]),
    createTaskCustomField: vi.fn().mockResolvedValue({
      guid: 'field_status',
      name: 'Status',
      type: 'single_select',
      single_select_setting: { options: [] },
    }),
    createTaskCustomFieldOption: vi
      .fn()
      .mockImplementation(async (_fieldGuid: string, name: string) => ({
        guid: `opt_${name}`,
        name,
      })),
    listTaskSections: vi.fn().mockResolvedValue([]),
    createTaskSection: vi.fn().mockImplementation(async (_tasklistGuid: string, name: string) => ({
      guid: `sec_${name}`,
      name,
    })),
    getMessageAppLink: vi.fn().mockResolvedValue('https://topic'),
    createTask: vi.fn().mockResolvedValue({ guid: 'ft_1', url: 'https://task' }),
    sendMessage: vi.fn().mockResolvedValue({ messageId: 'om_task_link' }),
    patchTaskCustomFields: vi.fn().mockResolvedValue(undefined),
    addTaskToTasklist: vi.fn().mockResolvedValue(undefined),
    removeTaskFromTasklist: vi.fn().mockResolvedValue(undefined),
    listTasklistTasks: vi.fn().mockResolvedValue([]),
    completeTask: vi.fn().mockResolvedValue(undefined),
    uncompleteTask: vi.fn().mockResolvedValue(undefined),
  } as unknown as FeishuClient;
}

describe('FeishuTaskSyncService', () => {
  let repo: MemoryTrackingRepository;
  let client: FeishuClient;

  beforeEach(() => {
    repo = new MemoryTrackingRepository();
    client = makeClient();
  });

  it('does nothing when tracking is disabled', async () => {
    const service = new FeishuTaskSyncService({
      client,
      repository: repo,
      config: { enabled: false },
    });

    await service.createTrackedTask({
      taskId: 'task_1',
      taskType: IntentType.SELF_DEV,
      summary: 'Implement feature',
      localStatus: TaskStatus.QUEUED,
    });

    expect(client.createTasklist).not.toHaveBeenCalled();
    expect(repo.links.size).toBe(0);
  });

  it('leaves chat reply task creation local-only without creating a Feishu task', async () => {
    repo.space = {
      id: 'space_1',
      scopeType: 'global',
      scopeId: 'default',
      tasklistGuid: 'tl_1',
      statusFieldGuid: 'field_status',
      statusOptions: {
        todo: 'opt_todo',
        'in-progress': 'opt_in-progress',
        'to-clarify': 'opt_to-clarify',
        review: 'opt_review',
        completed: 'opt_completed',
      },
      sections: {
        todo: 'sec_todo',
        'in-progress': 'sec_in-progress',
        'to-clarify': 'sec_to-clarify',
        review: 'sec_review',
        completed: 'sec_completed',
      },
    };
    const service = new FeishuTaskSyncService({
      client,
      repository: repo,
      config: { enabled: true },
    });

    await service.createTrackedTask({
      taskId: 'task_chat',
      taskType: IntentType.CHAT_REPLY,
      summary: 'hello',
      localStatus: TaskStatus.QUEUED,
      sourceMessageId: 'om_chat',
      sourceTopicKey: 'feishu:tenant:chat:topic:om_chat',
      chatId: 'oc_1',
      replyToMessageId: 'om_chat',
    });

    expect(client.getMessageAppLink).not.toHaveBeenCalled();
    expect(client.createTask).not.toHaveBeenCalled();
    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(repo.links.get('task_chat')).toBeUndefined();
  });

  it('tracks a chat reply task when the API explicitly forces tracking', async () => {
    const service = new FeishuTaskSyncService({
      client,
      repository: repo,
      config: { enabled: true, tasklistName: 'Project Tracking' },
    });

    await service.createTrackedTask({
      taskId: 'task_chat_work',
      taskType: IntentType.CHAT_REPLY,
      forceTrack: true,
      summary: '创建 2.txt 并写入 hello world',
      localStatus: TaskStatus.QUEUED,
      sourceMessageId: 'om_chat_work',
      sourceTopicKey: 'feishu:tenant:chat:session:session_1',
      chatId: 'oc_1',
      replyToMessageId: 'om_chat_work',
    });

    expect(client.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        summary: '创建 2.txt 并写入 hello world',
        clientToken: 'task_chat_work',
      }),
    );
    expect(repo.links.get('task_chat_work')).toEqual(
      expect.objectContaining({
        taskId: 'task_chat_work',
        feishuTaskGuid: 'ft_1',
        sourceTopicKey: 'feishu:tenant:chat:session:session_1',
      }),
    );
  });

  it('provisions tracking space and creates a linked Feishu task with source navigation', async () => {
    const service = new FeishuTaskSyncService({
      client,
      repository: repo,
      config: { enabled: true, tasklistName: 'Project Tracking' },
    });

    await service.createTrackedTask({
      taskId: 'task_1',
      taskType: IntentType.SELF_DEV,
      summary: 'Implement feature',
      localStatus: TaskStatus.QUEUED,
      sourceMessageId: 'om_1',
      chatId: 'oc_1',
      replyToMessageId: 'om_1',
      requesterOpenId: 'ou_user',
    });

    expect(client.createTasklist).toHaveBeenCalledWith({ name: 'Project Tracking' });
    expect(client.createTaskCustomFieldOption).toHaveBeenCalledTimes(5);
    expect(client.createTaskSection).toHaveBeenCalledTimes(5);
    expect(client.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        summary: 'Implement feature',
        description: 'OpenClaudeTag task: task_1\n\nSource thread: https://topic',
        tasklistGuid: 'tl_1',
        sectionGuid: 'sec_todo',
        customFields: [{ guid: 'field_status', single_select_value: 'opt_todo' }],
        origin: {
          platform_i18n_name: { zh_cn: '飞书话题', en_us: 'Lark Thread' },
          href: { title: 'Open source Feishu topic', url: 'https://topic' },
        },
        members: [{ id: 'ou_user', type: 'user', role: 'follower' }],
        clientToken: 'task_1',
      }),
    );
    expect(client.sendMessage).toHaveBeenCalledWith(
      'chat_id',
      'oc_1',
      { msg_type: 'text', content: { text: 'Feishu task: https://task' } },
      'om_1',
    );
    expect(repo.links.get('task_1')).toEqual(
      expect.objectContaining({
        taskId: 'task_1',
        trackingSpaceId: 'space_1',
        feishuTaskGuid: 'ft_1',
        feishuTaskUrl: 'https://task',
        sourceMessageId: 'om_1',
        sourceTopicUrl: 'https://topic',
        lastSyncedStatus: 'todo',
        lastSyncError: null,
      }),
    );
  });

  it('keeps a custom task description and appends the source thread link', async () => {
    const service = new FeishuTaskSyncService({
      client,
      repository: repo,
      config: { enabled: true },
    });

    await service.createTrackedTask({
      taskId: 'task_1',
      taskType: IntentType.SELF_DEV,
      summary: 'Implement feature',
      description: 'Review the failing workflow',
      localStatus: TaskStatus.QUEUED,
      sourceMessageId: 'om_1',
    });

    expect(client.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        description: 'Review the failing workflow\n\nSource thread: https://topic',
      }),
    );
  });

  it('preserves custom task description whitespace when appending the source thread link', async () => {
    const service = new FeishuTaskSyncService({
      client,
      repository: repo,
      config: { enabled: true },
    });

    await service.createTrackedTask({
      taskId: 'task_1',
      taskType: IntentType.SELF_DEV,
      summary: 'Implement feature',
      description: '\n  Review the failing workflow  \n',
      localStatus: TaskStatus.QUEUED,
      sourceMessageId: 'om_1',
    });

    expect(client.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        description: '\n  Review the failing workflow  \n\n\nSource thread: https://topic',
      }),
    );
  });

  it('keeps task creation within description limits when the source thread URL is very long', async () => {
    const sourceTopicUrl = `https://topic/${'a'.repeat(2968)}`;
    vi.mocked(client.getMessageAppLink).mockResolvedValueOnce(sourceTopicUrl);
    const service = new FeishuTaskSyncService({
      client,
      repository: repo,
      config: { enabled: true },
    });

    await service.createTrackedTask({
      taskId: 'task_1',
      taskType: IntentType.SELF_DEV,
      summary: 'Implement feature',
      description: 'abc',
      localStatus: TaskStatus.QUEUED,
      sourceMessageId: 'om_1',
    });

    const createInput = vi.mocked(client.createTask).mock.calls[0][0];
    expect(createInput.description).toHaveLength(3000);
    expect(createInput.description).toBe(`.\n\nSource thread: ${sourceTopicUrl}`);
    expect(createInput.origin).toBeUndefined();
    expect(repo.links.get('task_1')).toEqual(
      expect.objectContaining({
        sourceTopicUrl,
        lastSyncError: `source topic link exceeds Feishu origin URL limit (${sourceTopicUrl.length}/1024)`,
      }),
    );
  });

  it('skips Feishu origin when the source topic URL is not http(s)', async () => {
    vi.mocked(client.getMessageAppLink).mockResolvedValueOnce('lark://thread/open?id=om_1');
    const service = new FeishuTaskSyncService({
      client,
      repository: repo,
      config: { enabled: true },
    });

    await service.createTrackedTask({
      taskId: 'task_1',
      taskType: IntentType.SELF_DEV,
      summary: 'Implement feature',
      localStatus: TaskStatus.QUEUED,
      sourceMessageId: 'om_1',
    });

    expect(client.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        origin: undefined,
        description: 'OpenClaudeTag task: task_1\n\nSource thread: lark://thread/open?id=om_1',
      }),
    );
    expect(repo.links.get('task_1')).toEqual(
      expect.objectContaining({
        sourceTopicUrl: 'lark://thread/open?id=om_1',
        lastSyncError: 'source topic link must use http(s)',
      }),
    );
  });

  it('reuses the existing Feishu task for another internal task in the same source topic', async () => {
    const service = new FeishuTaskSyncService({
      client,
      repository: repo,
      config: { enabled: true, tasklistName: 'Project Tracking' },
    });

    await service.createTrackedTask({
      taskId: 'task_1',
      taskType: IntentType.SELF_DEV,
      summary: 'Implement feature',
      localStatus: TaskStatus.QUEUED,
      sourceMessageId: 'om_1',
      sourceTopicKey: 'feishu:tenant:chat:session:session_1',
      chatId: 'oc_1',
      replyToMessageId: 'om_1',
    });

    vi.mocked(client.createTask).mockClear();
    vi.mocked(client.sendMessage).mockClear();
    vi.mocked(client.getMessageAppLink).mockClear();

    await service.createTrackedTask({
      taskId: 'task_2',
      taskType: IntentType.SELF_DEV,
      summary: 'Follow-up in the same topic',
      localStatus: TaskStatus.QUEUED,
      sourceMessageId: 'om_2',
      sourceTopicKey: 'feishu:tenant:chat:session:session_1',
      chatId: 'oc_1',
      replyToMessageId: 'om_2',
    });

    expect(client.createTask).not.toHaveBeenCalled();
    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(client.getMessageAppLink).not.toHaveBeenCalled();
    expect(repo.links.get('task_2')).toEqual(
      expect.objectContaining({
        taskId: 'task_2',
        trackingSpaceId: 'space_1',
        feishuTaskGuid: 'ft_1',
        feishuTaskUrl: 'https://task',
        sourceMessageId: 'om_2',
        sourceTopicKey: 'feishu:tenant:chat:session:session_1',
        sourceTopicUrl: 'https://topic',
        lastSyncedStatus: 'todo',
        lastSyncError: null,
      }),
    );
  });

  it('does not reuse an existing Feishu task link for chat reply follow-ups', async () => {
    const service = new FeishuTaskSyncService({
      client,
      repository: repo,
      config: { enabled: true, tasklistName: 'Project Tracking' },
    });

    await service.createTrackedTask({
      taskId: 'task_1',
      taskType: IntentType.SELF_DEV,
      summary: 'Implement feature',
      localStatus: TaskStatus.QUEUED,
      sourceMessageId: 'om_1',
      sourceTopicKey: 'feishu:tenant:chat:session:session_1',
      chatId: 'oc_1',
      replyToMessageId: 'om_1',
    });

    vi.mocked(client.createTask).mockClear();
    vi.mocked(client.sendMessage).mockClear();
    vi.mocked(client.getMessageAppLink).mockClear();
    vi.mocked(client.patchTaskCustomFields).mockClear();
    vi.mocked(client.addTaskToTasklist).mockClear();

    await service.createTrackedTask({
      taskId: 'task_chat',
      taskType: IntentType.CHAT_REPLY,
      summary: 'Got it',
      localStatus: TaskStatus.QUEUED,
      sourceMessageId: 'om_2',
      sourceTopicKey: 'feishu:tenant:chat:session:session_1',
      chatId: 'oc_1',
      replyToMessageId: 'om_2',
    });

    expect(client.createTask).not.toHaveBeenCalled();
    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(client.getMessageAppLink).not.toHaveBeenCalled();
    expect(client.patchTaskCustomFields).not.toHaveBeenCalled();
    expect(client.addTaskToTasklist).not.toHaveBeenCalled();
    expect(repo.links.get('task_chat')).toBeUndefined();
  });

  it('reopens a completed Feishu task when a same-topic follow-up starts', async () => {
    const service = new FeishuTaskSyncService({
      client,
      repository: repo,
      config: { enabled: true, tasklistName: 'Project Tracking' },
    });

    await service.createTrackedTask({
      taskId: 'task_1',
      taskType: IntentType.SELF_DEV,
      summary: 'Implement feature',
      localStatus: TaskStatus.QUEUED,
      sourceMessageId: 'om_1',
      sourceTopicKey: 'feishu:tenant:chat:session:session_1',
      chatId: 'oc_1',
      replyToMessageId: 'om_1',
    });
    await repo.updateTaskLinkSync({ taskId: 'task_1', lastSyncedStatus: 'completed' });

    vi.mocked(client.createTask).mockClear();
    vi.mocked(client.patchTaskCustomFields).mockClear();
    vi.mocked(client.addTaskToTasklist).mockClear();
    vi.mocked(client.completeTask).mockClear();
    vi.mocked(client.uncompleteTask).mockClear();

    await service.createTrackedTask({
      taskId: 'task_2',
      taskType: IntentType.SELF_DEV,
      summary: 'Follow-up in the same topic',
      localStatus: TaskStatus.QUEUED,
      sourceMessageId: 'om_2',
      sourceTopicKey: 'feishu:tenant:chat:session:session_1',
      chatId: 'oc_1',
      replyToMessageId: 'om_2',
    });

    expect(client.createTask).not.toHaveBeenCalled();
    expect(client.patchTaskCustomFields).toHaveBeenCalledWith('ft_1', [
      { guid: 'field_status', single_select_value: 'opt_todo' },
    ]);
    expect(client.addTaskToTasklist).toHaveBeenCalledWith({
      taskGuid: 'ft_1',
      tasklistGuid: 'tl_1',
      sectionGuid: 'sec_todo',
    });
    expect(client.completeTask).not.toHaveBeenCalled();
    expect(client.uncompleteTask).toHaveBeenCalledWith('ft_1');
    expect(repo.links.get('task_2')).toEqual(
      expect.objectContaining({
        feishuTaskGuid: 'ft_1',
        lastSyncedStatus: 'todo',
        lastSyncError: null,
      }),
    );
  });

  it('reuses and backfills a legacy same-session Feishu task link without a topic key', async () => {
    repo.space = {
      id: 'space_1',
      scopeType: 'global',
      scopeId: 'default',
      tasklistGuid: 'tl_1',
      statusFieldGuid: 'field_status',
      statusOptions: {
        todo: 'opt_todo',
        'in-progress': 'opt_running',
        'to-clarify': 'opt_clarify',
        review: 'opt_review',
        completed: 'opt_completed',
      },
      sections: {
        todo: 'sec_todo',
        'in-progress': 'sec_running',
        'to-clarify': 'sec_clarify',
        review: 'sec_review',
        completed: 'sec_completed',
      },
    };
    await repo.recordTaskLink({
      taskId: 'task_legacy',
      trackingSpaceId: 'space_1',
      feishuTaskGuid: 'ft_legacy',
      feishuTaskUrl: 'https://legacy-task',
      sourceMessageId: 'om_legacy',
      sourceTopicUrl: 'https://legacy-topic',
      lastSyncedStatus: 'completed',
    });
    repo.taskSessions.set('task_legacy', 'session_1');
    const service = new FeishuTaskSyncService({
      client,
      repository: repo,
      config: { enabled: true, tasklistName: 'Project Tracking' },
    });

    await service.createTrackedTask({
      taskId: 'task_2',
      taskType: IntentType.SELF_DEV,
      sessionId: 'session_1',
      summary: 'Follow-up in an old topic',
      localStatus: TaskStatus.QUEUED,
      sourceMessageId: 'om_2',
      sourceTopicKey: 'feishu:tenant:chat:session:session_1',
      chatId: 'oc_1',
      replyToMessageId: 'om_2',
    });

    expect(client.createTask).not.toHaveBeenCalled();
    expect(repo.links.get('task_legacy')).toEqual(
      expect.objectContaining({
        sourceTopicKey: 'feishu:tenant:chat:session:session_1',
      }),
    );
    expect(repo.links.get('task_2')).toEqual(
      expect.objectContaining({
        feishuTaskGuid: 'ft_legacy',
        feishuTaskUrl: 'https://legacy-task',
        sourceTopicKey: 'feishu:tenant:chat:session:session_1',
        sourceTopicUrl: 'https://legacy-topic',
        lastSyncedStatus: 'todo',
      }),
    );
    expect(client.uncompleteTask).toHaveBeenCalledWith('ft_legacy');
  });

  it('initializes a chat task board and stores chat-scoped tracking config', async () => {
    const service = new FeishuTaskSyncService({
      client,
      repository: repo,
      config: { enabled: true },
    });

    const result = await service.initializeChatTrackingSpace({ chatId: 'oc_1' });

    expect(client.getChat).toHaveBeenCalledWith('oc_1');
    expect(client.listChatMembers).toHaveBeenCalledWith('oc_1');
    expect(client.createTasklist).toHaveBeenCalledWith({ name: 'Engineering任务看板' });
    expect(client.addTasklistMembers).toHaveBeenCalledWith('tl_1', [
      { id: 'oc_1', type: 'chat', role: 'editor' },
      { id: 'ou_1', type: 'user', role: 'editor', name: 'User 1' },
      { id: 'ou_2', type: 'user', role: 'editor', name: 'User 2' },
    ]);
    expect(result).toMatchObject({
      tasklistGuid: 'tl_1',
      tasklistName: 'Engineering任务看板',
      memberCount: 2,
      statusFieldGuid: 'field_status',
      created: true,
    });
    await expect(repo.findSpace('chat', 'oc_1')).resolves.toMatchObject({
      scopeType: 'chat',
      scopeId: 'oc_1',
      name: 'Engineering任务看板',
      tasklistGuid: 'tl_1',
      statusFieldGuid: 'field_status',
    });
  });

  it('stores tenant-scoped chat tracking config when tenantKey is provided', async () => {
    const service = new FeishuTaskSyncService({
      client,
      repository: repo,
      config: { enabled: true },
    });

    await service.initializeChatTrackingSpace({ tenantKey: 'tenant_a', chatId: 'oc_1' });

    await expect(repo.findSpace('chat', 'tenant_a:oc_1')).resolves.toMatchObject({
      scopeType: 'chat',
      scopeId: 'tenant_a:oc_1',
      tasklistGuid: 'tl_1',
      statusFieldGuid: 'field_status',
    });
    await expect(repo.findSpace('chat', 'oc_1')).resolves.toBeNull();
  });

  it('returns the existing chat tracking space without creating another task board', async () => {
    await repo.saveSpace({
      scopeType: 'chat',
      scopeId: 'oc_1',
      name: 'Engineering任务看板',
      tasklistGuid: 'tl_existing',
      statusFieldGuid: 'field_existing',
      statusOptions: {
        todo: 'opt_todo',
        'in-progress': 'opt_running',
        'to-clarify': 'opt_clarify',
        review: 'opt_review',
        completed: 'opt_completed',
      },
      sections: {
        todo: 'sec_todo',
        'in-progress': 'sec_running',
        'to-clarify': 'sec_clarify',
        review: 'sec_review',
        completed: 'sec_completed',
      },
    });
    const service = new FeishuTaskSyncService({
      client,
      repository: repo,
      config: { enabled: true },
    });

    const result = await service.initializeChatTrackingSpace({ chatId: 'oc_1' });

    expect(result).toMatchObject({
      tasklistGuid: 'tl_existing',
      tasklistName: 'Engineering任务看板',
      statusFieldGuid: 'field_existing',
      created: false,
    });
    expect(client.getChat).not.toHaveBeenCalled();
    expect(client.listChatMembers).not.toHaveBeenCalled();
    expect(client.createTasklist).not.toHaveBeenCalled();
    expect(client.addTasklistMembers).not.toHaveBeenCalled();
  });

  it('serializes concurrent chat task board initialization for the same chat', async () => {
    vi.mocked(client.createTasklist).mockImplementationOnce(
      async (input: { name?: string }) =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ guid: 'tl_1', url: 'https://tasklist', name: input.name }), 5);
        }),
    );
    const service = new FeishuTaskSyncService({
      client,
      repository: repo,
      config: { enabled: true },
    });

    const results = await Promise.all([
      service.initializeChatTrackingSpace({ chatId: 'oc_1' }),
      service.initializeChatTrackingSpace({ chatId: 'oc_1' }),
    ]);

    expect(client.createTasklist).toHaveBeenCalledTimes(1);
    expect(results.map((result) => result.created).sort()).toEqual([false, true]);
    expect(results).toEqual([
      expect.objectContaining({ tasklistGuid: 'tl_1' }),
      expect.objectContaining({ tasklistGuid: 'tl_1' }),
    ]);
  });

  it('uses an initialized chat tracking space when creating tasks from that chat', async () => {
    await repo.saveSpace({
      scopeType: 'chat',
      scopeId: 'oc_1',
      tasklistGuid: 'tl_chat',
      statusFieldGuid: 'field_chat',
      statusOptions: {
        todo: 'chat_opt_todo',
        'in-progress': 'chat_opt_running',
        'to-clarify': 'chat_opt_clarify',
        review: 'chat_opt_review',
        completed: 'chat_opt_completed',
      },
      sections: {
        todo: 'chat_sec_todo',
        'in-progress': 'chat_sec_running',
        'to-clarify': 'chat_sec_clarify',
        review: 'chat_sec_review',
        completed: 'chat_sec_completed',
      },
    });
    const service = new FeishuTaskSyncService({
      client,
      repository: repo,
      config: { enabled: true, tasklistGuid: 'tl_global' },
    });

    await service.createTrackedTask({
      taskId: 'task_1',
      taskType: IntentType.SELF_DEV,
      summary: 'Implement feature',
      localStatus: TaskStatus.QUEUED,
      chatId: 'oc_1',
    });

    expect(client.createTasklist).not.toHaveBeenCalled();
    expect(client.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        tasklistGuid: 'tl_chat',
        sectionGuid: 'chat_sec_todo',
        customFields: [{ guid: 'field_chat', single_select_value: 'chat_opt_todo' }],
      }),
    );
    expect(repo.links.get('task_1')).toEqual(
      expect.objectContaining({
        trackingSpaceId: 'space_1',
      }),
    );
  });

  it('prefers tenant-scoped chat tracking spaces over legacy chat-only spaces', async () => {
    await repo.saveSpace({
      scopeType: 'chat',
      scopeId: 'oc_1',
      tasklistGuid: 'tl_legacy',
      statusFieldGuid: 'field_legacy',
      statusOptions: {
        todo: 'legacy_opt_todo',
        'in-progress': 'legacy_opt_running',
        'to-clarify': 'legacy_opt_clarify',
        review: 'legacy_opt_review',
        completed: 'legacy_opt_completed',
      },
      sections: {
        todo: 'legacy_sec_todo',
        'in-progress': 'legacy_sec_running',
        'to-clarify': 'legacy_sec_clarify',
        review: 'legacy_sec_review',
        completed: 'legacy_sec_completed',
      },
    });
    await repo.saveSpace({
      scopeType: 'chat',
      scopeId: 'tenant_a:oc_1',
      tasklistGuid: 'tl_tenant',
      statusFieldGuid: 'field_tenant',
      statusOptions: {
        todo: 'tenant_opt_todo',
        'in-progress': 'tenant_opt_running',
        'to-clarify': 'tenant_opt_clarify',
        review: 'tenant_opt_review',
        completed: 'tenant_opt_completed',
      },
      sections: {
        todo: 'tenant_sec_todo',
        'in-progress': 'tenant_sec_running',
        'to-clarify': 'tenant_sec_clarify',
        review: 'tenant_sec_review',
        completed: 'tenant_sec_completed',
      },
    });
    const service = new FeishuTaskSyncService({
      client,
      repository: repo,
      config: { enabled: true },
    });

    await service.createTrackedTask({
      taskId: 'task_1',
      taskType: IntentType.SELF_DEV,
      summary: 'Implement feature',
      localStatus: TaskStatus.QUEUED,
      tenantKey: 'tenant_a',
      chatId: 'oc_1',
    });

    expect(client.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        tasklistGuid: 'tl_tenant',
        sectionGuid: 'tenant_sec_todo',
        customFields: [{ guid: 'field_tenant', single_select_value: 'tenant_opt_todo' }],
      }),
    );
  });

  it('adds another bot to an initialized chat task board and sends configuration', async () => {
    await repo.saveSpace({
      id: 'space_chat',
      scopeType: 'chat',
      scopeId: 'oc_1',
      tasklistGuid: 'tl_chat',
      statusFieldGuid: 'field_chat',
      statusOptions: {
        todo: 'chat_opt_todo',
        'in-progress': 'chat_opt_running',
        'to-clarify': 'chat_opt_clarify',
        review: 'chat_opt_review',
        completed: 'chat_opt_completed',
      },
      sections: {
        todo: 'chat_sec_todo',
        'in-progress': 'chat_sec_running',
        'to-clarify': 'chat_sec_clarify',
        review: 'chat_sec_review',
        completed: 'chat_sec_completed',
      },
    });
    const service = new FeishuTaskSyncService({
      client,
      repository: repo,
      config: { enabled: true },
    });

    const result = await service.addBotToChatTrackingSpace({
      chatId: 'oc_1',
      botOpenId: 'ou_new_bot',
      botName: 'New Bot',
      replyToMessageId: 'om_thread_1',
    });

    expect(client.addTasklistMembers).toHaveBeenCalledWith('tl_chat', [
      { id: 'ou_new_bot', type: 'user', role: 'editor', name: 'New Bot' },
    ]);
    expect(client.sendMessage).toHaveBeenCalledWith(
      'chat_id',
      'oc_1',
      {
        msg_type: 'text',
        content: {
          text: expect.stringMatching(
            /^<at user_id="ou_new_bot">New Bot<\/at> \/configure-tasklist \S+$/,
          ),
        },
      },
      'om_thread_1',
    );
    expect(result).toEqual({
      tasklistGuid: 'tl_chat',
      botOpenId: 'ou_new_bot',
      botName: 'New Bot',
      configurationMessageId: 'om_task_link',
    });
  });

  it('rejects /add-bot targets that are human chat members', async () => {
    await repo.saveSpace({
      id: 'space_chat',
      scopeType: 'chat',
      scopeId: 'oc_1',
      tasklistGuid: 'tl_chat',
      statusFieldGuid: 'field_chat',
      statusOptions: {
        todo: 'chat_opt_todo',
        'in-progress': 'chat_opt_running',
        'to-clarify': 'chat_opt_clarify',
        review: 'chat_opt_review',
        completed: 'chat_opt_completed',
      },
      sections: {
        todo: 'chat_sec_todo',
        'in-progress': 'chat_sec_running',
        'to-clarify': 'chat_sec_clarify',
        review: 'chat_sec_review',
        completed: 'chat_sec_completed',
      },
    });
    const service = new FeishuTaskSyncService({
      client,
      repository: repo,
      config: { enabled: true },
    });

    await expect(
      service.addBotToChatTrackingSpace({
        chatId: 'oc_1',
        botOpenId: 'ou_1',
        botName: 'User 1',
      }),
    ).rejects.toThrow('/add-bot target must be a bot mention');

    expect(client.addTasklistMembers).not.toHaveBeenCalledWith(
      'tl_chat',
      expect.arrayContaining([expect.objectContaining({ id: 'ou_1' })]),
    );
    expect(client.sendMessage).not.toHaveBeenCalled();
  });

  it('applies bot-to-bot task board configuration into chat tracking space', async () => {
    await repo.saveSpace({
      id: 'space_chat',
      scopeType: 'chat',
      scopeId: 'oc_source',
      tasklistGuid: 'tl_shared',
      statusFieldGuid: 'field_shared',
      statusOptions: {
        todo: 'shared_opt_todo',
        'in-progress': 'shared_opt_running',
        'to-clarify': 'shared_opt_clarify',
        review: 'shared_opt_review',
        completed: 'shared_opt_completed',
      },
      sections: {
        todo: 'shared_sec_todo',
        'in-progress': 'shared_sec_running',
        'to-clarify': 'shared_sec_clarify',
        review: 'shared_sec_review',
        completed: 'shared_sec_completed',
      },
    });
    const sourceService = new FeishuTaskSyncService({
      client,
      repository: repo,
      config: { enabled: true },
    });
    await sourceService.addBotToChatTrackingSpace({
      chatId: 'oc_source',
      botOpenId: 'ou_new_bot',
    });
    const sentText = (
      vi.mocked(client.sendMessage).mock.calls[0][2] as { content: { text: string } }
    ).content.text;
    const encodedPayload = sentText.replace(/^.*\/configure-tasklist /, '');

    const targetRepo = new MemoryTrackingRepository();
    const targetService = new FeishuTaskSyncService({
      client,
      repository: targetRepo,
      config: { enabled: true },
    });

    const result = await targetService.applyChatTasklistConfiguration({ encodedPayload });

    expect(result).toEqual({ chatId: 'oc_source', tasklistGuid: 'tl_shared' });
    await expect(targetRepo.findSpace('chat', 'oc_source')).resolves.toMatchObject({
      scopeType: 'chat',
      scopeId: 'oc_source',
      tasklistGuid: 'tl_shared',
      statusFieldGuid: 'field_shared',
      statusOptions: expect.objectContaining({ todo: 'shared_opt_todo' }),
      sections: expect.objectContaining({ todo: 'shared_sec_todo' }),
    });
  });

  it('syncs status through the task link tracking space', async () => {
    await repo.saveSpace({
      id: 'space_chat',
      scopeType: 'chat',
      scopeId: 'oc_1',
      tasklistGuid: 'tl_chat',
      statusFieldGuid: 'field_chat',
      statusOptions: {
        todo: 'chat_opt_todo',
        'in-progress': 'chat_opt_running',
        'to-clarify': 'chat_opt_clarify',
        review: 'chat_opt_review',
        completed: 'chat_opt_completed',
      },
      sections: {
        todo: 'chat_sec_todo',
        'in-progress': 'chat_sec_running',
        'to-clarify': 'chat_sec_clarify',
        review: 'chat_sec_review',
        completed: 'chat_sec_completed',
      },
    });
    await repo.recordTaskLink({
      taskId: 'task_1',
      trackingSpaceId: 'space_chat',
      feishuTaskGuid: 'ft_1',
    });
    const service = new FeishuTaskSyncService({
      client,
      repository: repo,
      config: { enabled: true, tasklistGuid: 'tl_global' },
    });

    await service.syncTaskStatus({ taskId: 'task_1', localStatus: TaskStatus.RUNNING });

    expect(client.patchTaskCustomFields).toHaveBeenCalledWith('ft_1', [
      { guid: 'field_chat', single_select_value: 'chat_opt_running' },
    ]);
    expect(client.addTaskToTasklist).toHaveBeenCalledWith({
      taskGuid: 'ft_1',
      tasklistGuid: 'tl_chat',
      sectionGuid: 'chat_sec_running',
    });
  });

  it('creates the Feishu task and records a warning when the source topic link is unavailable', async () => {
    vi.mocked(client.getMessageAppLink).mockResolvedValueOnce(null);
    const service = new FeishuTaskSyncService({
      client,
      repository: repo,
      config: { enabled: true },
    });

    await service.createTrackedTask({
      taskId: 'task_1',
      taskType: IntentType.SELF_DEV,
      summary: 'Implement feature',
      localStatus: TaskStatus.QUEUED,
      sourceMessageId: 'om_1',
      chatId: 'oc_1',
    });

    expect(client.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        description: 'OpenClaudeTag task: task_1',
        origin: undefined,
      }),
    );
    expect(repo.links.get('task_1')).toEqual(
      expect.objectContaining({
        feishuTaskGuid: 'ft_1',
        sourceMessageId: 'om_1',
        sourceTopicUrl: null,
        lastSyncError: 'source topic link unavailable',
      }),
    );
  });

  it('creates the Feishu task when source topic link lookup fails', async () => {
    vi.mocked(client.getMessageAppLink).mockRejectedValueOnce(new Error('missing im scope'));
    const service = new FeishuTaskSyncService({
      client,
      repository: repo,
      config: { enabled: true },
    });

    await service.createTrackedTask({
      taskId: 'task_1',
      taskType: IntentType.SELF_DEV,
      summary: 'Implement feature',
      localStatus: TaskStatus.QUEUED,
      sourceMessageId: 'om_1',
      chatId: 'oc_1',
    });

    expect(client.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        description: 'OpenClaudeTag task: task_1',
        origin: undefined,
      }),
    );
    expect(repo.links.get('task_1')).toEqual(
      expect.objectContaining({
        feishuTaskGuid: 'ft_1',
        feishuTaskUrl: 'https://task',
        sourceMessageId: 'om_1',
        sourceTopicUrl: null,
        lastSyncError: 'source topic link unavailable: missing im scope',
      }),
    );
  });

  it('keeps the Feishu task link when replying the source topic fails', async () => {
    vi.mocked(client.sendMessage).mockRejectedValueOnce(new Error('bot out of chat'));
    const service = new FeishuTaskSyncService({
      client,
      repository: repo,
      config: { enabled: true },
    });

    await service.createTrackedTask({
      taskId: 'task_1',
      taskType: IntentType.SELF_DEV,
      summary: 'Implement feature',
      localStatus: TaskStatus.QUEUED,
      sourceMessageId: 'om_1',
      chatId: 'oc_1',
    });

    expect(repo.links.get('task_1')).toEqual(
      expect.objectContaining({
        feishuTaskGuid: 'ft_1',
        feishuTaskUrl: 'https://task',
        sourceTopicUrl: 'https://topic',
        lastSyncedStatus: 'todo',
        lastSyncError: 'source topic reply failed: bot out of chat',
      }),
    );
  });

  it('syncs running status to custom field and section', async () => {
    repo.space = {
      id: 'space_1',
      scopeType: 'global',
      scopeId: 'default',
      tasklistGuid: 'tl_1',
      statusFieldGuid: 'field_status',
      statusOptions: {
        todo: 'opt_todo',
        'in-progress': 'opt_running',
        'to-clarify': 'opt_clarify',
        review: 'opt_review',
        completed: 'opt_completed',
      },
      sections: {
        todo: 'sec_todo',
        'in-progress': 'sec_running',
        'to-clarify': 'sec_clarify',
        review: 'sec_review',
        completed: 'sec_completed',
      },
    };
    await repo.recordTaskLink({ taskId: 'task_1', feishuTaskGuid: 'ft_1' });
    const service = new FeishuTaskSyncService({
      client,
      repository: repo,
      config: { enabled: true },
    });

    await service.syncTaskStatus({ taskId: 'task_1', localStatus: TaskStatus.RUNNING });

    expect(client.patchTaskCustomFields).toHaveBeenCalledWith('ft_1', [
      { guid: 'field_status', single_select_value: 'opt_running' },
    ]);
    expect(client.addTaskToTasklist).toHaveBeenCalledWith({
      taskGuid: 'ft_1',
      tasklistGuid: 'tl_1',
      sectionGuid: 'sec_running',
    });
    expect(client.completeTask).not.toHaveBeenCalled();
    expect(repo.links.get('task_1')?.lastSyncedStatus).toBe('in-progress');
  });

  it('clears native completion when a linked task moves out of completed status', async () => {
    repo.space = {
      id: 'space_1',
      scopeType: 'global',
      scopeId: 'default',
      tasklistGuid: 'tl_1',
      statusFieldGuid: 'field_status',
      statusOptions: {
        todo: 'opt_todo',
        'in-progress': 'opt_running',
        'to-clarify': 'opt_clarify',
        review: 'opt_review',
        completed: 'opt_completed',
      },
      sections: {
        todo: 'sec_todo',
        'in-progress': 'sec_running',
        'to-clarify': 'sec_clarify',
        review: 'sec_review',
        completed: 'sec_completed',
      },
    };
    await repo.recordTaskLink({
      taskId: 'task_1',
      feishuTaskGuid: 'ft_1',
      lastSyncedStatus: 'completed',
    });
    const service = new FeishuTaskSyncService({
      client,
      repository: repo,
      config: { enabled: true },
    });

    await service.syncTaskStatus({ taskId: 'task_1', localStatus: TaskStatus.RUNNING });

    expect(client.completeTask).not.toHaveBeenCalled();
    expect(client.uncompleteTask).toHaveBeenCalledWith('ft_1');
    expect(repo.links.get('task_1')?.lastSyncedStatus).toBe('in-progress');
  });

  it('uses native completion when local task completes', async () => {
    repo.space = {
      id: 'space_1',
      scopeType: 'global',
      scopeId: 'default',
      tasklistGuid: 'tl_1',
      statusFieldGuid: 'field_status',
      statusOptions: {
        todo: 'opt_todo',
        'in-progress': 'opt_running',
        'to-clarify': 'opt_clarify',
        review: 'opt_review',
        completed: 'opt_completed',
      },
      sections: {
        todo: 'sec_todo',
        'in-progress': 'sec_running',
        'to-clarify': 'sec_clarify',
        review: 'sec_review',
        completed: 'sec_completed',
      },
    };
    await repo.recordTaskLink({ taskId: 'task_1', feishuTaskGuid: 'ft_1' });
    const service = new FeishuTaskSyncService({
      client,
      repository: repo,
      config: { enabled: true },
    });

    await service.syncTaskStatus({ taskId: 'task_1', localStatus: TaskStatus.COMPLETED });

    expect(client.patchTaskCustomFields).toHaveBeenCalledWith('ft_1', [
      { guid: 'field_status', single_select_value: 'opt_completed' },
    ]);
    expect(client.addTaskToTasklist).toHaveBeenCalledWith({
      taskGuid: 'ft_1',
      tasklistGuid: 'tl_1',
      sectionGuid: 'sec_completed',
    });
    expect(client.completeTask).toHaveBeenCalledWith('ft_1');
    expect(repo.links.get('task_1')?.lastSyncedStatus).toBe('completed');
  });

  it('cleans completed tasks for the current session after the retention window', async () => {
    repo.space = {
      id: 'space_1',
      scopeType: 'global',
      scopeId: 'default',
      tasklistGuid: 'tl_1',
      statusFieldGuid: 'field_status',
      statusOptions: {
        todo: 'opt_todo',
        'in-progress': 'opt_running',
        'to-clarify': 'opt_clarify',
        review: 'opt_review',
        completed: 'opt_completed',
      },
      sections: {
        todo: 'sec_todo',
        'in-progress': 'sec_running',
        'to-clarify': 'sec_clarify',
        review: 'sec_review',
        completed: 'sec_completed',
      },
    };
    repo.completedLinks = [
      {
        taskId: 'task_1',
        trackingSpaceId: 'space_1',
        feishuTaskGuid: 'ft_1',
        lastSyncedStatus: 'completed',
        completedAt: new Date('2026-05-20T00:00:00Z'),
      },
      {
        taskId: 'task_recent',
        trackingSpaceId: 'space_1',
        feishuTaskGuid: 'ft_recent',
        lastSyncedStatus: 'completed',
        completedAt: new Date('2026-06-02T00:00:00Z'),
      },
    ];
    await repo.recordTaskLink(repo.completedLinks[0]);
    await repo.recordTaskLink(repo.completedLinks[1]);
    const service = new FeishuTaskSyncService({
      client,
      repository: repo,
      config: { enabled: true, completedTaskRetentionDays: 7 },
    });

    const result = await service.cleanCompletedTasksForSession({
      sessionId: 'session_1',
      now: new Date('2026-06-03T00:00:00Z'),
    });

    expect(result).toMatchObject({
      scope: 'session',
      retentionDays: 7,
      scanned: 1,
      eligible: 1,
      removed: 1,
      failed: 0,
    });
    expect(client.removeTaskFromTasklist).toHaveBeenCalledWith({
      taskGuid: 'ft_1',
      tasklistGuid: 'tl_1',
    });
    expect(client.removeTaskFromTasklist).toHaveBeenCalledTimes(1);
    expect(repo.links.get('task_1')?.lastSyncedStatus).toBe('cleaned');
    expect(repo.links.get('task_recent')?.lastSyncedStatus).toBe('completed');
  });

  it('does not remove a shared Feishu task while another linked task is still active', async () => {
    repo.space = {
      id: 'space_1',
      scopeType: 'global',
      scopeId: 'default',
      tasklistGuid: 'tl_1',
      statusFieldGuid: 'field_status',
      statusOptions: {
        todo: 'opt_todo',
        'in-progress': 'opt_running',
        'to-clarify': 'opt_clarify',
        review: 'opt_review',
        completed: 'opt_completed',
      },
      sections: {
        todo: 'sec_todo',
        'in-progress': 'sec_running',
        'to-clarify': 'sec_clarify',
        review: 'sec_review',
        completed: 'sec_completed',
      },
    };
    repo.completedLinks = [
      {
        taskId: 'task_old',
        trackingSpaceId: 'space_1',
        feishuTaskGuid: 'ft_shared',
        lastSyncedStatus: 'completed',
        completedAt: new Date('2026-05-20T00:00:00Z'),
      },
    ];
    await repo.recordTaskLink(repo.completedLinks[0]);
    await repo.recordTaskLink({
      taskId: 'task_active',
      trackingSpaceId: 'space_1',
      feishuTaskGuid: 'ft_shared',
      lastSyncedStatus: 'in-progress',
    });
    repo.taskStatuses.set('task_old', TaskStatus.COMPLETED);
    repo.taskUpdatedAt.set('task_old', new Date('2026-05-20T00:00:00Z'));
    repo.taskStatuses.set('task_active', TaskStatus.RUNNING);
    const service = new FeishuTaskSyncService({
      client,
      repository: repo,
      config: { enabled: true, completedTaskRetentionDays: 7 },
    });

    const result = await service.cleanCompletedTasksForSession({
      sessionId: 'session_1',
      now: new Date('2026-06-03T00:00:00Z'),
    });

    expect(result).toMatchObject({
      scanned: 1,
      eligible: 1,
      removed: 0,
      skipped: 1,
      failed: 0,
    });
    expect(client.removeTaskFromTasklist).not.toHaveBeenCalled();
    expect(repo.links.get('task_old')?.lastSyncedStatus).toBe('completed');
  });

  it('removes a shared Feishu task once and marks duplicate eligible links cleaned', async () => {
    repo.space = {
      id: 'space_1',
      scopeType: 'global',
      scopeId: 'default',
      tasklistGuid: 'tl_1',
      statusFieldGuid: 'field_status',
      statusOptions: {
        todo: 'opt_todo',
        'in-progress': 'opt_running',
        'to-clarify': 'opt_clarify',
        review: 'opt_review',
        completed: 'opt_completed',
      },
      sections: {
        todo: 'sec_todo',
        'in-progress': 'sec_running',
        'to-clarify': 'sec_clarify',
        review: 'sec_review',
        completed: 'sec_completed',
      },
    };
    repo.completedLinks = [
      {
        taskId: 'task_old_1',
        trackingSpaceId: 'space_1',
        feishuTaskGuid: 'ft_shared',
        lastSyncedStatus: 'completed',
        completedAt: new Date('2026-05-20T00:00:00Z'),
      },
      {
        taskId: 'task_old_2',
        trackingSpaceId: 'space_1',
        feishuTaskGuid: 'ft_shared',
        lastSyncedStatus: 'completed',
        completedAt: new Date('2026-05-21T00:00:00Z'),
      },
    ];
    for (const link of repo.completedLinks) {
      await repo.recordTaskLink(link);
      repo.taskStatuses.set(link.taskId, TaskStatus.COMPLETED);
      repo.taskUpdatedAt.set(link.taskId, link.completedAt);
    }
    const service = new FeishuTaskSyncService({
      client,
      repository: repo,
      config: { enabled: true, completedTaskRetentionDays: 7 },
    });

    const result = await service.cleanCompletedTasksForSession({
      sessionId: 'session_1',
      now: new Date('2026-06-03T00:00:00Z'),
    });

    expect(result).toMatchObject({
      scanned: 2,
      eligible: 2,
      removed: 1,
      skipped: 1,
      failed: 0,
    });
    expect(client.removeTaskFromTasklist).toHaveBeenCalledTimes(1);
    expect(client.removeTaskFromTasklist).toHaveBeenCalledWith({
      taskGuid: 'ft_shared',
      tasklistGuid: 'tl_1',
    });
    expect(repo.links.get('task_old_1')?.lastSyncedStatus).toBe('cleaned');
    expect(repo.links.get('task_old_2')?.lastSyncedStatus).toBe('cleaned');
  });

  it('dry-runs session cleanup without removing tasks', async () => {
    repo.space = {
      id: 'space_1',
      scopeType: 'global',
      scopeId: 'default',
      tasklistGuid: 'tl_1',
      statusFieldGuid: 'field_status',
      statusOptions: {
        todo: 'opt_todo',
        'in-progress': 'opt_running',
        'to-clarify': 'opt_clarify',
        review: 'opt_review',
        completed: 'opt_completed',
      },
      sections: {
        todo: 'sec_todo',
        'in-progress': 'sec_running',
        'to-clarify': 'sec_clarify',
        review: 'sec_review',
        completed: 'sec_completed',
      },
    };
    repo.completedLinks = [
      {
        taskId: 'task_1',
        trackingSpaceId: 'space_1',
        feishuTaskGuid: 'ft_1',
        lastSyncedStatus: 'completed',
        completedAt: new Date('2026-05-20T00:00:00Z'),
      },
    ];
    const service = new FeishuTaskSyncService({
      client,
      repository: repo,
      config: { enabled: true, completedTaskRetentionDays: 7 },
    });

    const result = await service.cleanCompletedTasksForSession({
      sessionId: 'session_1',
      now: new Date('2026-06-03T00:00:00Z'),
      dryRun: true,
    });

    expect(result).toMatchObject({ dryRun: true, scanned: 1, eligible: 1, removed: 0 });
    expect(client.removeTaskFromTasklist).not.toHaveBeenCalled();
  });

  it('keeps session cleanup dry-run read-only when the tracking space is missing', async () => {
    repo.completedLinks = [
      {
        taskId: 'task_1',
        trackingSpaceId: 'missing_space',
        feishuTaskGuid: 'ft_1',
        lastSyncedStatus: 'completed',
        completedAt: new Date('2026-05-20T00:00:00Z'),
      },
    ];
    const service = new FeishuTaskSyncService({
      client,
      repository: repo,
      config: { enabled: true, completedTaskRetentionDays: 7 },
    });

    const result = await service.cleanCompletedTasksForSession({
      sessionId: 'session_1',
      now: new Date('2026-06-03T00:00:00Z'),
      dryRun: true,
    });

    expect(result).toMatchObject({
      dryRun: true,
      scanned: 1,
      eligible: 1,
      removed: 0,
      failed: 1,
    });
    expect(result.failures[0]).toMatchObject({
      taskId: 'task_1',
      taskGuid: 'ft_1',
      error: 'Feishu Task tracking space is missing for this task link',
    });
    expect(client.createTasklist).not.toHaveBeenCalled();
    expect(client.createTaskCustomField).not.toHaveBeenCalled();
    expect(client.createTaskSection).not.toHaveBeenCalled();
    expect(client.removeTaskFromTasklist).not.toHaveBeenCalled();
    expect(repo.spaces.size).toBe(0);
  });

  it('cleans completed tasks from a chat task board after the retention window', async () => {
    repo.spaces.set('chat:oc_1', {
      id: 'space_chat',
      scopeType: 'chat',
      scopeId: 'oc_1',
      tasklistGuid: 'tl_chat',
      statusFieldGuid: 'field_status',
      statusOptions: {
        todo: 'opt_todo',
        'in-progress': 'opt_running',
        'to-clarify': 'opt_clarify',
        review: 'opt_review',
        completed: 'opt_completed',
      },
      sections: {
        todo: 'sec_todo',
        'in-progress': 'sec_running',
        'to-clarify': 'sec_clarify',
        review: 'sec_review',
        completed: 'sec_completed',
      },
    });
    vi.mocked(client.listTasklistTasks).mockResolvedValueOnce([
      { guid: 'ft_old', summary: 'old', completedAt: '1778889600000' },
      { guid: 'ft_recent', summary: 'recent', completedAt: '1780444800000' },
      { guid: 'ft_unknown', summary: 'unknown' },
    ]);
    const service = new FeishuTaskSyncService({
      client,
      repository: repo,
      config: { enabled: true, completedTaskRetentionDays: 7 },
    });

    const result = await service.cleanCompletedTasksForChat({
      chatId: 'oc_1',
      now: new Date('2026-06-03T00:00:00Z'),
    });

    expect(result).toMatchObject({
      scope: 'chat',
      tasklistGuid: 'tl_chat',
      scanned: 3,
      eligible: 1,
      removed: 1,
      skipped: 2,
      failed: 0,
    });
    expect(client.listTasklistTasks).toHaveBeenCalledWith({
      tasklistGuid: 'tl_chat',
      completed: true,
    });
    expect(client.removeTaskFromTasklist).toHaveBeenCalledWith({
      taskGuid: 'ft_old',
      tasklistGuid: 'tl_chat',
    });
    expect(client.removeTaskFromTasklist).toHaveBeenCalledTimes(1);
  });

  it('records create failures without throwing', async () => {
    vi.mocked(client.createTasklist).mockRejectedValueOnce(new Error('missing scope'));
    const service = new FeishuTaskSyncService({
      client,
      repository: repo,
      config: { enabled: true },
    });

    await service.createTrackedTask({
      taskId: 'task_1',
      taskType: IntentType.SELF_DEV,
      summary: 'Implement feature',
      localStatus: TaskStatus.QUEUED,
      sourceMessageId: 'om_1',
    });

    expect(repo.links.get('task_1')?.lastSyncError).toBe('missing scope');
  });

  it('records status sync failures without throwing', async () => {
    repo.space = {
      id: 'space_1',
      scopeType: 'global',
      scopeId: 'default',
      tasklistGuid: 'tl_1',
      statusFieldGuid: 'field_status',
      statusOptions: {
        todo: 'opt_todo',
        'in-progress': 'opt_running',
        'to-clarify': 'opt_clarify',
        review: 'opt_review',
        completed: 'opt_completed',
      },
      sections: {
        todo: 'sec_todo',
        'in-progress': 'sec_running',
        'to-clarify': 'sec_clarify',
        review: 'sec_review',
        completed: 'sec_completed',
      },
    };
    await repo.recordTaskLink({ taskId: 'task_1', feishuTaskGuid: 'ft_1' });
    vi.mocked(client.patchTaskCustomFields).mockRejectedValueOnce(new Error('rate limited'));
    const service = new FeishuTaskSyncService({
      client,
      repository: repo,
      config: { enabled: true },
    });

    await service.syncTaskStatus({ taskId: 'task_1', localStatus: TaskStatus.RUNNING });

    expect(repo.links.get('task_1')?.lastSyncError).toBe('rate limited');
  });
});
