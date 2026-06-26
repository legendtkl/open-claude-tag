import { exec as execCb } from 'child_process';
import { promisify } from 'util';
import { readdir, stat } from 'fs/promises';
import { isAbsolute, join } from 'path';
import { randomUUID } from 'crypto';
import type { Logger } from 'pino';
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import {
  agents,
  chatConfigs,
  feishuTaskTrackingSpaces,
  projects,
  sessions,
  tasks,
  updateChatMemoryConfig,
  buildChatMemoryDisablePatch,
  buildChatMemoryEnablePatch,
} from '@open-tag/storage';
import type { AgentAccessContext, Database } from '@open-tag/storage';
import { getUserRole } from '@open-tag/approval';
import { TaskStatus, UserRole, errorMessage } from '@open-tag/core-types';
import type { NormalizedEvent } from '@open-tag/core-types';
import type {
  FeishuClient,
  FeishuTaskCleanupResult,
  FeishuTaskSyncService,
} from '@open-tag/feishu-adapter';
import type { MemoryHandler } from '@open-tag/memory';
import type { TaskQueue } from '@open-tag/queue';
import { createStorageAgentCommandServices, handleAgentCommand } from '@open-tag/registry';
import type { ReplyLanguage } from '@open-tag/core-types';
import {
  closeSession,
  compactSession,
  getSessionStatus,
  listSessions,
  resolvePreferredReplyLanguage,
  useSession,
} from '@open-tag/session';
import { transitionTask } from '@open-tag/orchestrator';
import { createApiReplyLocalizer } from './reply-language-text.js';
import { getHelpText } from './slash-command-help.js';
import { parseScheduleArgs } from './schedule-utils.js';
import { shouldSkipTaskExecutionForDebugEvent } from './debug-task-control.js';
import {
  cleanAllWorktrees,
  cleanWorktrees,
  getPrState,
  removeWorktreeById,
} from './worktree-cleanup.js';
import { parseReviewRequestUrl, shellQuote } from './review-request.js';

const execAsync = promisify(execCb);

function worktreeSessionListFilter() {
  return and(
    isNotNull(sessions.worktreePath),
    sql`not exists (
      select 1
      from ${tasks}
      where ${tasks.sessionId} = ${sessions.id}
        and ${tasks.status} = ${TaskStatus.WAITING_DELEGATION}
    )`,
  );
}

export interface SlashCommandHandlerDeps {
  db: Database;
  feishuClient: FeishuClient;
  queue: TaskQueue;
  memoryHandler: MemoryHandler;
  feishuTaskSync?: FeishuTaskSyncService;
  logger: Logger;
  repoRoot: string;
  instanceRole: 'primary' | 'isolated';
  agentContext?: {
    agentId?: string;
    feishuAppId?: string;
    senderAccess?: AgentAccessContext;
  };
}

type NormalizedMention = NonNullable<NormalizedEvent['content']['mentions']>[number];

function unwrapFeishuMarkdownLinks(value: string): string {
  return value.replace(/\[([^\]\n]+)\]\((?:https?:\/\/)?[^\s)]+\)/g, '$1');
}

function buildChatTrackingScopeId(tenantKey: string, chatId: string): string {
  return `${tenantKey}:${chatId}`;
}

/**
 * Whether a workdir set for this chat would be used on a remote machine rather
 * than on the server. True when the acting agent is bound to a machine (D-A8),
 * or the chat has a default machine. In that case the path lives on the
 * machine's filesystem, so the server MUST NOT stat it for existence — the path
 * is validated by the daemon at run time. Returns false for server-local
 * execution, where the early server-side existence check still applies.
 */
async function chatWorkdirRunsOnRemoteMachine(
  deps: SlashCommandHandlerDeps,
  event: NormalizedEvent,
): Promise<boolean> {
  const agentId = deps.agentContext?.agentId;
  if (agentId) {
    const [agent] = await deps.db
      .select({ machineId: agents.machineId })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1);
    if (agent?.machineId) return true;
  }
  const [config] = await deps.db
    .select({ defaultMachineId: chatConfigs.defaultMachineId })
    .from(chatConfigs)
    .where(and(eq(chatConfigs.tenantKey, event.tenantKey), eq(chatConfigs.chatId, event.chatId)))
    .limit(1);
  return Boolean(config?.defaultMachineId);
}

function hasManageAgentsEnvGrant(feishuOpenId: string): boolean {
  const raw = process.env.MANAGE_AGENTS?.trim();
  if (!raw) return false;
  if (raw === '1' || raw.toLowerCase() === 'true' || raw === '*') return true;
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .includes(feishuOpenId);
}

async function canManageAgents(
  deps: SlashCommandHandlerDeps,
  event: NormalizedEvent,
): Promise<boolean> {
  if (hasManageAgentsEnvGrant(event.senderOpenId)) {
    return true;
  }
  if (deps.agentContext?.senderAccess?.role) {
    return deps.agentContext.senderAccess.role === UserRole.OWNER;
  }
  return (await getUserRole(deps.db, event.senderOpenId)) === UserRole.OWNER;
}

/**
 * Subcommand-level owner gate for the worktree subcommands of /session
 * (worktrees, clean). Mirrors the dispatcher-level owner gate semantics:
 * OPEN_ACCESS=true bypasses the check, otherwise the sender must resolve to
 * the OWNER role (agent access context first, then the users table).
 */
async function canManageWorktrees(
  deps: SlashCommandHandlerDeps,
  event: NormalizedEvent,
): Promise<boolean> {
  if (process.env.OPEN_ACCESS === 'true') {
    return true;
  }
  if (deps.agentContext?.senderAccess?.role) {
    return deps.agentContext.senderAccess.role === UserRole.OWNER;
  }
  return (await getUserRole(deps.db, event.senderOpenId)) === UserRole.OWNER;
}

async function canManageChatConfig(
  deps: SlashCommandHandlerDeps,
  event: NormalizedEvent,
): Promise<boolean> {
  if (process.env.OPEN_ACCESS === 'true') {
    return true;
  }
  if (deps.agentContext?.senderAccess?.role) {
    return deps.agentContext.senderAccess.role === UserRole.OWNER;
  }
  return (await getUserRole(deps.db, event.senderOpenId)) === UserRole.OWNER;
}

async function ensureChatConfig(
  deps: SlashCommandHandlerDeps,
  event: NormalizedEvent,
  values: {
    displayName?: string | null;
    defaultWorkDir?: string | null;
  } = {},
): Promise<void> {
  const now = new Date();
  const displayName = values.displayName ?? (await resolveFeishuChatDisplayName(deps, event));
  const rowValues = {
    ...values,
    ...(displayName ? { displayName } : {}),
  };
  await deps.db
    .insert(chatConfigs)
    .values({
      tenantKey: event.tenantKey,
      chatId: event.chatId,
      ...rowValues,
      createdByOpenId: event.senderOpenId,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [chatConfigs.tenantKey, chatConfigs.chatId],
      set: {
        ...rowValues,
        updatedAt: now,
      },
    });
}

