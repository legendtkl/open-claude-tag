// This module hosts the FeishuTaskTrackingRepository (Drizzle) and the
// FeishuTaskSyncService. The pure helpers, config, interfaces, and payload
// codec they share live in ./feishu-task-tracking-internals.ts and are
// re-exported below so this module's public surface is unchanged.

import type { Logger } from 'pino';
import { and, eq, isNotNull, lte, sql } from 'drizzle-orm';
import { TaskStatus, errorMessage } from '@open-tag/core-types';
import { createLogger } from '@open-tag/observability';
import {
  feishuTaskLinks,
  feishuTaskTrackingSpaces,
  tasks as storageTasks,
  type Database,
} from '@open-tag/storage';
import {
  FeishuClient,
  type FeishuTasklistTaskSummary,
  type FeishuTasklistMember,
  type FeishuTaskSection,
} from './feishu-client.js';
import {
  FEISHU_TRACKING_STATUSES,
  type FeishuTrackingStatus,
  mapTaskStatusToFeishuTrackingStatus,
} from './task-tracking-mapping.js';

import type {
  AddBotToChatTrackingSpaceInput,
  AddBotToChatTrackingSpaceResult,
  ApplyChatTasklistConfigurationInput,
  ApplyChatTasklistConfigurationResult,
  CleanCompletedChatTasksInput,
  CleanCompletedSessionTasksInput,
  CreateTrackedTaskInput,
  FeishuCompletedTaskLinkRecord,
  FeishuTaskCleanupResult,
  FeishuTaskLinkRecord,
  FeishuTaskTrackingConfig,
  FeishuTaskTrackingRepository,
  FeishuTaskTrackingSpace,
  InitializeChatTrackingSpaceInput,
  InitializeChatTrackingSpaceResult,
  SyncTrackedTaskStatusInput,
} from './feishu-task-tracking-internals.js';
import {
  CLEANED_STATUS,
  TASK_TEXT_MAX_LENGTH,
  appendSyncWarning,
  buildChatTrackingScopeId,
  buildConfigureTasklistMentionMessage,
  buildTaskDescription,
  buildTaskOrigin,
  chatTrackingScopeCandidates,
  chunk,
  decodeChatIdFromScopeId,
  decodeTasklistConfiguration,
  fieldOptionMap,
  isFeishuTaskTrackableTaskType,
  isSessionSourceTopicKey,
  normalizeOptionalText,
  normalizeRetentionDays,
  normalizeStatusMap,
  parseFeishuTimestamp,
  requireCompleteMap,
  retentionCutoff,
  taskBoardName,
  truncate,
} from './feishu-task-tracking-internals.js';

export type {
  AddBotToChatTrackingSpaceInput,
  AddBotToChatTrackingSpaceResult,
  ApplyChatTasklistConfigurationInput,
  ApplyChatTasklistConfigurationResult,
  CleanCompletedChatTasksInput,
  CleanCompletedSessionTasksInput,
  CleanCompletedTasksInput,
  CreateTrackedTaskInput,
  FeishuCompletedTaskLinkRecord,
  FeishuTaskCleanupResult,
  FeishuTaskLinkRecord,
  FeishuTaskTrackingConfig,
  FeishuTaskTrackingRepository,
  FeishuTaskTrackingSpace,
  InitializeChatTrackingSpaceInput,
  InitializeChatTrackingSpaceResult,
  SyncTrackedTaskStatusInput,
} from './feishu-task-tracking-internals.js';
export { createFeishuTaskTrackingConfigFromEnv, isFeishuTaskTrackableTaskType } from './feishu-task-tracking-internals.js';

export class DrizzleFeishuTaskTrackingRepository implements FeishuTaskTrackingRepository {
  constructor(private readonly db: Database) {}

