import { escapeAtText } from './text-utils.js';
import { IntentType, TaskStatus, errorMessage, truncateText } from '@open-tag/core-types';
import type { FeishuTaskCustomField, FeishuTaskOrigin } from './feishu-client.js';
import {
  FEISHU_TRACKING_STATUSES,
  type FeishuTrackingStatus,
  type TaskInteractionReason,
} from './task-tracking-mapping.js';

export interface FeishuTaskTrackingConfig {
  enabled: boolean;
  scopeType?: string;
  scopeId?: string;
  tasklistGuid?: string;
  tasklistName?: string;
  completedTaskRetentionDays?: number;
}

export interface FeishuTaskTrackingSpace {
  id?: string;
  scopeType: string;
  scopeId: string;
  name?: string | null;
  tasklistGuid: string;
  statusFieldGuid: string;
  statusOptions: Record<FeishuTrackingStatus, string>;
  sections: Record<FeishuTrackingStatus, string>;
}

export interface FeishuTaskLinkRecord {
  taskId: string;
  trackingSpaceId?: string | null;
  feishuTaskGuid?: string | null;
  feishuTaskUrl?: string | null;
  sourceMessageId?: string | null;
  sourceTopicKey?: string | null;
  sourceTopicUrl?: string | null;
  lastSyncedStatus?: string | null;
  lastSyncError?: string | null;
}

export interface FeishuCompletedTaskLinkRecord extends FeishuTaskLinkRecord {
  completedAt: Date;
}

export interface CleanCompletedTasksInput {
  retentionDays?: number;
  dryRun?: boolean;
  now?: Date;
}

export interface CleanCompletedSessionTasksInput extends CleanCompletedTasksInput {
  sessionId: string;
}

export interface CleanCompletedChatTasksInput extends CleanCompletedTasksInput {
  chatId: string;
}

export interface FeishuTaskCleanupResult {
  scope: 'session' | 'chat';
  tasklistGuid?: string;
  retentionDays: number;
  dryRun: boolean;
  scanned: number;
  eligible: number;
  removed: number;
  skipped: number;
  failed: number;
  failures: Array<{ taskId?: string; taskGuid: string; error: string }>;
}

export interface FeishuTaskTrackingRepository {
  withScopeLock<T>(scopeType: string, scopeId: string, callback: () => Promise<T>): Promise<T>;
  findSpace(scopeType: string, scopeId: string): Promise<FeishuTaskTrackingSpace | null>;
  findSpaceById(id: string): Promise<FeishuTaskTrackingSpace | null>;
  saveSpace(space: FeishuTaskTrackingSpace): Promise<FeishuTaskTrackingSpace>;
  findTaskLink(taskId: string): Promise<FeishuTaskLinkRecord | null>;
  findTaskLinkBySourceTopic(input: {
    trackingSpaceId: string;
    sourceTopicKey: string;
  }): Promise<FeishuTaskLinkRecord | null>;
  findTaskLinkBySession(input: {
    trackingSpaceId: string;
    sessionId: string;
  }): Promise<FeishuTaskLinkRecord | null>;
  recordTaskLink(link: FeishuTaskLinkRecord): Promise<void>;
  recordTaskLinkError(input: {
    taskId: string;
    sourceMessageId?: string;
    sourceTopicKey?: string | null;
    sourceTopicUrl?: string | null;
    error: string;
  }): Promise<void>;
  updateTaskLinkSync(input: {
    taskId: string;
    lastSyncedStatus?: string;
    lastSyncError?: string | null;
  }): Promise<void>;
  listCompletedTaskLinksForSession(input: {
    sessionId: string;
    completedBefore: Date;
  }): Promise<FeishuCompletedTaskLinkRecord[]>;
  hasRetainedTaskLinkForFeishuTask(input: {
    feishuTaskGuid: string;
    completedBefore: Date;
  }): Promise<boolean>;
}

export interface CreateTrackedTaskInput {
  taskId: string;
  taskType: IntentType;
  forceTrack?: boolean;
  sessionId?: string;
  summary: string;
  description?: string;
  localStatus: TaskStatus;
  interactionReason?: TaskInteractionReason | null;
  tenantKey?: string;
  sourceMessageId?: string;
  sourceTopicKey?: string;
  chatId?: string;
  replyToMessageId?: string;
  requesterOpenId?: string;
}

export interface SyncTrackedTaskStatusInput {
  taskId: string;
  localStatus: TaskStatus;
  interactionReason?: TaskInteractionReason | null;
}

export interface InitializeChatTrackingSpaceInput {
  chatId: string;
  tenantKey?: string;
}

export interface InitializeChatTrackingSpaceResult {
  tasklistGuid: string;
  tasklistUrl?: string;
  tasklistName?: string;
  memberCount?: number;
  statusFieldGuid: string;
  created: boolean;
}

export interface AddBotToChatTrackingSpaceInput {
  chatId: string;
  tenantKey?: string;
  botOpenId: string;
  botName?: string;
  replyToMessageId?: string;
}