function normalizeFeishuChatDisplayName(
  value: string | null | undefined,
  chatId: string,
): string | null {
  const name = value?.trim();
  if (!name || name === chatId || /^oc_[A-Za-z0-9]+$/.test(name)) return null;
  return name;
}

function extractChatDisplayNameFromTasklistName(
  name: string | null | undefined,
  chatId: string,
): string | null {
  const trimmed = name?.trim();
  if (!trimmed) return null;
  for (const suffix of ['任务看板', ' Task Board']) {
    if (trimmed.endsWith(suffix) && trimmed.length > suffix.length) {
      return normalizeFeishuChatDisplayName(trimmed.slice(0, -suffix.length), chatId);
    }
  }
  return null;
}

async function resolveFeishuChatDisplayName(
  deps: SlashCommandHandlerDeps,
  event: NormalizedEvent,
): Promise<string | null> {
  if (event.chatType !== 'group') return null;
  try {
    const chat = await deps.feishuClient.getChat(event.chatId);
    return (
      normalizeFeishuChatDisplayName(chat.name, event.chatId) ??
      normalizeFeishuChatDisplayName(chat.i18nNames?.zh_cn, event.chatId) ??
      normalizeFeishuChatDisplayName(chat.i18nNames?.en_us, event.chatId)
    );
  } catch (error) {
    deps.logger.warn({ err: error, chatId: event.chatId }, 'Failed to resolve Feishu chat name');
    return null;
  }
}

async function loadChatStatus(deps: SlashCommandHandlerDeps, event: NormalizedEvent) {
  const [config] = await deps.db
    .select({
      defaultWorkDir: chatConfigs.defaultWorkDir,
      updatedAt: chatConfigs.updatedAt,
    })
    .from(chatConfigs)
    .where(and(eq(chatConfigs.tenantKey, event.tenantKey), eq(chatConfigs.chatId, event.chatId)))
    .limit(1);

  let taskSpace:
    | {
        tasklistGuid: string;
        updatedAt: Date;
      }
    | undefined;
  for (const scopeId of [buildChatTrackingScopeId(event.tenantKey, event.chatId), event.chatId]) {
    const [candidate] = await deps.db
      .select({
        tasklistGuid: feishuTaskTrackingSpaces.tasklistGuid,
        updatedAt: feishuTaskTrackingSpaces.updatedAt,
      })
      .from(feishuTaskTrackingSpaces)
      .where(
        and(
          eq(feishuTaskTrackingSpaces.scopeType, 'chat'),
          eq(feishuTaskTrackingSpaces.scopeId, scopeId),
        ),
      )
      .limit(1);
    if (candidate) {
      taskSpace = candidate;
      break;
    }
  }

  return { config, taskSpace };
}

async function loadChatMemoryStatus(deps: SlashCommandHandlerDeps, event: NormalizedEvent) {
  const [row] = await deps.db
    .select({
      memoryEnabled: chatConfigs.memoryEnabled,
      memorySummaryAgentId: chatConfigs.memorySummaryAgentId,
      memorySummaryTime: chatConfigs.memorySummaryTime,
      memorySummaryTimezone: chatConfigs.memorySummaryTimezone,
      memorySummaryNextRunAt: chatConfigs.memorySummaryNextRunAt,
      memorySummaryLastRunAt: chatConfigs.memorySummaryLastRunAt,
      memorySummaryLastStatus: chatConfigs.memorySummaryLastStatus,
      memorySummaryLastError: chatConfigs.memorySummaryLastError,
    })
    .from(chatConfigs)
    .where(and(eq(chatConfigs.tenantKey, event.tenantKey), eq(chatConfigs.chatId, event.chatId)))
    .limit(1);
  return row ?? null;
}

async function handleChatMemoryCommand(
  deps: SlashCommandHandlerDeps,
  event: NormalizedEvent,
  subArgs: string,
  replyLanguage: ReplyLanguage,
): Promise<string> {
  if (!(await canManageChatConfig(deps, event))) {
    return createApiReplyLocalizer(replyLanguage).permissionDenied('/chat memory');
  }

  const parts = subArgs.trim().split(/\s+/).filter(Boolean);
  const action = parts[0] ?? 'status';
  if (action === 'status') {
    return formatChatMemoryStatus(await loadChatMemoryStatus(deps, event), replyLanguage);
  }

  if (action === 'enable') {
    await ensureChatConfig(deps, event);
    const patch = buildChatMemoryEnablePatch({
      ...(deps.agentContext?.agentId ? { agentId: deps.agentContext.agentId } : {}),
    });
    const nextRunAt = patch.memorySummaryNextRunAt;
    await updateChatMemoryConfig(deps.db, {
      tenantKey: event.tenantKey,
      chatId: event.chatId,
      patch,
    });
    return replyLanguage === 'zh-CN'
      ? `群聊记忆已启用。每日总结会自动使用当前群聊的 agent。下一次总结：${nextRunAt?.toISOString() ?? '(未计划)'}`
      : `Chat memory enabled. Daily summaries run automatically with this chat's agent. Next summary: ${nextRunAt?.toISOString() ?? '(not scheduled)'}`;
  }

  if (action === 'disable') {
    await ensureChatConfig(deps, event);
    await updateChatMemoryConfig(deps.db, {
      tenantKey: event.tenantKey,
      chatId: event.chatId,
      patch: buildChatMemoryDisablePatch(),
    });
    return replyLanguage === 'zh-CN' ? '群聊记忆已关闭。' : 'Chat memory disabled.';
  }

  return replyLanguage === 'zh-CN'
    ? '用法：/chat memory status | enable | disable'
    : 'Usage: /chat memory status | enable | disable';
}

function formatChatMemoryStatus(
  status: Awaited<ReturnType<typeof loadChatMemoryStatus>>,
  replyLanguage: ReplyLanguage,
): string {
  const enabled = status?.memoryEnabled ?? false;
  const lines =
    replyLanguage === 'zh-CN'
      ? [
          '群聊记忆：',
          `状态：${enabled ? '已启用' : '已关闭'}`,
          `下一次总结：${status?.memorySummaryNextRunAt?.toISOString() ?? '(未计划)'}`,
          `最近状态：${status?.memorySummaryLastStatus ?? '(无)'}`,
          ...(status?.memorySummaryLastError ? [`最近错误：${status.memorySummaryLastError}`] : []),
        ]
      : [
          'Chat memory:',
          `Status: ${enabled ? 'enabled' : 'disabled'}`,
          `Next summary: ${status?.memorySummaryNextRunAt?.toISOString() ?? '(not scheduled)'}`,
          `Last status: ${status?.memorySummaryLastStatus ?? '(none)'}`,
          ...(status?.memorySummaryLastError
            ? [`Last error: ${status.memorySummaryLastError}`]
            : []),
        ];
  return lines.join('\n');
}