  async withScopeLock<T>(
    scopeType: string,
    scopeId: string,
    callback: () => Promise<T>,
  ): Promise<T> {
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${scopeType}), hashtext(${scopeId}))`,
      );
      return callback();
    });
  }

  async findSpace(scopeType: string, scopeId: string): Promise<FeishuTaskTrackingSpace | null> {
    const [row] = await this.db
      .select()
      .from(feishuTaskTrackingSpaces)
      .where(
        and(
          eq(feishuTaskTrackingSpaces.scopeType, scopeType),
          eq(feishuTaskTrackingSpaces.scopeId, scopeId),
        ),
      )
      .limit(1);

    if (!row) return null;
    return {
      id: row.id,
      scopeType: row.scopeType,
      scopeId: row.scopeId,
      name: row.name,
      tasklistGuid: row.tasklistGuid,
      statusFieldGuid: row.statusFieldGuid,
      statusOptions: requireCompleteMap(normalizeStatusMap(row.statusOptions), 'status options'),
      sections: requireCompleteMap(normalizeStatusMap(row.sections), 'sections'),
    };
  }

  async saveSpace(space: FeishuTaskTrackingSpace): Promise<FeishuTaskTrackingSpace> {
    const [row] = await this.db
      .insert(feishuTaskTrackingSpaces)
      .values({
        scopeType: space.scopeType,
        scopeId: space.scopeId,
        name: space.name ?? undefined,
        tasklistGuid: space.tasklistGuid,
        statusFieldGuid: space.statusFieldGuid,
        statusOptions: space.statusOptions,
        sections: space.sections,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [feishuTaskTrackingSpaces.scopeType, feishuTaskTrackingSpaces.scopeId],
        set: {
          name: space.name ?? undefined,
          tasklistGuid: space.tasklistGuid,
          statusFieldGuid: space.statusFieldGuid,
          statusOptions: space.statusOptions,
          sections: space.sections,
          updatedAt: new Date(),
        },
      })
      .returning();

    return {
      id: row.id,
      scopeType: row.scopeType,
      scopeId: row.scopeId,
      name: row.name,
      tasklistGuid: row.tasklistGuid,
      statusFieldGuid: row.statusFieldGuid,
      statusOptions: requireCompleteMap(normalizeStatusMap(row.statusOptions), 'status options'),
      sections: requireCompleteMap(normalizeStatusMap(row.sections), 'sections'),
    };
  }

  async findTaskLink(taskId: string): Promise<FeishuTaskLinkRecord | null> {
    const [row] = await this.db
      .select()
      .from(feishuTaskLinks)
      .where(eq(feishuTaskLinks.taskId, taskId))
      .limit(1);

    return row
      ? {
          taskId: row.taskId,
          trackingSpaceId: row.trackingSpaceId,
          feishuTaskGuid: row.feishuTaskGuid,
          feishuTaskUrl: row.feishuTaskUrl,
          sourceMessageId: row.sourceMessageId,
          sourceTopicKey: row.sourceTopicKey,
          sourceTopicUrl: row.sourceTopicUrl,
          lastSyncedStatus: row.lastSyncedStatus,
          lastSyncError: row.lastSyncError,
        }
      : null;
  }

  async findTaskLinkBySourceTopic(input: {
    trackingSpaceId: string;
    sourceTopicKey: string;
  }): Promise<FeishuTaskLinkRecord | null> {
    const [row] = await this.db
      .select()
      .from(feishuTaskLinks)
      .where(
        and(
          eq(feishuTaskLinks.trackingSpaceId, input.trackingSpaceId),
          eq(feishuTaskLinks.sourceTopicKey, input.sourceTopicKey),
          isNotNull(feishuTaskLinks.feishuTaskGuid),
        ),
      )
      .orderBy(feishuTaskLinks.createdAt)
      .limit(1);

    return row
      ? {
          taskId: row.taskId,
          trackingSpaceId: row.trackingSpaceId,
          feishuTaskGuid: row.feishuTaskGuid,
          feishuTaskUrl: row.feishuTaskUrl,
          sourceMessageId: row.sourceMessageId,
          sourceTopicKey: row.sourceTopicKey,
          sourceTopicUrl: row.sourceTopicUrl,
          lastSyncedStatus: row.lastSyncedStatus,
          lastSyncError: row.lastSyncError,
        }
      : null;
  }

  async findTaskLinkBySession(input: {
    trackingSpaceId: string;
    sessionId: string;
  }): Promise<FeishuTaskLinkRecord | null> {
    const [row] = await this.db
      .select({
        taskId: feishuTaskLinks.taskId,
        trackingSpaceId: feishuTaskLinks.trackingSpaceId,
        feishuTaskGuid: feishuTaskLinks.feishuTaskGuid,
        feishuTaskUrl: feishuTaskLinks.feishuTaskUrl,
        sourceMessageId: feishuTaskLinks.sourceMessageId,
        sourceTopicKey: feishuTaskLinks.sourceTopicKey,
        sourceTopicUrl: feishuTaskLinks.sourceTopicUrl,
        lastSyncedStatus: feishuTaskLinks.lastSyncedStatus,
        lastSyncError: feishuTaskLinks.lastSyncError,
      })
      .from(feishuTaskLinks)
      .innerJoin(storageTasks, eq(feishuTaskLinks.taskId, storageTasks.id))
      .where(
        and(
          eq(feishuTaskLinks.trackingSpaceId, input.trackingSpaceId),
          eq(storageTasks.sessionId, input.sessionId),
          isNotNull(feishuTaskLinks.feishuTaskGuid),
        ),
      )
      .orderBy(feishuTaskLinks.createdAt)
      .limit(1);

    return row ?? null;
  }

  async findSpaceById(id: string): Promise<FeishuTaskTrackingSpace | null> {
    const [row] = await this.db
      .select()
      .from(feishuTaskTrackingSpaces)
      .where(eq(feishuTaskTrackingSpaces.id, id))
      .limit(1);

    if (!row) return null;
    return {
      id: row.id,
      scopeType: row.scopeType,
      scopeId: row.scopeId,
      name: row.name,
      tasklistGuid: row.tasklistGuid,
      statusFieldGuid: row.statusFieldGuid,
      statusOptions: requireCompleteMap(normalizeStatusMap(row.statusOptions), 'status options'),
      sections: requireCompleteMap(normalizeStatusMap(row.sections), 'sections'),
    };
  }

  async recordTaskLink(link: FeishuTaskLinkRecord): Promise<void> {
    await this.db
      .insert(feishuTaskLinks)
      .values({
        taskId: link.taskId,
        trackingSpaceId: link.trackingSpaceId,
        feishuTaskGuid: link.feishuTaskGuid,
        feishuTaskUrl: link.feishuTaskUrl,
        sourceMessageId: link.sourceMessageId,
        sourceTopicKey: link.sourceTopicKey,
        sourceTopicUrl: link.sourceTopicUrl,
        lastSyncedStatus: link.lastSyncedStatus,
        lastSyncError: link.lastSyncError,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: feishuTaskLinks.taskId,
        set: {
          trackingSpaceId: link.trackingSpaceId,
          feishuTaskGuid: link.feishuTaskGuid,
          feishuTaskUrl: link.feishuTaskUrl,
          sourceMessageId: link.sourceMessageId,
          sourceTopicKey: link.sourceTopicKey,
          sourceTopicUrl: link.sourceTopicUrl,
          lastSyncedStatus: link.lastSyncedStatus,
          lastSyncError: link.lastSyncError,
          updatedAt: new Date(),
        },
      });
  }

  async recordTaskLinkError(input: {
    taskId: string;
    sourceMessageId?: string;
    sourceTopicKey?: string | null;
    sourceTopicUrl?: string | null;
    error: string;
  }): Promise<void> {
    await this.recordTaskLink({
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
    await this.db
      .update(feishuTaskLinks)
      .set({
        ...(input.lastSyncedStatus !== undefined
          ? { lastSyncedStatus: input.lastSyncedStatus }
          : {}),
        ...(input.lastSyncError !== undefined ? { lastSyncError: input.lastSyncError } : {}),
        updatedAt: new Date(),
      })
      .where(eq(feishuTaskLinks.taskId, input.taskId));
  }

  async listCompletedTaskLinksForSession(input: {
    sessionId: string;
    completedBefore: Date;
  }): Promise<FeishuCompletedTaskLinkRecord[]> {
    const rows = await this.db
      .select({
        taskId: feishuTaskLinks.taskId,
        trackingSpaceId: feishuTaskLinks.trackingSpaceId,
        feishuTaskGuid: feishuTaskLinks.feishuTaskGuid,
        feishuTaskUrl: feishuTaskLinks.feishuTaskUrl,
        sourceMessageId: feishuTaskLinks.sourceMessageId,
        sourceTopicKey: feishuTaskLinks.sourceTopicKey,
        sourceTopicUrl: feishuTaskLinks.sourceTopicUrl,
        lastSyncedStatus: feishuTaskLinks.lastSyncedStatus,
        lastSyncError: feishuTaskLinks.lastSyncError,
        completedAt: storageTasks.updatedAt,
      })
      .from(feishuTaskLinks)
      .innerJoin(storageTasks, eq(feishuTaskLinks.taskId, storageTasks.id))
      .where(
        and(
          eq(storageTasks.sessionId, input.sessionId),
          eq(storageTasks.status, TaskStatus.COMPLETED),
          lte(storageTasks.updatedAt, input.completedBefore),
          isNotNull(feishuTaskLinks.feishuTaskGuid),
          sql`${feishuTaskLinks.lastSyncedStatus} IS DISTINCT FROM ${CLEANED_STATUS}`,
        ),
      );

    return rows.map((row) => ({
      taskId: row.taskId,
      trackingSpaceId: row.trackingSpaceId,
      feishuTaskGuid: row.feishuTaskGuid,
      feishuTaskUrl: row.feishuTaskUrl,
      sourceMessageId: row.sourceMessageId,
      sourceTopicKey: row.sourceTopicKey,
      sourceTopicUrl: row.sourceTopicUrl,
      lastSyncedStatus: row.lastSyncedStatus,
      lastSyncError: row.lastSyncError,
      completedAt: row.completedAt,
    }));
  }

  async hasRetainedTaskLinkForFeishuTask(input: {
    feishuTaskGuid: string;
    completedBefore: Date;
  }): Promise<boolean> {
    const [row] = await this.db
      .select({ taskId: feishuTaskLinks.taskId })
      .from(feishuTaskLinks)
      .innerJoin(storageTasks, eq(feishuTaskLinks.taskId, storageTasks.id))
      .where(
        and(
          eq(feishuTaskLinks.feishuTaskGuid, input.feishuTaskGuid),
          sql`${feishuTaskLinks.lastSyncedStatus} IS DISTINCT FROM ${CLEANED_STATUS}`,
          sql`(${storageTasks.status} <> ${TaskStatus.COMPLETED} OR ${storageTasks.updatedAt} > ${input.completedBefore})`,
        ),
      )
      .limit(1);

    return Boolean(row);
  }
}

export class FeishuTaskSyncService {
  private readonly logger: Logger;

  constructor(
    private readonly deps: {
      client: FeishuClient;
      repository: FeishuTaskTrackingRepository;
      config: FeishuTaskTrackingConfig;
      logger?: Logger;
    },
  ) {
    this.logger = deps.logger ?? createLogger('feishu-task-sync');
  }

  async createTrackedTask(input: CreateTrackedTaskInput): Promise<void> {
    if (!this.deps.config.enabled) return;
    if (!input.forceTrack && !isFeishuTaskTrackableTaskType(input.taskType)) return;

    const sourceTopicKey = normalizeOptionalText(input.sourceTopicKey ?? input.sourceMessageId);
    if (sourceTopicKey) {
      await this.deps.repository.withScopeLock('feishu-task-topic', sourceTopicKey, async () =>
        this.createTrackedTaskLocked(input, sourceTopicKey),
      );
      return;
    }

    await this.createTrackedTaskLocked(input, null);
  }

  private async createTrackedTaskLocked(
    input: CreateTrackedTaskInput,
    sourceTopicKey: string | null,
  ): Promise<void> {
    let sourceTopicUrl: string | null = null;
    let sourceTopicError: string | null = null;
    try {
      const space = await this.resolveTrackingSpaceForTask(input);
      const trackingStatus = mapTaskStatusToFeishuTrackingStatus(
        input.localStatus,
        input.interactionReason,
      );

      const existingTopicLink = sourceTopicKey
        ? await this.findReusableTaskLink(input, space, sourceTopicKey)
        : null;
      if (existingTopicLink?.feishuTaskGuid) {
        await this.deps.repository.recordTaskLink({
          taskId: input.taskId,
          trackingSpaceId: space.id,
          feishuTaskGuid: existingTopicLink.feishuTaskGuid,
          feishuTaskUrl: existingTopicLink.feishuTaskUrl,
          sourceMessageId: input.sourceMessageId,
          sourceTopicKey,
          sourceTopicUrl: existingTopicLink.sourceTopicUrl,
          lastSyncedStatus: trackingStatus,
          lastSyncError: null,
        });
        this.logger.info(
          {
            taskId: input.taskId,
            sourceTopicKey,
            feishuTaskGuid: existingTopicLink.feishuTaskGuid,
          },
          'Reused existing Feishu Task for source topic',
        );
        await this.syncReusedFeishuTaskStatus({
          taskId: input.taskId,
          taskGuid: existingTopicLink.feishuTaskGuid,
          space,
          trackingStatus,
          previousSyncedStatus: existingTopicLink.lastSyncedStatus,
        });
        return;
      }

      if (input.sourceMessageId) {
        try {
          sourceTopicUrl = await this.deps.client.getMessageAppLink(input.sourceMessageId);
          if (!sourceTopicUrl) {
            sourceTopicError = 'source topic link unavailable';
          }
        } catch (err) {
          sourceTopicError = `source topic link unavailable: ${errorMessage(err)}`;
          this.logger.warn({ err, taskId: input.taskId }, 'Feishu source topic link lookup failed');
        }
      }

      const taskOrigin = buildTaskOrigin(sourceTopicUrl);
      if (taskOrigin.warning) {
        sourceTopicError = appendSyncWarning(sourceTopicError, taskOrigin.warning);
        this.logger.warn(
          { taskId: input.taskId, warning: taskOrigin.warning },
          'Feishu source topic origin link skipped',
        );
      }
      const feishuTask = await this.deps.client.createTask({
        summary: truncate(input.summary, TASK_TEXT_MAX_LENGTH),
        description: buildTaskDescription({
          taskId: input.taskId,
          description: input.description,
          sourceTopicUrl,
        }),
        tasklistGuid: space.tasklistGuid,
        sectionGuid: space.sections[trackingStatus],
        customFields: [
          {
            guid: space.statusFieldGuid,
            single_select_value: space.statusOptions[trackingStatus],
          },
        ],
        origin: taskOrigin.origin,
        members: input.requesterOpenId
          ? [{ id: input.requesterOpenId, type: 'user', role: 'follower' }]
          : undefined,
        clientToken: input.taskId,
      });

      await this.deps.repository.recordTaskLink({
        taskId: input.taskId,
        trackingSpaceId: space.id,
        feishuTaskGuid: feishuTask.guid,
        feishuTaskUrl: feishuTask.url,
        sourceMessageId: input.sourceMessageId,
        sourceTopicKey,
        sourceTopicUrl,
        lastSyncedStatus: trackingStatus,
        lastSyncError: sourceTopicError,
      });

      if (trackingStatus === 'completed') {
        await this.deps.client.completeTask(feishuTask.guid);
      }

      if (feishuTask.url && input.chatId) {
        try {
          await this.deps.client.sendMessage(
            'chat_id',
            input.chatId,
            {
              msg_type: 'text',
              content: { text: `Feishu task: ${feishuTask.url}` },
            },
            input.replyToMessageId,
          );
        } catch (err) {
          const replyError = `source topic reply failed: ${errorMessage(err)}`;
          this.logger.warn({ err, taskId: input.taskId }, 'Feishu Task source reply failed');
          await this.deps.repository.updateTaskLinkSync({
            taskId: input.taskId,
            lastSyncError: appendSyncWarning(sourceTopicError, replyError),
          });
        }
      }
    } catch (err) {
      const error = errorMessage(err);
      this.logger.warn({ err, taskId: input.taskId }, 'Feishu Task create sync failed');
      await this.deps.repository.recordTaskLinkError({
        taskId: input.taskId,
        sourceMessageId: input.sourceMessageId,
        sourceTopicKey,
        sourceTopicUrl,
        error,
      });
    }
  }

  async syncTaskStatus(input: SyncTrackedTaskStatusInput): Promise<void> {
    if (!this.deps.config.enabled) return;

    try {
      const link = await this.deps.repository.findTaskLink(input.taskId);
      if (!link?.feishuTaskGuid) return;

      const space = await this.resolveTrackingSpaceForLink(link);
      const trackingStatus = mapTaskStatusToFeishuTrackingStatus(
        input.localStatus,
        input.interactionReason,
      );
      await this.applyTrackingStatusToFeishuTask({
        taskGuid: link.feishuTaskGuid,
        space,
        trackingStatus,
        previousSyncedStatus: link.lastSyncedStatus,
      });
      await this.deps.repository.updateTaskLinkSync({
        taskId: input.taskId,
        lastSyncedStatus: trackingStatus,
        lastSyncError: null,
      });
    } catch (err) {
      const error = errorMessage(err);
      this.logger.warn({ err, taskId: input.taskId }, 'Feishu Task status sync failed');
      await this.deps.repository.updateTaskLinkSync({
        taskId: input.taskId,
        lastSyncError: error,
      });
    }
  }

  async cleanCompletedTasksForSession(
    input: CleanCompletedSessionTasksInput,
  ): Promise<FeishuTaskCleanupResult> {
    if (!this.deps.config.enabled) {
      throw new Error('Feishu Task tracking is disabled');
    }

    const retentionDays = normalizeRetentionDays(
      input.retentionDays ?? this.deps.config.completedTaskRetentionDays,
    );
    const cutoff = retentionCutoff(input.now ?? new Date(), retentionDays);
    const links = await this.deps.repository.listCompletedTaskLinksForSession({
      sessionId: input.sessionId,
      completedBefore: cutoff,
    });
    const result = this.emptyCleanupResult('session', retentionDays, Boolean(input.dryRun));
    result.scanned = links.length;
    result.eligible = links.length;
    const processedTaskGuids = new Set<string>();

    for (const link of links) {
      const taskGuid = link.feishuTaskGuid;
      if (!taskGuid) {
        result.skipped += 1;
        continue;
      }

      try {
        const space = await this.findCleanupTrackingSpaceForLink(link);
        if (!space) {
          throw new Error('Feishu Task tracking space is missing for this task link');
        }
        result.tasklistGuid ??= space.tasklistGuid;
        if (processedTaskGuids.has(taskGuid)) {
          if (!input.dryRun) {
            await this.deps.repository.updateTaskLinkSync({
              taskId: link.taskId,
              lastSyncedStatus: CLEANED_STATUS,
              lastSyncError: null,
            });
          }
          result.skipped += 1;
          continue;
        }

        const hasRetainedLink = await this.deps.repository.hasRetainedTaskLinkForFeishuTask({
          feishuTaskGuid: taskGuid,
          completedBefore: cutoff,
        });
        if (hasRetainedLink) {
          result.skipped += 1;
          continue;
        }

        if (!input.dryRun) {
          await this.deps.client.removeTaskFromTasklist({
            taskGuid,
            tasklistGuid: space.tasklistGuid,
          });
          processedTaskGuids.add(taskGuid);
          await this.deps.repository.updateTaskLinkSync({
            taskId: link.taskId,
            lastSyncedStatus: CLEANED_STATUS,
            lastSyncError: null,
          });
        }
        result.removed += input.dryRun ? 0 : 1;
      } catch (err) {
        const error = errorMessage(err);
        result.failed += 1;
        result.failures.push({ taskId: link.taskId, taskGuid, error });
        if (!input.dryRun) {
          await this.deps.repository.updateTaskLinkSync({
            taskId: link.taskId,
            lastSyncError: error,
          });
        }
        this.logger.warn({ err, taskId: link.taskId, taskGuid }, 'Feishu Task cleanup failed');
      }
    }

    return result;
  }

  async cleanCompletedTasksForChat(
    input: CleanCompletedChatTasksInput,
  ): Promise<FeishuTaskCleanupResult> {
    if (!this.deps.config.enabled) {
      throw new Error('Feishu Task tracking is disabled');
    }

    const retentionDays = normalizeRetentionDays(
      input.retentionDays ?? this.deps.config.completedTaskRetentionDays,
    );
    const cutoff = retentionCutoff(input.now ?? new Date(), retentionDays);
    const space = await this.deps.repository.findSpace('chat', input.chatId);
    if (!space) {
      throw new Error('No Feishu task board is configured for this chat');
    }

    const tasks = await this.deps.client.listTasklistTasks({
      tasklistGuid: space.tasklistGuid,
      completed: true,
    });
    const result = this.emptyCleanupResult('chat', retentionDays, Boolean(input.dryRun));
    result.tasklistGuid = space.tasklistGuid;
    result.scanned = tasks.length;

    for (const task of tasks) {
      if (!this.isTaskOlderThanRetention(task, cutoff)) {
        result.skipped += 1;
        continue;
      }
      result.eligible += 1;

      try {
        if (!input.dryRun) {
          await this.deps.client.removeTaskFromTasklist({
            taskGuid: task.guid,
            tasklistGuid: space.tasklistGuid,
          });
        }
        result.removed += input.dryRun ? 0 : 1;
      } catch (err) {
        const error = errorMessage(err);
        result.failed += 1;
        result.failures.push({ taskGuid: task.guid, error });
        this.logger.warn({ err, taskGuid: task.guid }, 'Feishu Task cleanup failed');
      }
    }

    return result;
  }

  async initializeChatTrackingSpace(
    input: InitializeChatTrackingSpaceInput,
  ): Promise<InitializeChatTrackingSpaceResult> {
    if (!this.deps.config.enabled) {
      throw new Error('Feishu Task tracking is disabled');
    }

    const scopeId = buildChatTrackingScopeId(input);
    return this.deps.repository.withScopeLock('chat', scopeId, async () =>
      this.initializeChatTrackingSpaceLocked(input),
    );
  }

  private emptyCleanupResult(
    scope: 'session' | 'chat',
    retentionDays: number,
    dryRun: boolean,
  ): FeishuTaskCleanupResult {
    return {
      scope,
      retentionDays,
      dryRun,
      scanned: 0,
      eligible: 0,
      removed: 0,
      skipped: 0,
      failed: 0,
      failures: [],
    };
  }

  private isTaskOlderThanRetention(task: FeishuTasklistTaskSummary, cutoff: Date): boolean {
    const completedAt = parseFeishuTimestamp(task.completedAt);
    return Boolean(completedAt && completedAt <= cutoff);
  }

  private async initializeChatTrackingSpaceLocked(
    input: InitializeChatTrackingSpaceInput,
  ): Promise<InitializeChatTrackingSpaceResult> {
    const scopeId = buildChatTrackingScopeId(input);
    const existing = await this.deps.repository.findSpace('chat', scopeId);
    if (existing) {
      return {
        tasklistGuid: existing.tasklistGuid,
        tasklistName: existing.name ?? undefined,
        statusFieldGuid: existing.statusFieldGuid,
        created: false,
      };
    }

    const chat = await this.deps.client.getChat(input.chatId);
    const chatName = chat.name ?? chat.i18nNames?.zh_cn ?? chat.i18nNames?.en_us ?? input.chatId;
    const name = taskBoardName(chatName);
    const tasklist = await this.deps.client.createTasklist({ name });
    if (!tasklist.guid) {
      throw new Error('createTasklist returned an empty guid');
    }

    const chatMembers = await this.deps.client.listChatMembers(input.chatId);
    const members = new Map<string, FeishuTasklistMember>();
    members.set(`chat:${input.chatId}`, { id: input.chatId, type: 'chat', role: 'editor' });
    for (const member of chatMembers) {
      members.set(`user:${member.memberId}`, {
        id: member.memberId,
        type: 'user',
        role: 'editor',
        name: member.name,
      });
    }

    for (const memberChunk of chunk([...members.values()], 50)) {
      await this.deps.client.addTasklistMembers(tasklist.guid, memberChunk);
    }

    const statusField = await this.ensureStatusField(tasklist.guid);
    const sections = await this.ensureSections(tasklist.guid);
    const space = await this.deps.repository.saveSpace({
      scopeType: 'chat',
      scopeId,
      name,
      tasklistGuid: tasklist.guid,
      statusFieldGuid: statusField.guid,
      statusOptions: statusField.options,
      sections,
    });

    return {
      tasklistGuid: space.tasklistGuid,
      tasklistUrl: tasklist.url,
      tasklistName: name,
      memberCount: chatMembers.length,
      statusFieldGuid: space.statusFieldGuid,
      created: true,
    };
  }

  async addBotToChatTrackingSpace(
    input: AddBotToChatTrackingSpaceInput,
  ): Promise<AddBotToChatTrackingSpaceResult> {
    if (!this.deps.config.enabled) {
      throw new Error('Feishu Task tracking is disabled');
    }

    const space = await this.findChatTrackingSpace(input);
    if (!space) {
      throw new Error('chat task board is not initialized');
    }

    const humanMembers = await this.deps.client.listChatMembers(input.chatId);
    if (humanMembers.some((member) => member.memberId === input.botOpenId)) {
      throw new Error('/add-bot target must be a bot mention');
    }

    await this.deps.client.addTasklistMembers(space.tasklistGuid, [
      {
        id: input.botOpenId,
        type: 'user',
        role: 'editor',
        name: input.botName,
      },
    ]);

    const message = await this.deps.client.sendMessage(
      'chat_id',
      input.chatId,
      {
        msg_type: 'text',
        content: {
          text: buildConfigureTasklistMentionMessage(space, input.botOpenId, input.botName),
        },
      },
      input.replyToMessageId,
    );

    return {
      tasklistGuid: space.tasklistGuid,
      botOpenId: input.botOpenId,
      botName: input.botName,
      configurationMessageId: message.messageId,
    };
  }

  async applyChatTasklistConfiguration(
    input: ApplyChatTasklistConfigurationInput,
  ): Promise<ApplyChatTasklistConfigurationResult> {
    if (!this.deps.config.enabled) {
      throw new Error('Feishu Task tracking is disabled');
    }

    const payload = decodeTasklistConfiguration(input.encodedPayload);
    const space = await this.deps.repository.saveSpace({
      scopeType: payload.scopeType,
      scopeId: payload.scopeId,
      tasklistGuid: payload.tasklistGuid,
      statusFieldGuid: payload.statusFieldGuid,
      statusOptions: payload.statusOptions,
      sections: payload.sections,
    });

    return {
      chatId: decodeChatIdFromScopeId(space.scopeId),
      tasklistGuid: space.tasklistGuid,
    };
  }

  private async resolveTrackingSpaceForTask(
    input: CreateTrackedTaskInput,
  ): Promise<FeishuTaskTrackingSpace> {
    if (input.chatId) {
      const chatSpace = await this.findChatTrackingSpace({
        chatId: input.chatId,
        tenantKey: input.tenantKey,
      });
      if (chatSpace) return chatSpace;
    }
    return this.ensureDefaultTrackingSpace();
  }

  private async findChatTrackingSpace(input: {
    chatId: string;
    tenantKey?: string;
  }): Promise<FeishuTaskTrackingSpace | null> {
    for (const scopeId of chatTrackingScopeCandidates(input)) {
      const space = await this.deps.repository.findSpace('chat', scopeId);
      if (space) return space;
    }
    return null;
  }

  private async resolveTrackingSpaceForLink(
    link: FeishuTaskLinkRecord,
  ): Promise<FeishuTaskTrackingSpace> {
    if (link.trackingSpaceId) {
      const linkedSpace = await this.deps.repository.findSpaceById(link.trackingSpaceId);
      if (linkedSpace) return linkedSpace;
    }
    return this.ensureDefaultTrackingSpace();
  }

  private async findCleanupTrackingSpaceForLink(
    link: FeishuTaskLinkRecord,
  ): Promise<FeishuTaskTrackingSpace | null> {
    if (link.trackingSpaceId) {
      return this.deps.repository.findSpaceById(link.trackingSpaceId);
    }

    const scopeType = this.deps.config.scopeType ?? 'global';
    const scopeId = this.deps.config.scopeId ?? 'default';
    return this.deps.repository.findSpace(scopeType, scopeId);
  }

  private async findReusableTaskLink(
    input: CreateTrackedTaskInput,
    space: FeishuTaskTrackingSpace,
    sourceTopicKey: string,
  ): Promise<FeishuTaskLinkRecord | null> {
    if (!space.id) return null;

    const topicLink = await this.deps.repository.findTaskLinkBySourceTopic({
      trackingSpaceId: space.id,
      sourceTopicKey,
    });
    if (topicLink) return topicLink;

    if (!isSessionSourceTopicKey(sourceTopicKey, input.sessionId)) return null;

    const sessionLink = await this.deps.repository.findTaskLinkBySession({
      trackingSpaceId: space.id,
      sessionId: input.sessionId!,
    });
    if (!sessionLink?.feishuTaskGuid) return null;

    await this.deps.repository.recordTaskLink({
      ...sessionLink,
      sourceTopicKey,
    });
    return { ...sessionLink, sourceTopicKey };
  }

  private async syncReusedFeishuTaskStatus(input: {
    taskId: string;
    taskGuid: string;
    space: FeishuTaskTrackingSpace;
    trackingStatus: FeishuTrackingStatus;
    previousSyncedStatus?: string | null;
  }): Promise<void> {
    try {
      await this.applyTrackingStatusToFeishuTask(input);
      await this.deps.repository.updateTaskLinkSync({
        taskId: input.taskId,
        lastSyncedStatus: input.trackingStatus,
        lastSyncError: null,
      });
    } catch (err) {
      const error = errorMessage(err);
      this.logger.warn(
        { err, taskId: input.taskId, taskGuid: input.taskGuid },
        'Reused Feishu Task status sync failed',
      );
      await this.deps.repository.updateTaskLinkSync({
        taskId: input.taskId,
        lastSyncError: error,
      });
    }
  }

  private async applyTrackingStatusToFeishuTask(input: {
    taskGuid: string;
    space: FeishuTaskTrackingSpace;
    trackingStatus: FeishuTrackingStatus;
    previousSyncedStatus?: string | null;
  }): Promise<void> {
    await this.deps.client.patchTaskCustomFields(input.taskGuid, [
      {
        guid: input.space.statusFieldGuid,
        single_select_value: input.space.statusOptions[input.trackingStatus],
      },
    ]);
    await this.deps.client.addTaskToTasklist({
      taskGuid: input.taskGuid,
      tasklistGuid: input.space.tasklistGuid,
      sectionGuid: input.space.sections[input.trackingStatus],
    });
    if (input.trackingStatus === 'completed') {
      await this.deps.client.completeTask(input.taskGuid);
    } else if (
      input.previousSyncedStatus === 'completed' ||
      input.previousSyncedStatus === CLEANED_STATUS
    ) {
      await this.deps.client.uncompleteTask(input.taskGuid);
    }
  }

  private async ensureDefaultTrackingSpace(): Promise<FeishuTaskTrackingSpace> {
    const scopeType = this.deps.config.scopeType ?? 'global';
    const scopeId = this.deps.config.scopeId ?? 'default';
    const existing = await this.deps.repository.findSpace(scopeType, scopeId);
    if (existing) return existing;

    const tasklistGuid =
      this.deps.config.tasklistGuid ??
      (
        await this.deps.client.createTasklist({
          name: this.deps.config.tasklistName ?? 'OpenClaudeTag Project Tracking',
        })
      ).guid;

    const statusField = await this.ensureStatusField(tasklistGuid);
    const sections = await this.ensureSections(tasklistGuid);
    return this.deps.repository.saveSpace({
      scopeType,
      scopeId,
      name: this.deps.config.tasklistName ?? undefined,
      tasklistGuid,
      statusFieldGuid: statusField.guid,
      statusOptions: statusField.options,
      sections,
    });
  }

  private async ensureStatusField(
    tasklistGuid: string,
  ): Promise<{ guid: string; options: Record<FeishuTrackingStatus, string> }> {
    const fields = await this.deps.client.listTaskCustomFields(tasklistGuid);
    let field = fields.find(
      (candidate) => candidate.name === 'Status' && candidate.type === 'single_select',
    );
    if (!field) {
      field = await this.deps.client.createTaskCustomField({
        tasklistGuid,
        name: 'Status',
        type: 'single_select',
        options: FEISHU_TRACKING_STATUSES.map((name) => ({ name })),
      });
    }

    const options = fieldOptionMap(field);
    for (const status of FEISHU_TRACKING_STATUSES) {
      if (options[status]) continue;
      const option = await this.deps.client.createTaskCustomFieldOption(field.guid, status);
      options[status] = option.guid;
    }
    return {
      guid: field.guid,
      options: requireCompleteMap(options, 'status options'),
    };
  }

  private async ensureSections(
    tasklistGuid: string,
  ): Promise<Record<FeishuTrackingStatus, string>> {
    const existingSections = await this.deps.client.listTaskSections(tasklistGuid);
    const sections: Partial<Record<FeishuTrackingStatus, string>> = {};
    for (const section of existingSections) {
      if (!FEISHU_TRACKING_STATUSES.includes(section.name as FeishuTrackingStatus)) continue;
      sections[section.name as FeishuTrackingStatus] = section.guid;
    }

    for (const status of FEISHU_TRACKING_STATUSES) {
      if (sections[status]) continue;
      const section: FeishuTaskSection = await this.deps.client.createTaskSection(
        tasklistGuid,
        status,
      );
      sections[status] = section.guid;
    }

    return requireCompleteMap(sections, 'sections');
  }
}