export interface AddBotToChatTrackingSpaceResult {
  tasklistGuid: string;
  botOpenId: string;
  botName?: string;
  configurationMessageId?: string;
}

export interface ApplyChatTasklistConfigurationInput {
  encodedPayload: string;
}

export interface ApplyChatTasklistConfigurationResult {
  chatId: string;
  tasklistGuid: string;
}

const TRACKABLE_FEISHU_TASK_TYPES = new Set<IntentType>([
  IntentType.ANALYSIS,
  IntentType.RESEARCH,
  IntentType.SELF_IMPROVEMENT,
  IntentType.SELF_DEV,
]);

export function isFeishuTaskTrackableTaskType(taskType: IntentType): boolean {
  return TRACKABLE_FEISHU_TASK_TYPES.has(taskType);
}

interface ChatTasklistConfigurationPayload {
  version: 1;
  source: 'open-claude-tag';
  scopeType: 'chat';
  scopeId: string;
  tasklistGuid: string;
  statusFieldGuid: string;
  statusOptions: Record<FeishuTrackingStatus, string>;
  sections: Record<FeishuTrackingStatus, string>;
  issuedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function normalizeStatusMap(value: unknown): Partial<Record<FeishuTrackingStatus, string>> {
  if (!isRecord(value)) return {};
  const result: Partial<Record<FeishuTrackingStatus, string>> = {};
  for (const status of FEISHU_TRACKING_STATUSES) {
    const mapped = value[status];
    if (typeof mapped === 'string' && mapped) {
      result[status] = mapped;
    }
  }
  return result;
}

function optionGuid(option: { guid?: string; option_guid?: string }): string | null {
  return option.guid ?? option.option_guid ?? null;
}

export function fieldOptionMap(
  field: FeishuTaskCustomField,
): Partial<Record<FeishuTrackingStatus, string>> {
  const result: Partial<Record<FeishuTrackingStatus, string>> = {};
  for (const option of field.single_select_setting?.options ?? []) {
    const name = option.name;
    if (!FEISHU_TRACKING_STATUSES.includes(name as FeishuTrackingStatus)) continue;
    const guid = optionGuid(option);
    if (guid) result[name as FeishuTrackingStatus] = guid;
  }
  return result;
}

export function requireCompleteMap(
  value: Partial<Record<FeishuTrackingStatus, string>>,
  kind: string,
): Record<FeishuTrackingStatus, string> {
  const missing = FEISHU_TRACKING_STATUSES.filter((status) => !value[status]);
  if (missing.length > 0) {
    throw new Error(`Feishu Task tracking ${kind} missing values: ${missing.join(', ')}`);
  }
  return value as Record<FeishuTrackingStatus, string>;
}

export function truncate(value: string, maxLength: number): string {
  if (maxLength <= 0) return '';
  if (value.length <= maxLength) return value;
  if (maxLength <= 3) return '.'.repeat(maxLength);
  return truncateText(value, maxLength - 3, { suffix: '...' });
}

export function normalizeOptionalText(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function isSessionSourceTopicKey(sourceTopicKey: string, sessionId: string | undefined): boolean {
  return Boolean(sessionId && sourceTopicKey.endsWith(`:session:${sessionId}`));
}

export function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

const DEFAULT_COMPLETED_TASK_RETENTION_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
export const CLEANED_STATUS = 'cleaned';
export const TASK_TEXT_MAX_LENGTH = 3000;
const FEISHU_ORIGIN_URL_MAX_LENGTH = 1024;

export function normalizeRetentionDays(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return DEFAULT_COMPLETED_TASK_RETENTION_DAYS;
  }
  return Math.floor(value);
}

function parseRetentionDays(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : undefined;
}

export function retentionCutoff(now: Date, retentionDays: number): Date {
  return new Date(now.getTime() - retentionDays * DAY_MS);
}

export function buildTaskDescription(input: {
  taskId: string;
  description?: string;
  sourceTopicUrl?: string | null;
}): string {
  const base =
    input.description !== undefined && input.description.trim()
      ? input.description
      : `OpenClaudeTag task: ${input.taskId}`;
  if (!input.sourceTopicUrl) return truncate(base, TASK_TEXT_MAX_LENGTH);

  const sourceLine = `Source thread: ${input.sourceTopicUrl}`;
  const separator = '\n\n';
  const baseMaxLength = TASK_TEXT_MAX_LENGTH - separator.length - sourceLine.length;
  if (baseMaxLength <= 0) return truncate(sourceLine, TASK_TEXT_MAX_LENGTH);
  return `${truncate(base, baseMaxLength)}${separator}${sourceLine}`;
}

export function appendSyncWarning(current: string | null, warning: string): string {
  return current ? `${current}; ${warning}` : warning;
}

function validateFeishuOriginUrl(value: string): string | null {
  if (value.length > FEISHU_ORIGIN_URL_MAX_LENGTH) {
    return `source topic link exceeds Feishu origin URL limit (${value.length}/${FEISHU_ORIGIN_URL_MAX_LENGTH})`;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'source topic link is not a valid URL';
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'source topic link must use http(s)';
  }

  return null;
}

export function buildTaskOrigin(sourceTopicUrl: string | null): {
  origin?: FeishuTaskOrigin;
  warning?: string;
} {
  if (!sourceTopicUrl) return {};

  const warning = validateFeishuOriginUrl(sourceTopicUrl);
  if (warning) return { warning };

  return {
    origin: {
      platform_i18n_name: { zh_cn: '飞书话题', en_us: 'Lark Thread' },
      href: { title: 'Open source Feishu topic', url: sourceTopicUrl },
    },
  };
}

export function parseFeishuTimestamp(value: string | undefined): Date | null {
  if (!value || value === '0') return null;
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  return new Date(timestamp);
}

export function taskBoardName(chatName: string): string {
  const fallback = chatName.trim() || 'OpenClaudeTag';
  return truncate(`${fallback}任务看板`, 100);
}

export function buildChatTrackingScopeId(input: { tenantKey?: string; chatId: string }): string {
  return input.tenantKey ? `${input.tenantKey}:${input.chatId}` : input.chatId;
}

export function decodeChatIdFromScopeId(scopeId: string): string {
  const separator = scopeId.indexOf(':');
  return separator === -1 ? scopeId : scopeId.slice(separator + 1);
}

export function chatTrackingScopeCandidates(input: { tenantKey?: string; chatId: string }): string[] {
  const scoped = buildChatTrackingScopeId(input);
  return scoped === input.chatId ? [input.chatId] : [scoped, input.chatId];
}

function encodeTasklistConfiguration(payload: ChatTasklistConfigurationPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeTasklistConfiguration(encodedPayload: string): ChatTasklistConfigurationPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  } catch (err) {
    throw new Error(`invalid tasklist configuration payload: ${errorMessage(err)}`, {
      cause: err,
    });
  }