interface CleanTaskCommandOptions {
  scope: 'session' | 'chat';
  dryRun: boolean;
  retentionDays?: number;
}

function findAddBotTargetMention(event: NormalizedEvent): NormalizedMention | null {
  const commandIndex = event.content.commandIndex ?? -1;
  const targets = (event.content.mentions ?? [])
    .filter((mention) => mention.id && !mention.isBot)
    .filter(
      (mention) => commandIndex < 0 || mention.index === undefined || mention.index > commandIndex,
    )
    .sort((a, b) => (a.index ?? Number.MAX_SAFE_INTEGER) - (b.index ?? Number.MAX_SAFE_INTEGER));

  return targets.length === 1 ? targets[0] : null;
}

function parseCleanTaskArgs(args: string): { options?: CleanTaskCommandOptions; error?: string } {
  const tokens = args.trim() ? args.trim().split(/\s+/) : [];
  const options: CleanTaskCommandOptions = { scope: 'session', dryRun: false };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '--chat') {
      options.scope = 'chat';
      continue;
    }
    if (token === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (token === '--days') {
      const value = tokens[index + 1];
      if (!value) return { error: '--days requires a non-negative integer' };
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 0) {
        return { error: '--days requires a non-negative integer' };
      }
      options.retentionDays = parsed;
      index += 1;
      continue;
    }
    if (token.startsWith('--days=')) {
      const parsed = Number(token.slice('--days='.length));
      if (!Number.isInteger(parsed) || parsed < 0) {
        return { error: '--days requires a non-negative integer' };
      }
      options.retentionDays = parsed;
      continue;
    }
    return { error: `unknown option: ${token}` };
  }

  return { options };
}

function formatCleanTaskResult(
  result: FeishuTaskCleanupResult,
  replyLanguage: ReplyLanguage,
): string {
  const scope =
    result.scope === 'chat'
      ? replyLanguage === 'zh-CN'
        ? '当前群任务看板'
        : 'current chat task board'
      : replyLanguage === 'zh-CN'
        ? '当前 session'
        : 'current session';
  const lines =
    replyLanguage === 'zh-CN'
      ? [
          result.dryRun ? '任务清理预览完成。' : '任务清理完成。',
          `范围：${scope}`,
          `保留期：${result.retentionDays} 天`,
          ...(result.tasklistGuid ? [`Tasklist GUID：${result.tasklistGuid}`] : []),
          `扫描：${result.scanned}`,
          `符合条件：${result.eligible}`,
          result.dryRun ? `将移出：${result.eligible}` : `已移出：${result.removed}`,
          `跳过：${result.skipped}`,
          `失败：${result.failed}`,
        ]
      : [
          result.dryRun ? 'Task cleanup preview complete.' : 'Task cleanup complete.',
          `Scope: ${scope}`,
          `Retention: ${result.retentionDays} day(s)`,
          ...(result.tasklistGuid ? [`Tasklist GUID: ${result.tasklistGuid}`] : []),
          `Scanned: ${result.scanned}`,
          `Eligible: ${result.eligible}`,
          result.dryRun ? `Would remove: ${result.eligible}` : `Removed: ${result.removed}`,
          `Skipped: ${result.skipped}`,
          `Failed: ${result.failed}`,
        ];

  if (result.failures.length > 0) {
    const failureLines = result.failures
      .slice(0, 3)
      .map((failure) => `  ${failure.taskId ?? failure.taskGuid}: ${failure.error}`);
    lines.push(replyLanguage === 'zh-CN' ? '失败明细：' : 'Failures:', ...failureLines);
  }
  return lines.join('\n');
}

function relativeTime(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

async function sendTextReply(
  feishuClient: FeishuClient,
  chatId: string,
  text: string,
  replyToMessageId?: string,
): Promise<string | undefined> {
  const result = await feishuClient.sendMessage(
    'chat_id',
    chatId,
    {
      msg_type: 'text',
      content: { text },
    } as any,
    replyToMessageId,
  );
  return result?.messageId || undefined;
}

async function buildWorktreeListReply(
  deps: SlashCommandHandlerDeps,
  replyLanguage: ReplyLanguage,
): Promise<string> {
  const t = createApiReplyLocalizer(replyLanguage);
  const worktreeSessions = await deps.db
    .select({
      id: sessions.id,
      scope: sessions.scope,
      status: sessions.status,
      messageCount: sessions.messageCount,
      worktreePath: sessions.worktreePath,
      worktreeBranch: sessions.worktreeBranch,
      prUrl: sessions.prUrl,
      updatedAt: sessions.updatedAt,
    })
    .from(sessions)
    .where(worktreeSessionListFilter());

  const lines: string[] = [];

  if (worktreeSessions.length > 0) {
    const [latestTasks, prStates] = await Promise.all([
      Promise.all(
        worktreeSessions.map((session) =>
          deps.db
            .select({ goal: tasks.goal })
            .from(tasks)
            .where(eq(tasks.sessionId, session.id))
            .orderBy(desc(tasks.createdAt))
            .limit(1)
            .then(([task]) => task?.goal ?? null),
        ),
      ),
      Promise.all(worktreeSessions.map((session) => getPrState(session.prUrl))),
    ]);

    lines.push(
      replyLanguage === 'zh-CN'
        ? `── 已跟踪 worktree（${worktreeSessions.length}）──`
        : `── Tracked worktrees (${worktreeSessions.length}) ──`,
    );
    for (let i = 0; i < worktreeSessions.length; i++) {
      const session = worktreeSessions[i];
      const age = relativeTime(session.updatedAt);
      const pr = session.prUrl ? ` | PR/MR: ${session.prUrl}` : '';
      lines.push(
        `• ${session.id.slice(0, 8)} | ${session.worktreeBranch} | ${session.status} | ${session.messageCount} msgs | ${age}${pr}`,
      );
      if (latestTasks[i]) {
        lines.push(
          replyLanguage === 'zh-CN'
            ? `  └ 目标：${latestTasks[i]!.slice(0, 80)}`
            : `  └ goal: ${latestTasks[i]!.slice(0, 80)}`,
        );
      }
      if (prStates[i] === 'MERGED') {
        lines.push(replyLanguage === 'zh-CN' ? '  └ ⚠ PR/MR 已合并' : '  └ ⚠ PR/MR merged');
      } else if (prStates[i] === 'CLOSED') {
        lines.push(replyLanguage === 'zh-CN' ? '  └ ⚠ PR/MR 已关闭' : '  └ ⚠ PR/MR closed');
      }
    }
  }

  const dbPaths = new Set(worktreeSessions.map((session) => session.worktreePath!));
  const worktreesDir = join(deps.repoRoot, '.worktrees');
  const orphanDirs: string[] = [];
  try {
    // Async readdir keeps the event loop free; a missing .worktrees directory
    // (ENOENT) or any disk read error falls through to DB-backed results only.
    const entries = await readdir(worktreesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('dev-')) continue;
      const fullPath = join(worktreesDir, entry.name);
      if (!dbPaths.has(fullPath)) {
        orphanDirs.push(entry.name);
      }
    }
  } catch {
    // Ignore disk read errors and return DB-backed results only.
  }

  if (orphanDirs.length > 0) {
    lines.push('');
    lines.push(
      replyLanguage === 'zh-CN'
        ? `── 孤儿目录（${orphanDirs.length}，无 DB session）──`
        : `── Orphan directories (${orphanDirs.length}, no DB session) ──`,
    );
    for (const dirName of orphanDirs) {
      lines.push(`• ${dirName}`);
    }
  }

  if (worktreeSessions.length === 0 && orphanDirs.length === 0) {
    return t.noWorktreesFound();
  }

  const total = worktreeSessions.length + orphanDirs.length;
  lines.push('');
  lines.push(
    replyLanguage === 'zh-CN'
      ? `总计：${worktreeSessions.length} 个已跟踪 + ${orphanDirs.length} 个孤儿 = ${total} 个 worktree`
      : `Total: ${worktreeSessions.length} tracked + ${orphanDirs.length} orphan = ${total} worktrees`,
  );
  lines.push(
    replyLanguage === 'zh-CN'
      ? '提示：/session clean — 自动移除已合并和孤儿 worktree'
      : 'Hint: /session clean — auto-remove merged + orphans',
  );
  lines.push(
    replyLanguage === 'zh-CN'
      ? '提示：/session clean <id> — 删除指定 worktree'
      : 'Hint: /session clean <id> — remove a specific worktree',
  );
  return lines.join('\n');
}

