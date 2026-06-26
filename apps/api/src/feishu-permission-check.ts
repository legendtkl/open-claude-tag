export type FeishuPermissionSeverity = 'required' | 'optional';
export type FeishuPermissionCheckStatus = 'pass' | 'fail';
export type FeishuPermissionCapabilityStatus = 'ok' | 'missing' | 'optional_missing';

export interface FeishuPermissionScopeGroup {
  anyOf: string[];
}

export interface FeishuPermissionCapability {
  id: string;
  label: string;
  description?: string;
  severity: FeishuPermissionSeverity;
  groups: FeishuPermissionScopeGroup[];
}

export interface FeishuPermissionGroupResult extends FeishuPermissionScopeGroup {
  satisfiedBy: string | null;
}

export interface FeishuPermissionCapabilityResult {
  id: string;
  label: string;
  description?: string;
  severity: FeishuPermissionSeverity;
  status: FeishuPermissionCapabilityStatus;
  groups: FeishuPermissionGroupResult[];
}

export interface FeishuPermissionCheckResult {
  status: FeishuPermissionCheckStatus;
  grantedScopes: string[];
  inventoryScopes: string[];
  extraGrantedScopes: string[];
  missingRequiredCapabilities: string[];
  optionalMissingCapabilities: string[];
  capabilities: FeishuPermissionCapabilityResult[];
  notes: string[];
}

export const OPEN_TAG_FEISHU_PERMISSION_INVENTORY: FeishuPermissionCapability[] = [
  {
    id: 'receive-p2p-message',
    label: 'Receive direct user messages',
    severity: 'required',
    groups: [{ anyOf: ['im:message.p2p_msg:readonly', 'im:message.p2p_msg'] }],
  },
  {
    id: 'receive-group-at-message',
    label: 'Receive group @bot messages',
    severity: 'required',
    groups: [{ anyOf: ['im:message.group_at_msg:readonly', 'im:message.group_at_msg'] }],
  },
  {
    id: 'send-message-as-bot',
    label: 'Send and reply as bot',
    severity: 'required',
    groups: [{ anyOf: ['im:message:send_as_bot', 'im:message', 'im:message:send'] }],
  },
  {
    id: 'update-message-card',
    label: 'Update task cards',
    severity: 'required',
    groups: [{ anyOf: ['im:message:update', 'im:message:send_as_bot', 'im:message'] }],
  },
  {
    id: 'message-reactions',
    label: 'Add and remove processing reactions',
    severity: 'required',
    groups: [{ anyOf: ['im:message.reactions:write_only', 'im:message'] }],
  },
  {
    id: 'read-message',
    label: 'Read referenced messages and attachments',
    severity: 'required',
    groups: [
      { anyOf: ['im:message:readonly', 'im:message', 'im:message.history:readonly'] },
      { anyOf: ['im:resource'] },
    ],
  },
  {
    id: 'document-comment-events',
    label: 'Subscribe to Feishu document comment events',
    description:
      'Required for document comment @bot tasks to receive Feishu comment notifications.',
    severity: 'required',
    groups: [{ anyOf: ['docs:event:subscribe'] }],
  },
  {
    id: 'document-comment-read',
    label: 'Read Feishu document comments',
    description:
      'Required to fetch compact document comment notifications before task creation.',
    severity: 'required',
    groups: [{ anyOf: ['docs:document.comment:read'] }],
  },
  {
    id: 'document-comment-reply',
    label: 'Reply and react to Feishu document comments',
    description:
      'Required for document comment @bot tasks to add acknowledgement reactions and reply in the original comment thread.',
    severity: 'required',
    groups: [{ anyOf: ['docs:document.comment:create'] }],
  },
  {
    id: 'read-chat',
    label: 'Read chat metadata',
    severity: 'required',
    groups: [{ anyOf: ['im:chat:read', 'im:chat', 'im:chat:readonly'] }],
  },
  {
    id: 'read-chat-members',
    label: 'Read chat members',
    severity: 'required',
    groups: [
      {
        anyOf: [
          'im:chat.members:read',
          'im:chat',
          'im:chat:readonly',
          'im:chat.group_info:readonly',
        ],
      },
    ],
  },
  {
    id: 'tasklist-management',
    label: 'Manage Feishu task lists',
    severity: 'required',
    groups: [
      { anyOf: ['task:tasklist:read', 'task:tasklist:write'] },
      { anyOf: ['task:tasklist:writeonly', 'task:tasklist:write'] },
    ],
  },
  {
    id: 'custom-field-management',
    label: 'Manage task custom fields and options',
    severity: 'required',
    groups: [
      { anyOf: ['task:custom_field:read', 'task:custom_field:write'] },
      { anyOf: ['task:custom_field:writeonly', 'task:custom_field:write'] },
    ],
  },
  {
    id: 'section-management',
    label: 'Manage task sections',
    severity: 'required',
    groups: [
      { anyOf: ['task:section:read', 'task:section:write'] },
      { anyOf: ['task:section:writeonly', 'task:section:write'] },
    ],
  },
  {
    id: 'task-management',
    label: 'Create, update, and move tasks',
    severity: 'required',
    groups: [
      { anyOf: ['task:task:write'] },
      { anyOf: ['task:task:write', 'task:task:writeonly'] },
    ],
  },
];

