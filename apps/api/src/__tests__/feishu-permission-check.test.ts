import { describe, expect, it } from 'vitest';
import {
  buildOpenClaudeTagFeishuPermissionInventory,
  OPEN_TAG_FEISHU_PERMISSION_INVENTORY,
  evaluateFeishuPermissionScopes,
} from '../feishu-permission-check.js';

describe('Feishu permission check inventory', () => {
  it('passes when every required capability has one opened scope per group', () => {
    const result = evaluateFeishuPermissionScopes({
      grantedScopes: [
        'im:message.p2p_msg:readonly',
        'im:message.group_at_msg:readonly',
        'im:message:send_as_bot',
        'im:message:update',
        'im:message.reactions:write_only',
        'im:message:readonly',
        'im:resource',
        'docs:event:subscribe',
        'docs:document.comment:read',
        'docs:document.comment:create',
        'im:chat:read',
        'im:chat.members:read',
        'task:tasklist:read',
        'task:tasklist:writeonly',
        'task:custom_field:read',
        'task:custom_field:writeonly',
        'task:section:read',
        'task:section:write',
        'task:section:writeonly',
        'task:task:write',
      ],
    });

    expect(result.status).toBe('pass');
    expect(result.missingRequiredCapabilities).toEqual([]);
    expect(result.optionalMissingCapabilities).toEqual([]);
    expect(result.capabilities.find((item) => item.id === 'custom-field-management')).toMatchObject(
      {
        status: 'ok',
        groups: [
          { satisfiedBy: 'task:custom_field:read' },
          { satisfiedBy: 'task:custom_field:writeonly' },
        ],
      },
    );
  });

  it('fails when any required permission group is unsatisfied', () => {
    const result = evaluateFeishuPermissionScopes({
      grantedScopes: [
        'im:message.p2p_msg:readonly',
        'im:message.group_at_msg:readonly',
        'im:message:send_as_bot',
        'im:message:update',
        'im:message.reactions:write_only',
        'im:message:readonly',
        'im:resource',
        'im:chat:read',
        'im:chat.members:read',
        'task:tasklist:read',
        'task:tasklist:writeonly',
        'task:custom_field:writeonly',
        'task:section:read',
        'task:section:write',
        'task:section:writeonly',
        'task:task:writeonly',
      ],
    });

    expect(result.status).toBe('fail');
    expect(result.missingRequiredCapabilities).toEqual([
      'document-comment-events',
      'document-comment-read',
      'document-comment-reply',
      'custom-field-management',
      'task-management',
    ]);
    expect(
      result.capabilities
        .find((item) => item.id === 'custom-field-management')
        ?.groups.some((group) => group.satisfiedBy === null),
    ).toBe(true);
    expect(result.capabilities.find((item) => item.id === 'task-management')).toMatchObject({
      status: 'missing',
      groups: [
        { anyOf: ['task:task:write'], satisfiedBy: null },
        { satisfiedBy: 'task:task:writeonly' },
      ],
    });
    expect(result.capabilities.find((item) => item.id === 'document-comment-events')).toMatchObject(
      {
        status: 'missing',
        groups: [{ anyOf: ['docs:event:subscribe'], satisfiedBy: null }],
      },
    );
    expect(result.capabilities.find((item) => item.id === 'document-comment-read')).toMatchObject({
      status: 'missing',
      groups: [{ anyOf: ['docs:document.comment:read'], satisfiedBy: null }],
    });
    expect(result.capabilities.find((item) => item.id === 'document-comment-reply')).toMatchObject({
      status: 'missing',
      groups: [{ anyOf: ['docs:document.comment:create'], satisfiedBy: null }],
    });
  });

  it('deduplicates granted scopes and reports granted scopes that are outside the inventory', () => {
    const result = evaluateFeishuPermissionScopes({
      grantedScopes: ['im:message:send_as_bot', 'im:message:send_as_bot', 'extra:scope'],
      inventory: [
        {
          id: 'send-message-as-bot',
          label: 'Send messages as bot',
          severity: 'required',
          groups: [{ anyOf: ['im:message:send_as_bot'] }],
        },
      ],
    });

    expect(result.grantedScopes).toEqual(['extra:scope', 'im:message:send_as_bot']);
    expect(result.extraGrantedScopes).toEqual(['extra:scope']);
  });

  it('keeps preferred required scopes ahead of broad compatibility alternatives', () => {
    const result = evaluateFeishuPermissionScopes({ grantedScopes: [] });

    expect(result.capabilities.find((item) => item.id === 'update-message-card')).toMatchObject({
      groups: [{ anyOf: ['im:message:update', 'im:message:send_as_bot', 'im:message'] }],
    });
    expect(result.capabilities.find((item) => item.id === 'custom-field-management')).toMatchObject(
      {
        groups: [
          { anyOf: ['task:custom_field:read', 'task:custom_field:write'] },
          { anyOf: ['task:custom_field:writeonly', 'task:custom_field:write'] },
        ],
      },
    );
    expect(result.capabilities.find((item) => item.id === 'task-management')).toMatchObject({
      groups: [
        { anyOf: ['task:task:write'] },
        { anyOf: ['task:task:write', 'task:task:writeonly'] },
      ],
    });
    expect(result.capabilities.find((item) => item.id === 'document-comment-reply')).toMatchObject({
      groups: [{ anyOf: ['docs:document.comment:create'] }],
    });
    expect(result.inventoryScopes).toContain('docs:event:subscribe');
    expect(result.inventoryScopes).toContain('docs:document.comment:read');
    expect(result.inventoryScopes).toContain('docs:document.comment:create');
    expect(result.inventoryScopes).toContain('task:custom_field:write');
    expect(result.inventoryScopes).toContain('im:message');
  });

  it('keeps the maintained inventory ids stable for UI and tests', () => {
    expect(OPEN_TAG_FEISHU_PERMISSION_INVENTORY.map((item) => item.id)).toEqual([
      'receive-p2p-message',
      'receive-group-at-message',
      'send-message-as-bot',
      'update-message-card',
      'message-reactions',
      'read-message',
      'document-comment-events',
      'document-comment-read',
      'document-comment-reply',
      'read-chat',
      'read-chat-members',
      'tasklist-management',
      'custom-field-management',
      'section-management',
      'task-management',
    ]);
  });

  it('excludes Feishu Task tracking permissions when task tracking is disabled', () => {
    const result = evaluateFeishuPermissionScopes({
      grantedScopes: [
        'im:message.p2p_msg:readonly',
        'im:message.group_at_msg:readonly',
        'im:message:send_as_bot',
        'im:message:update',
        'im:message.reactions:write_only',
        'im:message:readonly',
        'im:resource',
        'docs:event:subscribe',
        'docs:document.comment:read',
        'docs:document.comment:create',
        'im:chat:read',
        'im:chat.members:read',
      ],
      inventory: buildOpenClaudeTagFeishuPermissionInventory({ feishuTaskTrackingEnabled: false }),
    });

    expect(result.status).toBe('pass');
    expect(result.inventoryScopes.some((scope) => scope.startsWith('task:'))).toBe(false);
    expect(result.missingRequiredCapabilities).toEqual([]);
  });
});