async function runWorktreeClean(
  deps: SlashCommandHandlerDeps,
  parts: string[],
  replyLanguage: ReplyLanguage,
): Promise<string> {
  const t = createApiReplyLocalizer(replyLanguage);
  const hasAll = parts.includes('--all');
  const targetId = parts.find((part, index) => index > 0 && part !== '--all') ?? '';

  if (targetId) {
    const result = await removeWorktreeById(deps.db, deps.repoRoot, targetId);
    if (result.targetCleaned.length > 0) {
      return t.removedWorktree(result.targetCleaned);
    }
    if (result.errors.length > 0) {
      return t.cleanupFailed(result.errors);
    }
    return t.nothingToClean();
  }

  if (hasAll) {
    const result = await cleanAllWorktrees(deps.db, deps.repoRoot);
    const lines: string[] = [
      replyLanguage === 'zh-CN' ? '强制清理完成（--all）：' : 'Force cleanup complete (--all):',
    ];
    if (result.targetCleaned.length > 0) {
      lines.push(
        replyLanguage === 'zh-CN'
          ? `  已移除 worktree：${result.targetCleaned.join(', ')}`
          : `  Worktrees removed: ${result.targetCleaned.join(', ')}`,
      );
    }
    if (result.orphanDiskCleaned.length > 0) {
      lines.push(
        replyLanguage === 'zh-CN'
          ? `  已移除孤儿磁盘目录：${result.orphanDiskCleaned.join(', ')}`
          : `  Orphan disk dirs removed: ${result.orphanDiskCleaned.join(', ')}`,
      );
    }
    if (result.errors.length > 0) {
      lines.push(
        replyLanguage === 'zh-CN'
          ? `  错误：${result.errors.join('; ')}`
          : `  Errors: ${result.errors.join('; ')}`,
      );
    }

    const total = result.targetCleaned.length + result.orphanDiskCleaned.length;
    if (total === 0) {
      lines.push(replyLanguage === 'zh-CN' ? '  没有可清理的内容。' : '  Nothing to clean.');
    } else {
      lines.push(
        replyLanguage === 'zh-CN' ? `\n总计已清理：${total}` : `\nTotal cleaned: ${total}`,
      );
    }

    return lines.join('\n');
  }

  const result = await cleanWorktrees(deps.db, deps.repoRoot);
  const lines: string[] = [
    replyLanguage === 'zh-CN' ? 'Worktree 清理完成：' : 'Worktree cleanup complete:',
  ];
  if (result.mergedCleaned.length > 0) {
    lines.push(
      replyLanguage === 'zh-CN'
        ? `  已合并 → 已移除：${result.mergedCleaned.join(', ')}`
        : `  Merged → removed: ${result.mergedCleaned.join(', ')}`,
    );
  }
  if (result.closedCleaned.length > 0) {
    lines.push(
      replyLanguage === 'zh-CN'
        ? `  已关闭 → 已移除：${result.closedCleaned.join(', ')}`
        : `  Closed → removed: ${result.closedCleaned.join(', ')}`,
    );
  }
  if (result.orphanDbCleaned.length > 0) {
    lines.push(
      replyLanguage === 'zh-CN'
        ? `  已清理孤儿 DB 记录：${result.orphanDbCleaned.join(', ')}`
        : `  Orphan DB records cleared: ${result.orphanDbCleaned.join(', ')}`,
    );
  }
  if (result.orphanDiskCleaned.length > 0) {
    lines.push(
      replyLanguage === 'zh-CN'
        ? `  已移除孤儿磁盘目录：${result.orphanDiskCleaned.join(', ')}`
        : `  Orphan disk dirs removed: ${result.orphanDiskCleaned.join(', ')}`,
    );
  }
  if (result.staleSkipped.length > 0) {
    lines.push(
      replyLanguage === 'zh-CN'
        ? `  已跳过非受管 worktree：${result.staleSkipped.join(', ')}`
        : `  Skipped unmanaged worktrees: ${result.staleSkipped.join(', ')}`,
    );
  }
  if (result.errors.length > 0) {
    lines.push(
      replyLanguage === 'zh-CN'
        ? `  错误：${result.errors.join('; ')}`
        : `  Errors: ${result.errors.join('; ')}`,
    );
  }

  const totalCleaned =
    result.mergedCleaned.length +
    result.closedCleaned.length +
    result.orphanDbCleaned.length +
    result.orphanDiskCleaned.length;
  const totalReported = totalCleaned + result.staleSkipped.length;
  if (totalReported === 0) {
    lines.push(replyLanguage === 'zh-CN' ? '  没有可清理的内容。' : '  Nothing to clean.');
  } else if (totalCleaned > 0) {
    lines.push(
      replyLanguage === 'zh-CN'
        ? `\n总计已清理：${totalCleaned}`
        : `\nTotal cleaned: ${totalCleaned}`,
    );
  }

  return lines.join('\n');
}