const FEISHU_TASK_TRACKING_CAPABILITY_IDS = new Set([
  'tasklist-management',
  'custom-field-management',
  'section-management',
  'task-management',
]);

export function buildOpenClaudeTagFeishuPermissionInventory(input: {
  feishuTaskTrackingEnabled: boolean;
}): FeishuPermissionCapability[] {
  if (input.feishuTaskTrackingEnabled) return OPEN_TAG_FEISHU_PERMISSION_INVENTORY;
  return OPEN_TAG_FEISHU_PERMISSION_INVENTORY.filter(
    (capability) => !FEISHU_TASK_TRACKING_CAPABILITY_IDS.has(capability.id),
  );
}

const NON_SCOPE_NOTES = [
  [
    'This check covers Feishu application scopes only.',
    'Event subscriptions such as drive.notice.comment_add_v1, card callbacks,',
    'app publishing, installation, and bot capability setup are not validated.',
  ].join(' '),
];

export function evaluateFeishuPermissionScopes(input: {
  grantedScopes: string[];
  inventory?: FeishuPermissionCapability[];
}): FeishuPermissionCheckResult {
  const inventory = input.inventory ?? OPEN_TAG_FEISHU_PERMISSION_INVENTORY;
  const grantedScopes = [...new Set(input.grantedScopes)].sort();
  const grantedScopeSet = new Set(grantedScopes);
  const inventoryScopes = [
    ...new Set(
      inventory.flatMap((capability) => capability.groups.flatMap((group) => group.anyOf)),
    ),
  ].sort();
  const inventoryScopeSet = new Set(inventoryScopes);

  const capabilities = inventory.map((capability): FeishuPermissionCapabilityResult => {
    const groups = capability.groups.map((group) => ({
      anyOf: [...group.anyOf],
      satisfiedBy: group.anyOf.find((scope) => grantedScopeSet.has(scope)) ?? null,
    }));
    const hasMissingGroup = groups.some((group) => group.satisfiedBy === null);
    const status: FeishuPermissionCapabilityStatus = hasMissingGroup
      ? capability.severity === 'optional'
        ? 'optional_missing'
        : 'missing'
      : 'ok';
    return {
      id: capability.id,
      label: capability.label,
      ...(capability.description ? { description: capability.description } : {}),
      severity: capability.severity,
      status,
      groups,
    };
  });

  const missingRequiredCapabilities = capabilities
    .filter((capability) => capability.status === 'missing')
    .map((capability) => capability.id);
  const optionalMissingCapabilities = capabilities
    .filter((capability) => capability.status === 'optional_missing')
    .map((capability) => capability.id);

  return {
    status: missingRequiredCapabilities.length === 0 ? 'pass' : 'fail',
    grantedScopes,
    inventoryScopes,
    extraGrantedScopes: grantedScopes.filter((scope) => !inventoryScopeSet.has(scope)),
    missingRequiredCapabilities,
    optionalMissingCapabilities,
    capabilities,
    notes: NON_SCOPE_NOTES,
  };
}
