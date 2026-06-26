import { describe, expect, it, vi, beforeEach } from 'vitest';
import { FeishuClient } from '../feishu-client.js';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

function makeTokenResponse() {
  return {
    ok: true,
    json: async () => ({ tenant_access_token: 'test_token', expire: 7200 }),
  };
}

function makeApiResponse(data: unknown) {
  return {
    ok: true,
    json: async () => ({ code: 0, data }),
  };
}

describe('FeishuClient task APIs', () => {
  let client: FeishuClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new FeishuClient({ appId: 'app_id', appSecret: 'secret' });
  });

  it('creates tasklists through task/v2/tasklists', async () => {
    fetchMock
      .mockResolvedValueOnce(makeTokenResponse())
      .mockResolvedValueOnce(
        makeApiResponse({ tasklist: { guid: 'tl_1', url: 'https://tasklist' } }),
      );

    const result = await client.createTasklist({ name: 'Project Tracking' });

    expect(result.guid).toBe('tl_1');
    const [url, opts] = fetchMock.mock.calls[1];
    expect(url).toBe('https://open.feishu.cn/open-apis/task/v2/tasklists');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual({ name: 'Project Tracking' });
  });

  it('creates the Status single-select custom field', async () => {
    fetchMock.mockResolvedValueOnce(makeTokenResponse()).mockResolvedValueOnce(
      makeApiResponse({
        custom_field: { guid: 'field_1', name: 'Status', type: 'single_select' },
      }),
    );

    await client.createTaskCustomField({
      tasklistGuid: 'tl_1',
      name: 'Status',
      type: 'single_select',
      options: [{ name: 'todo' }, { name: 'in-progress' }],
    });

    const [url, opts] = fetchMock.mock.calls[1];
    expect(url).toBe('https://open.feishu.cn/open-apis/task/v2/custom_fields');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual({
      resource_type: 'tasklist',
      resource_id: 'tl_1',
      name: 'Status',
      type: 'single_select',
      single_select_setting: { options: [{ name: 'todo' }, { name: 'in-progress' }] },
    });
  });

  it('creates a missing single-select option', async () => {
    fetchMock
      .mockResolvedValueOnce(makeTokenResponse())
      .mockResolvedValueOnce(makeApiResponse({ option: { guid: 'opt_todo', name: 'todo' } }));

    const option = await client.createTaskCustomFieldOption('field_status', 'todo');

    expect(option).toEqual({ guid: 'opt_todo', name: 'todo' });
    const [url, opts] = fetchMock.mock.calls[1];
    expect(url).toBe('https://open.feishu.cn/open-apis/task/v2/custom_fields/field_status/options');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual({ name: 'todo' });
  });

  it('lists sections with tasklist resource filters', async () => {
    fetchMock
      .mockResolvedValueOnce(makeTokenResponse())
      .mockResolvedValueOnce(
        makeApiResponse({ items: [{ guid: 'sec_1', name: 'todo' }], has_more: false }),
      );

    const sections = await client.listTaskSections('tl_1');

    expect(sections).toEqual([{ guid: 'sec_1', name: 'todo' }]);
    const [url, opts] = fetchMock.mock.calls[1];
    expect(url).toContain('/task/v2/sections?');
    expect(url).toContain('resource_type=tasklist');
    expect(url).toContain('resource_id=tl_1');
    expect(opts.method).toBe('GET');
  });

  it('creates a task with section, status field, origin, and follower', async () => {
    fetchMock
      .mockResolvedValueOnce(makeTokenResponse())
      .mockResolvedValueOnce(makeApiResponse({ task: { guid: 'task_1', url: 'https://task' } }));

    await client.createTask({
      summary: 'Implement feature',
      description: 'OpenClaudeTag task task_1',
      tasklistGuid: 'tl_1',
      sectionGuid: 'sec_todo',
      customFields: [{ guid: 'field_status', single_select_value: 'option_todo' }],
      origin: {
        platform_i18n_name: { zh_cn: '飞书话题', en_us: 'Lark Thread' },
        href: { title: 'Open source topic', url: 'https://topic' },
      },
      members: [{ id: 'ou_user', type: 'user', role: 'follower' }],
      clientToken: 'local-task-id',
    });

    const [url, opts] = fetchMock.mock.calls[1];
    expect(url).toBe('https://open.feishu.cn/open-apis/task/v2/tasks');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual({
      summary: 'Implement feature',
      description: 'OpenClaudeTag task task_1',
      client_token: 'local-task-id',
      tasklists: [{ tasklist_guid: 'tl_1', section_guid: 'sec_todo' }],
      custom_fields: [{ guid: 'field_status', single_select_value: 'option_todo' }],
      origin: {
        platform_i18n_name: { zh_cn: '飞书话题', en_us: 'Lark Thread' },
        href: { title: 'Open source topic', url: 'https://topic' },
      },
      members: [{ id: 'ou_user', type: 'user', role: 'follower' }],
    });
  });

  it('patches custom fields and section separately', async () => {
    fetchMock
      .mockResolvedValueOnce(makeTokenResponse())
      .mockResolvedValueOnce(makeApiResponse({ task: { guid: 'task_1' } }))
      .mockResolvedValueOnce(makeApiResponse({}));

    await client.patchTaskCustomFields('task_1', [
      { guid: 'field_status', single_select_value: 'option_running' },
    ]);
    await client.addTaskToTasklist({
      taskGuid: 'task_1',
      tasklistGuid: 'tl_1',
      sectionGuid: 'sec_running',
    });

    const [patchUrl, patchOpts] = fetchMock.mock.calls[1];
    expect(patchUrl).toBe(
      'https://open.feishu.cn/open-apis/task/v2/tasks/task_1?user_id_type=open_id',
    );
    expect(patchOpts.method).toBe('PATCH');
    expect(JSON.parse(patchOpts.body)).toEqual({
      update_fields: ['custom_fields'],
      task: {
        custom_fields: [{ guid: 'field_status', single_select_value: 'option_running' }],
      },
    });

    const [addUrl, addOpts] = fetchMock.mock.calls[2];
    expect(addUrl).toBe(
      'https://open.feishu.cn/open-apis/task/v2/tasks/task_1/add_tasklist?user_id_type=open_id',
    );
    expect(addOpts.method).toBe('POST');
    expect(JSON.parse(addOpts.body)).toEqual({
      tasklist_guid: 'tl_1',
      section_guid: 'sec_running',
    });
  });

  it('removes a task from a tasklist without deleting the task', async () => {
    fetchMock.mockResolvedValueOnce(makeTokenResponse()).mockResolvedValueOnce(makeApiResponse({}));

    await client.removeTaskFromTasklist({ taskGuid: 'task_1', tasklistGuid: 'tl_1' });

    const [url, opts] = fetchMock.mock.calls[1];
    expect(url).toBe(
      'https://open.feishu.cn/open-apis/task/v2/tasks/task_1/remove_tasklist?user_id_type=open_id',
    );
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual({ tasklist_guid: 'tl_1' });
  });

  it('lists completed tasklist tasks across pages', async () => {
    fetchMock
      .mockResolvedValueOnce(makeTokenResponse())
      .mockResolvedValueOnce(
        makeApiResponse({
          items: [{ guid: 'task_1', summary: 'Done 1', completed_at: '123456' }],
          has_more: true,
          page_token: 'next_page',
        }),
      )
      .mockResolvedValueOnce(
        makeApiResponse({
          items: [{ guid: 'task_2', summary: 'Done 2', completed_at: '123999' }],
          has_more: false,
        }),
      );

    const result = await client.listTasklistTasks({ tasklistGuid: 'tl_1', completed: true });

    expect(result).toEqual([
      { guid: 'task_1', summary: 'Done 1', completedAt: '123456' },
      { guid: 'task_2', summary: 'Done 2', completedAt: '123999' },
    ]);
    const [firstUrl, firstOpts] = fetchMock.mock.calls[1];
    expect(firstUrl).toContain('/task/v2/tasklists/tl_1/tasks?');
    expect(firstUrl).toContain('completed=true');
    expect(firstUrl).toContain('page_size=100');
    expect(firstOpts.method).toBe('GET');
    const [secondUrl] = fetchMock.mock.calls[2];
    expect(secondUrl).toContain('page_token=next_page');
  });

  it('marks a task complete with completed_at', async () => {
    fetchMock
      .mockResolvedValueOnce(makeTokenResponse())
      .mockResolvedValueOnce(makeApiResponse({ task: { guid: 'task_1' } }));

    await client.completeTask('task_1', 123456);

    const [url, opts] = fetchMock.mock.calls[1];
    expect(url).toBe('https://open.feishu.cn/open-apis/task/v2/tasks/task_1?user_id_type=open_id');
    expect(opts.method).toBe('PATCH');
    expect(JSON.parse(opts.body)).toEqual({
      update_fields: ['completed_at'],
      task: { completed_at: '123456' },
    });
  });

  it('clears task completion with completed_at zero', async () => {
    fetchMock
      .mockResolvedValueOnce(makeTokenResponse())
      .mockResolvedValueOnce(makeApiResponse({ task: { guid: 'task_1' } }));

    await client.uncompleteTask('task_1');

    const [url, opts] = fetchMock.mock.calls[1];
    expect(url).toBe('https://open.feishu.cn/open-apis/task/v2/tasks/task_1?user_id_type=open_id');
    expect(opts.method).toBe('PATCH');
    expect(JSON.parse(opts.body)).toEqual({
      update_fields: ['completed_at'],
      task: { completed_at: '0' },
    });
  });

  it('reads message_app_link from message mget', async () => {
    fetchMock
      .mockResolvedValueOnce(makeTokenResponse())
      .mockResolvedValueOnce(
        makeApiResponse({ items: [{ message_id: 'om_1', message_app_link: 'https://topic' }] }),
      );

    const link = await client.getMessageAppLink('om_1');

    expect(link).toBe('https://topic');
    const [url, opts] = fetchMock.mock.calls[1];
    expect(url).toContain('/im/v1/messages/mget?');
    expect(url).toContain('message_ids=om_1');
    expect(opts.method).toBe('GET');
  });

  it('reads message content from the single message API body', async () => {
    fetchMock.mockResolvedValueOnce(makeTokenResponse()).mockResolvedValueOnce(
      makeApiResponse({
        items: [
          {
            message_id: 'om_1',
            msg_type: 'image',
            body: { content: JSON.stringify({ image_key: 'img_ref_1' }) },
          },
        ],
      }),
    );

    const message = await client.getMessage('om_1');

    expect(message).toEqual({
      messageId: 'om_1',
      messageType: 'image',
      content: JSON.stringify({ image_key: 'img_ref_1' }),
    });
    const [url, opts] = fetchMock.mock.calls[1];
    expect(url).toContain('/im/v1/messages/om_1?');
    expect(url).toContain('user_id_type=open_id');
    expect(url).toContain('card_msg_content_type=user_card_content');
    expect(opts.method).toBe('GET');
  });

  it('maps parent and explicit reference fields from the single message API body', async () => {
    fetchMock.mockResolvedValueOnce(makeTokenResponse()).mockResolvedValueOnce(
      makeApiResponse({
        items: [
          {
            message_id: 'om_2',
            thread_id: 'omt_thread_2',
            root_id: 'om_root_2',
            parent_id: 'om_thread_parent',
            reference_message_id: 'om_1',
            msg_type: 'text',
            body: { content: JSON.stringify({ text: 'reply text' }) },
          },
        ],
      }),
    );

    const message = await client.getMessage('om_2');

    expect(message).toEqual({
      messageId: 'om_2',
      messageType: 'text',
      content: JSON.stringify({ text: 'reply text' }),
      threadId: 'omt_thread_2',
      rootMessageId: 'om_root_2',
      parentMessageId: 'om_thread_parent',
      referenceMessageId: 'om_1',
    });
  });

  it('keeps every item returned for merge-forward message content', async () => {
    fetchMock.mockResolvedValueOnce(makeTokenResponse()).mockResolvedValueOnce(
      makeApiResponse({
        items: [
          {
            message_id: 'om_merge',
            msg_type: 'merge_forward',
            body: { content: JSON.stringify({ content: 'Merged and Forwarded Message' }) },
          },
          {
            message_id: 'om_child_text',
            upper_message_id: 'om_merge',
            msg_type: 'text',
            sender: { id: 'ou_1', name: 'Alice' },
            body: { content: JSON.stringify({ text: 'First child' }) },
          },
          {
            message_id: 'om_child_image',
            upper_message_id: 'om_merge',
            msg_type: 'image',
            sender: { id: 'ou_2', name: 'Bob' },
            body: { content: JSON.stringify({ image_key: 'img_child_1' }) },
          },
        ],
      }),
    );

    const message = await client.getMessage('om_merge');

    expect(message).toEqual({
      messageId: 'om_merge',
      messageType: 'merge_forward',
      content: JSON.stringify({ content: 'Merged and Forwarded Message' }),
      children: [
        {
          messageId: 'om_child_text',
          messageType: 'text',
          content: JSON.stringify({ text: 'First child' }),
          senderName: 'Alice',
        },
        {
          messageId: 'om_child_image',
          messageType: 'image',
          content: JSON.stringify({ image_key: 'img_child_1' }),
          senderName: 'Bob',
        },
      ],
    });
  });
});