export function createSlashCommandHandler(deps: SlashCommandHandlerDeps) {
  return async function handleSlashCommand(
    event: NormalizedEvent,
    sessionId: string,
    replyToMessageId?: string,
  ): Promise<string | undefined> {
    const command = event.content.command!;
    const args = event.content.args ?? '';
    const chatId = event.chatId;
    const replyLanguage = await resolvePreferredReplyLanguage(
      deps.db,
      sessionId,
      event.replyLanguage,
    );
    const t = createApiReplyLocalizer(replyLanguage);
    let replyText: string | undefined;
    let sentMessageId: string | undefined;

    try {
      switch (command) {
        case '/new': {
          if (args.trim() === '--help') {
            replyText = getHelpText('/new', replyLanguage);
            break;
          }
          replyText =
            event.chatType === 'group'
              ? replyLanguage === 'zh-CN'
                ? `新的手动 session 已启动：${sessionId.slice(0, 8)}\n使用 /reset 可回到 main session。`
                : `New manual session started: ${sessionId.slice(0, 8)}\nUse /reset to return to the main session.`
              : replyLanguage === 'zh-CN'
                ? '/new 仅用于群聊；私聊会按根消息自动创建独立 session。'
                : '/new is only used in group chats; private chats already create independent sessions per root message.';
          break;
        }

        case '/reset': {
          if (args.trim() === '--help') {
            replyText = getHelpText('/reset', replyLanguage);
            break;
          }
          replyText =
            event.chatType === 'group'
              ? replyLanguage === 'zh-CN'
                ? `已回到 main session：${sessionId.slice(0, 8)}`
                : `Returned to the main session: ${sessionId.slice(0, 8)}`
              : replyLanguage === 'zh-CN'
                ? '/reset 仅用于群聊；私聊没有群级活跃 session 指针。'
                : '/reset is only used in group chats; private chats do not have a group-level active session pointer.';
          break;
        }

        case '/status': {
          if (args.trim() === '--help') {
            replyText = getHelpText('/status', replyLanguage);
            break;
          }
          // Process health (formerly /ping) is computed before the DB lookup
          // and replied even when the session query fails, so /status keeps
          // working as a liveness probe independent of storage.
          const uptimeSec = Math.floor(process.uptime());
          const rssMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
          const healthLines = `Uptime: ${uptimeSec}s\nRSS: ${rssMb} MB`;
          let sessionLines: string;
          try {
            const status = await getSessionStatus(deps.db, sessionId);
            sessionLines = status
              ? `Session: ${status.sessionKey}\nScope: ${status.scope}\nStatus: ${status.status}\nMessages: ${status.messageCount}\nCreated: ${status.createdAt}`
              : t.sessionNotFound();
          } catch (statusErr) {
            deps.logger.warn({ err: statusErr, sessionId }, '/status: session lookup failed');
            sessionLines =
              replyLanguage === 'zh-CN' ? '会话信息暂不可用。' : 'Session info unavailable.';
          }
          replyText = `${sessionLines}\n\n${healthLines}`;
          break;
        }

        case '/session': {
          if (args.trim() === '--help') {
            replyText = getHelpText('/session', replyLanguage);
            break;
          }
          const parts = args.trim().split(/\s+/).filter(Boolean);
          const subCmd = parts[0] ?? '';
          if (subCmd === 'list') {
            const sessionsList = await listSessions(deps.db, chatId);
            if (sessionsList.length === 0) {
              replyText = t.noSessionsInChat();
            } else {
              replyText = sessionsList
                .map(
                  (session) =>
                    `• ${session.id.slice(0, 8)} | ${session.scope} | ${session.status} | ${session.messageCount} msgs${session.title ? ` | ${session.title}` : ''}`,
                )
                .join('\n');
            }
          } else if (subCmd === 'use') {
            const targetId = parts[1];
            if (!targetId) {
              replyText = t.sessionUseUsage();
            } else {
              const result = await useSession(deps.db, chatId, targetId);
              replyText = result.success
                ? `Switched to session ${targetId.slice(0, 8)}`
                : `Failed: ${result.error}`;
            }
          } else if (subCmd === 'worktrees' || subCmd === 'clean') {
            // Worktree management is owner-only at subcommand level; the
            // /session command itself stays open for list/use.
            if (!(await canManageWorktrees(deps, event))) {
              replyText = t.permissionDenied(`/session ${subCmd}`);
              break;
            }
            if (subCmd === 'worktrees') {
              replyText = await buildWorktreeListReply(deps, replyLanguage);
            } else {
              replyText = await runWorktreeClean(deps, parts, replyLanguage);
            }
          } else {
            replyText = t.sessionUsage();
          }
          break;
        }

        case '/compact': {
          if (args.trim() === '--help') {
            replyText = getHelpText('/compact', replyLanguage);
            break;
          }
          const result = await compactSession(deps.db, sessionId);
          replyText = `Compacted: ${result.messagesRemoved} messages removed, ${result.tokensBefore} → ${result.tokensAfter} tokens`;
          break;
        }

        case '/schedule': {
          if (args.trim() === '--help') {
            replyText = getHelpText('/schedule', replyLanguage);
            break;
          }
          const parsed = parseScheduleArgs(args.trim());
          if (!parsed) {
            replyText = t.scheduleParseError();
            break;
          }

          const { scheduledAt, goal, timeDesc } = parsed;
          const [sessionRow] = await deps.db
            .select({
              sdkSessionId: sessions.sdkSessionId,
              runtimeBackend: sessions.runtimeBackend,
            })
            .from(sessions)
            .where(eq(sessions.id, sessionId))
            .limit(1);

          const taskId = randomUUID();
          await deps.db.insert(tasks).values({
            id: taskId,
            sessionId,
            agentId: deps.agentContext?.agentId,
            feishuAppId: deps.agentContext?.feishuAppId,
            taskType: 'self_dev',
            goal,
            status: TaskStatus.PENDING,
            constraints: {
              chatId,
              agentId: deps.agentContext?.agentId,
              feishuAppId: deps.agentContext?.feishuAppId,
              replyLanguage,
              debugSkipExecution: shouldSkipTaskExecutionForDebugEvent(event) || undefined,
            },
          });

          await transitionTask(deps.db, taskId, TaskStatus.QUEUED);

          let jobId: string;
          try {
            jobId = await deps.queue.enqueue(
              {
                taskId,
                sessionId,
                agentId: deps.agentContext?.agentId,
                feishuAppId: deps.agentContext?.feishuAppId,
                taskType: 'self_dev',
                goal,
                runtimeHint: sessionRow?.runtimeBackend ?? 'claude_code',
                constraints: {
                  chatId,
                  agentId: deps.agentContext?.agentId,
                  feishuAppId: deps.agentContext?.feishuAppId,
                  replyLanguage,
                  debugSkipExecution: shouldSkipTaskExecutionForDebugEvent(event) || undefined,
                },
              },
              { startAfter: scheduledAt },
            );
          } catch (err) {
            const message = errorMessage(err);
            deps.logger.error({ err, taskId, sessionId }, 'Failed to enqueue scheduled task');
            await transitionTask(deps.db, taskId, TaskStatus.FAILED, { errorMessage: message });
            replyText =
              replyLanguage === 'zh-CN'
                ? '任务调度失败，请稍后重试。'
                : 'Scheduling failed: please retry later.';
            break;
          }

          replyText = `Scheduled: will start at ${timeDesc}\nGoal: ${goal}\n\nJob ID: ${jobId}`;
          break;
        }

        case '/chat': {
          if (args.trim() === '--help') {
            replyText = getHelpText('/chat', replyLanguage);
            break;
          }
          if (event.chatType !== 'group') {
            replyText =
              replyLanguage === 'zh-CN'
                ? '/chat 只能在群聊中使用。'
                : '/chat can only be used in group chats.';
            break;
          }

          const parts = args.trim().split(/\s+/).filter(Boolean);
          const subCmd = parts[0] ?? '';
          const subArgs = subCmd ? args.trim().slice(subCmd.length).trim() : '';

          if (subCmd === 'init') {
            await ensureChatConfig(deps, event);

            if (!deps.feishuTaskSync) {
              replyText =
                replyLanguage === 'zh-CN'
                  ? '群聊配置已初始化。Feishu 任务跟踪服务未启用，已跳过任务看板初始化。'
                  : 'Chat configuration initialized. Feishu Task tracking is not configured, so task board initialization was skipped.';
              break;
            }

            const result = await deps.feishuTaskSync.initializeChatTrackingSpace({
              chatId,
              tenantKey: event.tenantKey,
            });
            const tasklistChatName = extractChatDisplayNameFromTasklistName(
              result.tasklistName,
              chatId,
            );
            if (tasklistChatName) {
              await ensureChatConfig(deps, event, { displayName: tasklistChatName });
            }
            const lines = result.created
              ? replyLanguage === 'zh-CN'
                ? [
                    '群聊配置已初始化。',
                    '任务看板已初始化。',
                    `名称：${result.tasklistName}`,
                    `GUID：${result.tasklistGuid}`,
                    `协作人：${result.memberCount ?? 0} 个群成员`,
                    ...(result.tasklistUrl ? [`链接：${result.tasklistUrl}`] : []),
                  ]
                : [
                    'Chat configuration initialized.',
                    'Task board initialized.',
                    `Name: ${result.tasklistName}`,
                    `GUID: ${result.tasklistGuid}`,
                    `Collaborators: ${result.memberCount ?? 0} chat members`,
                    ...(result.tasklistUrl ? [`URL: ${result.tasklistUrl}`] : []),
                  ]
              : replyLanguage === 'zh-CN'
                ? [
                    '群聊配置已初始化。',
                    '任务看板已存在，跳过重复创建。',
                    `GUID：${result.tasklistGuid}`,
                  ]
                : [
                    'Chat configuration initialized.',
                    'Task board is already initialized; skipped creating another one.',
                    `GUID: ${result.tasklistGuid}`,
                  ];
            replyText = lines.join('\n');
          } else if (subCmd === 'memory') {
            replyText = await handleChatMemoryCommand(deps, event, subArgs, replyLanguage);
          } else if (subCmd === 'status') {
            const { config, taskSpace } = await loadChatStatus(deps, event);
            if (replyLanguage === 'zh-CN') {
              replyText = [
                '群聊配置：',
                `工作目录：${config?.defaultWorkDir ?? '(未设置)'}`,
                `任务看板：${taskSpace?.tasklistGuid ?? '(未初始化)'}`,
              ].join('\n');
            } else {
              replyText = [
                'Chat configuration:',
                `Workdir: ${config?.defaultWorkDir ?? '(not set)'}`,
                `Task board: ${taskSpace?.tasklistGuid ?? '(not initialized)'}`,
              ].join('\n');
            }
          } else if (subCmd === 'set-workdir') {
            const workDir = unwrapFeishuMarkdownLinks(subArgs);
            if (!workDir) {
              replyText =
                replyLanguage === 'zh-CN'
                  ? '用法：/chat set-workdir <absolute-path>'
                  : 'Usage: /chat set-workdir <absolute-path>';
              break;
            }
            if (!isAbsolute(workDir)) {
              replyText =
                replyLanguage === 'zh-CN'
                  ? `无效路径："${workDir}" 不是绝对路径。`
                  : `Invalid path: "${workDir}" is not an absolute path.`;
              break;
            }
            // When the chat's tasks run on a bound remote machine (agent machine
            // binding or chat default machine, D-A8), the workdir lives on THAT
            // machine's filesystem — statting it here on the server would falsely
            // reject a valid machine-local path. Only do the early existence check
            // for server-local execution; the daemon validates it at run time.
            const runsRemote = await chatWorkdirRunsOnRemoteMachine(deps, event);
            if (!runsRemote) {
              try {
                const stats = await stat(workDir);
                if (!stats.isDirectory()) throw new Error('not a directory');
              } catch {
                replyText = t.invalidProjectPath(workDir);
                break;
              }
            }

            await ensureChatConfig(deps, event, { defaultWorkDir: workDir });
            replyText =
              replyLanguage === 'zh-CN'
                ? runsRemote
                  ? `当前群聊默认工作目录已设置为：\n${workDir}\n（路径将在执行任务的机器上校验）`
                  : `当前群聊默认工作目录已设置为：\n${workDir}`
                : runsRemote
                  ? `Default workdir for this chat set to:\n${workDir}\n(existence will be checked on the executing machine)`
                  : `Default workdir for this chat set to:\n${workDir}`;
          } else if (subCmd === 'clear-workdir') {
            await ensureChatConfig(deps, event, { defaultWorkDir: null });
            replyText =
              replyLanguage === 'zh-CN'
                ? '当前群聊默认工作目录已清除。'
                : 'Default workdir for this chat cleared.';
          } else {
            replyText =
              replyLanguage === 'zh-CN'
                ? '用法：/chat init | /chat status | /chat memory <subcommand> | /chat set-workdir <absolute-path> | /chat clear-workdir'
                : 'Usage: /chat init | /chat status | /chat memory <subcommand> | /chat set-workdir <absolute-path> | /chat clear-workdir';
          }
          break;
        }

        case '/agent': {
          if (args.trim() === '--help') {
            replyText = getHelpText('/agent', replyLanguage);
            break;
          }

          const services = createStorageAgentCommandServices(deps.db, {
            repoRoot: deps.repoRoot,
            tenantKey: event.tenantKey,
            chatId,
          });
          const result = await handleAgentCommand(
            args,
            { canManageAgents: await canManageAgents(deps, event) },
            services,
          );
          replyText = result.message;
          break;
        }

        case '/add-bot': {
          if (args.trim() === '--help') {
            replyText = getHelpText('/add-bot', replyLanguage);
            break;
          }
          if (event.chatType !== 'group') {
            replyText =
              replyLanguage === 'zh-CN'
                ? '/add-bot 只能在群聊中使用。'
                : '/add-bot can only be used in group chats.';
            break;
          }
          if (!deps.feishuTaskSync) {
            replyText =
              replyLanguage === 'zh-CN'
                ? 'Feishu 任务跟踪服务未启用。'
                : 'Feishu Task tracking service is not configured.';
            break;
          }

          const targetBot = findAddBotTargetMention(event);
          if (!targetBot) {
            replyText =
              replyLanguage === 'zh-CN' ? '用法：/add-bot @新的机器人' : 'Usage: /add-bot @new-bot';
            break;
          }

          const result = await deps.feishuTaskSync.addBotToChatTrackingSpace({
            chatId,
            tenantKey: event.tenantKey,
            botOpenId: targetBot.id,
            botName: targetBot.name,
            replyToMessageId,
          });

          replyText =
            replyLanguage === 'zh-CN'
              ? [
                  '已将机器人加入当前群的任务看板。',
                  `机器人：${result.botName ?? result.botOpenId}`,
                  `GUID：${result.tasklistGuid}`,
                  result.configurationMessageId
                    ? `配置消息：${result.configurationMessageId}`
                    : undefined,
                ]
                  .filter(Boolean)
                  .join('\n')
              : [
                  'Bot added to this chat task board.',
                  `Bot: ${result.botName ?? result.botOpenId}`,
                  `GUID: ${result.tasklistGuid}`,
                  result.configurationMessageId
                    ? `Configuration message: ${result.configurationMessageId}`
                    : undefined,
                ]
                  .filter(Boolean)
                  .join('\n');
          break;
        }

        case '/clean-task': {
          if (args.trim() === '--help') {
            replyText = getHelpText('/clean-task', replyLanguage);
            break;
          }
          if (!deps.feishuTaskSync) {
            replyText =
              replyLanguage === 'zh-CN'
                ? 'Feishu 任务跟踪服务未启用。'
                : 'Feishu Task tracking service is not configured.';
            break;
          }

          const parsed = parseCleanTaskArgs(args);
          if (!parsed.options) {
            replyText =
              replyLanguage === 'zh-CN'
                ? `参数错误：${parsed.error}\n用法：/clean-task [--chat] [--dry-run] [--days N]`
                : `Invalid options: ${parsed.error}\nUsage: /clean-task [--chat] [--dry-run] [--days N]`;
            break;
          }
          if (parsed.options.scope === 'chat' && event.chatType !== 'group') {
            replyText =
              replyLanguage === 'zh-CN'
                ? '/clean-task --chat 只能在群聊中使用。'
                : '/clean-task --chat can only be used in group chats.';
            break;
          }

          const result =
            parsed.options.scope === 'chat'
              ? await deps.feishuTaskSync.cleanCompletedTasksForChat({
                  chatId,
                  retentionDays: parsed.options.retentionDays,
                  dryRun: parsed.options.dryRun,
                })
              : await deps.feishuTaskSync.cleanCompletedTasksForSession({
                  sessionId,
                  retentionDays: parsed.options.retentionDays,
                  dryRun: parsed.options.dryRun,
                });
          replyText = formatCleanTaskResult(result, replyLanguage);
          break;
        }

        case '/configure-tasklist': {
          if (event.senderType !== 'app' || !['group', 'p2p'].includes(event.chatType)) {
            replyText =
              replyLanguage === 'zh-CN'
                ? '/configure-tasklist 只接受机器人发送的任务看板配置消息。'
                : '/configure-tasklist only accepts bot-sent task board configuration messages.';
            break;
          }
          if (!deps.feishuTaskSync) {
            replyText =
              replyLanguage === 'zh-CN'
                ? 'Feishu 任务跟踪服务未启用。'
                : 'Feishu Task tracking service is not configured.';
            break;
          }

          const encodedPayload = args.trim();
          if (!encodedPayload) {
            replyText =
              replyLanguage === 'zh-CN'
                ? '任务看板配置缺少 payload。'
                : 'Task board configuration payload is missing.';
            break;
          }

          const result = await deps.feishuTaskSync.applyChatTasklistConfiguration({
            encodedPayload,
          });
          replyText =
            replyLanguage === 'zh-CN'
              ? `任务看板配置已应用。\n群聊：${result.chatId}\nGUID：${result.tasklistGuid}`
              : `Task board configuration applied.\nChat: ${result.chatId}\nGUID: ${result.tasklistGuid}`;
          break;
        }

        case '/help': {
          replyText = getHelpText('/help', replyLanguage);
          break;
        }

        case '/project': {
          if (args.trim() === '--help') {
            replyText = getHelpText('/project', replyLanguage);
            break;
          }
          const subCmd = args.trim().split(/\s+/)[0] ?? '';

          if (!subCmd) {
            const [sessionRow] = await deps.db
              .select({ projectId: sessions.projectId })
              .from(sessions)
              .where(eq(sessions.id, sessionId))
              .limit(1);

            if (!sessionRow?.projectId) {
              replyText = t.noProjectSet();
            } else {
              const [project] = await deps.db
                .select({ name: projects.name, path: projects.path })
                .from(projects)
                .where(eq(projects.id, sessionRow.projectId))
                .limit(1);
              replyText = project
                ? t.currentProject(project.name, project.path)
                : t.projectMissingRecord();
            }
          } else if (subCmd === 'list') {
            const allProjects = await deps.db
              .select({ name: projects.name, path: projects.path })
              .from(projects);
            if (allProjects.length === 0) {
              replyText = t.noProjectsRegistered();
            } else {
              replyText =
                t.registeredProjectsHeader() +
                allProjects.map((project) => `  ${project.name}  →  ${project.path}`).join('\n');
            }
          } else if (subCmd === 'add') {
            const parts = args.trim().split(/\s+/);
            const name = parts[1];
            const path = parts.slice(2).join(' ');
            if (!name || !path) {
              replyText = t.projectMissingUsage('add');
            } else {
              try {
                const stats = await stat(path);
                if (!stats.isDirectory()) throw new Error('not a directory');
              } catch {
                replyText = t.invalidProjectPath(path);
                break;
              }

              const [existing] = await deps.db
                .select({ id: projects.id })
                .from(projects)
                .where(eq(projects.name, name))
                .limit(1);
              if (existing) {
                replyText = t.projectNameAlreadyRegistered(name);
              } else {
                await deps.db.insert(projects).values({ name, path });
                replyText = t.projectRegistered(name, path);
              }
            }
          } else if (subCmd === 'remove') {
            const name = args.trim().split(/\s+/)[1];
            if (!name) {
              replyText = t.projectMissingUsage('remove');
            } else {
              const [existing] = await deps.db
                .select({ id: projects.id })
                .from(projects)
                .where(eq(projects.name, name))
                .limit(1);
              if (!existing) {
                replyText = t.noProjectNamed(name);
              } else {
                await deps.db.delete(projects).where(eq(projects.name, name));
                replyText = t.projectRemoved(name);
              }
            }
          } else if (subCmd === 'use') {
            const name = args.trim().split(/\s+/)[1];
            if (!name) {
              replyText = t.projectMissingUsage('use');
            } else {
              const [project] = await deps.db
                .select({ id: projects.id, path: projects.path })
                .from(projects)
                .where(eq(projects.name, name))
                .limit(1);
              if (!project) {
                replyText = t.noProjectNamedWithHint(name);
              } else {
                await deps.db
                  .update(sessions)
                  .set({
                    projectId: project.id,
                    worktreePath: null,
                    worktreeBranch: null,
                    updatedAt: new Date(),
                  })
                  .where(eq(sessions.id, sessionId));
                replyText = t.sessionNowTargetingProject(name, project.path);
              }
            }
          } else if (subCmd === 'clear') {
            await deps.db
              .update(sessions)
              .set({
                projectId: null,
                worktreePath: null,
                worktreeBranch: null,
                updatedAt: new Date(),
              })
              .where(eq(sessions.id, sessionId));
            replyText = t.projectDetached();
          } else {
            replyText = t.projectSubcommandUsage();
          }
          break;
        }

        case '/forget': {
          if (args.trim() === '--help') {
            replyText = getHelpText('/forget', replyLanguage);
            break;
          }
          const keyword = args.trim();
          if (!keyword) {
            replyText = t.forgetUsage();
          } else {
            // Scope deletion to the caller: a group member must not be able to
            // wipe other users' or other chats' memories.
            const count = await deps.memoryHandler.forgetInScopes(keyword, [
              { scopeType: 'user', scopeId: event.senderOpenId },
              {
                scopeType: 'group',
                scopeId: buildChatTrackingScopeId(event.tenantKey, event.chatId),
              },
              { scopeType: 'group', scopeId: event.chatId },
            ]);
            replyText = `Forgot ${count} memory entries matching "${keyword}"`;
          }
          break;
        }

        case '/merge-pr': {
          if (args.trim() === '--help') {
            replyText = getHelpText('/merge-pr', replyLanguage);
            break;
          }
          const [sessionForMerge] = await deps.db
            .select({ prUrl: sessions.prUrl })
            .from(sessions)
            .where(eq(sessions.id, sessionId))
            .limit(1);

          if (!sessionForMerge?.prUrl) {
            replyText = t.noPrForSession();
            break;
          }

          const prUrl = sessionForMerge.prUrl;
          const reviewRequest = parseReviewRequestUrl(prUrl);
          if (!reviewRequest) {
            replyText = t.invalidPrUrl(prUrl);
            break;
          }

          // Remove the current session's local worktree and branch before
          // deleting the source branch, otherwise Git refuses to delete a branch
          // that is checked out in a worktree.
          try {
            await removeWorktreeById(deps.db, deps.repoRoot, sessionId);
          } catch (wtErr) {
            deps.logger.warn(
              { wtErr, sessionId },
              '/merge-pr: failed to pre-remove current session worktree (continuing)',
            );
          }

          try {
            const mergeCommand = `gh pr merge ${shellQuote(prUrl)} --squash --delete-branch`;
            await execAsync(mergeCommand, { cwd: deps.repoRoot });
          } catch (mergeErr) {
            const errOutput = mergeErr instanceof Error ? mergeErr.message : String(mergeErr);
            replyText = t.mergeFailed(errOutput);
            break;
          }

          replyText = t.prMerged(prUrl);
          try {
            const cleanResult = await cleanWorktrees(deps.db, deps.repoRoot);
            const cleanedMerged = cleanResult.mergedCleaned;
            const cleanedClosed = cleanResult.closedCleaned;
            const totalCleaned = cleanedMerged.length + cleanedClosed.length;
            if (totalCleaned > 0) {
              replyText += `\n${t.cleanedWorktrees(totalCleaned, [...cleanedMerged, ...cleanedClosed])}`;
            }
          } catch (cleanErr) {
            deps.logger.warn(
              { cleanErr, prUrl },
              '/merge-pr: worktree cleanup failed after successful merge',
            );
          }
          break;
        }

        case '/close': {
          if (args.trim() === '--help') {
            replyText = getHelpText('/close', replyLanguage);
            break;
          }
          let worktreeResult: Awaited<ReturnType<typeof removeWorktreeById>> = {
            mergedCleaned: [],
            closedCleaned: [],
            orphanDbCleaned: [],
            orphanDiskCleaned: [],
            targetCleaned: [],
            staleSkipped: [],
            errors: [],
          };
          try {
            worktreeResult = await removeWorktreeById(deps.db, deps.repoRoot, sessionId);
          } catch (err) {
            deps.logger.warn(
              { err, sessionId },
              '/close: worktree removal failed, continuing with archive',
            );
          }
          if (worktreeResult.errors.length > 0) {
            deps.logger.warn(
              { errors: worktreeResult.errors, sessionId },
              '/close: worktree removal errors',
            );
          }
          await closeSession(deps.db, sessionId);
          if (worktreeResult.targetCleaned.length > 0) {
            replyText = `Session closed. Worktree removed: ${worktreeResult.targetCleaned.join(', ')}`;
          } else {
            replyText = 'Session closed.';
          }
          break;
        }

        default:
          replyText = t.unknownCommand(command);
      }
    } catch (err) {
      deps.logger.error({ err, command }, 'Slash command failed');
      replyText = t.commandFailed(err instanceof Error ? err.message : 'unknown error');
    }

    if (replyText) {
      sentMessageId = await sendTextReply(deps.feishuClient, chatId, replyText, replyToMessageId);
    }

    return sentMessageId;
  };
}