  if (!isRecord(parsed)) {
    throw new Error('invalid tasklist configuration payload');
  }
  if (parsed.version !== 1 || parsed.source !== 'open-claude-tag' || parsed.scopeType !== 'chat') {
    throw new Error('unsupported tasklist configuration payload');
  }
  if (
    typeof parsed.scopeId !== 'string' ||
    !parsed.scopeId ||
    typeof parsed.tasklistGuid !== 'string' ||
    !parsed.tasklistGuid ||
    typeof parsed.statusFieldGuid !== 'string' ||
    !parsed.statusFieldGuid
  ) {
    throw new Error('tasklist configuration payload is missing required fields');
  }

  return {
    version: 1,
    source: 'open-claude-tag',
    scopeType: 'chat',
    scopeId: parsed.scopeId,
    tasklistGuid: parsed.tasklistGuid,
    statusFieldGuid: parsed.statusFieldGuid,
    statusOptions: requireCompleteMap(
      normalizeStatusMap(parsed.statusOptions),
      'configured status options',
    ),
    sections: requireCompleteMap(normalizeStatusMap(parsed.sections), 'configured sections'),
    issuedAt: typeof parsed.issuedAt === 'string' ? parsed.issuedAt : new Date().toISOString(),
  };
}

function buildConfigureTasklistCommand(space: FeishuTaskTrackingSpace): string {
  const encodedPayload = encodeTasklistConfiguration({
    version: 1,
    source: 'open-claude-tag',
    scopeType: 'chat',
    scopeId: space.scopeId,
    tasklistGuid: space.tasklistGuid,
    statusFieldGuid: space.statusFieldGuid,
    statusOptions: space.statusOptions,
    sections: space.sections,
    issuedAt: new Date().toISOString(),
  });
  return `/configure-tasklist ${encodedPayload}`;
}


export function buildConfigureTasklistMentionMessage(
  space: FeishuTaskTrackingSpace,
  botOpenId: string,
  botName?: string,
): string {
  const mentionName = escapeAtText(botName?.trim() || 'Bot');
  return `<at user_id="${botOpenId}">${mentionName}</at> ${buildConfigureTasklistCommand(space)}`;
}

export function createFeishuTaskTrackingConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): FeishuTaskTrackingConfig {
  return {
    enabled: env.OPEN_TAG_FEISHU_TASK_TRACKING === 'enabled',
    scopeType: env.OPEN_TAG_FEISHU_TASK_SCOPE_TYPE ?? 'global',
    scopeId: env.OPEN_TAG_FEISHU_TASK_SCOPE_ID ?? 'default',
    tasklistGuid: env.OPEN_TAG_FEISHU_TASKLIST_GUID,
    tasklistName: env.OPEN_TAG_FEISHU_TASKLIST_NAME ?? 'OpenClaudeTag Project Tracking',
    completedTaskRetentionDays:
      parseRetentionDays(env.OPEN_TAG_FEISHU_TASK_RETENTION_DAYS) ??
      DEFAULT_COMPLETED_TASK_RETENTION_DAYS,
  };
}
